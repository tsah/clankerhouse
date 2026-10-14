import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"

/**
 * Warm worktree pool. Each repository keeps one pre-checked-out, detached, locked spare
 * worktree inside its git common directory. Creating a branch claims the spare (create the
 * branch in place, let Worktrunk relocate it to its templated path) instead of checking
 * every file out on the hot path. Anything unusual declines the claim so the caller falls
 * back to `wt switch --create`.
 */

const poolDirectoryName = "clankerhouse-pool"
const lockReason = "clankerhouse warm spare"

interface SpareMetadata { defaultBranch: string }
interface CommandResult { exitCode: number; stdout: string; stderr: string }

const run = (argv: string[]): CommandResult => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } })
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() }
}

const runAsync = async (argv: string[]): Promise<CommandResult> => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

export const worktreePoolEnabled = (env: Record<string, string | undefined> = Bun.env) => !["0", "off", "false"].includes((env.CLANKERHOUSE_WORKTREE_POOL ?? "").toLowerCase())

/** Spares are bookkeeping, never Workshop candidates. */
export const isSpareWorktreePath = (path: string) => path.split(sep).includes(poolDirectoryName)

const commonDirOf = (repository: string) => {
  const result = run(["git", "-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  return result.exitCode === 0 && result.stdout ? realpathSync(result.stdout) : undefined
}

const metadataPath = (sparePath: string) => `${sparePath}.json`
const refillsInFlight = new Set<string>()

const readySpares = (commonDir: string) => {
  const pool = join(commonDir, poolDirectoryName)
  if (!existsSync(pool)) return []
  return readdirSync(pool, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const path = join(pool, entry.name)
    try {
      const metadata = JSON.parse(readFileSync(metadataPath(path), "utf8")) as SpareMetadata
      return typeof metadata.defaultBranch === "string" && metadata.defaultBranch ? [{ path, metadata }] : []
    } catch { return [] }
  })
}

const localBranchExists = (repository: string, branch: string) => run(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0

const worktreePathForBranch = (repository: string, branch: string) => {
  const listed = run(["git", "-C", repository, "worktree", "list", "--porcelain"])
  let path = ""
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/**
 * Turns a ready spare into the worktree for a new `branch` and returns its final path, or
 * undefined when the pool cannot serve the request exactly as Worktrunk would.
 */
export const claimSpareWorktree = (repository: string, branch: string, base?: string): string | undefined => {
  const commonDir = commonDirOf(repository)
  // A refill may be freshening the spare; never race it.
  if (!commonDir || refillsInFlight.has(commonDir)) return undefined
  const spare = readySpares(commonDir)[0]
  if (!spare) return undefined
  // Worktrunk's other base shortcuts (@, -, pr:N, mr:N) and remote bases stay with Worktrunk.
  const baseBranch = !base || base === "^" ? spare.metadata.defaultBranch : base
  if (!localBranchExists(repository, baseBranch) || localBranchExists(repository, branch)) return undefined
  if (run(["git", "check-ref-format", "--branch", branch]).exitCode !== 0) return undefined
  // Worktrunk owns hook execution and approval; a hooked repository keeps its normal path.
  const hooks = run(["wt", "-C", spare.path, "hook", "show", "--format", "json"])
  if (hooks.exitCode !== 0 || hooks.stdout !== "[]") return undefined
  const dirty = run(["git", "-C", spare.path, "status", "--porcelain"])
  if (dirty.exitCode !== 0 || dirty.stdout) return undefined

  const relock = () => { run(["git", "-C", commonDir, "worktree", "lock", "--reason", lockReason, spare.path]) }
  if (run(["git", "-C", commonDir, "worktree", "unlock", spare.path]).exitCode !== 0) return undefined
  if (run(["git", "-C", spare.path, "switch", "--quiet", "--no-track", "--create", branch, baseBranch]).exitCode !== 0) {
    relock()
    return undefined
  }
  run(["wt", "-C", spare.path, "step", "relocate", branch, "--format", "json"])
  const path = worktreePathForBranch(repository, branch)
  if (!path || isSpareWorktreePath(path)) {
    run(["git", "-C", spare.path, "switch", "--quiet", "--detach"])
    run(["git", "-C", commonDir, "branch", "--delete", "--force", branch])
    relock()
    return undefined
  }
  rmSync(metadataPath(spare.path), { force: true })
  return realpathSync(path)
}

/**
 * Leaves the repository with one ready spare at its default branch tip: freshens an existing
 * spare, or checks a new one out. Runs off the hot path; failures only mean the next create
 * takes the normal Worktrunk path.
 */
export const refillSpareWorktree = async (repository: string): Promise<void> => {
  const commonDir = commonDirOf(repository)
  if (!commonDir || refillsInFlight.has(commonDir)) return
  refillsInFlight.add(commonDir)
  try {
    const resolved = await runAsync(["wt", "-C", repository, "step", "eval", "{{ default_branch }}"])
    const defaultBranch = resolved.exitCode === 0 ? resolved.stdout : ""
    if (!defaultBranch || !localBranchExists(repository, defaultBranch)) return
    const pool = join(commonDir, poolDirectoryName)
    mkdirSync(pool, { recursive: true })
    const ready = readySpares(commonDir)
    const readyPaths = new Set(ready.map((spare) => spare.path))
    // A spare without metadata is an interrupted refill.
    for (const entry of readdirSync(pool, { withFileTypes: true })) {
      const path = join(pool, entry.name)
      if (!entry.isDirectory() || readyPaths.has(path)) continue
      await runAsync(["git", "-C", commonDir, "worktree", "remove", "--force", "--force", path])
      rmSync(path, { recursive: true, force: true })
    }
    await runAsync(["git", "-C", commonDir, "worktree", "prune"])
    const existing = ready[0]
    if (existing) {
      const [head, tip] = await Promise.all([
        runAsync(["git", "-C", existing.path, "rev-parse", "HEAD"]),
        runAsync(["git", "-C", commonDir, "rev-parse", `refs/heads/${defaultBranch}`]),
      ])
      if (head.stdout !== tip.stdout || existing.metadata.defaultBranch !== defaultBranch) {
        const moved = await runAsync(["git", "-C", existing.path, "checkout", "--quiet", "--detach", defaultBranch])
        if (moved.exitCode === 0) writeFileSync(metadataPath(existing.path), JSON.stringify({ defaultBranch } satisfies SpareMetadata))
      }
      return
    }
    const path = join(pool, `spare-${Date.now().toString(36)}`)
    const added = await runAsync(["git", "-C", commonDir, "worktree", "add", "--quiet", "--detach", "--lock", "--reason", lockReason, path, defaultBranch])
    if (added.exitCode !== 0) {
      console.error(`Warm worktree refill failed for ${repository}: ${added.stderr || `git exited ${added.exitCode}`}`)
      return
    }
    writeFileSync(metadataPath(path), JSON.stringify({ defaultBranch } satisfies SpareMetadata))
  } finally { refillsInFlight.delete(commonDir) }
}

/**
 * The base a new Workshop branch starts from. An explicit base keeps its meaning. Without
 * one, or with Worktrunk's `^` (the default branch, which the picker sends), the repository's
 * local default branch is not trusted: nothing keeps it current, so
 * the remote's default branch is fetched and the Workshop starts from `origin/<default>`.
 * A create never fails on the remote: GitHub's ssh auth refuses a valid key now and then, so after
 * a retry it falls back to what is here (the last fetched `origin/<default>`, else the local
 * default) and says so in the log.
 */

const remote = "origin"

export interface GitResult { exitCode: number; stdout: string; stderr: string }
export type GitRunner = (args: string[]) => GitResult

/** A remote call that takes longer is abandoned: a hanging GitHub ssh login must not hold up a create. */
export const REMOTE_TIMEOUT_MS = 8_000
const remoteCommands = new Set(["fetch", "ls-remote"])

const runGit = (repository: string): GitRunner => (args) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: Bun.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=5" },
    ...(remoteCommands.has(args[0]!) ? { timeout: REMOTE_TIMEOUT_MS } : {}),
  })
  const timedOut = result.exitCode === null
  return { exitCode: result.exitCode ?? 124, stdout: result.stdout.toString().trim(), stderr: timedOut ? `git ${args[0]} timed out after ${REMOTE_TIMEOUT_MS / 1000}s` : result.stderr.toString().trim() }
}

const failure = (result: GitResult, fallback: string) => result.stderr || result.stdout || fallback

/** Waits before each retry of a remote call; a remote that keeps failing fails after the last. */
export const REMOTE_RETRY_DELAYS_MS = [1_000]
/** Only a quick failure, such as GitHub refusing a key, is worth another try; a slow one is not. */
const QUICK_FAILURE_MS = 5_000

const withRetries = (call: () => GitResult, delays: number[]) => {
  let started = Date.now()
  let result = call()
  for (const delay of delays) {
    if (result.exitCode === 0 || Date.now() - started > QUICK_FAILURE_MS) break
    Bun.sleepSync(delay)
    started = Date.now()
    result = call()
  }
  return result
}

type Warn = (message: string) => void
const logWarning: Warn = (message) => console.error(message)

const refExists = (git: GitRunner, ref: string) => git(["show-ref", "--verify", "--quiet", ref]).exitCode === 0

/** The remote's default branch name, or undefined when neither this clone nor the remote says. */
const remoteDefaultBranch = (git: GitRunner, delays: number[], warn: Warn) => {
  const head = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`])
  const prefix = `refs/remotes/${remote}/`
  if (head.exitCode === 0 && head.stdout.startsWith(prefix)) return head.stdout.slice(prefix.length)
  // refs/remotes/origin/HEAD is only written by clone or `git remote set-head`; ask the remote.
  const listed = withRetries(() => git(["ls-remote", "--symref", remote, "HEAD"]), delays)
  const branch = listed.exitCode === 0 ? listed.stdout.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1] : undefined
  if (!branch) warn(`Unable to resolve ${remote}'s default branch; using Worktrunk's default: ${listed.exitCode === 0 ? "the remote did not report a symbolic HEAD" : failure(listed, `git ls-remote exited ${listed.exitCode}`)}`)
  return branch
}

/**
 * Fetches the remote default branch and returns `origin/<default>`. Without a reachable remote it
 * returns the freshest default here; undefined (Worktrunk's default) when there is no `origin`
 * or no way to tell its default branch.
 */
export const freshDefaultBase = (repository: string, git: GitRunner = runGit(repository), delays = REMOTE_RETRY_DELAYS_MS, warn: Warn = logWarning): string | undefined => {
  if (git(["remote", "get-url", remote]).exitCode !== 0) return undefined
  const branch = remoteDefaultBranch(git, delays, warn)
  if (!branch) return undefined
  const fetched = withRetries(() => git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]), delays)
  if (fetched.exitCode === 0) return `${remote}/${branch}`
  const local = refExists(git, `refs/remotes/${remote}/${branch}`) ? `${remote}/${branch}` : refExists(git, `refs/heads/${branch}`) ? branch : undefined
  warn(`Unable to fetch ${remote}/${branch} for a new Workshop's base; starting from ${local ?? "Worktrunk's default"} as last fetched: ${failure(fetched, `git fetch exited ${fetched.exitCode}`)}`)
  return local
}

export const workshopBase = (repository: string, base?: string, git?: GitRunner) => base && base !== "^" ? base : freshDefaultBase(repository, git)

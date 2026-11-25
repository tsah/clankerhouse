/**
 * Pre-trusting a clanker's folder in the Claude account it is about to run on.
 *
 * Claude keeps "Yes, I trust this folder" per config, in `projects[<path>].hasTrustDialogAccepted` of the account's
 * global config file (`$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` for Claude's default config). A clanker
 * moved to an account that never opened its folder would otherwise resume into the trust dialog, whose default is
 * "No, exit". Inside a git repository Claude looks the trust up on the repository's main root, the parent of the
 * shared `.git` (for a linked worktree, not the worktree itself), so every candidate key is written: the folder, its
 * worktree top level and the main root.
 *
 * Only that config file is touched: read, one flag set, written back atomically under the same `<file>.lock` that
 * Claude takes (proper-lockfile's directory lock), keeping every other key as it was. Never `.credentials.json`.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { accountHome, launchAccounts, type ClaudeAccount } from "./claude-accounts"

/** Claude's own defaults for a project entry it has not seen, so a new entry looks like one Claude wrote. */
const NEW_PROJECT = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
}

/** The global config file Claude reads for `configDir` (null: Claude's default config). */
export const claudeGlobalConfigFile = (configDir: string | null, home: string) => {
  const main = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json")
  // An old install keeps it as .config.json in the config directory; Claude still reads that when it is the only one.
  const legacy = join(configDir ?? join(home, ".claude"), ".config.json")
  const size = (path: string) => { try { return statSync(path).size } catch { return -1 } }
  return size(main) < 0 && size(legacy) > 0 ? legacy : main
}

const git = (cwd: string, args: string[]) => {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 })
    return result.exitCode === 0 ? result.stdout.toString().trim() : ""
  } catch { return "" }
}

const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

/** Every path Claude may look a folder's trust up under. */
export const trustKeysFor = (cwd: string): string[] => {
  const folder = real(cwd)
  const keys = [folder]
  const topLevel = git(folder, ["rev-parse", "--show-toplevel"])
  if (topLevel) keys.push(real(topLevel))
  const common = git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common) {
    const shared = real(common)
    keys.push(basename(shared) === ".git" ? dirname(shared) : shared)
  }
  return [...new Set(keys)]
}

export interface TrustResult { configFile: string; trusted: string[]; already: string[]; skipped?: string }

const sleep = (ms: number) => Bun.sleepSync(ms)

/** proper-lockfile's lock: a directory beside the file; Claude treats one older than 30 s as stale. */
const withConfigLock = <T>(file: string, run: () => T, options: { waitMs?: number; staleMs?: number } = {}): T | undefined => {
  const lock = `${file}.lock`
  const deadline = Date.now() + (options.waitMs ?? 5_000)
  const staleMs = options.staleMs ?? 30_000
  for (;;) {
    try { mkdirSync(lock); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let age = 0
      try { age = Date.now() - lstatSync(lock).mtimeMs } catch { continue }
      if (age > staleMs) { try { rmdirSync(lock) } catch {} ; continue }
      if (Date.now() > deadline) return undefined
      sleep(50)
    }
  }
  try { return run() } finally { try { rmdirSync(lock) } catch {} }
}

/** Marks `keys` trusted in one Claude global config file. Never creates the file and never rewrites one it cannot read. */
export const trustInConfig = (configFile: string, keys: readonly string[], options: { waitMs?: number; staleMs?: number } = {}): TrustResult => {
  let file: string
  try { file = realpathSync(configFile) }
  catch { return { configFile, trusted: [], already: [], skipped: "the account has no Claude config yet (never opened)" } }
  const outcome = withConfigLock(file, (): TrustResult => {
    const text = readFileSync(file, "utf8")
    let config: Record<string, unknown>
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      config = parsed
    } catch { return { configFile, trusted: [], already: [], skipped: "the Claude config is not readable JSON; left as it is" } }
    const projects = (config.projects && typeof config.projects === "object" && !Array.isArray(config.projects) ? config.projects : {}) as Record<string, Record<string, unknown>>
    const trusted: string[] = []
    const already: string[] = []
    for (const key of keys) {
      const entry = projects[key]
      if (entry && typeof entry === "object" && entry.hasTrustDialogAccepted === true) { already.push(key); continue }
      projects[key] = { ...(entry && typeof entry === "object" ? entry : NEW_PROJECT), hasTrustDialogAccepted: true }
      trusted.push(key)
    }
    if (!trusted.length) return { configFile, trusted, already }
    config.projects = projects
    const mode = statSync(file).mode & 0o777
    const temporary = join(dirname(file), `.${basename(file)}.clankerhouse-${process.pid}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode })
    renameSync(temporary, file)
    return { configFile, trusted, already }
  }, options)
  return outcome ?? { configFile, trusted: [], already: [], skipped: "Claude held its config lock; not changed" }
}

/**
 * Before a Claude launch on `label`, trusts `cwd` in that account's config. Best effort: a failure is reported in the
 * result and never stops the launch. No label (no accounts configured) changes nothing.
 */
export const trustFolderForAccount = (label: string | undefined, cwd: string, options: { accounts?: readonly ClaudeAccount[]; env?: Record<string, string | undefined> } = {}): TrustResult | undefined => {
  if (label === undefined) return undefined
  const env = options.env ?? Bun.env
  const accounts = options.accounts ?? launchAccounts(env)
  // An account the registry no longer lists runs on Claude's default config (claudeAccountEnvironment).
  const account = accounts.find((candidate) => candidate.label === label)
  const configFile = claudeGlobalConfigFile(account?.configDir ?? null, accountHome(env))
  try { return trustInConfig(configFile, trustKeysFor(cwd)) }
  catch (error) { return { configFile, trusted: [], already: [], skipped: `could not update the Claude config: ${(error as Error).message}` } }
}

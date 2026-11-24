/**
 * `clankers login`: add, list and remove the Claude accounts a usage-limited clanker can move to
 * (src/claude-accounts.ts). Adding one makes its config directory, opens Claude in it so the operator runs /login
 * themselves, checks the result with `claude auth status` (which answers whether a login exists, never the token), and
 * only then lists the account in the machine's registry. Nothing here reads, copies or writes a credentials file or
 * token; removing an account deletes its directory (and so its login) only when asked to.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"
import { validateAccountLabel } from "./clanker-ledger"
import { ClaudeAccountsConfigError, parseClaudeAccounts, type ClaudeAccount } from "./claude-accounts"

/** The default account's label when the registry is empty and the first extra account is added. */
export const DEFAULT_ACCOUNT_LABEL = "work"

const tildePath = (path: string, home: string) => {
  const inside = relative(home, path)
  return inside && !inside.startsWith("..") && !inside.startsWith("/") ? `~/${inside}` : path
}

const accountTable = (account: ClaudeAccount, home: string) =>
  `[[account]]\nlabel = "${account.label}"\n${account.configDir ? `config_dir = "${tildePath(account.configDir, home)}"\n` : ""}`

export const readRegistry = (path: string) => {
  try { return readFileSync(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

const writeRegistry = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let mode = 0o600
  try { mode = statSync(path).mode & 0o777 } catch {}
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, path)
}

export interface RegistryAdd { added: string[]; alreadyListed: boolean; accounts: ClaudeAccount[] }

/**
 * Appends an account to the registry text, keeping everything already there (order, comments, other accounts).
 * Listing the same label with the same directory again changes nothing. An empty registry also gets Claude's
 * default config as its first account, so switching has somewhere to start.
 */
export const addAccountToRegistryText = (text: string, account: ClaudeAccount, home: string, defaultLabel = DEFAULT_ACCOUNT_LABEL): { text: string } & RegistryAdd => {
  validateAccountLabel(account.label)
  const accounts = parseClaudeAccounts(text, home)
  const same = accounts.find((existing) => existing.label === account.label)
  if (same) {
    if (same.configDir !== account.configDir) throw new ClaudeAccountsConfigError(`account ${account.label} is already listed with ${same.configDir ?? "Claude's default config"}`)
    return { text, added: [], alreadyListed: true, accounts }
  }
  const sameDir = accounts.find((existing) => existing.configDir === account.configDir)
  if (sameDir) throw new ClaudeAccountsConfigError(`${account.configDir ?? "Claude's default config"} is already listed as account ${sameDir.label}`)
  const tables: ClaudeAccount[] = []
  if (accounts.length === 0 && account.configDir !== null) {
    validateAccountLabel(defaultLabel)
    if (defaultLabel === account.label) throw new ClaudeAccountsConfigError(`the default account cannot also be labelled ${account.label}; pass --default-label`)
    tables.push({ label: defaultLabel, configDir: null })
  }
  tables.push(account)
  let next = text
  if (next.trim()) next = `${next.replace(/\s*$/, "")}\n\n`
  else next = ""
  next += tables.map((table) => accountTable(table, home)).join("\n")
  const parsed = parseClaudeAccounts(next, home)
  return { text: next, added: tables.map((table) => table.label), alreadyListed: false, accounts: parsed }
}

/** Drops one `[[account]]` table from the registry text, keeping the rest as written. */
export const removeAccountFromRegistryText = (text: string, label: string, home: string): { text: string; removed: ClaudeAccount | undefined; accounts: ClaudeAccount[] } => {
  validateAccountLabel(label)
  const before = parseClaudeAccounts(text, home)
  const removed = before.find((account) => account.label === label)
  if (!removed) return { text, removed: undefined, accounts: before }
  const lines = text.split("\n")
  const headers = lines.flatMap((line, index) => /^\s*\[/.test(line) ? [index] : [])
  const escaped = label.replace(/[.]/g, "\\.")
  for (const [position, start] of headers.entries()) {
    if (!/^\s*\[\[\s*account\s*\]\]\s*(#.*)?$/.test(lines[start]!)) continue
    const end = headers[position + 1] ?? lines.length
    if (!lines.slice(start, end).some((line) => new RegExp(`^\\s*label\\s*=\\s*["']${escaped}["']\\s*(#.*)?$`).test(line))) continue
    // A comment directly above a table belongs to it: the removed table's goes with it, the next table's stays.
    let own = start
    while (own > 0 && /^\s*#/.test(lines[own - 1]!)) own--
    let cut = end
    if (end < lines.length) while (cut > start + 1 && /^\s*#/.test(lines[cut - 1]!)) cut--
    const kept = [...lines.slice(0, own), ...lines.slice(cut)]
    let next = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n")
    if (next.trim() === "") next = ""
    else if (!next.endsWith("\n")) next += "\n"
    const after = parseClaudeAccounts(next, home)
    if (after.length !== before.length - 1 || after.some((account) => account.label === label)) break
    return { text: next, removed, accounts: after }
  }
  throw new ClaudeAccountsConfigError(`cannot remove ${label} without rewriting the registry; edit it by hand`)
}

export const addAccountToRegistry = (path: string, account: ClaudeAccount, home: string, defaultLabel?: string): RegistryAdd => {
  const result = addAccountToRegistryText(readRegistry(path), account, home, defaultLabel)
  if (!result.alreadyListed) writeRegistry(path, result.text)
  return result
}

export const removeAccountFromRegistry = (path: string, label: string, home: string) => {
  const result = removeAccountFromRegistryText(readRegistry(path), label, home)
  if (result.removed) writeRegistry(path, result.text)
  return result
}

export interface LoginState { loggedIn: boolean; authMethod: string | null; checkedWith: "claude auth status" | "unavailable" }

/**
 * Whether Claude has a login in `configDir` (null: Claude's default config), from `claude auth status --json`. Only
 * the `loggedIn` and `authMethod` fields are kept. Credentials that would come from the environment instead of the
 * directory are removed for the check, so it answers for the directory.
 */
export const claudeLoginState = (configDir: string | null, options: { env?: Record<string, string | undefined>; claude?: string } = {}): LoginState => {
  const env: Record<string, string | undefined> = { ...(options.env ?? Bun.env) }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) delete env[name]
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  try {
    const result = Bun.spawnSync([options.claude ?? "claude", "auth", "status", "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 60_000 })
    const text = result.stdout.toString()
    const start = text.indexOf("{")
    const value = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as { loggedIn?: unknown; authMethod?: unknown }
    if (typeof value.loggedIn !== "boolean") throw new Error("no loggedIn field")
    return { loggedIn: value.loggedIn, authMethod: typeof value.authMethod === "string" ? value.authMethod : null, checkedWith: "claude auth status" }
  } catch { return { loggedIn: false, authMethod: null, checkedWith: "unavailable" } }
}

/** Runs Claude interactively in an account's directory so the operator logs in; returns its exit code. */
export const launchClaudeForLogin = (configDir: string, cwd: string, options: { env?: Record<string, string | undefined>; claude?: string } = {}) => {
  const env: Record<string, string | undefined> = { ...(options.env ?? Bun.env), CLAUDE_CONFIG_DIR: configDir }
  // A login in the environment would stand in for the one the operator is about to make.
  for (const name of ["CLANKER_ID", "CLANKERHOUSE_CLAUDE_ACCOUNT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[name]
  const result = Bun.spawnSync([options.claude ?? "claude"], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return result.exitCode ?? 1
}

/**
 * Deletes an account's directory, and with it the login Claude keeps there. Only a directory the registry listed,
 * never Claude's default config or the home directory.
 */
export const deleteAccountDir = (account: ClaudeAccount, home: string) => {
  if (!account.configDir) throw new Error(`${account.label} is Claude's default config; it is never deleted`)
  const dir = normalize(account.configDir)
  if (dir === normalize(home) || dir === normalize(join(home, ".claude")) || dir === "/") throw new Error(`refusing to delete ${dir}`)
  if (!existsSync(dir)) return false
  // rmSync removes the shared links themselves, never what they point at.
  rmSync(dir, { recursive: true, force: true })
  return true
}

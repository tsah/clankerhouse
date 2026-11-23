/**
 * Claude accounts: several Claude logins a clanker can run on, one CLAUDE_CONFIG_DIR each. When a clanker's turn ends
 * on a usage limit, the runner resumes its exact session on the next account whose limit has not been hit
 * (src/claude-account-switch.ts). Everything here is opt-in: with fewer than two accounts in the registry, nothing
 * changes how a clanker launches.
 *
 * The registry names accounts and their config directories, never a token. Each account's login lives in its own
 * config directory (Claude refuses a symlinked credentials file), and only the operator logs in. The account
 * directories share Claude's default `projects/`, settings and instructions through symlinks, so a session started
 * on one account resumes on another. Nothing here reads, writes or links a credentials file.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"
import { validateAccountLabel } from "./clanker-ledger"
import { instanceSlug, stateDirFor, stateHomeDefault } from "./paths"

export interface ClaudeAccount {
  label: string
  /** Claude's config directory for this account; null is Claude's default (no CLAUDE_CONFIG_DIR). */
  configDir: string | null
}

export class ClaudeAccountsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeAccountsConfigError"
  }
}

/** Every Clankerhouse instance has its own registry, so a test instance never switches the live accounts. */
export const claudeAccountsConfigPath = (env: Record<string, string | undefined> = Bun.env) => {
  if (env.CLANKERHOUSE_CLAUDE_ACCOUNTS) return env.CLANKERHOUSE_CLAUDE_ACCOUNTS
  const slug = instanceSlug(env)
  return `${env.XDG_CONFIG_HOME || `${env.HOME || ""}/.config`}/clankerhouse/claude-accounts${slug === "-rex" ? "" : slug}.toml`
}

export const accountHome = (env: Record<string, string | undefined> = Bun.env) => env.HOME || homedir()
const expandHome = (path: string, home: string) => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path

/** The registry's accounts in preference order; an absent file is no accounts. */
export const parseClaudeAccounts = (text: string, home: string): ClaudeAccount[] => {
  let raw: unknown
  try { raw = Bun.TOML.parse(text) }
  catch { throw new ClaudeAccountsConfigError("the Claude accounts registry is not valid TOML") }
  const list = (raw as Record<string, unknown>).account ?? []
  if (!Array.isArray(list)) throw new ClaudeAccountsConfigError("account must be an array of tables ([[account]])")
  const accounts: ClaudeAccount[] = []
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ClaudeAccountsConfigError(`account[${index}] must be a table`)
    const { label, config_dir: configDir, ...rest } = entry as Record<string, unknown>
    if (Object.keys(rest).length) throw new ClaudeAccountsConfigError(`account[${index}] has unknown keys: ${Object.keys(rest).join(", ")}`)
    try { validateAccountLabel(label) }
    catch { throw new ClaudeAccountsConfigError(`account[${index}].label must be 1-64 letters, digits, '.', '_' or '-'`) }
    let dir: string | null = null
    if (configDir !== undefined) {
      if (typeof configDir !== "string" || !configDir.trim()) throw new ClaudeAccountsConfigError(`account[${index}].config_dir must be a path`)
      dir = normalize(expandHome(configDir.trim(), home)).replace(/\/+$/, "")
      if (!isAbsolute(dir)) throw new ClaudeAccountsConfigError(`account[${index}].config_dir must be absolute or start with ~/`)
    }
    if (accounts.some((account) => account.label === label)) throw new ClaudeAccountsConfigError(`account label ${label} is listed twice`)
    if (accounts.some((account) => account.configDir === dir)) throw new ClaudeAccountsConfigError(dir ? `config_dir ${dir} is listed twice` : "only one account may omit config_dir (Claude's default config)")
    accounts.push({ label: label as string, configDir: dir })
  }
  return accounts
}

export const loadClaudeAccounts = (env: Record<string, string | undefined> = Bun.env): ClaudeAccount[] => {
  const path = claudeAccountsConfigPath(env)
  let text: string
  try { text = readFileSync(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new ClaudeAccountsConfigError(`cannot read ${path}: ${(error as Error).message}`)
  }
  return parseClaudeAccounts(text, accountHome(env))
}

/** Switching needs somewhere to switch to. */
export const switchingEnabled = (accounts: readonly ClaudeAccount[]) => accounts.length >= 2

/** The registry for a launch: a broken registry must not stop clankers from starting, so it reads as no accounts. */
export const launchAccounts = (env: Record<string, string | undefined> = Bun.env): ClaudeAccount[] => {
  try { return loadClaudeAccounts(env) }
  catch (error) {
    console.error(`Claude account switching is off: ${(error as Error).message}`)
    return []
  }
}

/**
 * The environment a Claude launch on `label` adds. An account the registry no longer lists runs on Claude's default
 * config, as every clanker did before accounts.
 */
export const claudeAccountEnvironment = (label: string | undefined, accounts: readonly ClaudeAccount[]): { unset: string[]; set: string[] } => {
  if (label === undefined) return { unset: [], set: [] }
  const account = accounts.find((candidate) => candidate.label === label)
  if (!account?.configDir) return { unset: ["CLAUDE_CONFIG_DIR"], set: [`CLANKERHOUSE_CLAUDE_ACCOUNT=${label}`] }
  return { unset: [], set: [`CLAUDE_CONFIG_DIR=${account.configDir}`, `CLANKERHOUSE_CLAUDE_ACCOUNT=${label}`] }
}

// ---- Usage state: which accounts are out of usage, and until when ----

export interface AccountMark {
  /** Epoch ms until which the account is not offered; past it the account is usable again. */
  until: number
  /** The StopFailure error that marked it (`rate_limit`, `authentication_failed`, ...). */
  error: string
  /** Claude's own words, with the reset time. */
  message: string
  at: number
}

export interface AccountSwitchRecord { clankerId: string; from: string | null; to: string; error: string; at: number }

export interface ClaudeAccountState {
  version: 1
  accounts: Record<string, AccountMark>
  /** Per clanker, the `at` of the last turn error a pass acted on, so one limit moves a clanker once. */
  handled: Record<string, number>
  switches: AccountSwitchRecord[]
}

export const emptyAccountState = (): ClaudeAccountState => ({ version: 1, accounts: {}, handled: {}, switches: [] })

export const claudeAccountStatePath = (env: Record<string, string | undefined> = Bun.env) =>
  join(stateDirFor(stateHomeDefault(env), env), "claude-accounts.json")

export const readAccountState = (path = claudeAccountStatePath()): ClaudeAccountState => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (value?.version !== 1) return emptyAccountState()
    return { version: 1, accounts: value.accounts ?? {}, handled: value.handled ?? {}, switches: Array.isArray(value.switches) ? value.switches : [] }
  } catch { return emptyAccountState() }
}

export const writeAccountState = (state: ClaudeAccountState, path = claudeAccountStatePath()) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...state, switches: state.switches.slice(-50) }, null, 1)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export const accountAvailable = (state: ClaudeAccountState, label: string, now: number) => (state.accounts[label]?.until ?? 0) <= now

/** The first account in preference order that is not out of usage, other than `except`. */
export const chooseAccount = (accounts: readonly ClaudeAccount[], state: ClaudeAccountState, now: number, except?: string | null) =>
  accounts.find((account) => account.label !== except && accountAvailable(state, account.label, now))?.label

/** The account a new Claude clanker starts on, or undefined to launch exactly as before accounts. */
export const spawnAccount = (env: Record<string, string | undefined> = Bun.env, now = Date.now()) => {
  const accounts = launchAccounts(env)
  if (!switchingEnabled(accounts)) return undefined
  return chooseAccount(accounts, readAccountState(claudeAccountStatePath(env)), now) ?? accounts[0]!.label
}

// ---- When a limit resets, from Claude's own text ----

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Offset of `zone` from UTC at `instant`, in ms; throws on an unknown zone. */
const zoneOffset = (instant: number, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(instant / 1000) * 1000
}

const wallClockToUtc = (year: number, month: number, day: number, hour: number, minute: number, zone: string) => {
  const guess = Date.UTC(year, month, day, hour, minute)
  const first = guess - zoneOffset(guess, zone)
  return guess - zoneOffset(first, zone)
}

/**
 * When the limit in Claude's message resets: "You've hit your weekly limit · resets Nov 26, 11am (UTC)" or
 * "... resets 3:30pm (Europe/Amsterdam)". Undefined when the text names no time Claude would write.
 */
export const parseLimitReset = (message: string, now: number): number | undefined => {
  const match = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(message)
  if (!match) return undefined
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = match
  const zone = zoneText?.trim() || "UTC"
  let hour = Number(hourText) % 12
  if (meridiem!.toLowerCase() === "pm") hour += 12
  const minute = Number(minuteText ?? 0)
  try {
    if (monthName) {
      const month = MONTHS.indexOf(monthName.toLowerCase())
      if (month < 0) return undefined
      const thisYear = new Date(now).getUTCFullYear()
      const at = wallClockToUtc(thisYear, month, Number(dayText), hour, minute, zone)
      // A reset in early January read in late December belongs to next year.
      return at < now - 86_400_000 ? wallClockToUtc(thisYear + 1, month, Number(dayText), hour, minute, zone) : at
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)).split("-").map(Number)
    const at = wallClockToUtc(today[0]!, today[1]! - 1, today[2]!, hour, minute, zone)
    return at <= now ? wallClockToUtc(today[0]!, today[1]! - 1, today[2]! + 1, hour, minute, zone) : at
  } catch { return undefined }
}

// ---- Account directories ----

/**
 * What an account directory shares with Claude's default config. Never `.credentials.json` (each account's own login)
 * or `.claude.json` (each account's own onboarding, trust and account details).
 */
export const SHARED_CONFIG_ENTRIES = ["projects", "settings.json", "CLAUDE.md", "commands", "agents", "skills", "plugins", "output-styles", "keybindings.json", "file-history", "todos", "plans"] as const
const NEVER_SHARED = new Set([".credentials.json", ".claude.json"])

export const defaultAccountDir = (label: string, home: string) => join(home, ".claude-acct", validateAccountLabel(label))

export interface AccountDirSetup { configDir: string; linked: string[]; kept: string[]; conflicts: string[] }

/**
 * Creates an account's config directory with links to the shared parts of `sharedFrom` (Claude's default config).
 * It never logs in and never touches a credentials file; an entry that exists and is not our link is left alone.
 */
export const setupAccountDir = (configDir: string, sharedFrom: string): AccountDirSetup => {
  if (normalize(configDir) === normalize(sharedFrom)) throw new Error("an account directory cannot be Claude's default config itself")
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  // Transcripts must have one home, or a session started on one account cannot resume on another.
  mkdirSync(join(sharedFrom, "projects"), { recursive: true, mode: 0o700 })
  const result: AccountDirSetup = { configDir, linked: [], kept: [], conflicts: [] }
  for (const entry of SHARED_CONFIG_ENTRIES) {
    if (NEVER_SHARED.has(entry)) continue
    const source = join(sharedFrom, entry)
    const target = join(configDir, entry)
    if (!existsSync(source)) continue
    let present: ReturnType<typeof lstatSync> | undefined
    try { present = lstatSync(target) } catch {}
    if (!present) {
      symlinkSync(source, target)
      result.linked.push(entry)
    } else if (present.isSymbolicLink() && readlinkSync(target) === source) result.kept.push(entry)
    else result.conflicts.push(entry)
  }
  return result
}

/** Whether an account's directory was set up and has been used by Claude (it writes `.claude.json` on first run). */
export const accountDirState = (account: ClaudeAccount): "default" | "missing" | "not-used-yet" | "ready" => {
  if (!account.configDir) return "default"
  if (!existsSync(account.configDir)) return "missing"
  return existsSync(join(account.configDir, ".claude.json")) ? "ready" : "not-used-yet"
}

// ---- Status, for `clankers claude-accounts` ----

export interface ClaudeAccountsStatus {
  registry: string
  /** Switching runs only with two or more accounts. */
  enabled: boolean
  error?: string
  accounts: Array<{ label: string; configDir: string | null; directory: ReturnType<typeof accountDirState>; available: boolean; outUntil: string | null; outBecause: string | null }>
  recentSwitches: Array<AccountSwitchRecord & { atIso: string }>
}

export const claudeAccountsStatus = (env: Record<string, string | undefined> = Bun.env, now = Date.now()): ClaudeAccountsStatus => {
  const registry = claudeAccountsConfigPath(env)
  let accounts: ClaudeAccount[] = []
  let error: string | undefined
  try { accounts = loadClaudeAccounts(env) } catch (problem) { error = (problem as Error).message }
  const state = readAccountState(claudeAccountStatePath(env))
  return {
    registry,
    enabled: switchingEnabled(accounts),
    ...(error ? { error } : {}),
    accounts: accounts.map((account) => {
      const mark = state.accounts[account.label]
      const out = !!mark && mark.until > now
      return { label: account.label, configDir: account.configDir, directory: accountDirState(account), available: !out, outUntil: out ? new Date(mark.until).toISOString() : null, outBecause: out ? mark.message || mark.error : null }
    }),
    recentSwitches: state.switches.slice(-10).map((entry) => ({ ...entry, atIso: new Date(entry.at).toISOString() })),
  }
}

/** Offer an account again before its recorded reset (the operator raised its limit, say). */
export const clearAccountMark = (label: string, env: Record<string, string | undefined> = Bun.env) => {
  const path = claudeAccountStatePath(env)
  const state = readAccountState(path)
  const had = label in state.accounts
  delete state.accounts[label]
  writeAccountState(state, path)
  return had
}

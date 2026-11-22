/**
 * Rex Multiplexer Adapter, the only runtime (ADR-0012). All Rex vocabulary (blocks,
 * layers, the `rex` CLI, its Lua scripts and events) lives here. Mapping: Rex session → session, window → window, block →
 * pane. Rex ids, labels and layouts survive a server restart; the programs in them do not (a restored block runs a shell).
 *
 * Rex carries one label per object and no key/value metadata, so Claims live in a store of this lane's own: one file per
 * object and key under the instance's state directory, written by atomic rename. The Rust lifecycle hook reads and writes
 * the same files (`native-client/src/bin/clankerhouse-hook.rs`).
 *
 * Every request goes through the `rex` CLI, the server's documented interface. One observation is one `rex do` script
 * (`share/rex/observe.lua`) that returns the whole server; the Change Stream is one long-lived `rex events --all --json`.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DAEMON_INTERNAL_ENV_KEYS } from "../client-environment"
import { applicationRoot } from "../installation"
import { foregroundGroup, type GroupMember } from "./process-group"
import { runtimeDirFor, stateDirFor } from "../paths"
import {
  claimScopeOf, locationScope,
  MultiplexerUnavailableError,
  type AgentInterruptOutcome, type ClaimKey, type ClaimMap, type ClaimScope, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities,
  type MultiplexerChange, type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type MultiplexerWindow, type NativeLocation,
  type RuntimeAgentStatus, type SpawnRequest, type SpawnResult,
} from "./interface"

export const REX_PANE_ADDRESS_ENV = "REX_BLOCK"
export const REX_TERMINAL_CREATOR = "com.superlogical.terminal"
export const REX_TERMINAL_FLAVOR = "com.superlogical.terminal.shell"
/** Blocks whose label starts with this are Clankerhouse's own popups: never a session's pane. */
export const REX_POPUP_LABEL_PREFIX = "clankerhouse:"
/** Rex refuses labels longer than this. */
export const REX_LABEL_MAX = 128
/** The app that last opened a popup is the one a choice in it should move, for this long. */
export const REX_CLIENT_FRESH_MS = 600_000
/** A harness that always reports and has said nothing for this long is held at a startup dialog. */
export const REX_STARTUP_SILENCE_MS = 30_000
/** How long one interrupt key gets to end a turn before the next. Vim-mode Claude spends the first ESC leaving INSERT. */
export const REX_INTERRUPT_STEP_MS = 400
/** Claude reads a paste before it takes the Enter that submits it. */
export const REX_PROMPT_SUBMIT_DELAY_MS = 150
/** How long after Enter the input box is read back, and how many reads (each but the last followed by Enter again). */
export const REX_PROMPT_CONFIRM_MS = 800
export const REX_PROMPT_SUBMIT_CHECKS = 3

/** Box detection reads only the screen's tail, not the whole scrollback. */
const SCREEN_TAIL_LINES = 80
const RULE = /^\s*─{8,}/
/**
 * A screen line as a person reads it: styling dropped, cursor-forward moves (how the VT capture writes runs of
 * spaces) turned back into spaces, and dim text (SGR 2, which is how Claude draws its suggestion) left out. Colour
 * parameters are skipped whole, so the `2` in a truecolor `38;2;r;g;b` is not taken for dim.
 */
export const visibleText = (line: string) => {
  let out = ""
  let dim = false
  const escape = /\x1b\[([0-9;?]*)([A-Za-z])/g
  let at = 0
  for (let match = escape.exec(line); match; match = escape.exec(line)) {
    if (!dim) out += line.slice(at, match.index)
    at = match.index + match[0].length
    if (match[2] === "C") { if (!dim) out += " ".repeat(Number(match[1] || 1)); continue }
    if (match[2] !== "m") continue
    const params = (match[1] || "0").split(";").map((value) => Number(value || 0))
    for (let index = 0; index < params.length; index += 1) {
      const param = params[index]!
      if (param === 38 || param === 48 || param === 58) { index += params[index + 1] === 5 ? 2 : params[index + 1] === 2 ? 4 : 0; continue }
      if (param === 2) dim = true
      else if (param === 0 || param === 22) dim = false
    }
  }
  if (!dim) out += line.slice(at)
  return out.replace(/\r/g, "")
}
const visible = visibleText

/**
 * The typed text in Claude's input box: the lines between the last two horizontal rules on the screen, with the
 * prompt glyph and dim suggestion text removed. Undefined when the screen shows no such box (another program, or a
 * dialog in its place). Takes plain or VT-styled screen text.
 */
export const inputBoxOf = (screen: string): string | undefined => {
  const lines = screen.split("\n").map(visible)
  const rules = lines.flatMap((line, index) => RULE.test(line) ? [index] : [])
  if (rules.length < 2) return undefined
  const [top, bottom] = [rules.at(-2)!, rules.at(-1)!]
  return lines.slice(top + 1, bottom).map((line) => line.replace(/^\s*[❯>]\s?/, "").trimEnd()).join("\n").trim()
}

/**
 * Whether the box holds this prompt: its clankerhouse tag (looked for across wrapped lines), its first line, or
 * Claude's placeholder for a long paste.
 */
export const unsentPrompt = (box: string, prompt: string) => {
  if (!box) return false
  if (/\[Pasted text #\d+/.test(box)) return true
  const tag = /\[clankerhouse (msg-[A-Za-z0-9-]+)/.exec(prompt)?.[1]
  if (tag) return box.replace(/\s+/g, "").includes(tag)
  const first = prompt.trim().split("\n")[0]!.trim().slice(0, 40)
  return first.length > 0 && box.includes(first)
}

/**
 * Whether the box holds this prompt and nothing else (an earlier copy whose Enter was lost), as opposed to someone's
 * draft, which may even contain the prompt pasted onto it. Whitespace is ignored, since the box wraps lines.
 */
export const onlyThisPrompt = (box: string, prompt: string) => {
  const squeeze = (value: string) => value.replace(/\s+/g, "")
  return squeeze(box) === squeeze(prompt) || /^\[Pasted text #\d+[^\]]*\]$/.test(box.trim())
}

/** Claude's usage-limit dialog ("Stop and wait for limit to reset" / "Switch to extra usage"), which takes typed keys. */
export const limitDialogShown = (screen: string) =>
  /^\s*(❯\s*)?\d\.\s+(Stop and wait|Wait for (the )?limit)/im.test(screen.split("\n").slice(-16).map(visible).join("\n"))
/** How long an app gets to switch to a session before focus gives up on it. */
export const REX_CLIENT_TIMEOUT_MS = 3_000
const SELF_REPORTING_HARNESSES = new Set(["claude", "pi"])
/** Rex's name for a program (OSC 7501 `app`) → the harness name Clankerhouse claims. */
const harnessOfApp: Record<string, string> = { "claude-code": "claude" }
/** Store-only keys: the server instance a block's program was started by, when, and whether it ever reported status. */
const EPOCH_KEY = "_epoch"
const SPAWNED_KEY = "_spawned"
const REPORTED_KEY = "_reported"

/** Identity a terminal must never take from the spawner's environment. `spawn` unsets whichever the caller did not set. */
export const REX_UNSET_ON_SPAWN = [
  // A command's own markers (src/client-environment.ts) never reach a terminal it starts.
  ...DAEMON_INTERNAL_ENV_KEYS,
  "CLANKER_ID", "CLANKER_SESSION_ID", "CLANKERHOUSE_WORKSHOP_ID", "CLANKERHOUSE_PARENT_WORKSHOP_ID", "CLANKERHOUSE_CURRENT_SESSION", "CLANKERHOUSE_MODE", "CLANKERHOUSE_REX_FOCUS", "CLANKERHOUSE_REX_CLIENT",
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE",
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION",
]

/** The spawner's PATH and Clankerhouse settings, without the variables that say which clanker the spawner is. */
const laneEnvironment = (env: Record<string, string | undefined> = Bun.env) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => (entry[0] === "PATH" || /^CLANKERHOUSE_/.test(entry[0])) && !REX_UNSET_ON_SPAWN.includes(entry[0]) && Boolean(entry[1])))

/** Rex terminals take no environment, so the launch is wrapped in `env`, which also removes inherited identity. */
export const rexLaunchCommand = (argv: string[] | undefined, env: Record<string, string>) => {
  const unset = REX_UNSET_ON_SPAWN.filter((name) => !(name in env)).flatMap((name) => ["-u", name])
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`)
  return ["env", ...unset, ...assignments, ...(argv ?? ["sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'])]
}

export const rexLabel = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, REX_LABEL_MAX)

/** One file per object and key: a write never reads, so two writers of one object cannot lose each other's keys. */
export class RexClaimStore {
  constructor(readonly root: string) {}

  private objectDir(objectId: string) {
    if (!/^[a-z]+:[A-Za-z0-9-]+$/.test(objectId)) throw new Error(`Not a Rex object id: ${objectId}`)
    return join(this.root, objectId)
  }

  write(objectId: string, key: string, value: string | null) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`Invalid Rex claim key: ${key}`)
    const dir = this.objectDir(objectId)
    const path = join(dir, key)
    if (value === null || value === "") { rmSync(path, { force: true }); return }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temporary, value, { mode: 0o600 })
    renameSync(temporary, path)
  }

  read(objectId: string, key: string) {
    try { return readFileSync(join(this.objectDir(objectId), key), "utf8") || undefined } catch { return undefined }
  }

  all(objectId: string): Record<string, string> {
    let names: string[]
    try { names = readdirSync(this.objectDir(objectId)) } catch { return {} }
    const values: Record<string, string> = {}
    for (const name of names) {
      if (name.endsWith(".tmp")) continue
      try { const value = readFileSync(join(this.objectDir(objectId), name), "utf8"); if (value) values[name] = value } catch {}
    }
    return values
  }

  remove(objectId: string) { rmSync(this.objectDir(objectId), { recursive: true, force: true }) }

  objects() { try { return readdirSync(this.root) } catch { return [] } }

  /** Forget objects the server no longer has. A store entry younger than `graceMs` may belong to a spawn in flight. */
  prune(live: ReadonlySet<string>, now: number, graceMs = 600_000) {
    for (const objectId of this.objects()) {
      if (live.has(objectId)) continue
      try { if (now - statSync(join(this.root, objectId)).mtimeMs < graceMs) continue } catch { continue }
      rmSync(join(this.root, objectId), { recursive: true, force: true })
    }
  }
}

export const rexClaimRoot = (env: Record<string, string | undefined> = Bun.env) => join(stateDirFor(undefined, env), "rex-claims")

export type RexRun = (args: string[], options?: { stdin?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** Global `rex` options: never start a server as a side effect, and talk to the lane's server when one is named. */
const rexGlobalArgs = (server: string | undefined) => ["--autostart=false", ...(server ? ["--server", server] : [])]

const runRex = (bin: string, server: string | undefined): RexRun => async (args, options = {}) => {
  const child = Bun.spawn([bin, "--timeout", `${Math.ceil((options.timeoutMs ?? 10_000) / 1000)}s`, ...rexGlobalArgs(server), ...args], {
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe",
  })
  const killer = setTimeout(() => child.kill(), (options.timeoutMs ?? 10_000) + 2_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { exitCode, stdout, stderr }
  } catch (error) {
    throw new MultiplexerUnavailableError("rex", error instanceof Error ? error.message : String(error))
  } finally { clearTimeout(killer) }
}

export class RexRequestError extends Error {
  constructor(readonly method: string, readonly code: string | undefined, message: string) {
    super(`rex ${method}: ${message}`)
    this.name = "RexRequestError"
  }
}

const unavailable = (stderr: string) => /no (rex )?server|connection refused|no such file|not running|dial unix|cannot connect|could not connect/i.test(stderr)

/** Lua's JSON encoder writes an empty list as `{}`. */
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []

interface RexProcess { pid: number; name?: string; argv0?: string; cwd?: string; path?: string }
interface RexStatusRecord { id?: string; state: string; kind?: string; app?: string; effective_app?: string; msg?: string; updated_at?: string }
interface RexObservedBlock { block_id: string; label: string; creator: string; layer: string; title?: string; process?: { child?: RexProcess | null; foreground?: RexProcess | null; last_exit?: unknown }; program_status?: { records?: unknown } }
interface RexObservedWindow { window_id: string; label: string; focused_block_id?: string; blocks: unknown }
interface RexObservedSession { session_id: string; label: string; active_window_id?: string; windows: unknown }
interface RexObservedClient { client_id: string; kind?: string; session_ids?: unknown }
interface RexObservation { host_id: string; instance_id: string; pid: number; sessions: unknown; clients?: unknown }

const statusOf = (word: string | undefined): RuntimeAgentStatus => {
  if (word === "working" || word === "blocked" || word === "idle" || word === "done") return word
  return word === "error" ? "blocked" : "unknown"
}

/** The root record speaks for the program; without one, the newest record does. */
const leadRecord = (records: RexStatusRecord[]) =>
  records.find((record) => !record.id) ?? [...records].sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))[0]

const argvOf = (pid: number | undefined) => {
  if (!pid) return undefined
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) } catch { return undefined }
}

/** Without /proc (macOS), one `ps` per observation names every process group's members. */
export const psProcessGroups = (output: string) => {
  const groups = new Map<number, GroupMember[]>()
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const argv = match[3]!.trim().split(/\s+/)
    const member = { pid: Number(match[1]), name: argv[0]!.split("/").pop(), argv }
    groups.set(Number(match[2]), [...(groups.get(Number(match[2])) ?? []), member])
  }
  return groups
}

const readProcessGroups = () => {
  if (process.platform === "linux") return undefined
  try { return psProcessGroups(Bun.spawnSync(["ps", "-axo", "pid=,pgid=,command="], { stdout: "pipe", stderr: "ignore" }).stdout.toString()) } catch { return undefined }
}

/** `lsof -Fn` output for `-d cwd`: each process's working directory. */
export const lsofWorkingDirectories = (output: string) => {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** Without /proc, one `lsof` for every pid that needs one. */
const readWorkingDirectories = (pids: number[]) => {
  if (process.platform === "linux" || !pids.length) return new Map<number, string>()
  try { return lsofWorkingDirectories(Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" }).stdout.toString()) } catch { return new Map<number, string>() }
}

/** macOS Rex starts each program under login(1), which leads the group without being what runs there. */
const LAUNCH_WRAPPERS = new Set(["login"])

/** The foreground group: Rex names its leader, which for a harness is the lifecycle wrapper; the harness is another member. */
const foregroundMembers = (leader: GroupMember, groups: Map<number, GroupMember[]> | undefined, cwds?: Map<number, string>): GroupMember[] => {
  if (!groups) return foregroundGroup(leader)
  const members = [leader, ...(groups.get(leader.pid) ?? []).filter((member) => member.pid !== leader.pid)]
  return members.map((member) => ({ ...member, cwd: member.cwd || cwds?.get(member.pid) }))
}

const pickClaims = (values: Record<string, string>, scope: ClaimScope) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("_") && claimScopeOf(key as ClaimKey) === scope)) as ClaimMap

export interface RexAdapterOptions {
  bin?: string
  /** A Rex server address; defaults to CLANKERHOUSE_REX_SERVER, else the account's own server. */
  server?: string
  run?: RexRun
  claims?: RexClaimStore
  observeScript?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  env?: Record<string, string | undefined>
}

export class RexAdapter implements Multiplexer {
  readonly kind = "rex" as const
  readonly bin: string
  readonly server: string | undefined
  readonly claims: RexClaimStore
  private readonly run: RexRun
  private readonly observeScript: string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly env: Record<string, string | undefined>

  constructor(options: RexAdapterOptions = {}) {
    this.env = options.env ?? Bun.env
    this.bin = options.bin ?? (this.env.REX_BIN || "rex")
    this.server = options.server ?? (this.env.CLANKERHOUSE_REX_SERVER?.trim() || undefined)
    this.run = options.run ?? runRex(this.bin, this.server)
    this.claims = options.claims ?? new RexClaimStore(rexClaimRoot(this.env))
    this.observeScript = options.observeScript ?? join(applicationRoot, "share", "rex", "observe.lua")
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? Bun.sleep
  }

  capabilities(): MultiplexerCapabilities {
    return { processInfo: true, agentStatus: true, agentPrompt: true, sessionRefs: false, persistentLabels: true, durableIds: true, popup: true, worktrees: false, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "window", "pane"] }
  }

  paneAddressEnv() { return REX_PANE_ADDRESS_ENV }
  insideRuntime() { return Boolean(this.env.REX_BLOCK?.trim()) }

  /** One server method, through `rex api call`. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, any>> {
    const result = await this.run(["api", "call", method, "-"], { stdin: JSON.stringify(params), timeoutMs })
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `exit ${result.exitCode}`
      if (unavailable(message)) throw new MultiplexerUnavailableError("rex", message)
      throw new RexRequestError(method, /code=([a-z_]+)/.exec(message)?.[1], message)
    }
    const text = result.stdout.trim()
    return text ? JSON.parse(text) : {}
  }

  private blockMethod(sessionId: string, blockId: string, method: string, args: Record<string, unknown> = {}) {
    return this.call("block.method", { session_id: sessionId, block_id: blockId, method, args })
  }

  async available() {
    try { await this.call("server.status", {}, 2_000); return true } catch { return false }
  }

  /** The host id survives restarts, as Rex's ids do; it changes only when the server's state is wiped. */
  async instanceId() { return `rex:${(await this.call("server.status")).host_id}` }

  /** A new server process restores the layout but restarts every program in it. */
  async serverEpoch() {
    try { return `rex:${(await this.call("server.status", {}, 2_000)).instance_id}` } catch { return undefined }
  }

  private async observation(): Promise<RexObservation> {
    const result = await this.run(["do", this.observeScript])
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `exit ${result.exitCode}`
      if (unavailable(message)) throw new MultiplexerUnavailableError("rex", message)
      throw new RexRequestError("observe", undefined, message)
    }
    return JSON.parse(result.stdout) as RexObservation
  }

  /** `rex do` already returns process facts for every block in the one call, so the `processInfo` options change nothing. */
  async observe(): Promise<MultiplexerSnapshot> {
    const observed = await this.observation()
    const groups = readProcessGroups()
    const cwds = groups ? readWorkingDirectories(list<RexObservedSession>(observed.sessions).flatMap((session) => list<RexObservedWindow>(session.windows).flatMap((window) => list<RexObservedBlock>(window.blocks).flatMap((block) => {
      const leader = block.process?.foreground?.pid
      return leader ? (groups.get(leader) ?? []).map((member) => member.pid) : []
    })))) : undefined
    const instanceId = `rex:${observed.host_id}`
    const now = this.now()
    const attachedSessions = new Set(list<RexObservedClient>(observed.clients).filter((client) => client.kind === "app" || client.kind === "ios").flatMap((client) => list<string>(client.session_ids)))
    const live = new Set<string>()
    const sessions: MultiplexerSession[] = []
    for (const session of list<RexObservedSession>(observed.sessions)) {
      live.add(session.session_id)
      const sessionValues = this.claims.all(session.session_id)
      const claims = pickClaims(sessionValues, "session")
      const windows: MultiplexerWindow[] = []
      for (const [windowIndex, window] of list<RexObservedWindow>(session.windows).entries()) {
        live.add(window.window_id)
        const windowValues = this.claims.all(window.window_id)
        const panes: MultiplexerPane[] = []
        for (const block of list<RexObservedBlock>(window.blocks)) {
          live.add(block.block_id)
          if (block.creator !== REX_TERMINAL_CREATOR || block.label.startsWith(REX_POPUP_LABEL_PREFIX)) continue
          panes.push(this.paneOf(block, panes.length, window, observed.instance_id, now, groups, cwds))
        }
        windows.push({
          id: window.window_id,
          index: String(windowIndex),
          nativeName: window.label,
          active: window.window_id === session.active_window_id,
          claims: pickClaims(windowValues, "window"),
          resourceId: window.window_id,
          displayName: windowValues.windowDisplayName || undefined,
          panes,
        })
      }
      const worktreePath = claims.worktreePath || ""
      const directoryPath = claims.directoryPath || ""
      const firstPane = windows.flatMap((window) => window.panes)[0]
      sessions.push({
        id: session.session_id,
        nativeName: session.label,
        path: worktreePath || directoryPath || firstPane?.currentPath || "",
        recency: Math.max(0, ...windows.flatMap((window) => window.panes.map((pane) => pane.activity))),
        attached: attachedSessions.has(session.session_id),
        worktreePath,
        directoryPath,
        claims,
        workshopId: claims.workshopId,
        parentWorkshopId: claims.workshopParentId || undefined,
        resourceId: session.session_id,
        displayName: claims.sessionDisplayName || undefined,
        windows,
      })
    }
    this.claims.prune(live, now)
    return { kind: "rex", instanceId, sessions }
  }

  private paneOf(block: RexObservedBlock, index: number, window: RexObservedWindow, serverInstance: string, now: number, groups: Map<number, GroupMember[]> | undefined, cwds: Map<number, string> | undefined): MultiplexerPane {
    const values = this.claims.all(block.block_id)
    const claims = pickClaims(values, "pane")
    const records = list<RexStatusRecord>(block.program_status?.records)
    if (records.length && !values[REPORTED_KEY]) this.claims.write(block.block_id, REPORTED_KEY, String(now))
    const child = block.process?.child ?? undefined
    const foreground = block.process?.foreground ?? undefined
    const members = foreground ? foregroundMembers({ pid: foreground.pid, name: foreground.name, argv: argvOf(foreground.pid) ?? (foreground.argv0 ? [foreground.argv0] : undefined), cwd: foreground.cwd }, groups, cwds) : []
    const running = members.find((member) => !LAUNCH_WRAPPERS.has(member.name ?? "")) ?? members[0]
    const lead = leadRecord(records)
    const reportedAt = lead?.updated_at ? Date.parse(lead.updated_at) : undefined
    const spawnedAt = Number(values[SPAWNED_KEY] ?? 0)
    const harness = claims.harness
    // Every program dies with the server: a block that outlived its server's instance holds a shell, not the harness.
    const harnessGone = Boolean(harness && values[EPOCH_KEY] && values[EPOCH_KEY] !== serverInstance)
    return {
      id: block.block_id,
      index: String(index),
      pid: child?.pid ? String(child.pid) : "",
      command: (running?.name ?? child?.name ?? "").toLowerCase(),
      title: block.title ?? "",
      currentPath: running?.cwd || foreground?.cwd || child?.cwd || "",
      // Rex reports no output activity; the last status report is the nearest fact.
      activity: Math.floor((reportedAt ?? spawnedAt) / 1000),
      active: block.block_id === window.focused_block_id,
      claims,
      terminalId: block.block_id,
      displayName: claims.terminalDisplayName || undefined,
      clankerId: claims.clankerId,
      harness,
      harnessSessionId: claims.harnessSessionId,
      processInfo: {
        shellPid: child?.pid,
        foregroundProcessGroupId: foreground?.pid,
        foregroundProcesses: members,
      },
      agentStatus: this.agentStatusOf(lead, harness, Boolean(values[REPORTED_KEY]) || records.length > 0, spawnedAt, now),
      ...(harnessGone ? { harnessGone: true } : {}),
    }
  }

  private agentStatusOf(lead: RexStatusRecord | undefined, harness: string | undefined, everReported: boolean, spawnedAt: number, now: number): NonNullable<MultiplexerPane["agentStatus"]> {
    if (!lead && !everReported && harness && SELF_REPORTING_HARNESSES.has(harness) && spawnedAt && now - spawnedAt >= REX_STARTUP_SILENCE_MS) {
      // The silence is only noticed once the window has passed, so that is when it was "reported".
      return { agent: harness, status: "blocked", blockedKind: "startup", message: "no status since it started; a startup dialog may be waiting", reportedAt: spawnedAt + REX_STARTUP_SILENCE_MS }
    }
    if (!lead) return { status: "unknown" }
    const app = lead.effective_app ?? lead.app
    const status = statusOf(lead.state)
    const blockedKind = status !== "blocked" ? undefined : lead.state === "error" ? "error" : lead.kind === "permission" || lead.kind === "question" || lead.kind === "auth" ? lead.kind : undefined
    const reportedAt = lead.updated_at ? Date.parse(lead.updated_at) : undefined
    return { ...(app ? { agent: harnessOfApp[app] ?? app } : {}), status, ...(blockedKind ? { blockedKind } : {}), ...(lead.msg ? { message: lead.msg } : {}), ...(reportedAt ? { reportedAt } : {}) }
  }

  /** Coarse classes only: consumers re-observe. A restarted event stream becomes `reconnect`. */
  async *changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> {
    const queue: MultiplexerChange[] = []
    let notify: (() => void) | undefined
    const push = (kind: MultiplexerChange["kind"]) => { queue.push({ kind, at: Date.now() }); notify?.() }
    let child: ReturnType<typeof Bun.spawn> | undefined
    let restart: ReturnType<typeof setTimeout> | undefined
    let backoffMs = 500
    const start = () => {
      if (signal.aborted) return
      const started = Date.now()
      const stream = Bun.spawn([this.bin, ...rexGlobalArgs(this.server), "events", "--all", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      child = stream
      push("reconnect")
      void (async () => {
        const decoder = new TextDecoder()
        let buffer = ""
        try {
          for await (const chunk of stream.stdout as ReadableStream<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true })
            let newline = buffer.indexOf("\n")
            while (newline >= 0) {
              const kind = rexChangeKind(buffer.slice(0, newline))
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf("\n")
              if (kind) push(kind)
            }
          }
        } catch {}
        await stream.exited
        if (signal.aborted) return
        if (Date.now() - started > 10_000) backoffMs = 500
        restart = setTimeout(start, backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15_000)
      })()
    }
    const wake = () => notify?.()
    signal.addEventListener("abort", wake)
    try {
      start()
      while (!signal.aborted) {
        if (queue.length) { yield queue.shift()!; continue }
        await new Promise<void>((resolve) => { notify = resolve })
        notify = undefined
      }
    } finally {
      signal.removeEventListener("abort", wake)
      clearTimeout(restart)
      child?.kill()
    }
  }

  /**
   * Inside a Clankerhouse popup the launcher names the block the popup opened over (`CLANKERHOUSE_REX_FOCUS`,
   * `SESSION WINDOW BLOCK`); inside any other Rex terminal, that terminal is the location. Rex keeps no focus of its own
   * outside a client, so a process elsewhere has none.
   */
  async currentLocation(): Promise<CurrentLocation | undefined> {
    const focus = this.env.CLANKERHOUSE_REX_FOCUS?.trim()
    if (focus) {
      const [session, window, block] = focus.split(/\s+/)
      if (session) return { kind: "rex", instanceId: await this.instanceId(), nativeSessionId: session, nativeWindowId: window || null, nativePaneId: block || null }
    }
    const session = this.env.REX_SESSION?.trim()
    const block = this.env.REX_BLOCK?.trim()
    if (!session || !block) return undefined
    const described = await this.call("session.describe_block", { session_id: session, block_id: block })
    const placement = (described.block ?? described) as { window_id?: string }
    return { kind: "rex", instanceId: await this.instanceId(), nativeSessionId: session, nativeWindowId: placement.window_id ?? null, nativePaneId: block }
  }

  private terminalLayout(label: string, cwd: string, env: Record<string, string>, argv: string[] | undefined) {
    return { block: { flavor: REX_TERMINAL_FLAVOR, label: rexLabel(label), options: { shell: "none", cwd, command: rexLaunchCommand(argv, env) } } }
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const env = { ...laneEnvironment(this.env), CLANKERHOUSE_MULTIPLEXER: "rex", ...request.env }
    const argv = request.launch?.kind === "argv" ? request.launch.argv : undefined
    const [{ instance_id: serverInstance }] = await Promise.all([this.call("server.status")])
    let result: SpawnResult
    if (request.scope === "session") {
      const windowName = request.windowName || request.name
      const created = await this.call("session.create", { label: rexLabel(request.name), initial_windows: [{ window_label: rexLabel(windowName), layout: this.terminalLayout(windowName, request.cwd, env, argv) }] })
      const window = created.initial_windows[0]
      result = { nativeSessionId: created.session_id, nativeWindowId: window.window_id, nativePaneId: window.block_ids[0] }
    } else {
      const created = await this.call("session.new_window", { session_id: request.nativeSessionId, window_label: rexLabel(request.name), focus: false, layout: this.terminalLayout(request.name, request.cwd, env, argv) })
      result = { nativeSessionId: request.nativeSessionId, nativeWindowId: created.window_id, nativePaneId: created.block_ids[0] }
    }
    this.claims.write(result.nativePaneId, EPOCH_KEY, serverInstance)
    this.claims.write(result.nativePaneId, SPAWNED_KEY, String(this.now()))
    return result
  }

  /**
   * A location whose session is unknown (a caller holding only a pane or window id, such as `clankers mux kill --pane`)
   * gets its session from Rex; Rex methods on a block or window need the session that holds it.
   */
  private async located(location: NativeLocation): Promise<NativeLocation> {
    if (location.nativeSessionId || (!location.nativePaneId && !location.nativeWindowId)) return location
    const observed = await this.observation()
    for (const session of list<RexObservedSession>(observed.sessions)) {
      for (const window of list<RexObservedWindow>(session.windows)) {
        if (location.nativeWindowId && window.window_id === location.nativeWindowId) return { ...location, nativeSessionId: session.session_id }
        if (location.nativePaneId && list<RexObservedBlock>(window.blocks).some((block) => block.block_id === location.nativePaneId)) {
          return { ...location, nativeSessionId: session.session_id, nativeWindowId: location.nativeWindowId ?? window.window_id }
        }
      }
    }
    throw new RexRequestError("locate", "not_found", `no Rex session holds ${location.nativePaneId ?? location.nativeWindowId}`)
  }

  async kill(location: NativeLocation) {
    location = await this.located(location)
    const scope = locationScope(location)
    try {
      if (scope === "session") await this.call("session.destroy", { session_id: location.nativeSessionId })
      else if (scope === "window") await this.call("session.close_window", { session_id: location.nativeSessionId, window_id: location.nativeWindowId })
      else await this.call("block.close", { session_id: location.nativeSessionId, block_id: location.nativePaneId })
    } catch (error) {
      if (!(error instanceof RexRequestError && (error.code === "not_found" || error.code === "session_not_found"))) throw error
    }
    this.claims.remove(scope === "session" ? location.nativeSessionId : scope === "window" ? location.nativeWindowId! : location.nativePaneId!)
  }

  async rename(location: NativeLocation, name: string) {
    location = await this.located(location)
    const scope = locationScope(location)
    const label = rexLabel(name)
    if (scope === "session") await this.call("session.set_label", { session_id: location.nativeSessionId, label })
    else if (scope === "window") await this.call("session.set_window_label", { session_id: location.nativeSessionId, window_id: location.nativeWindowId, label })
    else await this.call("session.set_block_label", { session_id: location.nativeSessionId, block_id: location.nativePaneId, label })
  }

  /**
   * App clients that should follow a focus: the one that opened the popup (named in this process, or recorded by the
   * popup's launcher for the daemon), else every app connected to the server.
   */
  private async appClients(): Promise<string[]> {
    const clients = list<{ client_id: string; info?: { kind?: string } }>((await this.call("client.list")).clients)
    const apps = clients.filter((client) => client.info?.kind === "app" || client.info?.kind === "ios").map((client) => client.client_id)
    let named = this.env.CLANKERHOUSE_REX_CLIENT?.trim()
    if (!named) {
      try {
        const path = join(runtimeDirFor(this.env), "rex-client")
        if (this.now() - statSync(path).mtimeMs < REX_CLIENT_FRESH_MS) named = readFileSync(path, "utf8").trim()
      } catch {}
    }
    return named && apps.includes(named) ? [named] : apps
  }

  /**
   * Focus inside the session is the server's, so it always moves. Showing that session is each app's own choice, asked
   * for with its `session.select` action; an app with Remote Control off refuses, and the session is still focused.
   */
  async focus(location: NativeLocation) {
    location = await this.located(location)
    const session = location.nativeSessionId
    if (location.nativePaneId) await this.call("session.focus_block", { session_id: session, block_id: location.nativePaneId })
    else if (location.nativeWindowId) await this.call("session.focus_window", { session_id: session, window_id: location.nativeWindowId })
    const args = { session_id: session, ...(location.nativeWindowId ? { window_id: location.nativeWindowId } : {}) }
    const outcomes = await Promise.all((await this.appClients()).map((client) =>
      this.call("client.perform", { client_id: client, action: "session.select", args, origin: "api", timeout_ms: REX_CLIENT_TIMEOUT_MS }, REX_CLIENT_TIMEOUT_MS + 2_000).then(() => undefined, (error: unknown) => error)))
    // The session is focused either way; when no app would show it, say why rather than leave the operator where they were.
    const refusals = outcomes.filter((outcome): outcome is Error => outcome instanceof Error)
    if (outcomes.length && refusals.length === outcomes.length) {
      const refused = refusals.find((error) => error instanceof RexRequestError && error.code === "refused")
      throw new Error(refused ? `Rex focused the session, but the app would not switch to it: ${/Turn on Remote Control[^(]*/.exec(refused.message)?.[0]?.trim() ?? refused.message}` : `Rex focused the session, but no app switched to it: ${refusals[0]!.message}`)
    }
  }

  /** The tail of the pane's screen with its terminal styling (dim suggestion text stays tellable), or undefined. */
  private async screen(location: NativeLocation): Promise<string | undefined> {
    try {
      const result = await this.run(["capture", "-s", location.nativeSessionId, "-b", location.nativePaneId!, "--format=vt"], { timeoutMs: 5_000 })
      return result.exitCode === 0 ? result.stdout.split("\n").slice(-SCREEN_TAIL_LINES).join("\n") : undefined
    } catch { return undefined }
  }

  /**
   * Paste, then Enter as a key of its own, as a person would. Before typing: a draft someone left in the input box is
   * never touched (the hand-off is refused, and the message waits with that reason); an unsent copy of this same
   * prompt (a lost Enter) is submitted rather than pasted again; and Claude's usage-limit dialog, when it has taken
   * the box's place, is dismissed. After Enter the box is read back: the prompt still sitting there (Enter lost, as after a compaction) gets
   * Enter again, and one that never leaves is reported as stalled, which the sender treats as unconfirmed and retries.
   * Claude's greyed-out suggestion is dim text and never counts as a draft or as unsent text.
   */
  async promptAgent(location: NativeLocation, text: string) {
    location = await this.located(location)
    if (!location.nativePaneId) throw new Error("Agent prompt requires a pane location")
    const target = { session_id: location.nativeSessionId, block_id: location.nativePaneId }
    const key = (name: string) => this.call("block.event", { ...target, event: { type: "key", payload: { key: name } } })
    const before = await this.screen(location)
    const draft = before === undefined ? undefined : inputBoxOf(before)
    if (draft && !onlyThisPrompt(draft, text)) throw new Error(`a draft is in the input box ("${draft.slice(0, 60)}"); typing would mix with it`)
    if (draft) {
      // An earlier copy of this very prompt is still sitting there (its Enter was lost): submit it, do not paste twice.
      await key("enter")
    } else {
      if (before !== undefined && draft === undefined && limitDialogShown(before)) {
        await key("escape")
        await this.sleep(REX_PROMPT_SUBMIT_DELAY_MS)
      }
      // Clears a line Claude left behind where it honours ctrl+u; a dim suggestion needs nothing, the paste replaces it.
      await key("ctrl+u")
      await this.call("block.event", { ...target, event: { type: "paste", payload: { text } } })
      await this.sleep(REX_PROMPT_SUBMIT_DELAY_MS)
      await key("enter")
    }
    if (before === undefined) return
    for (let check = 0; check < REX_PROMPT_SUBMIT_CHECKS; check += 1) {
      await this.sleep(REX_PROMPT_CONFIRM_MS)
      const box = inputBoxOf(await this.screen(location) ?? "")
      if (box === undefined || !unsentPrompt(box, text)) return
      if (check < REX_PROMPT_SUBMIT_CHECKS - 1) await key("enter")
    }
    throw new Error("prompt stalled in the input box: Enter did not submit it")
  }

  private async leadStatus(location: NativeLocation) {
    const status = await this.blockMethod(location.nativeSessionId, location.nativePaneId!, "program_status")
    return leadRecord(list<RexStatusRecord>(status.records))?.state
  }

  /**
   * Stop the current turn. A program that reports no status gets ctrl+c and no wait; a reporting one gets up to two ESCs,
   * each with a short look at its status, since one ESC only leaves INSERT in vim-mode Claude.
   */
  async interruptAgent(location: NativeLocation): Promise<AgentInterruptOutcome> {
    location = await this.located(location)
    if (!location.nativePaneId) throw new Error("Agent interrupt requires a pane location")
    const key = (name: string) => this.call("block.event", { session_id: location.nativeSessionId, block_id: location.nativePaneId, event: { type: "key", payload: { key: name } } })
    const state = await this.leadStatus(location)
    if (state === undefined && !this.claims.read(location.nativePaneId, REPORTED_KEY)) {
      await key("ctrl+c")
      return "sent"
    }
    if (state !== "working") return "not_working"
    for (let press = 0; press < 2; press += 1) {
      await key("escape")
      for (let waited = 0; waited < REX_INTERRUPT_STEP_MS; waited += 50) {
        if (await this.leadStatus(location) !== "working") return "stopped"
        await this.sleep(50)
      }
    }
    return "still_working"
  }

  private claimObject(location: NativeLocation, scope: ClaimScope) {
    if (scope === "session") return location.nativeSessionId
    if (scope === "window") return location.nativeWindowId ?? undefined
    return location.nativePaneId ?? undefined
  }

  async claim(location: NativeLocation, key: ClaimKey, value: string | null) {
    const scope = claimScopeOf(key)
    const object = this.claimObject(location, scope)
    if (!object) throw new Error(`Claim ${key} requires a ${scope} location`)
    this.claims.write(object, key, value)
  }

  async readClaim(location: NativeLocation, key: ClaimKey) {
    const object = this.claimObject(location, claimScopeOf(key))
    return object ? this.claims.read(object, key) : undefined
  }

}

const topologyEvents = new Set(["session_created", "session_destroyed", "window_created", "window_closed", "block_created", "block_closed", "session_view_changed"])
const metadataEvents = new Set(["session_label_changed", "window_label_changed"])
const blockMetadataEvents = new Set(["pwd_changed", "title_changed", "process_changed", "child_exited"])
const blockStatusEvents = new Set(["program_status_changed", "program_status_removed"])

/** The change class of one `rex events --json` line, or undefined for events no observation reflects (clients come and go with every CLI call). */
export const rexChangeKind = (line: string): MultiplexerChange["kind"] | undefined => {
  let event: { type?: string; payload?: any }
  try { event = JSON.parse(line) } catch { return undefined }
  if (event.type === "session_event") event = event.payload?.event ?? {}
  if (event.type === "block_event") {
    const name = String(event.payload?.name ?? "")
    if (blockStatusEvents.has(name)) return "status"
    return blockMetadataEvents.has(name) ? "metadata" : undefined
  }
  if (topologyEvents.has(event.type ?? "")) return "topology"
  if (metadataEvents.has(event.type ?? "")) return "metadata"
  if (event.type === "active_window_changed") return "focus"
  return undefined
}


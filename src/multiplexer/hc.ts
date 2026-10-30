/**
 * herdr-core (`hc`) Multiplexer Adapter, selected by CLANKERHOUSE_MULTIPLEXER=hc; Herdr stays the default. hc has no
 * workspaces, tabs, or focus. Mapping: every terminal is one window with one pane (window id = pane id = hc address), and
 * a session is the set of terminals sharing the `ch_session` label. Session Claims live on every terminal of the session,
 * so a session ends with its last terminal, as a herdr workspace does. Core lifecycle lives in `hc-core.ts`.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import {
  claimScopeOf, locationScope,
  MultiplexerUnavailableError, UnsupportedMultiplexerOperation,
  type AgentInterruptOutcome, type ClaimKey, type ClaimMap, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange,
  type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type RuntimeAgentStatus, type SpawnRequest, type SpawnResult,
} from "./interface"
import { runtimeDirFor } from "../paths"

export const HC_PROTOCOL_GENERATION = 1
export const HC_PANE_ADDRESS_ENV = "HC_TERMINAL_ID"
const SESSION_LABEL = "ch_session"
const SESSION_NAME_LABEL = "ch_session_name"
const WINDOW_NAME_LABEL = "ch_window_name"
const PANE_NAME_LABEL = "ch_pane_name"
/** Workshop Labels on session terminals; hc has no sidebar, so these serve `hc ls --label` and `shownLabels`. */
const SHOWN_LABEL_PREFIX = "lbl_"
/** The lane's session, so Clankerhouse never shares a core with a person's own `hc` use. */
export const HC_DEFAULT_SESSION = "clankerhouse"
/** A harness that always reports and has said nothing for this long is held at a startup dialog. */
export const HC_STARTUP_SILENCE_MS = 30_000
/** How long one interrupt key gets to end a turn before the next. Vim-mode Claude spends the first ESC leaving INSERT. */
export const HC_INTERRUPT_STEP_MS = 400
/** A notification is a courtesy: the caller never waits on the operator's command longer than this. */
export const HC_NOTIFY_TIMEOUT_MS = 1_000
const SELF_REPORTING_HARNESSES = new Set(["claude", "pi"])
/** hc's name for a program → the harness name Clankerhouse claims. */
const harnessOfApp: Record<string, string> = { "claude-code": "claude" }

/** Claim key → hc label. hc enforces no key or value limits, so unlike herdr tokens nothing is dropped or refused. */
const labelNames: Partial<Record<ClaimKey, string>> = {
  workshopId: "ch_workshop_id",
  workshopParentId: "ch_workshop_parent",
  worktreePath: "ch_worktree_path",
  directoryPath: "ch_directory_path",
  gitCommonDir: "ch_git_common_dir",
  sessionId: "ch_session_id",
  sessionDisplayName: SESSION_NAME_LABEL,
  windowDisplayName: WINDOW_NAME_LABEL,
  terminalDisplayName: PANE_NAME_LABEL,
  terminalId: "ch_terminal_id",
  clankerId: "ch_clanker_id",
  harness: "ch_harness",
  harnessSessionId: "ch_harness_session",
  clankerSocket: "ch_clanker_socket",
  clankerPid: "ch_clanker_pid",
  clankerCapabilities: "ch_clanker_caps",
  paneWorkshopParentId: "ch_pane_parent",
}
const claimKeyByLabel = new Map(Object.entries(labelNames).map(([key, label]) => [label, key as ClaimKey]))

export const hcSocketPath = (env: Record<string, string | undefined> = Bun.env) => {
  if (env.HC_SOCKET) return env.HC_SOCKET
  if (env.HC_TERMINAL_SOCKET) return env.HC_TERMINAL_SOCKET
  return join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, "herdr-core", `${env.HC_SESSION || HC_DEFAULT_SESSION}.sock`)
}

export type HcRequest = (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>

export const hcRequest = (socketPath: string, timeoutMs = 10_000): HcRequest => (method, params = {}) => new Promise((resolveRequest, reject) => {
  const socket = createConnection(socketPath)
  let buffer = ""
  let settled = false
  const finish = (error?: Error, value?: Record<string, any>) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    if (error) reject(error)
    else resolveRequest(value!)
  }
  const timer = setTimeout(() => finish(new Error(`hc ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
  socket.setEncoding("utf8")
  socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`))
  socket.on("data", (chunk) => {
    buffer += chunk
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    try {
      const payload = JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, any>; error?: { message?: string; data?: { kind?: string } } }
      if (payload.error) return finish(new Error(`hc ${method}: ${payload.error.data?.kind ?? "error"}: ${payload.error.message}`))
      finish(undefined, payload.result ?? {})
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
  socket.on("error", (error: NodeJS.ErrnoException) => finish(new MultiplexerUnavailableError("hc", error.code === "ENOENT" || error.code === "ECONNREFUSED" ? `no core at ${socketPath}` : error.message)))
  socket.on("end", () => finish(new Error(`hc ${method}: connection closed without a response`)))
})

interface HcForeground { pid: number; name?: string; argv?: string[]; cwd?: string }
interface HcTerminal { address: string; name?: string | null; argv: string[]; cwd: string; pid: number | null; state: "live" | "finished"; reason?: string | null; exit_code?: number | null; title?: string; created_ms: number; reported?: boolean; status_ms?: number | null; status?: { state: string; app?: string; kind?: string; msg?: string } | null; labels: Record<string, string>; foreground?: HcForeground | null }

/** Identity a terminal must never take from the core's environment. `spawn` unsets whichever the caller did not set. */
export const HC_UNSET_ON_SPAWN = ["CLANKER_ID", "CLANKER_SESSION_ID", "CLANKERHOUSE_WORKSHOP_ID", "CLANKERHOUSE_PARENT_WORKSHOP_ID", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"]

/** `env -u` is the only way to remove a variable from a terminal: hc's `env` parameter can only set them. */
const scrubbedArgv = (argv: string[] | undefined, env: Record<string, string>) => {
  const unset = HC_UNSET_ON_SPAWN.filter((name) => !(name in env)).flatMap((name) => ["-u", name])
  return ["env", ...unset, ...(argv ?? ["sh", "-c", 'exec "${SHELL:-/bin/sh}"'])]
}

export class HcAttachError extends Error {
  constructor(address: string, reason: string, readonly transcript: string) {
    super(`${address} has finished (${reason}); nothing to attach to`)
    this.name = "HcAttachError"
  }
}

/** idle and done both mean the turn is over; `error` needs a person, which Clankerhouse calls blocked. */
const agentStatusOf = (word: string | undefined): RuntimeAgentStatus => {
  if (word === "working" || word === "blocked" || word === "idle" || word === "done") return word
  return word === "error" ? "blocked" : "unknown"
}

const claimsFromLabels = (labels: Record<string, string>): ClaimMap => {
  const claims: ClaimMap = {}
  for (const [label, value] of Object.entries(labels)) {
    const key = claimKeyByLabel.get(label)
    if (key && value) claims[key] = value
  }
  return claims
}

const shownLabelsOf = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).filter(([label]) => label.startsWith(SHOWN_LABEL_PREFIX)))

const silentAtStartup = (terminal: HcTerminal, harness: string | undefined, now: number) =>
  !terminal.reported && Boolean(harness) && SELF_REPORTING_HARNESSES.has(harness!) && now - terminal.created_ms >= HC_STARTUP_SILENCE_MS

const agentStatusFor = (terminal: HcTerminal, harness: string | undefined, now: number): NonNullable<MultiplexerPane["agentStatus"]> => {
  if (silentAtStartup(terminal, harness, now)) return { agent: harness, status: "blocked", blockedKind: "startup", message: "no status since it started; a startup dialog may be waiting" }
  const status = terminal.status
  const agent = status?.app ? harnessOfApp[status.app] ?? status.app : undefined
  const mapped = agentStatusOf(status?.state)
  const blockedKind = mapped !== "blocked" ? undefined : status?.state === "error" ? "error" : status?.kind === "permission" || status?.kind === "question" || status?.kind === "auth" ? status.kind : undefined
  return { agent, status: mapped, ...(blockedKind ? { blockedKind } : {}), ...(status?.msg ? { message: status.msg } : {}) }
}

const pickClaims = (claims: ClaimMap, scope: "session" | "pane") => Object.fromEntries(Object.entries(claims).filter(([key]) => claimScopeOf(key as ClaimKey) === scope)) as ClaimMap

export class HcAdapter implements Multiplexer {
  readonly kind = "hc" as const
  readonly socketPath: string
  private readonly request: HcRequest
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: { socketPath?: string; request?: HcRequest; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.socketPath = options.socketPath ?? hcSocketPath()
    this.request = options.request ?? hcRequest(this.socketPath)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? Bun.sleep
  }

  capabilities(): MultiplexerCapabilities {
    return { processInfo: true, agentStatus: true, agentPrompt: true, sessionRefs: false, persistentLabels: true, durableIds: true, popup: false, worktrees: false, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }
  }

  paneAddressEnv() { return HC_PANE_ADDRESS_ENV }
  insideRuntime() { return Boolean(Bun.env.HC_TERMINAL_ID?.trim()) }

  async available() {
    try {
      const hello = await this.request("hello", { generation: HC_PROTOCOL_GENERATION })
      return hello.generation === HC_PROTOCOL_GENERATION
    } catch { return false }
  }

  /** `core.id` is kept in the state directory: it survives restarts and upgrades, and changes only when state is wiped. */
  async instanceId() { return `hc:${(await this.request("server.status")).core.id}` }

  async serverEpoch() {
    try { return `hc:${(await this.request("server.status")).pid}` } catch { return undefined }
  }

  private async terminals() { return (await this.request("terminal.list")).terminals as HcTerminal[] }

  /** One list call carries labels, status and foreground for every terminal. */
  private async sessionTerminals(sessionId: string) { return (await this.terminals()).filter((terminal) => (terminal.labels[SESSION_LABEL] ?? terminal.address) === sessionId) }

  /** No per-pane requests: `terminal.list` has everything, so the `processInfo` options change nothing here. */
  async observe(): Promise<MultiplexerSnapshot> {
    const [instanceId, terminals] = await Promise.all([this.instanceId(), this.terminals()])
    const now = this.now()
    const grouped = new Map<string, HcTerminal[]>()
    for (const terminal of terminals) {
      const id = terminal.labels[SESSION_LABEL] ?? terminal.address
      grouped.set(id, [...(grouped.get(id) ?? []), terminal])
    }
    const sessions = [...grouped].map(([id, members]): MultiplexerSession => {
      const claims = pickClaims(claimsFromLabels(members[0]!.labels), "session")
      const worktreePath = claims.worktreePath || ""
      const directoryPath = claims.directoryPath || ""
      const windows = members.map((terminal, index) => {
        const paneClaims = pickClaims(claimsFromLabels(terminal.labels), "pane")
        const foreground = terminal.foreground ?? undefined
        // hc reports no output activity; the last status change is the nearest fact, and herdr's pane revision has no twin.
        const activity = Math.floor((terminal.status_ms ?? terminal.created_ms) / 1000)
        const pane: MultiplexerPane = {
          id: terminal.address,
          index: "0",
          pid: terminal.pid ? String(terminal.pid) : "",
          command: (foreground?.name ?? terminal.argv[0] ?? "").toLowerCase(),
          title: terminal.title ?? "",
          currentPath: foreground?.cwd || terminal.cwd,
          activity,
          active: true,
          claims: paneClaims,
          terminalId: paneClaims.terminalId,
          displayName: terminal.labels[PANE_NAME_LABEL] || undefined,
          clankerId: paneClaims.clankerId,
          harness: paneClaims.harness,
          harnessSessionId: paneClaims.harnessSessionId,
          processInfo: { shellPid: terminal.pid ?? undefined, foregroundProcessGroupId: foreground?.pid, foregroundProcesses: foreground ? [foreground] : [] },
          agentStatus: agentStatusFor(terminal, paneClaims.harness, now),
        }
        return { id: terminal.address, index: String(index), nativeName: terminal.labels[WINDOW_NAME_LABEL] ?? "", active: index === 0, claims: {}, panes: [pane] }
      })
      return {
        id,
        nativeName: members[0]!.labels[SESSION_NAME_LABEL] ?? id,
        path: worktreePath || directoryPath || members[0]!.cwd,
        recency: Math.max(...windows.map((window) => window.panes[0]!.activity)),
        attached: false,
        worktreePath,
        directoryPath,
        claims,
        workshopId: claims.workshopId,
        parentWorkshopId: claims.workshopParentId || undefined,
        resourceId: claims.sessionId,
        displayName: members[0]!.labels[SESSION_NAME_LABEL] || undefined,
        shownLabels: shownLabelsOf(members[0]!.labels),
        windows,
      }
    })
    return { kind: "hc", instanceId, sessions }
  }

  /** Coarse classes only: consumers re-observe. A `missed` notice or a lost connection becomes `reconnect`. */
  async *changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> {
    const queue: MultiplexerChange[] = []
    let notify: (() => void) | undefined
    const push = (kind: MultiplexerChange["kind"]) => { queue.push({ kind, at: Date.now() }); notify?.() }
    const classes: Record<string, MultiplexerChange["kind"]> = { created: "topology", removed: "topology", finished: "topology", lost: "topology", restarted: "topology", status: "status", turn: "status", labels: "metadata", title: "metadata", foreground: "metadata" }
    let socket: ReturnType<typeof createConnection> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let backoffMs = 500
    const connect = () => {
      if (signal.aborted) return
      let buffer = ""
      socket = createConnection(this.socketPath)
      socket.setEncoding("utf8")
      socket.on("connect", () => { backoffMs = 500; socket!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: {} })}\n`); push("reconnect") })
      socket.on("data", (chunk) => {
        buffer += chunk
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          try {
            const message = JSON.parse(line) as { method?: string; params?: { type?: string } }
            if (message.method === "missed") push("reconnect")
            const kind = message.method === "event" ? classes[message.params?.type ?? ""] : undefined
            if (kind) push(kind)
          } catch {}
        }
      })
      socket.on("error", () => {})
      socket.on("close", () => {
        if (signal.aborted) return
        reconnect = setTimeout(connect, backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15_000)
      })
    }
    const wake = () => notify?.()
    signal.addEventListener("abort", wake)
    try {
      connect()
      while (!signal.aborted) {
        if (queue.length) { yield queue.shift()!; continue }
        await new Promise<void>((resolve) => { notify = resolve })
        notify = undefined
      }
    } finally {
      signal.removeEventListener("abort", wake)
      clearTimeout(reconnect)
      socket?.destroy()
    }
  }

  /** hc has no focus and no client notion, so the only location it can name is the terminal this process runs in. */
  async currentLocation(): Promise<CurrentLocation | undefined> {
    const address = Bun.env.HC_TERMINAL_ID?.trim()
    if (!address) return undefined
    const terminal = await this.request("terminal.get", { terminal: address }) as HcTerminal
    return { kind: "hc", instanceId: await this.instanceId(), nativeSessionId: terminal.labels[SESSION_LABEL] ?? address, nativeWindowId: address, nativePaneId: address }
  }

  /** Labels land atomically with the terminal, so a pane is never observable without its Claims. `no_parent` opts out of hc's parent cascade and notes. */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const sessionId = request.scope === "session" ? randomUUID() : request.nativeSessionId
    const inherited = request.scope === "window" ? (await this.sessionTerminals(sessionId))[0]?.labels ?? {} : {}
    const labels: Record<string, string> = { ...Object.fromEntries(Object.entries(inherited).filter(([label]) => claimScopeOf(claimKeyByLabel.get(label) ?? "terminalId") === "session")), [SESSION_LABEL]: sessionId }
    if (request.scope === "session") labels[SESSION_NAME_LABEL] = request.name
    const windowName = request.scope === "session" ? request.windowName : request.name
    if (windowName) labels[WINDOW_NAME_LABEL] = windowName
    const instance = Bun.env.CLANKERHOUSE_INSTANCE?.trim()
    const env = { CLANKERHOUSE_MULTIPLEXER: "hc", ...(instance ? { CLANKERHOUSE_INSTANCE: instance } : {}), ...request.env }
    const argv = scrubbedArgv(request.launch?.kind === "argv" ? request.launch.argv : undefined, env)
    const created = await this.request("terminal.run", { cwd: request.cwd, env, labels, argv, no_parent: true, no_notify: true }) as { address?: string; terminal?: HcTerminal }
    const address = (created.terminal?.address ?? created.address)!
    return { nativeSessionId: sessionId, nativeWindowId: address, nativePaneId: address }
  }

  async kill(location: NativeLocation) {
    const pane = location.nativePaneId ?? location.nativeWindowId
    const addresses = locationScope(location) === "session" ? (await this.sessionTerminals(location.nativeSessionId)).map((terminal) => terminal.address) : [pane!]
    for (const terminal of addresses) {
      try {
        await this.request("terminal.kill", { terminal })
        await this.request("terminal.rm", { terminal })
      } catch (error) { if (!/: not_found:/.test(String(error))) throw error }
    }
  }

  async rename(location: NativeLocation, name: string) {
    const scope = locationScope(location)
    if (scope === "session") return this.labelSession(location.nativeSessionId, { [SESSION_NAME_LABEL]: name })
    await this.request("terminal.label", { terminal: location.nativePaneId ?? location.nativeWindowId, labels: { [scope === "pane" ? PANE_NAME_LABEL : WINDOW_NAME_LABEL]: name } })
  }

  /**
   * hc has no focus and this process has no client to move, so the request is left for the launcher that owns the
   * operator's terminal: `bin/clankerhouse-hc` attaches to it when the picker exits.
   */
  async focus(location: NativeLocation) {
    const terminal = location.nativePaneId ?? location.nativeWindowId ?? (await this.sessionTerminals(location.nativeSessionId))[0]?.address
    if (!terminal) throw new UnsupportedMultiplexerOperation("hc", "focus on an empty session")
    const directory = runtimeDirFor()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(`${directory}/hc-attach.tmp`, `${terminal}\n`, { mode: 0o600 })
    renameSync(`${directory}/hc-attach.tmp`, `${directory}/hc-attach`)
  }

  /** `hc attach` on a finished terminal probes the operator's terminal before failing; answer here instead. */
  async attachTarget(address: string) {
    const terminal = await this.request("terminal.get", { terminal: address }) as HcTerminal
    if (terminal.state === "live") return terminal.address
    const read = await this.request("terminal.read", { terminal: address, lines: 40 })
    throw new HcAttachError(terminal.address, terminal.reason ?? `exit ${terminal.exit_code}`, String(read.text ?? ""))
  }

  /**
   * Stop the current turn. `hc interrupt` waits out its timeout on a program with no status, and one ESC only leaves
   * INSERT in vim-mode Claude, so the steps and the check are ours: a program with no status gets ctrl+c and no wait, a
   * reporting one gets up to two ESCs and each gets a short look at its status.
   */
  async interruptAgent(location: NativeLocation): Promise<AgentInterruptOutcome> {
    const address = location.nativePaneId ?? location.nativeWindowId
    if (!address) throw new Error("Agent interrupt requires a pane location")
    const status = async () => (await this.request("terminal.get", { terminal: address }) as HcTerminal).status?.state
    if (!(await this.request("terminal.get", { terminal: address }) as HcTerminal).reported) {
      await this.request("terminal.keys", { terminal: address, keys: ["ctrl+c"] })
      return "sent"
    }
    if (await status() !== "working") return "not_working"
    for (let press = 0; press < 2; press += 1) {
      await this.request("terminal.keys", { terminal: address, keys: ["esc"] })
      for (let waited = 0; waited < HC_INTERRUPT_STEP_MS; waited += 50) {
        if (await status() !== "working") return "stopped"
        await this.sleep(50)
      }
    }
    return "still_working"
  }

  async promptAgent(location: NativeLocation, text: string) {
    if (!location.nativePaneId) throw new Error("Agent prompt requires a pane location")
    await this.request("terminal.send", { terminal: location.nativePaneId, text })
  }

  private async labelSession(sessionId: string, labels: Record<string, string>) {
    for (const terminal of await this.sessionTerminals(sessionId)) await this.request("terminal.label", { terminal: terminal.address, labels })
  }

  async claim(location: NativeLocation, key: ClaimKey, value: string | null) {
    const label = labelNames[key]
    if (!label) return
    const scope = claimScopeOf(key)
    // An empty value removes a label.
    if (scope === "session") return this.labelSession(location.nativeSessionId, { [label]: value ?? "" })
    if (scope === "window") return
    if (!location.nativePaneId) throw new Error(`Claim ${key} requires a pane location`)
    await this.request("terminal.label", { terminal: location.nativePaneId, labels: { [label]: value ?? "" } })
  }

  async readClaim(location: NativeLocation, key: ClaimKey) {
    const label = labelNames[key]
    if (!label) return undefined
    const scope = claimScopeOf(key)
    if (scope === "window") return undefined
    if (scope === "pane") {
      if (!location.nativePaneId) return undefined
      return (await this.request("terminal.get", { terminal: location.nativePaneId }) as HcTerminal).labels[label] || undefined
    }
    return (await this.sessionTerminals(location.nativeSessionId))[0]?.labels[label] || undefined
  }

  /** Stored for `hc ls --label` and for `shownLabels`; hc has no sidebar to show them in. */
  async showLabels(location: NativeLocation, labels: Readonly<Record<string, string>>, shown: Readonly<Record<string, string>> | undefined) {
    const wanted = Object.fromEntries(Object.entries(labels).filter(([, value]) => value).map(([key, value]) => [`${SHOWN_LABEL_PREFIX}${key}`, value]))
    const patch = { ...Object.fromEntries(Object.keys(shown ?? {}).filter((label) => !(label in wanted)).map((label) => [label, ""])), ...Object.fromEntries(Object.entries(wanted).filter(([label, value]) => shown?.[label] !== value)) }
    if (!Object.keys(patch).length) return false
    await this.labelSession(location.nativeSessionId, patch)
    return true
  }

  /** hc has no notification surface, so delivery is the operator's: CLANKERHOUSE_NOTIFY_COMMAND runs with title and body. */
  async notify(notice: { title: string; body?: string }) {
    const command = Bun.env.CLANKERHOUSE_NOTIFY_COMMAND?.trim()
    if (!command) return false
    const child = Bun.spawn(["sh", "-c", `${command} "$@"`, "notify", notice.title, notice.body ?? ""], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    const timeout = setTimeout(() => child.kill(), HC_NOTIFY_TIMEOUT_MS)
    const exitCode = await child.exited
    clearTimeout(timeout)
    return exitCode === 0
  }
}

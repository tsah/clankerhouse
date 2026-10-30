/**
 * SPIKE, do not ship. herdr-core (`hc`) Multiplexer Adapter, to learn how the session/window/pane model and Claims map
 * onto hc's flat terminals. hc has no workspaces, tabs, or focus. Mapping: every terminal is one window with one pane
 * (window id = pane id = hc address), and a session is the set of terminals sharing the `ch_session` label. Session
 * Claims live on every terminal of the session, so a session ends with its last terminal, as a herdr workspace does.
 */
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { join } from "node:path"
import {
  claimScopeOf, locationScope,
  MultiplexerUnavailableError, UnsupportedMultiplexerOperation,
  type ClaimKey, type ClaimMap, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange,
  type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type RuntimeAgentStatus, type SpawnRequest, type SpawnResult,
} from "./interface"

export const HC_PROTOCOL_GENERATION = 1
export const HC_PANE_ADDRESS_ENV = "HC_TERMINAL_ID"
const SESSION_LABEL = "ch_session"
const SESSION_NAME_LABEL = "ch_session_name"
const WINDOW_NAME_LABEL = "ch_window_name"
const PANE_NAME_LABEL = "ch_pane_name"

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
  return join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, "herdr-core", `${env.HC_SESSION || "default"}.sock`)
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
interface HcTerminal { address: string; name?: string | null; argv: string[]; cwd: string; pid: number | null; state: "live" | "finished"; title?: string; created_ms: number; status_ms?: number | null; status?: { state: string; app?: string } | null; labels: Record<string, string>; foreground?: HcForeground | null }

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

const pickClaims = (claims: ClaimMap, scope: "session" | "pane") => Object.fromEntries(Object.entries(claims).filter(([key]) => claimScopeOf(key as ClaimKey) === scope)) as ClaimMap

export class HcAdapter implements Multiplexer {
  readonly kind = "hc" as const
  readonly socketPath: string
  private readonly request: HcRequest

  constructor(options: { socketPath?: string; request?: HcRequest } = {}) {
    this.socketPath = options.socketPath ?? hcSocketPath()
    this.request = options.request ?? hcRequest(this.socketPath)
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

  private async sessionTerminals(sessionId: string) { return (await this.terminals()).filter((terminal) => (terminal.labels[SESSION_LABEL] ?? terminal.address) === sessionId) }

  /** One list call carries labels, status and foreground for every terminal, so no per-pane requests and `processInfo` options are moot. */
  async observe(): Promise<MultiplexerSnapshot> {
    const [instanceId, terminals] = await Promise.all([this.instanceId(), this.terminals()])
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
          agentStatus: { agent: terminal.status?.app, status: agentStatusOf(terminal.status?.state) },
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
    const created = await this.request("terminal.run", { cwd: request.cwd, env: request.env ?? {}, labels, no_parent: true, no_notify: true, ...(request.launch?.kind === "argv" ? { argv: request.launch.argv } : {}) }) as { address?: string; terminal?: HcTerminal }
    const address = (created.terminal?.address ?? created.address)!
    return { nativeSessionId: sessionId, nativeWindowId: address, nativePaneId: address }
  }

  async kill(location: NativeLocation) {
    const pane = location.nativePaneId ?? location.nativeWindowId
    const addresses = locationScope(location) === "session" ? (await this.sessionTerminals(location.nativeSessionId)).map((terminal) => terminal.address) : [pane!]
    for (const terminal of addresses) {
      await this.request("terminal.kill", { terminal })
      await this.request("terminal.rm", { terminal })
    }
  }

  async rename(location: NativeLocation, name: string) {
    const scope = locationScope(location)
    if (scope === "session") return this.labelSession(location.nativeSessionId, { [SESSION_NAME_LABEL]: name })
    await this.request("terminal.label", { terminal: location.nativePaneId ?? location.nativeWindowId, labels: { [scope === "pane" ? PANE_NAME_LABEL : WINDOW_NAME_LABEL]: name } })
  }

  async focus(): Promise<void> { throw new UnsupportedMultiplexerOperation("hc", "focus") }

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

  /** hc has no notification surface. */
  async notify() { return false }
}

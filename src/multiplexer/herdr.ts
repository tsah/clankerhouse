/**
 * herdr Multiplexer Adapter. All herdr vocabulary (workspace, tab, pane, tokens, the
 * NDJSON socket) lives here. Mapping: workspace → session, tab → window, pane → pane.
 */
import { existsSync, statSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import {
  claimScopeOf, locationScope,
  MultiplexerResourceExhaustedError, MultiplexerUnavailableError,
  type ClaimKey, type ClaimMap, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange,
  type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type MultiplexerWindow, type NativeLocation, type ObserveOptions, type RuntimeAgentStatus, type SpawnRequest, type SpawnResult,
} from "./interface"

/** Oldest herdr socket protocol whose JSON API this Adapter uses; newer protocols are accepted because herdr keeps JSON methods compatible and clients ignore unknown fields. */
export const HERDR_MIN_PROTOCOL = 20
export const HERDR_PANE_ADDRESS_ENV = "HERDR_PANE_ID"
/** Most per-pane requests one observation keeps in flight. */
export const HERDR_PROCESS_INFO_CONCURRENCY = 8

/** Claim key → herdr token name (`^[A-Za-z0-9_-]{1,32}$`, values ≤ 80 chars). */
const tokenNames: Partial<Record<ClaimKey, string>> = {
  workshopId: "ch_workshop_id",
  workshopParentId: "ch_workshop_parent",
  worktreePath: "ch_worktree_path",
  directoryPath: "ch_directory_path",
  gitCommonDir: "ch_git_common_dir",
  sessionId: "ch_session_id",
  terminalId: "ch_terminal_id",
  clankerId: "ch_clanker_id",
  harness: "ch_harness",
  harnessSessionId: "ch_harness_session",
  recoveryAttemptId: "ch_recovery_attempt",
  clankerSocket: "ch_clanker_socket",
  clankerPid: "ch_clanker_pid",
  clankerCapabilities: "ch_clanker_caps",
}
const TOKEN_VALUE_LIMIT = 80
const pathLikeKeys = new Set<ClaimKey>(["worktreePath", "directoryPath", "gitCommonDir", "clankerSocket"])
const claimKeyByToken = new Map(Object.entries(tokenNames).map(([key, token]) => [token, key as ClaimKey]))

export const herdrSocketPath = (env: Record<string, string | undefined> = Bun.env) => {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || "", ".config")
  return env.HERDR_SESSION ? join(configHome, "herdr", "sessions", env.HERDR_SESSION, "herdr.sock") : join(configHome, "herdr", "herdr.sock")
}

export type HerdrRequest = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

interface HerdrError extends Error { code?: string }

// herdr reports its own EMFILE as an ordinary request error; these are the messages it uses.
const fdExhaustion = /os error 24|No file descriptors available|Too many open files|dup of fd \d+ failed|failed to openpty/i

const herdrError = (method: string, detail: string, code?: string): Error => {
  if (fdExhaustion.test(detail)) {
    return new MultiplexerResourceExhaustedError(`herdr ${method}: the herdr server ran out of file descriptors (${detail}). Close finished workspaces, or raise the server's open-file limit, e.g. prlimit --pid <herdr server pid> --nofile=65536:524288`)
  }
  const error: HerdrError = new Error(`herdr ${method}: ${detail}`)
  error.code = code
  return error
}

export const herdrRequest = (socketPath: string, timeoutMs = 10_000): HerdrRequest => (method, params = {}) => new Promise((resolveRequest, reject) => {
  const socket = createConnection(socketPath)
  let buffer = ""
  let settled = false
  const finish = (error?: Error, value?: Record<string, unknown>) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    if (error) reject(error)
    else resolveRequest(value!)
  }
  const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
  socket.setEncoding("utf8")
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: "1", method, params })}\n`))
  socket.on("data", (chunk) => {
    buffer += chunk
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    try {
      const payload = JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, unknown>; error?: { code?: string; message?: string } }
      if (payload.error) return finish(herdrError(method, payload.error.message || payload.error.code || "error", payload.error.code))
      finish(undefined, payload.result ?? {})
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
  socket.on("error", (error: NodeJS.ErrnoException) => finish(new MultiplexerUnavailableError("herdr", error.code === "ENOENT" || error.code === "ECONNREFUSED" ? `no server at ${socketPath}` : error.message)))
  socket.on("end", () => finish(new Error(`herdr ${method}: connection closed without a response`)))
})

interface HerdrWorkspace { workspace_id: string; number: number; label: string; focused: boolean; active_tab_id: string; agent_status: RuntimeAgentStatus; tokens?: Record<string, string>; worktree?: { repo_root?: string; checkout_path?: string } | null }
interface HerdrTab { tab_id: string; workspace_id: string; number: number; label: string; focused: boolean; agent_status: RuntimeAgentStatus }
interface HerdrPane { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; focused: boolean; cwd?: string | null; foreground_cwd?: string | null; label?: string | null; agent?: string | null; title?: string | null; terminal_title?: string | null; terminal_title_stripped?: string | null; agent_status: RuntimeAgentStatus; tokens?: Record<string, string>; agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string } | null; revision: number }
interface HerdrSnapshot { focused_workspace_id?: string | null; focused_tab_id?: string | null; focused_pane_id?: string | null; workspaces: HerdrWorkspace[]; tabs: HerdrTab[]; panes: HerdrPane[] }
interface HerdrProcessInfo { shell_pid?: number | null; foreground_process_group_id?: number | null; foreground_processes?: Array<{ pid: number; name?: string; argv?: string[]; cmdline?: string; cwd?: string }> }

const paneNumber = (paneId: string) => Number(paneId.split(":p")[1] ?? 0) || 0

const claimsFromTokens = (tokens: Record<string, string> | undefined): ClaimMap => {
  const claims: ClaimMap = {}
  for (const [token, value] of Object.entries(tokens ?? {})) {
    const key = claimKeyByToken.get(token)
    if (key && value) claims[key] = value
  }
  return claims
}

export class HerdrAdapter implements Multiplexer {
  readonly kind = "herdr" as const
  readonly socketPath: string
  private readonly request: HerdrRequest
  private readonly activity = new Map<string, number>()
  private readonly revisions = new Map<string, number>()
  private readonly source: string
  private readonly observing = new Map<"full" | "topology", Promise<MultiplexerSnapshot>>()
  private readonly nextObservation = new Map<"full" | "topology", Promise<MultiplexerSnapshot>>()

  constructor(options: { socketPath?: string; request?: HerdrRequest; source?: string } = {}) {
    this.socketPath = options.socketPath ?? herdrSocketPath()
    this.request = options.request ?? herdrRequest(this.socketPath)
    this.source = options.source ?? "clankerhouse"
  }

  capabilities(): MultiplexerCapabilities {
    return { processInfo: true, agentStatus: true, agentPrompt: true, sessionRefs: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }
  }

  paneAddressEnv() { return HERDR_PANE_ADDRESS_ENV }
  insideRuntime() { return Bun.env.HERDR_ENV?.trim() === "1" && Boolean(Bun.env.HERDR_PANE_ID?.trim()) }

  async available() {
    if (!existsSync(this.socketPath)) return false
    try {
      const pong = await this.request("ping")
      if (!(typeof pong.protocol === "number" && pong.protocol >= HERDR_MIN_PROTOCOL)) throw new MultiplexerUnavailableError("herdr", `protocol ${String(pong.protocol)} is older than the supported minimum ${HERDR_MIN_PROTOCOL}`)
      return true
    } catch (error) {
      if (error instanceof MultiplexerUnavailableError && /protocol/.test(error.message)) throw error
      return false
    }
  }

  async instanceId() { return `herdr:${this.socketPath}` }

  /** herdr reports no server pid or start time, but every server start binds its API socket afresh, so the socket file's identity marks the running server. */
  async serverEpoch() {
    if (!await this.available()) return undefined
    try {
      const socket = statSync(this.socketPath)
      return `herdr:${this.socketPath}:${socket.dev}:${socket.ino}:${Math.round(socket.ctimeMs)}`
    } catch { return undefined }
  }

  private touch(id: string, revision?: number) {
    const now = Math.floor(Date.now() / 1000)
    if (revision !== undefined) {
      const previous = this.revisions.get(id)
      if (previous !== undefined && previous !== revision) this.activity.set(id, now)
      this.revisions.set(id, revision)
    }
    if (!this.activity.has(id)) this.activity.set(id, now)
    return this.activity.get(id)!
  }

  private async snapshot(): Promise<HerdrSnapshot> {
    const result = await this.request("session.snapshot")
    return result.snapshot as HerdrSnapshot
  }

  /**
   * Callers that arrive while an observation of the same kind runs share the next one, which starts
   * after it finishes: each still sees topology from after its call, and a process never runs two at once.
   */
  observe(options: ObserveOptions = {}): Promise<MultiplexerSnapshot> {
    const mode = options.processInfo === false ? "topology" : "full"
    const observing = this.observing.get(mode)
    if (!observing) return this.startObservation(mode)
    let next = this.nextObservation.get(mode)
    if (!next) {
      next = observing.catch(() => undefined).then(() => {
        this.nextObservation.delete(mode)
        return this.startObservation(mode)
      })
      this.nextObservation.set(mode, next)
    }
    return next.then((snapshot) => structuredClone(snapshot))
  }

  private startObservation(mode: "full" | "topology") {
    const observation = this.observeOnce(mode === "full").finally(() => { if (this.observing.get(mode) === observation) this.observing.delete(mode) })
    this.observing.set(mode, observation)
    return observation
  }

  private async observeOnce(withProcessInfo: boolean): Promise<MultiplexerSnapshot> {
    const [instanceId, snapshot] = await Promise.all([this.instanceId(), this.snapshot()])
    const processInfo = new Map<string, HerdrProcessInfo>()
    // Process facts cost one request per pane, so callers that only need topology and claims skip them.
    // herdr takes one request per connection, and each open connection holds a server file descriptor.
    let next = 0
    if (withProcessInfo) await Promise.all(Array.from({ length: Math.min(HERDR_PROCESS_INFO_CONCURRENCY, snapshot.panes.length) }, async () => {
      while (next < snapshot.panes.length) {
        const pane = snapshot.panes[next++]!
        try {
          const info = await this.request("pane.process_info", { pane_id: pane.pane_id })
          processInfo.set(pane.pane_id, (info.process_info ?? {}) as HerdrProcessInfo)
        } catch {}
      }
    }))
    const sessions: MultiplexerSession[] = []
    for (const workspace of snapshot.workspaces) {
      const claims = claimsFromTokens(workspace.tokens)
      const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).sort((a, b) => a.number - b.number)
      const panes = snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id).sort((a, b) => paneNumber(a.pane_id) - paneNumber(b.pane_id))
      const rootCwd = panes[0]?.cwd || panes[0]?.foreground_cwd || ""
      const worktreePath = claims.worktreePath || workspace.worktree?.checkout_path || ""
      const directoryPath = claims.directoryPath || ""
      const path = worktreePath || directoryPath || rootCwd
      let recency = this.touch(workspace.workspace_id)
      const windows: MultiplexerWindow[] = tabs.map((tab) => {
        const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id)
        const mapped: MultiplexerPane[] = tabPanes.map((pane, index) => {
          const paneClaims = claimsFromTokens(pane.tokens)
          const info = processInfo.get(pane.pane_id)
          const foreground = info?.foreground_processes?.at(-1)
          const activity = this.touch(pane.pane_id, pane.revision)
          recency = Math.max(recency, activity)
          return {
            id: pane.pane_id,
            index: String(index),
            pid: info?.shell_pid ? String(info.shell_pid) : "",
            command: (foreground?.name ?? "").toLowerCase(),
            title: pane.terminal_title_stripped || pane.title || pane.terminal_title || "",
            currentPath: pane.foreground_cwd || pane.cwd || path,
            activity,
            active: pane.focused || (tabPanes.length === 1),
            focused: pane.focused,
            claims: paneClaims,
            terminalId: paneClaims.terminalId,
            displayName: pane.label || undefined,
            clankerId: paneClaims.clankerId,
            harness: paneClaims.harness,
            harnessSessionId: paneClaims.harnessSessionId,
            recoveryAttemptId: paneClaims.recoveryAttemptId,
            processInfo: info ? { shellPid: info.shell_pid ?? undefined, foregroundProcessGroupId: info.foreground_process_group_id ?? undefined, foregroundProcesses: (info.foreground_processes ?? []).map((process) => ({ pid: process.pid, name: process.name, argv: process.argv, cmdline: process.cmdline, cwd: process.cwd })) } : undefined,
            agentStatus: { agent: pane.agent ?? undefined, status: pane.agent_status },
            sessionRef: pane.agent_session ? { agent: pane.agent_session.agent, kind: pane.agent_session.kind, value: pane.agent_session.value, source: pane.agent_session.source } : undefined,
          }
        })
        return {
          id: tab.tab_id,
          index: String(tab.number),
          nativeName: tab.label,
          active: tab.tab_id === workspace.active_tab_id,
          claims: {},
          resourceId: undefined,
          displayName: undefined,
          panes: mapped,
        }
      })
      sessions.push({
        id: workspace.workspace_id,
        nativeName: workspace.label,
        path,
        recency,
        attached: workspace.focused,
        worktreePath,
        directoryPath,
        claims,
        workshopId: claims.workshopId,
        parentWorkshopId: claims.workshopParentId || undefined,
        resourceId: claims.sessionId,
        displayName: workspace.label || undefined,
        windows,
      })
    }
    return { kind: "herdr", instanceId, sessions }
  }

  async *changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> {
    const subscriptions = ["workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed", "workspace.closed", "workspace.focused", "worktree.created", "worktree.opened", "worktree.removed", "tab.created", "tab.closed", "tab.renamed", "tab.focused", "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected"].map((type) => ({ type }))
    let backoffMs = 500
    while (!signal.aborted) {
      const queue: MultiplexerChange[] = []
      let notify: (() => void) | undefined
      let closed = false
      const socket = createConnection(this.socketPath)
      let buffer = ""
      socket.setEncoding("utf8")
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: "changes", method: "events.subscribe", params: { subscriptions } })}\n`))
      socket.on("data", (chunk) => {
        buffer += chunk
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          try {
            const payload = JSON.parse(line) as { event?: string; result?: { type?: string }; error?: unknown }
            if (payload.error) { closed = true; socket.destroy(); break }
            if (payload.result?.type === "subscription_started") { backoffMs = 500; queue.push({ kind: "reconnect", at: Date.now() }) }
            else if (payload.event) {
              const event = payload.event
              const kind: MultiplexerChange["kind"] = /focused$/.test(event) ? "focus" : /metadata_updated$|renamed$|pane_updated$/.test(event) ? "metadata" : /agent_detected$/.test(event) ? "status" : "topology"
              const data = (payload as { data?: { pane?: { pane_id?: string; revision?: number }; pane_id?: string; workspace_id?: string } }).data
              const paneId = data?.pane?.pane_id ?? data?.pane_id
              const now = Math.floor(Date.now() / 1000)
              if (paneId) this.activity.set(paneId, now)
              if (data?.workspace_id) this.activity.set(data.workspace_id, now)
              queue.push({ kind, at: Date.now() })
            }
          } catch {}
          notify?.()
        }
      })
      const finish = () => { closed = true; notify?.() }
      socket.on("error", finish)
      socket.on("close", finish)
      const abort = () => { socket.destroy(); finish() }
      signal.addEventListener("abort", abort, { once: true })
      try {
        while (!closed || queue.length) {
          if (queue.length) { yield queue.shift()!; continue }
          await new Promise<void>((resolve) => { notify = resolve })
          notify = undefined
        }
      } finally {
        signal.removeEventListener("abort", abort)
        socket.destroy()
      }
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs)
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
      })
      backoffMs = Math.min(backoffMs * 2, 15_000)
    }
  }

  async currentLocation(): Promise<CurrentLocation | undefined> {
    const snapshot = await this.snapshot()
    if (!snapshot.focused_workspace_id) return undefined
    return { kind: "herdr", instanceId: await this.instanceId(), nativeSessionId: snapshot.focused_workspace_id, nativeWindowId: snapshot.focused_tab_id ?? null, nativePaneId: snapshot.focused_pane_id ?? null }
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const env = request.env ?? {}
    const argv = request.launch?.kind === "argv" ? request.launch.argv : undefined
    if (request.scope === "session") {
      const created = await this.request("workspace.create", { cwd: request.cwd, label: request.name, env, focus: false }) as { workspace: HerdrWorkspace; tab: HerdrTab; root_pane: HerdrPane }
      const workspaceId = created.workspace.workspace_id
      if (!argv) {
        if (request.windowName) await this.request("tab.rename", { tab_id: created.tab.tab_id, label: request.windowName })
        return { nativeSessionId: workspaceId, nativeWindowId: created.tab.tab_id, nativePaneId: created.root_pane.pane_id }
      }
      const applied = await this.request("layout.apply", { workspace_id: workspaceId, tab_label: request.windowName ?? "main", focus: false, root: { type: "pane", command: argv, cwd: request.cwd, env } }) as { layout: { tab_id: string; root: { pane_id?: string } } }
      await this.request("tab.close", { tab_id: created.tab.tab_id })
      return { nativeSessionId: workspaceId, nativeWindowId: applied.layout.tab_id, nativePaneId: applied.layout.root.pane_id ?? "" }
    }
    if (argv) {
      const applied = await this.request("layout.apply", { workspace_id: request.nativeSessionId, tab_label: request.name, focus: false, root: { type: "pane", command: argv, cwd: request.cwd, env } }) as { layout: { tab_id: string; root: { pane_id?: string } } }
      return { nativeSessionId: request.nativeSessionId, nativeWindowId: applied.layout.tab_id, nativePaneId: applied.layout.root.pane_id ?? "" }
    }
    const created = await this.request("tab.create", { workspace_id: request.nativeSessionId, cwd: request.cwd, label: request.name, env, focus: false }) as { tab: HerdrTab; root_pane: HerdrPane }
    return { nativeSessionId: request.nativeSessionId, nativeWindowId: created.tab.tab_id, nativePaneId: created.root_pane.pane_id }
  }

  async kill(location: NativeLocation) {
    const scope = locationScope(location)
    if (scope === "pane") await this.request("pane.close", { pane_id: location.nativePaneId })
    else if (scope === "window") await this.request("tab.close", { tab_id: location.nativeWindowId })
    else await this.request("workspace.close", { workspace_id: location.nativeSessionId })
  }

  async rename(location: NativeLocation, name: string) {
    const scope = locationScope(location)
    if (scope === "pane") await this.request("pane.rename", { pane_id: location.nativePaneId, label: name })
    else if (scope === "window") await this.request("tab.rename", { tab_id: location.nativeWindowId, label: name })
    else await this.request("workspace.rename", { workspace_id: location.nativeSessionId, label: name })
  }

  async focus(location: NativeLocation) {
    await this.request("workspace.focus", { workspace_id: location.nativeSessionId })
    if (location.nativeWindowId) await this.request("tab.focus", { tab_id: location.nativeWindowId })
    if (location.nativePaneId) await this.request("pane.focus", { pane_id: location.nativePaneId })
  }

  async promptAgent(location: NativeLocation, text: string) {
    if (!location.nativePaneId) throw new Error("Agent prompt requires a pane location")
    await this.request("agent.prompt", { target: location.nativePaneId, text })
  }

  async claim(location: NativeLocation, key: ClaimKey, value: string | null) {
    const scope = claimScopeOf(key)
    if (key === "sessionDisplayName") { if (value !== null) await this.rename({ nativeSessionId: location.nativeSessionId, nativeWindowId: null, nativePaneId: null }, value); return }
    if (key === "terminalDisplayName") { if (value !== null && location.nativePaneId) await this.rename(location, value); return }
    if (scope === "window") return
    const token = tokenNames[key]
    if (!token) return
    if (value !== null && value.length > TOKEN_VALUE_LIMIT) {
      if (pathLikeKeys.has(key)) return
      throw new Error(`Claim ${key} exceeds the ${TOKEN_VALUE_LIMIT}-character herdr token limit`)
    }
    if (scope === "pane") {
      if (!location.nativePaneId) throw new Error(`Claim ${key} requires a pane location`)
      await this.request("pane.report_metadata", { pane_id: location.nativePaneId, source: this.source, tokens: { [token]: value } })
      return
    }
    await this.request("workspace.report_metadata", { workspace_id: location.nativeSessionId, source: this.source, tokens: { [token]: value } })
  }

  async readClaim(location: NativeLocation, key: ClaimKey) {
    const scope = claimScopeOf(key)
    if (scope === "pane") {
      if (!location.nativePaneId) return undefined
      const info = await this.request("pane.get", { pane_id: location.nativePaneId }) as { pane: HerdrPane }
      if (key === "terminalDisplayName") return info.pane.label || undefined
      return claimsFromTokens(info.pane.tokens)[key]
    }
    if (scope === "window") return undefined
    const info = await this.request("workspace.get", { workspace_id: location.nativeSessionId }) as { workspace: HerdrWorkspace }
    if (key === "sessionDisplayName") return info.workspace.label || undefined
    return claimsFromTokens(info.workspace.tokens)[key]
  }

  /** Mirror an attested Clankerhouse lifecycle state into herdr so its own UI agrees. */
  async reportAgentState(paneId: string, harness: string, state: "idle" | "working" | "blocked" | "unknown", seq?: number, sessionId?: string) {
    await this.request("pane.report_agent", { pane_id: paneId, source: `${this.source}:${harness}`, agent: harness, state, ...(seq !== undefined ? { seq } : {}), ...(sessionId ? { agent_session_id: sessionId } : {}) })
  }
}

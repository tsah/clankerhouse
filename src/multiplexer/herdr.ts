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
/** How long a full observation reuses process facts for a pane that runs no harness. */
export const HERDR_PROCESS_INFO_TTL_MS = 10_000
/** Coalesces topology bursts before the agent-status subscription is re-established. */
export const HERDR_STATUS_RESUBSCRIBE_DELAY_MS = 250
/** A notification is a courtesy: the caller never waits on herdr longer than this. */
export const HERDR_NOTIFY_TIMEOUT_MS = 1_000
/** Events after which the set of agent panes may differ; herdr names pushed events with underscores (`pane_created`). */
const statusTopologyEvents = /^pane[._](created|closed|moved|exited|agent_detected)$|^(tab|workspace)[._]closed$/

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
  clankerSocket: "ch_clanker_socket",
  clankerPid: "ch_clanker_pid",
  clankerCapabilities: "ch_clanker_caps",
  // The Workshop parent again on every pane, because herdr agent views filter on pane tokens only.
  paneWorkshopParentId: "ch_pane_parent",
}
const TOKEN_VALUE_LIMIT = 80
const pathLikeKeys = new Set<ClaimKey>(["worktreePath", "directoryPath", "gitCommonDir", "clankerSocket"])
const claimKeyByToken = new Map(Object.entries(tokenNames).map(([key, token]) => [token, key as ClaimKey]))

/**
 * Workshop Labels as workspace tokens, for `$lbl_<key>` and `$labels` in Herdr's Space sidebar rows. One report may
 * mention 16 tokens and a workspace keeps 32, so at most 15 keys get their own token, beside `labels`, which holds
 * every visible value. A key too long for a token name has only the aggregate.
 */
export const HERDR_LABEL_TOKEN_PREFIX = "lbl_"
export const HERDR_LABELS_TOKEN = "labels"
export const HERDR_LABEL_TOKEN_LIMIT = 15
const tokenNamePattern = /^[A-Za-z0-9_-]{1,32}$/
const isLabelToken = (token: string) => token === HERDR_LABELS_TOKEN || token.startsWith(HERDR_LABEL_TOKEN_PREFIX)

export const herdrLabelTokens = (labels: Readonly<Record<string, string>>): Record<string, string> => {
  const entries = Object.entries(labels).toSorted(([left], [right]) => left.localeCompare(right))
  const tokens: Record<string, string> = {}
  for (const [key, value] of entries) {
    const token = `${HERDR_LABEL_TOKEN_PREFIX}${key}`
    if (Object.keys(tokens).length >= HERDR_LABEL_TOKEN_LIMIT) break
    if (tokenNamePattern.test(token) && value) tokens[token] = value.slice(0, TOKEN_VALUE_LIMIT)
  }
  const all = entries.map(([, value]) => value).filter(Boolean).join(" ").slice(0, TOKEN_VALUE_LIMIT).trim()
  if (all) tokens[HERDR_LABELS_TOKEN] = all
  return tokens
}

const labelTokensOf = (tokens: Record<string, string> | undefined) => Object.fromEntries(Object.entries(tokens ?? {}).filter(([token]) => isLabelToken(token)))

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
interface HerdrEventData { pane?: { pane_id?: string }; pane_id?: string; workspace_id?: string }
interface HerdrProcessInfo { shell_pid?: number | null; foreground_process_group_id?: number | null; foreground_processes?: Array<{ pid: number; name?: string; argv?: string[]; cmdline?: string; cwd?: string }> }

type ObserveMode = "full" | "harnesses" | "topology"
const runsHarness = (pane: HerdrPane) => Boolean(pane.agent || pane.tokens?.[tokenNames.harness!] || pane.tokens?.[tokenNames.clankerId!])

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
  /** A test's request function; otherwise quick calls open their own short-timeout connection. */
  private readonly injectedRequest?: HerdrRequest
  private readonly activity = new Map<string, number>()
  private readonly revisions = new Map<string, number>()
  private readonly source: string
  private readonly observing = new Map<ObserveMode, Promise<MultiplexerSnapshot>>()
  private readonly nextObservation = new Map<ObserveMode, Promise<MultiplexerSnapshot>>()
  private readonly processInfoCache = new Map<string, { at: number; info: HerdrProcessInfo }>()

  constructor(options: { socketPath?: string; request?: HerdrRequest; source?: string } = {}) {
    this.socketPath = options.socketPath ?? herdrSocketPath()
    this.request = options.request ?? herdrRequest(this.socketPath)
    this.injectedRequest = options.request
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
    const mode: ObserveMode = options.processInfo === false ? "topology" : options.processInfo === "harnesses" ? "harnesses" : "full"
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

  private startObservation(mode: ObserveMode) {
    const observation = this.observeOnce(mode).finally(() => { if (this.observing.get(mode) === observation) this.observing.delete(mode) })
    this.observing.set(mode, observation)
    return observation
  }

  /**
   * Process facts cost one request per pane, and herdr takes one request per connection, each holding a server file
   * descriptor. `session.snapshot` already carries each pane's agent and cwd, so harness panes are asked every time,
   * other panes only in full observations and at most once per TTL, and topology observations ask none.
   */
  private async observeOnce(mode: ObserveMode): Promise<MultiplexerSnapshot> {
    const [instanceId, snapshot] = await Promise.all([this.instanceId(), this.snapshot()])
    const processInfo = new Map<string, HerdrProcessInfo>()
    const now = Date.now()
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id))
    for (const paneId of this.processInfoCache.keys()) if (!live.has(paneId)) this.processInfoCache.delete(paneId)
    const wanted = mode === "topology" ? [] : snapshot.panes.filter((pane) => {
      if (runsHarness(pane)) return true
      if (mode === "harnesses") return false
      const cached = this.processInfoCache.get(pane.pane_id)
      if (cached && now - cached.at < HERDR_PROCESS_INFO_TTL_MS) { processInfo.set(pane.pane_id, cached.info); return false }
      return true
    })
    let next = 0
    await Promise.all(Array.from({ length: Math.min(HERDR_PROCESS_INFO_CONCURRENCY, wanted.length) }, async () => {
      while (next < wanted.length) {
        const pane = wanted[next++]!
        try {
          const info = (await this.request("pane.process_info", { pane_id: pane.pane_id })).process_info as HerdrProcessInfo ?? {}
          processInfo.set(pane.pane_id, info)
          this.processInfoCache.set(pane.pane_id, { at: Date.now(), info })
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
        shownLabels: labelTokensOf(workspace.tokens),
        windows,
      })
    }
    return { kind: "herdr", instanceId, sessions }
  }

  /** One `events.subscribe` connection; `end` runs once, with herdr's error when it rejected or dropped the subscription. */
  private subscribe(id: string, subscriptions: Array<Record<string, string>>, on: { started(): void; event(event: string, data: HerdrEventData | undefined): void; end(error?: { code?: string }): void }) {
    const socket = createConnection(this.socketPath)
    let buffer = ""
    let ended = false
    const end = (error?: { code?: string }) => {
      if (ended) return
      ended = true
      socket.destroy()
      on.end(error)
    }
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0 && !ended) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        let payload: { event?: string; data?: HerdrEventData; result?: { type?: string }; error?: { code?: string } }
        try { payload = JSON.parse(line) } catch { continue }
        if (payload.error) end(payload.error)
        else if (payload.result?.type === "subscription_started") on.started()
        else if (payload.event) on.event(payload.event, payload.data)
      }
    })
    socket.on("error", () => end())
    socket.on("close", () => end())
    return () => end()
  }

  private touchEvent(data: HerdrEventData | undefined) {
    const paneId = data?.pane?.pane_id ?? data?.pane_id
    const now = Math.floor(Date.now() / 1000)
    if (paneId) this.activity.set(paneId, now)
    if (data?.workspace_id) this.activity.set(data.workspace_id, now)
  }

  /**
   * herdr emits no `pane.updated` when a pane's agent status changes, and `pane.agent_status_changed` needs one
   * subscription entry per existing pane: one unknown pane rejects the whole request. Status therefore rides a second
   * connection, re-established for the current agent panes whenever topology may have changed them. A pane gains an
   * agent through `pane.agent_detected`, so only agent panes are subscribed, which bounds herdr's per-entry polling.
   */
  private statusSubscriptions(push: (kind: MultiplexerChange["kind"]) => void, signal: AbortSignal) {
    let current: object | undefined
    let subscribedKey: string | undefined
    let close = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let again = false
    let failures = 0
    const schedule = (delayMs = HERDR_STATUS_RESUBSCRIBE_DELAY_MS) => {
      if (signal.aborted || timer) return
      timer = setTimeout(() => { timer = undefined; void sync() }, delayMs)
    }
    const retry = () => schedule(Math.min(HERDR_STATUS_RESUBSCRIBE_DELAY_MS * 2 ** failures++, 15_000))
    const sync = async () => {
      if (running) { again = true; return }
      running = true
      try {
        const panes = (await this.snapshot()).panes.filter((pane) => pane.agent).map((pane) => pane.pane_id).sort()
        const key = panes.join(" ")
        if (signal.aborted || (current && key === subscribedKey)) return
        const previous = close
        current = undefined
        previous()
        if (!panes.length) return
        const token = {}
        current = token
        subscribedKey = key
        close = this.subscribe("status", panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })), {
          started: () => { failures = 0 },
          event: (_event, data) => { this.touchEvent(data); push("status") },
          end: (error) => {
            if (current !== token) return
            current = undefined
            if (signal.aborted) return
            // Lost history means statuses may have changed unseen; consumers re-observe on reconnect.
            if (error?.code === "events_lost") push("reconnect")
            retry()
          },
        })
      } catch { retry() } finally {
        running = false
        if (again) { again = false; schedule() }
      }
    }
    return { refresh: () => schedule(), stop: () => { clearTimeout(timer); current = undefined; close() } }
  }

  async *changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> {
    const subscriptions = ["workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed", "workspace.closed", "workspace.focused", "worktree.created", "worktree.opened", "worktree.removed", "tab.created", "tab.closed", "tab.renamed", "tab.focused", "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected"].map((type) => ({ type }))
    const queue: MultiplexerChange[] = []
    let notify: (() => void) | undefined
    const push = (kind: MultiplexerChange["kind"]) => { queue.push({ kind, at: Date.now() }); notify?.() }
    const statuses = this.statusSubscriptions(push, signal)
    let backoffMs = 500
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let closeTopology = () => {}
    const connect = () => {
      if (signal.aborted) return
      closeTopology = this.subscribe("changes", subscriptions, {
        started: () => { backoffMs = 500; push("reconnect"); statuses.refresh() },
        event: (event, data) => {
          this.touchEvent(data)
          push(/focused$/.test(event) ? "focus" : /metadata_updated$|renamed$|pane_updated$/.test(event) ? "metadata" : /agent_detected$/.test(event) ? "status" : "topology")
          if (statusTopologyEvents.test(event)) statuses.refresh()
        },
        end: () => {
          if (signal.aborted) return
          reconnect = setTimeout(connect, backoffMs)
          backoffMs = Math.min(backoffMs * 2, 15_000)
        },
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
      closeTopology()
      statuses.stop()
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

  /** Patches only the label tokens that differ from `shown`, clearing the ones no longer wanted, at most 16 per report. */
  async showLabels(location: NativeLocation, labels: Readonly<Record<string, string>>, shown: Readonly<Record<string, string>> | undefined) {
    const wanted = herdrLabelTokens(labels)
    const current = labelTokensOf(shown)
    const patch: Array<[string, string | null]> = [
      ...Object.entries(wanted).filter(([token, value]) => current[token] !== value),
      ...Object.keys(current).filter((token) => !(token in wanted)).map((token): [string, null] => [token, null]),
    ]
    for (let start = 0; start < patch.length; start += 16) {
      await this.request("workspace.report_metadata", { workspace_id: location.nativeSessionId, source: this.source, tokens: Object.fromEntries(patch.slice(start, start + 16)) })
    }
    return patch.length > 0
  }

  /**
   * `notification.show` with the request sound. herdr answers `shown: false` when toasts are off, no client is in
   * the foreground, or it is rate limited; none of that is an error here. A missing server answers at once.
   */
  async notify(notice: { title: string; body?: string }) {
    if (!this.injectedRequest && !existsSync(this.socketPath)) return false
    const request = this.injectedRequest ?? herdrRequest(this.socketPath, HERDR_NOTIFY_TIMEOUT_MS)
    const result = await request("notification.show", { title: notice.title, ...(notice.body ? { body: notice.body } : {}), sound: "request" })
    return result.shown === true
  }

  /** herdr's Agents view, owned by this source so clearing never removes another owner's view. */
  async showChildAgents(view: { parentWorkshopId: string; label: string } | null) {
    if (!view) {
      await this.request("agent.view.clear", { source: this.source })
      return
    }
    await this.request("agent.view.set", {
      source: this.source,
      label: view.label,
      filter: { op: "eq", field: { token: tokenNames.paneWorkshopParentId }, value: view.parentWorkshopId },
    })
  }

  /**
   * Hold the pane for `harness` with a lifecycle state, so herdr's sidebar, waits, notifications, and seen agree with
   * Clankerhouse. The agent keeps herdr's own name (`claude`, `pi`), which `agent.prompt` requires.
   */
  async reportAgentState(paneId: string, harness: string, state: "idle" | "working" | "blocked", sessionId?: string) {
    await this.request("pane.report_agent", { pane_id: paneId, source: `${this.source}:${harness}`, agent: harness, state, seq: nextHerdrReportSeq(), ...(sessionId ? { agent_session_id: sessionId } : {}) })
  }

  /** Give the pane back to herdr's own detection once the harness session has ended. */
  async releaseAgent(paneId: string, harness: string) {
    await this.request("pane.release_agent", { pane_id: paneId, source: `${this.source}:${harness}`, agent: harness, seq: nextHerdrReportSeq() })
  }
}

let lastReportSeq = 0
/**
 * herdr ignores a report whose `seq` is not above the last one it accepted from that source on that pane, including
 * after a daemon restart, and ignores a report with no `seq` once one had one. Every report from a `clankerhouse:*`
 * source takes its number here: microseconds since the epoch, kept strictly increasing within the process.
 */
export const nextHerdrReportSeq = () => (lastReportSeq = Math.max(lastReportSeq + 1, Date.now() * 1000))

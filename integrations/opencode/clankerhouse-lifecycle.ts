import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"

const pane = (process.env.CLANKERHOUSE_MULTIPLEXER === "hc" ? process.env.HC_TERMINAL_ID : process.env.HERDR_PANE_ID)?.trim() || ""
const clankersEnv = process.env
const clankersCli = process.env.CLANKERHOUSE_CLANKERS || "clankers"
const clankerId = process.env.CLANKER_ID?.trim() || ""
const expectedSessionId = process.env.CLANKER_SESSION_ID?.trim() || ""
const tracked = Boolean(clankerId)
let attestedSessionId = ""
let observedSessionId = ""
let generation = 0
let settledGeneration = 0
let currentState: ClankerState = "idle"
let reportSeq = Date.now() * 1000
let lastReportFingerprint = ""
let reportInFlight = false
let queuedReport: Record<string, unknown> | undefined

type ClankerState = "blocked" | "working" | "done" | "idle" | "unknown"

const requestedInstance = process.env.CLANKERHOUSE_INSTANCE?.trim() || ""
if (requestedInstance && (requestedInstance === "." || requestedInstance === ".." || !/^[A-Za-z0-9._-]+$/.test(requestedInstance))) throw new Error(`Invalid CLANKERHOUSE_INSTANCE: ${requestedInstance}`)
const instanceSlug = requestedInstance
  ? (requestedInstance === "default" ? "" : `-${requestedInstance}`)
  : "-herdr"
const runtime = `${process.env.XDG_RUNTIME_DIR || "/tmp"}/clankerhouse-${process.getuid?.() || 0}${instanceSlug}`
const reportPath = `${runtime}/clanker-state/${pane.replace(/[^A-Za-z0-9_.%-]/g, "_")}.json`
const daemonSocketPath = `${runtime}/daemon.sock`
const daemonAvailable = Boolean(pane && existsSync(daemonSocketPath))

/** Pane claims written through `clankers mux`. */
const claims = {
  read: (key: string) => pane ? spawnSync(clankersCli, ["mux", "read-claim", "--pane", pane, key], { env: clankersEnv, encoding: "utf8" }) : undefined,
  set: (key: string, value: string) => { if (pane) spawnSync(clankersCli, ["mux", "claim", "--pane", pane, key, value], { env: clankersEnv, encoding: "utf8" }) },
  unset: (key: string) => { if (pane) spawnSync(clankersCli, ["mux", "claim", "--pane", pane, key, "--unset"], { env: clankersEnv, encoding: "utf8" }) },
}

const attest = (sessionId: string) => {
  if (!tracked || !sessionId || attestedSessionId === sessionId) return
  if (attestedSessionId && attestedSessionId !== sessionId) return
  if (expectedSessionId && expectedSessionId !== sessionId) return
  claims.set("clankerId", clankerId)
  claims.set("harness", "opencode")
  claims.set("harnessSessionId", sessionId)
  attestedSessionId = sessionId
}

const trackedSession = (sessionId: string) => {
  if (expectedSessionId) attest(sessionId)
  return Boolean(pane && clankerId && sessionId && sessionId === attestedSessionId)
}

const currentSession = (sessionId: string) => tracked
  ? trackedSession(sessionId)
  : Boolean(pane && sessionId && sessionId === observedSessionId)

const writeLegacyReport = (record: Record<string, unknown>) => {
  try {
    const directory = `${runtime}/clanker-state`
    const temporary = `${reportPath}.tmp-${process.pid}`
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const runtimeStat = lstatSync(runtime)
    const directoryStat = lstatSync(directory)
    const uid = process.getuid?.()
    if (runtimeStat.isSymbolicLink() || directoryStat.isSymbolicLink() || !runtimeStat.isDirectory() || !directoryStat.isDirectory()) return
    if (uid !== undefined && (runtimeStat.uid !== uid || directoryStat.uid !== uid)) return
    chmodSync(directory, 0o700)
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, reportPath)
  } catch {}
}

const sendReport = (record: Record<string, unknown>) => new Promise<void>((resolve) => {
  const request = {
    version: 1,
    id: `opencode:${process.pid}:${record.seq}`,
    method: "observation.report",
    params: record,
  }
  const socket = createConnection(daemonSocketPath)
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    socket.destroy()
    resolve()
  }
  socket.setTimeout(500, finish)
  socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
  socket.once("data", finish)
  socket.once("error", finish)
  socket.once("end", finish)
  socket.once("close", finish)
})

const drainReports = async () => {
  if (reportInFlight) return
  reportInFlight = true
  try {
    while (queuedReport) {
      const next = queuedReport
      queuedReport = undefined
      await sendReport(next)
    }
  } finally {
    reportInFlight = false
    if (queuedReport) void drainReports()
  }
}

const report = (state: ClankerState, hookEvent: string) => {
  const harnessSessionId = tracked ? attestedSessionId : observedSessionId
  if (!pane || !harnessSessionId) return
  currentState = state
  const fingerprint = [state, harnessSessionId, clankerId, generation, settledGeneration].join("\0")
  if (fingerprint === lastReportFingerprint) return
  lastReportFingerprint = fingerprint
  reportSeq += 1
  const record = {
    source: `opencode:${process.pid}`,
    seq: reportSeq,
    harness: "opencode",
    ...(clankerId ? { clankerId } : {}),
    harnessSessionId,
    state,
    pane,
    generation,
    settledGeneration,
    updatedAt: Date.now(),
    hookEvent,
  }
  if (!daemonAvailable) return writeLegacyReport(record)
  queuedReport = record
  void drainReports()
}

const withdraw = () => {
  const currentId = claims.read("clankerId")?.stdout.trim()
  if (currentId !== clankerId) return
  for (const key of ["clankerId", "harness", "harnessSessionId"]) claims.unset(key)
}

if (expectedSessionId) try {
  const previous = JSON.parse(readFileSync(reportPath, "utf8")) as { clankerId?: string; harnessSessionId?: string; pane?: string; generation?: number; settledGeneration?: number; state?: ClankerState }
  if (previous.clankerId === clankerId && previous.harnessSessionId === expectedSessionId && previous.pane === pane) {
    generation = Math.max(0, Number(previous.generation) || 0)
    settledGeneration = Math.max(0, Number(previous.settledGeneration) || 0)
    if (["blocked", "working", "done", "idle", "unknown"].includes(previous.state || "")) currentState = previous.state!
  }
} catch {}

type LifecycleEvent = { type: string; properties?: Record<string, any>; data?: Record<string, any> }
type SessionInfo = { id: string; parentID?: string }
type SessionLookup = (sessionId: string) => Promise<SessionInfo | undefined>

export const handleLifecycleEvent = async (event: LifecycleEvent, lookupSession?: SessionLookup) => {
    const data = event.data ?? event.properties ?? {}
    const eventSessionId = data.sessionID
    if (!tracked && !observedSessionId && eventSessionId && lookupSession) {
      const info = await lookupSession(eventSessionId)
      if (info && !info.parentID) observedSessionId = info.id
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = data.info ?? data
      const sessionId = info.sessionID ?? info.id
      const firstObservation = !(tracked ? attestedSessionId : observedSessionId)
      if (!info.parentID) {
        if (tracked) attest(sessionId)
        else if (!observedSessionId) observedSessionId = sessionId
      }
      if (currentSession(sessionId) && firstObservation) report(currentState, event.type)
      return
    }
    const sessionId = data.sessionID
    if (event.type === "session.status" && currentSession(sessionId)) {
      if (data.status.type === "busy") {
        if (generation <= settledGeneration) generation = settledGeneration + 1
        report("working", event.type)
      } else if (data.status.type === "retry") report("blocked", event.type)
      else {
        settledGeneration = generation
        report(generation > 0 ? "done" : "idle", event.type)
      }
      return
    }
    if (event.type === "session.idle" && currentSession(sessionId)) {
      settledGeneration = generation
      report(generation > 0 ? "done" : "idle", event.type)
      return
    }
    if (["session.error", "session.execution.failed", "session.step.failed"].includes(event.type) && sessionId && currentSession(sessionId)) {
      report("blocked", event.type)
      return
    }
    if (["permission.updated", "permission.asked"].includes(event.type) && currentSession(sessionId)) {
      report("blocked", event.type)
      return
    }
    if (event.type === "permission.replied" && currentSession(sessionId)) {
      report("working", event.type)
      return
    }
    if (event.type === "question.asked" && sessionId && currentSession(sessionId)) {
      report("blocked", event.type)
      return
    }
    if (["question.replied", "question.rejected"].includes(event.type) && sessionId && currentSession(sessionId)) {
      report("working", event.type)
      return
    }
    const deletedSessionId = data.info?.id ?? data.sessionID
    if (event.type === "session.deleted" && deletedSessionId === (tracked ? attestedSessionId : observedSessionId)) {
      report("unknown", event.type)
      if (tracked) withdraw()
      attestedSessionId = ""
      observedSessionId = ""
    }
}

interface PluginContext {
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<LifecycleEvent> }
  session: { get(input: { sessionID: string }): Promise<SessionInfo> }
}

export const ClankerhouseLifecyclePlugin = {
  id: "clankerhouse.lifecycle",
  setup(context: PluginContext) {
    if (!pane) return () => {}
    const controller = new AbortController()
    const lookupSession: SessionLookup = async (sessionId) => context.session.get({ sessionID: sessionId }).catch(() => undefined)
    const task = (async () => {
      for await (const event of context.event.subscribe({ signal: controller.signal })) await handleLifecycleEvent(event, lookupSession)
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("Clankerhouse lifecycle event stream failed", error)
    })
    return async () => {
      controller.abort()
      await task
    }
  },
}

export default ClankerhouseLifecyclePlugin

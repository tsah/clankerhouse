import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { clankerHealth, type ClankerHealth } from "./clanker-health"
import type { ClankerState } from "./model"
import { openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import { paneLocation, type MultiplexerSnapshot } from "./multiplexer/interface"
import { OrchestrationStore, clankerBusy, generatedMessageId, readyForDelivery, sendStatusOf, withOrchestrationStore, type ClankerReportRecord, type PromptObservation, type SendStatus } from "./orchestration"
import { runtimeDirFor } from "./paths"
import { getHerd } from "./transport/client"

export type ClankerHarness = "pi" | "claude" | "opencode" | "codex" | string
export type ClankerDelivery = "steer" | "followUp"
export type ClankerDeliveryMode = ClankerDelivery | "queued"

export class ClankerApiError extends Error {
  constructor(public code: "NOT_FOUND" | "AMBIGUOUS" | "UNSUPPORTED" | "UNAVAILABLE" | "TIMEOUT", message: string, public exitCode: number) {
    super(message)
    this.name = "ClankerApiError"
  }
}

export interface ClankerResult {
  generation: number
  timestamp: number
  status: number
  stopReason: string
  errorMessage: string
  reply: string
}

export interface ClankerCapabilities {
  status: true
  wait: "reports" | false
  send: "unix-socket" | "multiplexer-prompt" | false
  /** `transcript`: read from the harness's own session transcript (Claude). */
  result: "reports" | "transcript" | false
  /** `clankers report` runs from any harness that can run a shell. */
  report: true
  deliveryModes: ClankerDeliveryMode[]
}

export interface ClankerInfo {
  id: string
  harness: ClankerHarness
  session: string
  sessionId: string
  window: string
  pane: string
  name: string
  cwd: string
  worktreePath: string
  state: ClankerState
  generation: number
  settledGeneration: number
  updatedAt: number
  /** Time of the newest lifecycle hook event, or null before the first report. */
  lastEventAt: number | null
  socketOnline: boolean
  capabilities: ClankerCapabilities
}

interface ClankerReport {
  harness?: unknown
  clankerId?: unknown
  pane?: unknown
  state?: unknown
  generation?: unknown
  settledGeneration?: unknown
  updatedAt?: unknown
  hookEvent?: unknown
  result?: unknown
  results?: unknown
  prompts?: unknown
  turns?: unknown
  transcriptPath?: unknown
}

interface ClankerRecord extends ClankerInfo {
  socketPath: string
  focused: boolean
  report?: ClankerReport
}

export interface SendReceipt {
  clankerId: string
  acceptedAt: number
  afterGeneration: number
  observedGeneration: number
  delivery: "immediate" | "queued" | ClankerDelivery
  messageId: string
}

const runtimeRoot = () => runtimeDirFor()
const safePane = (pane: string) => pane.replace(/[^A-Za-z0-9_.%-]/g, "_")
const reportPath = (pane: string) => `${runtimeRoot()}/clanker-state/${safePane(pane)}.json`
/** Written by the harness lifecycle wrapper when the harness ends, naming the clanker that ran there. */
const exitMarkPath = (pane: string) => `${runtimeRoot()}/clanker-state/${safePane(pane)}.exited`
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

export const generatedClankerId = () => `clanker-${randomUUID()}`

const number = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

const normalizedState = (value: unknown): ClankerState =>
  ["blocked", "working", "done", "idle", "unknown"].includes(String(value)) ? value as ClankerState : "unknown"

const terminalReport = (report: ClankerReport, state: ClankerState) => {
  if (number(report.settledGeneration) > 0) return true
  return report.generation === undefined && (state === "done" || report.hookEvent === "agent_settled")
}

/** The pane may outlive its harness, held open by a leftover child; the clanker is gone all the same. */
const harnessExited = (pane: string, id: string) => {
  try { return readFileSync(exitMarkPath(pane), "utf8").trim() === id }
  catch { return false }
}

const readReportSync = (pane: string): ClankerReport | undefined => {
  try { return JSON.parse(readFileSync(reportPath(pane), "utf8")) as ClankerReport }
  catch { return undefined }
}

const socketIsOnline = (path: string) => {
  if (!path) return false
  try {
    const stat = lstatSync(path)
    return stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid())
  } catch { return false }
}

const capabilitiesFor = (harness: ClankerHarness, online: boolean, agentPrompt: boolean): ClankerCapabilities => ({
  status: true,
  wait: harness === "opencode" ? false : "reports",
  send: harness === "pi" && online ? "unix-socket" : harness === "claude" && agentPrompt ? "multiplexer-prompt" : false,
  result: harness === "pi" ? "reports" : harness === "claude" ? "transcript" : false,
  report: true,
  deliveryModes: harness === "pi" ? ["steer", "followUp"] : harness === "claude" && agentPrompt ? ["queued", "followUp"] : [],
})

export interface PaneMetadata {
  harness: string
  id: string
  socketPath: string
  sessionId: string
  session: string
  window: string
  name: string
  pane: string
  cwd: string
  worktreePath: string
  focused?: boolean
}

/** Cross-process mutex for pane-id allocation, runtime-agnostic (atomic mkdir under the runtime dir). */
const withPaneLock = async <T>(pane: string, work: () => Promise<T>): Promise<T> => {
  const dir = `${runtimeRoot()}/locks`
  const lock = `${dir}/clanker-id-${safePane(pane)}.lock`
  let locked = false
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}
  for (let attempt = 0; attempt < 100 && !locked; attempt += 1) {
    try { mkdirSync(lock); locked = true }
    catch { await Bun.sleep(20) }
  }
  try { return await work() }
  finally { if (locked) { try { rmSync(lock, { recursive: true, force: true }) } catch {} } }
}

export async function ensurePaneClankerId(pane: string, preferredId?: string, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  const at = paneLocation("", null, pane)
  return withPaneLock(pane, async () => {
    const current = await multiplexer.readClaim(at, "clankerId")
    if (current) return current
    const candidate = preferredId || generatedClankerId()
    await multiplexer.claim(at, "clankerId", candidate)
    const stored = await multiplexer.readClaim(at, "clankerId")
    if (!stored) throw new Error(`${multiplexer.kind} did not retain a clanker id for pane ${pane}`)
    return stored
  })
}

/** Pane metadata rows of one Multiplexer observation (harness-bearing panes only). */
export const paneMetadataFromSnapshot = (snapshot: MultiplexerSnapshot): PaneMetadata[] =>
  snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.flatMap((pane) => {
    const claims = pane.claims ?? {}
    const harness = claims.harness || pane.harness || ""
    if (!harness) return []
    return [{
      harness,
      id: claims.clankerId || pane.clankerId || "",
      socketPath: claims.clankerSocket || "",
      sessionId: session.id,
      session: session.nativeName,
      window: window.id,
      name: window.nativeName,
      pane: pane.id,
      cwd: pane.currentPath,
      worktreePath: claims.worktreePath || session.worktreePath || "",
      focused: pane.focused === true,
    }]
  })))

/** Pane metadata rows discovered through the Multiplexer Interface. Clanker rows need no process facts. */
export const discoverPaneMetadata = async (multiplexer: ManagedMultiplexer): Promise<PaneMetadata[]> =>
  paneMetadataFromSnapshot(await multiplexer.observe({ processInfo: false }))

// The daemon observes on every Multiplexer change and at least every refresh interval, so an
// older herd means it is stuck and the caller observes for itself.
const DAEMON_HERD_MAX_AGE_MS = 60_000
const DAEMON_HERD_TIMEOUT_MS = 2_000

/**
 * The daemon's newest herd, or undefined when no daemon for this Multiplexer instance answers.
 * Polling callers read it so that many waiters cost the Multiplexer nothing.
 */
const daemonPaneMetadata = async (multiplexer: ManagedMultiplexer): Promise<PaneMetadata[] | undefined> => {
  const socketPath = `${runtimeRoot()}/daemon.sock`
  if (!existsSync(socketPath)) return undefined
  try {
    const [herd, instanceId] = await Promise.all([getHerd<PaneMetadata>(socketPath, { timeoutMs: DAEMON_HERD_TIMEOUT_MS }), multiplexer.instanceId()])
    if (herd.instanceId !== instanceId || Date.now() - herd.observedAt > DAEMON_HERD_MAX_AGE_MS || !Array.isArray(herd.panes)) return undefined
    return herd.panes
  } catch { return undefined }
}

/**
 * Where clanker rows come from. A caller that injects no Multiplexer reads the daemon's herd
 * when one answers; `multiplexer` observes directly, for a caller whose target the daemon has
 * not seen yet.
 */
type RecordSource = "daemon" | "multiplexer"

interface DiscoveredRecords { records: ClankerRecord[]; source: RecordSource }

const discoverRecordsFrom = async (injected: ManagedMultiplexer | undefined, strict: boolean, allowDaemon: boolean): Promise<DiscoveredRecords> => {
  const multiplexer = injected ?? openManagedMultiplexer()
  let rows: PaneMetadata[] | undefined = allowDaemon && !injected ? await daemonPaneMetadata(multiplexer) : undefined
  const source: RecordSource = rows ? "daemon" : "multiplexer"
  if (!rows) {
    try { rows = await discoverPaneMetadata(multiplexer) }
    catch (error) {
      if (strict) throw error
      return { records: [], source }
    }
  }
  const agentPrompt = multiplexer.capabilities().agentPrompt
  const records = await Promise.all(rows.map(async (row): Promise<ClankerRecord> => {
    const candidateReport = readReportSync(row.pane)
    const reportedId = typeof candidateReport?.clankerId === "string" && candidateReport.clankerId ? candidateReport.clankerId : undefined
    const id = row.id || await ensurePaneClankerId(row.pane, reportedId, multiplexer)
    const report = candidateReport
      && (!candidateReport.clankerId || candidateReport.clankerId === id)
      && (!candidateReport.pane || candidateReport.pane === row.pane)
      && (!candidateReport.harness || candidateReport.harness === row.harness)
      ? candidateReport
      : undefined
    const state = normalizedState(report?.state)
    const updatedAt = number(report?.updatedAt)
    const generation = report?.generation === undefined ? updatedAt : number(report.generation)
    const settledGeneration = number(report?.settledGeneration) || (terminalReport(report ?? {}, state) ? generation : 0)
    const online = socketIsOnline(row.socketPath)
    return {
      id,
      harness: row.harness,
      session: row.session,
      sessionId: row.sessionId,
      window: row.window,
      pane: row.pane,
      name: row.name,
      cwd: row.cwd,
      worktreePath: row.worktreePath,
      state,
      generation,
      settledGeneration,
      updatedAt,
      lastEventAt: updatedAt || null,
      socketOnline: online,
      capabilities: capabilitiesFor(row.harness, online, agentPrompt),
      socketPath: row.socketPath,
      focused: row.focused === true,
      report,
    }
  }))
  return { records: records.filter((record) => !harnessExited(record.pane, record.id)), source }
}

const discoverRecords = async (multiplexer?: ManagedMultiplexer, strict = false) =>
  (await discoverRecordsFrom(multiplexer, strict, true)).records

/** Records that satisfy `found`, observing the Multiplexer directly when the daemon's herd does not have them yet. */
const discoverRecordsWhere = async (multiplexer: ManagedMultiplexer | undefined, strict: boolean, found: (records: ClankerRecord[]) => boolean) => {
  const discovered = await discoverRecordsFrom(multiplexer, strict, true)
  if (discovered.source === "multiplexer" || found(discovered.records)) return discovered.records
  return (await discoverRecordsFrom(multiplexer, strict, false)).records
}

const publicInfo = ({ socketPath: _socketPath, focused: _focused, report: _report, ...clanker }: ClankerRecord): ClankerInfo => clanker

const canonicalFilterPath = (cwd: string) => {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" })
  return realpathSafe(git.exitCode === 0 ? git.stdout.toString().trim() : cwd)
}

/** `strict` reports an unreachable Multiplexer instead of an empty herd. */
export async function listClankers(options: { cwd?: string; multiplexer?: ManagedMultiplexer; strict?: boolean } = {}) {
  const records = await discoverRecords(options.multiplexer, options.strict)
  if (!options.cwd) return records.map(publicInfo)
  const cwd = canonicalFilterPath(options.cwd)
  return records.filter((clanker) => (clanker.worktreePath ? realpathSafe(clanker.worktreePath) : canonicalFilterPath(clanker.cwd)) === cwd).map(publicInfo)
}

const findRecord = async (id: string, multiplexer?: ManagedMultiplexer) => {
  const matches = (await discoverRecordsWhere(multiplexer, false, (records) => records.some((candidate) => candidate.id === id))).filter((candidate) => candidate.id === id)
  if (matches.length === 0) throw new ClankerApiError("NOT_FOUND", `Unknown clanker id: ${id}`, 3)
  if (matches.length > 1) throw new ClankerApiError("AMBIGUOUS", `Ambiguous clanker id ${id}; ${matches.length} live panes advertise it`, 3)
  return matches[0]!
}

export async function clankerForPane(pane: string) {
  const clanker = (await discoverRecordsWhere(undefined, false, (records) => records.some((candidate) => candidate.pane === pane))).find((candidate) => candidate.pane === pane)
  if (!clanker) throw new Error(`Pane ${pane} is not a discovered clanker`)
  return publicInfo(clanker)
}

export async function clankerStatus(id: string, multiplexer?: ManagedMultiplexer) {
  return publicInfo(await findRecord(id, multiplexer))
}

/** Lifecycle status plus the clanker's newest Report, a Declaration that never replaces `state`, and its scope's health. */
export async function clankerStatusWithReport(id: string, multiplexer?: ManagedMultiplexer): Promise<ClankerInfo & { lastReport: ClankerReportRecord | null; health: ClankerHealth }> {
  const status = await clankerStatus(id, multiplexer)
  return { ...status, lastReport: withOrchestrationStore((store) => store.lastReportFor(id)), health: clankerHealth(id) }
}

export async function clankerCapabilities(id: string) {
  const clanker = await findRecord(id)
  return { clankerId: clanker.id, harness: clanker.harness, capabilities: clanker.capabilities }
}

const unsupported = (clanker: ClankerRecord, capability: "send" | "result") => {
  const unavailable = clanker.harness === "pi" ? "the Pi native socket is unavailable" : `${clanker.harness} has no verified native transport`
  throw new ClankerApiError(clanker.harness === "pi" ? "UNAVAILABLE" : "UNSUPPORTED", `Clanker ${clanker.id} does not support ${capability}: ${unavailable}`, clanker.harness === "pi" ? 5 : 4)
}

export function requestUnixSocket(path: string, request: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(path)
    let response = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    timer = setTimeout(() => finishError(new Error(`Timed out contacting clanker socket after ${timeoutMs}ms`)), timeoutMs)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk) => {
      response += chunk
      if (response.length > 1024 * 1024) return finishError(new Error("Clanker socket response exceeded 1 MiB"))
      const newline = response.indexOf("\n")
      if (newline < 0) return
      try {
        const payload = JSON.parse(response.slice(0, newline)) as Record<string, unknown>
        if (payload.ok !== true) throw new Error(String(payload.error || "Clanker socket rejected the request"))
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.end()
        resolveRequest(payload)
      } catch (error) { finishError(error instanceof Error ? error : new Error(String(error))) }
    })
    socket.on("error", (error) => finishError(error))
    socket.on("end", () => { if (!settled) finishError(new Error("Clanker socket closed without a response")) })
  })
}

const promptObservations = (report: ClankerReport | undefined): PromptObservation[] =>
  Array.isArray(report?.prompts)
    ? report.prompts.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).sha256 === "string"
      ? [{ sha256: String((entry as Record<string, unknown>).sha256), generation: number((entry as Record<string, unknown>).generation) }]
      : [])
    : []

/** Submit through the Multiplexer prompt transport after revalidating the pane's Clanker claim (ADR-0007). */
const promptClaimedPane = async (multiplexer: ManagedMultiplexer, clanker: ClankerRecord, text: string) => {
  const location = paneLocation(clanker.sessionId, clanker.window || null, clanker.pane)
  try {
    const claimedId = await multiplexer.readClaim(location, "clankerId")
    if (claimedId !== clanker.id) throw new Error(`pane claim changed to ${claimedId || "none"}`)
    await multiplexer.promptAgent(location, text)
  } catch (error) {
    throw new ClankerApiError("UNAVAILABLE", `Clanker ${clanker.id} rejected the Multiplexer prompt: ${error instanceof Error ? error.message : String(error)}`, 5)
  }
}

export async function sendClanker(id: string, text: string, options: { delivery?: ClankerDelivery } = {}, multiplexer?: ManagedMultiplexer): Promise<SendReceipt> {
  const clanker = await findRecord(id, multiplexer)
  if (!text.trim()) throw new Error("Clanker message must not be empty")
  if (clanker.capabilities.send === "multiplexer-prompt") {
    // Follow-up is what the prompt transport already does: queue until the current turn ends.
    if (options.delivery === "steer") throw new ClankerApiError("UNSUPPORTED", `Clanker ${id} does not support ${options.delivery} delivery through the Multiplexer prompt transport`, 4)
    const acceptedAt = Date.now()
    const store = OrchestrationStore.open()
    try {
      store.acknowledge(id, promptObservations(clanker.report))
      const message = store.admitMessage({ clankerId: id, text, busy: clankerBusy(clanker), afterGeneration: clanker.generation, now: acceptedAt })
      const receipt = { clankerId: id, acceptedAt, afterGeneration: clanker.generation, observedGeneration: clanker.generation, messageId: message.messageId }
      if (message.state === "queued") return { ...receipt, delivery: "queued" }
      try { await promptClaimedPane(multiplexer ?? openManagedMultiplexer(), clanker, text) }
      catch (error) { store.deleteMessage(message.messageId); throw error }
      return { ...receipt, delivery: "immediate" }
    } finally { store.close() }
  }
  if (clanker.capabilities.send !== "unix-socket" || !clanker.socketPath) unsupported(clanker, "send")
  const payload = await requestUnixSocket(clanker.socketPath, { version: 1, action: "send", clankerId: id, text, delivery: options.delivery })
  const responseId = payload.clankerId
  if (responseId !== id) throw new ClankerApiError("UNAVAILABLE", `Clanker socket identity mismatch: expected ${id}, received ${String(responseId || "none")}`, 5)
  const delivery = payload.delivery === "steer" || payload.delivery === "followUp" ? payload.delivery : "immediate"
  const afterGeneration = number(payload.afterGeneration)
  // Pi's socket reply is the harness's own acknowledgement; it names no turn, so waits use afterGeneration.
  let messageId = generatedMessageId()
  try { messageId = withOrchestrationStore((store) => store.insertMessage({ messageId, clankerId: id, text, delivery, state: "acked", afterGeneration })).messageId }
  catch {}
  return {
    clankerId: id,
    acceptedAt: number(payload.acceptedAt),
    afterGeneration,
    observedGeneration: number(payload.observedGeneration),
    delivery,
    messageId,
  }
}

/**
 * Acknowledge delivered prompts from hook reports and hand the next queued message to each
 * settled, unfocused clanker. The daemon runs this continuously; waiting CLI commands run it
 * too, so queues drain without a daemon. The store's claim keeps deliveries one at a time.
 */
export async function deliverQueuedMessages(multiplexer?: ManagedMultiplexer) {
  const delivered: string[] = []
  const acked: string[] = []
  const failed: Array<{ messageId: string; error: string }> = []
  const store = OrchestrationStore.open()
  try {
    if (!store.hasPendingMessages()) return { delivered, acked, failed }
    const records = await discoverRecords(multiplexer, true)
    store.reconcileRecipients(new Set(records.map((record) => record.id)))
    for (const clankerId of new Set(store.pendingMessages().map((message) => message.clankerId))) {
      const matches = records.filter((record) => record.id === clankerId)
      if (matches.length !== 1) continue
      const clanker = matches[0]!
      acked.push(...store.acknowledge(clankerId, promptObservations(clanker.report)).map((message) => message.messageId))
      if (clanker.capabilities.send !== "multiplexer-prompt" || !readyForDelivery(clanker)) continue
      const claimed = store.claimNextDelivery(clankerId, clanker.generation)
      if (!claimed) continue
      try {
        await promptClaimedPane(multiplexer ?? openManagedMultiplexer(), clanker, claimed.text)
        delivered.push(claimed.messageId)
      } catch (error) {
        store.requeue(claimed.messageId)
        failed.push({ messageId: claimed.messageId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { delivered, acked, failed }
  } finally { store.close() }
}

const messageStatus = async (messageId: string, multiplexer: ManagedMultiplexer | undefined): Promise<{ status: SendStatus; record?: ClankerRecord; afterGeneration: number }> => {
  await deliverQueuedMessages(multiplexer).catch(() => undefined)
  const message = withOrchestrationStore((store) => store.message(messageId))
  if (!message) throw new ClankerApiError("NOT_FOUND", `Unknown message id: ${messageId}`, 3)
  // A clanker missing from the daemon's herd is checked against the Multiplexer before its message is called orphaned.
  const matches = (await discoverRecordsWhere(multiplexer, true, (records) => records.some((record) => record.id === message.clankerId))).filter((record) => record.id === message.clankerId)
  return { status: sendStatusOf(message, matches.length > 0), record: matches.length === 1 ? matches[0] : undefined, afterGeneration: message.afterGeneration }
}

export async function sendStatus(messageId: string, multiplexer?: ManagedMultiplexer): Promise<SendStatus> {
  return (await messageStatus(messageId, multiplexer)).status
}

// A wait starts polling at its pollMs and doubles toward this, so a short turn is noticed quickly
// and a long one costs little.
const MAX_POLL_MS = 2_000
const backedOff = (pollMs: number) => Math.max(pollMs, Math.min(pollMs * 2, MAX_POLL_MS))

export async function waitForClanker(id: string, options: { afterGeneration?: number; timeoutMs?: number; pollMs?: number } = {}, multiplexer?: ManagedMultiplexer) {
  const timeoutMs = options.timeoutMs ?? 600_000
  let pollMs = options.pollMs ?? 200
  const started = Date.now()
  const initial = await clankerStatus(id, multiplexer)
  if (!initial.capabilities.wait) throw new ClankerApiError("UNSUPPORTED", `Clanker ${id} does not support wait: ${initial.harness} has no lifecycle report producer`, 4)
  const targetGeneration = options.afterGeneration === undefined
    ? Math.max(initial.generation, initial.settledGeneration)
    : undefined
  while (true) {
    const status = await clankerStatus(id, multiplexer)
    const settled = options.afterGeneration === undefined
      ? status.settledGeneration >= targetGeneration! && status.generation <= status.settledGeneration
      : status.settledGeneration > options.afterGeneration
    if (settled) return status
    if (Date.now() - started >= timeoutMs) throw new ClankerApiError("TIMEOUT", `Timed out waiting for clanker ${id}; clanker remains available`, 124)
    await Bun.sleep(pollMs)
    pollMs = backedOff(pollMs)
  }
}

/**
 * Wait for the turn a message started to settle. A prompt-transport message first waits for
 * its hook acknowledgement, which names the generation it started; a Pi message, acknowledged
 * by its socket, settles past the generation it was sent after.
 */
export async function waitForMessage(id: string, messageId: string, options: { timeoutMs?: number; pollMs?: number } = {}, multiplexer?: ManagedMultiplexer) {
  const timeoutMs = options.timeoutMs ?? 600_000
  // Each poll may read the herd twice (delivery pass and status), so it starts slower than `wait`.
  let pollMs = options.pollMs ?? 500
  const started = Date.now()
  while (true) {
    const { status, record, afterGeneration } = await messageStatus(messageId, multiplexer)
    if (status.clankerId !== id) throw new ClankerApiError("NOT_FOUND", `Message ${messageId} was sent to ${status.clankerId}, not ${id}`, 3)
    if (status.state === "orphaned") throw new ClankerApiError("NOT_FOUND", `Clanker ${id} disappeared; message ${messageId} is orphaned and will not be delivered elsewhere`, 3)
    if (record && status.state === "acked") {
      const settled = status.startedGeneration === null ? record.settledGeneration > afterGeneration : record.settledGeneration >= status.startedGeneration
      if (settled) {
        return { ...publicInfo(record), lastReport: withOrchestrationStore((store) => store.lastReportFor(id)), message: status }
      }
    }
    if (Date.now() - started >= timeoutMs) throw new ClankerApiError("TIMEOUT", `Timed out waiting for message ${messageId} (${status.state}); clanker remains available`, 124)
    await Bun.sleep(pollMs)
    pollMs = backedOff(pollMs)
  }
}

const normalizeResult = (value: unknown): ClankerResult | undefined => {
  if (!value || typeof value !== "object") return undefined
  const result = value as Record<string, unknown>
  const generation = number(result.generation)
  if (!generation) return undefined
  return {
    generation,
    timestamp: number(result.timestamp),
    status: number(result.status),
    stopReason: String(result.stopReason || ""),
    errorMessage: String(result.errorMessage || ""),
    reply: String(result.reply || ""),
  }
}

interface TranscriptEntry {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { id?: string; stop_reason?: string | null; content?: unknown }
}

const transcriptText = (entry: TranscriptEntry) => Array.isArray(entry.message?.content)
  ? entry.message.content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n\n")
  : ""

/**
 * The final assistant message of each settled Claude turn, read from the session transcript.
 * The hook records each turn's start and settle times; the reply is the last text-bearing
 * assistant message written between them (one message may span several transcript lines).
 */
const claudeResults = (report: ClankerReport | undefined): ClankerResult[] => {
  const turns = (Array.isArray(report?.turns) ? report.turns as Array<Record<string, unknown>> : [])
    .map((turn) => ({ generation: number(turn?.generation), startedAt: number(turn?.startedAt), settledAt: number(turn?.settledAt) }))
    .filter((turn) => turn.generation > 0 && turn.settledAt > 0)
    .sort((a, b) => a.generation - b.generation)
  const path = typeof report?.transcriptPath === "string" ? report.transcriptPath : ""
  if (!turns.length || !path) return []
  let lines: string[]
  try { lines = readFileSync(path, "utf8").split("\n") }
  catch (error) { throw new ClankerApiError("UNAVAILABLE", `Claude transcript ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`, 5) }
  const assistant = lines.flatMap((line) => {
    if (!line.includes('"assistant"')) return []
    try {
      const entry = JSON.parse(line) as TranscriptEntry
      return entry.type === "assistant" && !entry.isSidechain ? [{ entry, at: Date.parse(entry.timestamp || "") || 0 }] : []
    } catch { return [] }
  })
  return turns.flatMap((turn, index) => {
    // A turn recorded before the hook kept start times begins where the previous one settled.
    const from = turn.startedAt || (index > 0 ? turns[index - 1]!.settledAt : 0)
    const window = assistant.filter(({ at }) => at > from && at <= turn.settledAt)
    const last = window.findLast(({ entry }) => transcriptText(entry))
    if (!last) return []
    const message = window.filter(({ entry }) => last.entry.message?.id ? entry.message?.id === last.entry.message.id : entry === last.entry)
    return [{
      generation: turn.generation,
      timestamp: last.at,
      status: 0,
      stopReason: String(message.findLast(({ entry }) => entry.message?.stop_reason)?.entry.message?.stop_reason || ""),
      errorMessage: "",
      reply: message.map(({ entry }) => transcriptText(entry)).filter(Boolean).join("\n\n"),
    }]
  })
}

export async function resultForClanker(id: string, generation?: number, multiplexer?: ManagedMultiplexer) {
  const clanker = await findRecord(id, multiplexer)
  if (clanker.capabilities.result === "transcript") return pickResult(id, claudeResults(clanker.report), generation)
  if (clanker.capabilities.result !== "reports") unsupported(clanker, "result")
  const report = clanker.report
  const results = Array.isArray(report?.results) ? report.results.map(normalizeResult).filter((result): result is ClankerResult => !!result) : []
  const latest = normalizeResult(report?.result)
  if (latest && !results.some((result) => result.generation === latest.generation)) results.push(latest)
  return pickResult(id, results, generation)
}

const pickResult = (id: string, results: ClankerResult[], generation?: number) => {
  const result = generation === undefined
    ? results.sort((a, b) => b.generation - a.generation)[0]
    : results.find((candidate) => candidate.generation === generation)
  if (!result) throw new Error(generation === undefined ? `Clanker ${id} has no settled result` : `Clanker ${id} has no result for generation ${generation}`)
  return { clankerId: id, ...result }
}

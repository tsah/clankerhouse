import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import type { ClankerState } from "./model"
import { parseTmuxFields, tmuxFields } from "./tmux-fields"

export type ClankerHarness = "pi" | "claude" | "opencode" | "codex" | string
export type ClankerDelivery = "steer" | "followUp"

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
  send: "unix-socket" | false
  result: "reports" | false
  deliveryModes: ClankerDelivery[]
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
}

interface ClankerRecord extends ClankerInfo {
  socketPath: string
  report?: ClankerReport
}

export interface SendReceipt {
  clankerId: string
  acceptedAt: number
  afterGeneration: number
  observedGeneration: number
  delivery: "immediate" | ClankerDelivery
}

const runtimeRoot = () => `${Bun.env.XDG_RUNTIME_DIR || "/tmp"}/clankerhouse-${process.getuid?.() || 0}`
const safePane = (pane: string) => pane.replace(/[^A-Za-z0-9_.%-]/g, "_")
const reportPath = (pane: string) => `${runtimeRoot()}/clanker-state/${safePane(pane)}.json`
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

async function command(argv: string[], allowFailure = false) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `${argv.join(" ")} exited ${code}`)
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

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

const capabilitiesFor = (harness: ClankerHarness, online: boolean): ClankerCapabilities => ({
  status: true,
  wait: harness === "opencode" ? false : "reports",
  send: harness === "pi" && online ? "unix-socket" : false,
  result: harness === "pi" ? "reports" : false,
  deliveryModes: harness === "pi" ? ["steer", "followUp"] : [],
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
}

export const parsePaneMetadata = (output: string): PaneMetadata[] => output.split("\n").filter(Boolean).map((line) => {
  const [harness = "", id = "", socketPath = "", sessionId = "", session = "", window = "", name = "", pane = "", cwd = "", worktreePath = ""] = parseTmuxFields(line)
  return { harness, id, socketPath, sessionId, session, window, name, pane, cwd, worktreePath }
}).filter((row) => row.harness && row.pane)

export async function ensurePaneClankerId(pane: string, preferredId?: string) {
  const lock = `clankerhouse-clanker-id-${safePane(pane)}`
  const locked = (await command(["tmux", "wait-for", "-L", lock], true)).code === 0
  try {
    const current = await command(["tmux", "show-option", "-p", "-qv", "-t", pane, "@clankerhouse_clanker_id"], true)
    if (current.stdout) return current.stdout
    const candidate = preferredId || generatedClankerId()
    await command(["tmux", "set-option", "-p", "-t", pane, "@clankerhouse_clanker_id", candidate])
    const stored = await command(["tmux", "show-option", "-p", "-qv", "-t", pane, "@clankerhouse_clanker_id"])
    if (!stored.stdout) throw new Error(`tmux did not retain a clanker id for pane ${pane}`)
    return stored.stdout
  } finally {
    if (locked) await command(["tmux", "wait-for", "-U", lock], true)
  }
}

const discoverRecords = async (): Promise<ClankerRecord[]> => {
  const format = tmuxFields(
    "#{@dotfiles_harness}", "#{@clankerhouse_clanker_id}", "#{@clankerhouse_clanker_socket}",
    "#{session_id}", "#{session_name}", "#{window_id}", "#{window_name}", "#{pane_id}",
    "#{pane_current_path}", "#{@dotfiles_worktree_path}",
  )
  const listed = await command(["tmux", "list-panes", "-a", "-F", format], true)
  if (listed.code !== 0 || !listed.stdout) return []
  const rows = parsePaneMetadata(listed.stdout)
  return Promise.all(rows.map(async (row) => {
    const candidateReport = readReportSync(row.pane)
    const reportedId = typeof candidateReport?.clankerId === "string" && candidateReport.clankerId ? candidateReport.clankerId : undefined
    const id = row.id || await ensurePaneClankerId(row.pane, reportedId)
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
      socketOnline: online,
      capabilities: capabilitiesFor(row.harness, online),
      socketPath: row.socketPath,
      report,
    }
  }))
}

const publicInfo = ({ socketPath: _socketPath, report: _report, ...clanker }: ClankerRecord): ClankerInfo => clanker

const canonicalFilterPath = (cwd: string) => {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" })
  return realpathSafe(git.exitCode === 0 ? git.stdout.toString().trim() : cwd)
}

export async function listClankers(options: { cwd?: string } = {}) {
  const records = await discoverRecords()
  if (!options.cwd) return records.map(publicInfo)
  const cwd = canonicalFilterPath(options.cwd)
  return records.filter((clanker) => (clanker.worktreePath ? realpathSafe(clanker.worktreePath) : canonicalFilterPath(clanker.cwd)) === cwd).map(publicInfo)
}

const findRecord = async (id: string) => {
  const matches = (await discoverRecords()).filter((candidate) => candidate.id === id)
  if (matches.length === 0) throw new ClankerApiError("NOT_FOUND", `Unknown clanker id: ${id}`, 3)
  if (matches.length > 1) throw new ClankerApiError("AMBIGUOUS", `Ambiguous clanker id ${id}; ${matches.length} live panes advertise it`, 3)
  return matches[0]!
}

export async function clankerForPane(pane: string) {
  const clanker = (await discoverRecords()).find((candidate) => candidate.pane === pane)
  if (!clanker) throw new Error(`Pane ${pane} is not a discovered clanker`)
  return publicInfo(clanker)
}

export async function clankerStatus(id: string) {
  return publicInfo(await findRecord(id))
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

export async function sendClanker(id: string, text: string, options: { delivery?: ClankerDelivery } = {}): Promise<SendReceipt> {
  const clanker = await findRecord(id)
  if (!text.trim()) throw new Error("Clanker message must not be empty")
  if (clanker.capabilities.send !== "unix-socket" || !clanker.socketPath) unsupported(clanker, "send")
  const payload = await requestUnixSocket(clanker.socketPath, { version: 1, action: "send", clankerId: id, text, delivery: options.delivery })
  const responseId = payload.clankerId
  if (responseId !== id) throw new ClankerApiError("UNAVAILABLE", `Clanker socket identity mismatch: expected ${id}, received ${String(responseId || "none")}`, 5)
  return {
    clankerId: id,
    acceptedAt: number(payload.acceptedAt),
    afterGeneration: number(payload.afterGeneration),
    observedGeneration: number(payload.observedGeneration),
    delivery: payload.delivery === "steer" || payload.delivery === "followUp" ? payload.delivery : "immediate",
  }
}

export async function waitForClanker(id: string, options: { afterGeneration?: number; timeoutMs?: number; pollMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 600_000
  const pollMs = options.pollMs ?? 200
  const started = Date.now()
  const initial = await clankerStatus(id)
  if (!initial.capabilities.wait) throw new ClankerApiError("UNSUPPORTED", `Clanker ${id} does not support wait: ${initial.harness} has no lifecycle report producer`, 4)
  const targetGeneration = options.afterGeneration === undefined
    ? Math.max(initial.generation, initial.settledGeneration)
    : undefined
  while (true) {
    const status = await clankerStatus(id)
    const settled = options.afterGeneration === undefined
      ? status.settledGeneration >= targetGeneration! && status.generation <= status.settledGeneration
      : status.settledGeneration > options.afterGeneration
    if (settled) return status
    if (Date.now() - started >= timeoutMs) throw new ClankerApiError("TIMEOUT", `Timed out waiting for clanker ${id}; clanker remains available`, 124)
    await Bun.sleep(pollMs)
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

export async function resultForClanker(id: string, generation?: number) {
  const clanker = await findRecord(id)
  if (clanker.capabilities.result !== "reports") unsupported(clanker, "result")
  const report = clanker.report
  const results = Array.isArray(report?.results) ? report.results.map(normalizeResult).filter((result): result is ClankerResult => !!result) : []
  const latest = normalizeResult(report?.result)
  if (latest && !results.some((result) => result.generation === latest.generation)) results.push(latest)
  const result = generation === undefined
    ? results.sort((a, b) => b.generation - a.generation)[0]
    : results.find((candidate) => candidate.generation === generation)
  if (!result) throw new Error(generation === undefined ? `Clanker ${id} has no settled result` : `Clanker ${id} has no result for generation ${generation}`)
  return { clankerId: id, ...result }
}

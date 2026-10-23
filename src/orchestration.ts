/**
 * Orchestration records: clanker Reports, queued Claude messages, and the watch cursor.
 *
 * A Report is a clanker's Declaration about its own work (question, blocked, done, failed,
 * working) addressed upward to its parent Workshop. It never overrides lifecycle state,
 * which stays an Observation from the harness (ADR-0004). Reports and messages live in one
 * small SQLite store under the instance state directory, so they survive daemon and host
 * restarts; Report `seq` is the store's monotonically increasing row id.
 */
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ClankerState } from "./model"
import { stateDirFor } from "./paths"

export const REPORT_STATES = ["question", "blocked", "done", "failed", "working"] as const
export type ReportState = typeof REPORT_STATES[number]
export const MAX_PAYLOAD_BYTES = 64 * 1024

export interface ClankerReportRecord {
  seq: number
  at: number
  clankerId: string
  workshopId: string | null
  to: string | null
  state: ReportState
  message: string | null
  payload: Record<string, unknown> | null
}

export type MessageState = "queued" | "delivered" | "acked" | "orphaned"
export type StoredMessageState = MessageState

/** A message whose recipient stays missing this long is orphaned for good and no longer waited for. */
export const ORPHAN_AFTER_MS = 30 * 60_000

export interface StoredMessage {
  messageId: string
  clankerId: string
  text: string
  sha256: string
  delivery: "immediate" | "queued" | "steer" | "followUp"
  state: StoredMessageState
  createdAt: number
  /** Clanker generation when the prompt was handed to the harness; an ack must be newer. */
  afterGeneration: number
  deliveredAt: number | null
  ackedAt: number | null
  startedGeneration: number | null
}

export const orchestrationStatePath = () => `${stateDirFor()}/orchestration.sqlite3`

export const generatedMessageId = () => `msg-${randomUUID()}`

/** Must match `prompt_sha256` in `native-client/src/bin/clankerhouse-hook.rs`. */
export const promptSha256 = (text: string) =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")).digest("hex")

export class ReportInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReportInputError"
  }
}

export const parseReportState = (value: string | undefined): ReportState => {
  if (!value) throw new ReportInputError(`--state is required: ${REPORT_STATES.join("|")}`)
  if (!(REPORT_STATES as readonly string[]).includes(value)) throw new ReportInputError(`--state must be one of ${REPORT_STATES.join("|")}`)
  return value as ReportState
}

/** A payload is one JSON object of at most 64 KiB. */
export const parseReportPayload = (text: string | undefined): Record<string, unknown> | null => {
  if (text === undefined || !text.trim()) return null
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) throw new ReportInputError(`Report payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch (error) { throw new ReportInputError(`Report payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReportInputError("Report payload must be a JSON object")
  return parsed as Record<string, unknown>
}

export interface ReportAddressInput {
  workshopId: string | null
  parentWorkshopId: string | null
  to?: string
  noParent?: boolean
}

/** Default addressee is the reporting Workshop's parent; `--to` overrides and `--no-parent` records without one. */
export const reportAddressee = (input: ReportAddressInput): string | null => {
  if (input.to !== undefined && input.noParent) throw new ReportInputError("--to and --no-parent are mutually exclusive")
  if (input.to !== undefined) return input.to
  if (input.noParent) return null
  return input.parentWorkshopId
}

interface ReportRow { seq: number; at: number; clanker_id: string; workshop_id: string | null; to_id: string | null; state: string; message: string | null; payload: string | null }
interface MessageRow { message_id: string; clanker_id: string; text: string; sha256: string; delivery: string; state: string; created_at: number; after_generation: number; delivered_at: number | null; acked_at: number | null; started_generation: number | null }

const reportFromRow = (row: ReportRow): ClankerReportRecord => ({
  seq: row.seq,
  at: row.at,
  clankerId: row.clanker_id,
  workshopId: row.workshop_id,
  to: row.to_id,
  state: row.state as ReportState,
  message: row.message,
  payload: row.payload === null ? null : JSON.parse(row.payload),
})

const messageFromRow = (row: MessageRow): StoredMessage => ({
  messageId: row.message_id,
  clankerId: row.clanker_id,
  text: row.text,
  sha256: row.sha256,
  delivery: row.delivery as StoredMessage["delivery"],
  state: row.state as StoredMessageState,
  createdAt: row.created_at,
  afterGeneration: row.after_generation,
  deliveredAt: row.delivered_at,
  ackedAt: row.acked_at,
  startedGeneration: row.started_generation,
})

export interface ReportFilter {
  clankerIds?: readonly string[]
  workshopIds?: readonly string[]
  to?: readonly string[]
}

/** A submitted prompt as the lifecycle hook recorded it in the pane report. */
export interface PromptObservation { sha256: string; generation: number }

export class OrchestrationStore {
  private constructor(readonly db: Database) {}

  static open(path = orchestrationStatePath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    db.exec("PRAGMA busy_timeout = 5000")
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null
    if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        clanker_id TEXT NOT NULL,
        workshop_id TEXT,
        to_id TEXT,
        state TEXT NOT NULL,
        message TEXT,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_clanker_idx ON reports(clanker_id, seq);
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        clanker_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        delivery TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        after_generation INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER,
        started_generation INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages(state, clanker_id, created_at);
    `)
    // When the recipient was first found missing; cleared when it is seen again.
    const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "missing_since")) db.exec("ALTER TABLE messages ADD COLUMN missing_since INTEGER")
    return new OrchestrationStore(db)
  }

  close() { this.db.close() }

  appendReport(input: Omit<ClankerReportRecord, "seq" | "at"> & { at?: number }): ClankerReportRecord {
    const at = input.at ?? Date.now()
    const row = this.db.query("INSERT INTO reports (at, clanker_id, workshop_id, to_id, state, message, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *")
      .get(at, input.clankerId, input.workshopId, input.to, input.state, input.message, input.payload === null ? null : JSON.stringify(input.payload)) as ReportRow
    return reportFromRow(row)
  }

  latestSeq() {
    return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM reports").get() as { seq: number }).seq
  }

  lastReportFor(clankerId: string): ClankerReportRecord | null {
    const row = this.db.query("SELECT * FROM reports WHERE clanker_id = ?1 ORDER BY seq DESC LIMIT 1").get(clankerId) as ReportRow | null
    return row ? reportFromRow(row) : null
  }

  /** Reports after `seq` matching any filter list, in order. */
  reportsAfter(seq: number, filter: ReportFilter): ClankerReportRecord[] {
    const clauses: string[] = []
    const values: string[] = []
    const add = (column: string, list: readonly string[] | undefined) => {
      if (!list?.length) return
      clauses.push(`${column} IN (${list.map(() => "?").join(", ")})`)
      values.push(...list)
    }
    add("clanker_id", filter.clankerIds)
    add("workshop_id", filter.workshopIds)
    add("to_id", filter.to)
    if (!clauses.length) return []
    const rows = this.db.query(`SELECT * FROM reports WHERE seq > ? AND (${clauses.join(" OR ")}) ORDER BY seq`).all(seq, ...values) as ReportRow[]
    return rows.map(reportFromRow)
  }

  insertMessage(input: { messageId?: string; clankerId: string; text: string; delivery: StoredMessage["delivery"]; state: StoredMessageState; afterGeneration: number; now?: number; startedGeneration?: number | null }): StoredMessage {
    const now = input.now ?? Date.now()
    const messageId = input.messageId ?? generatedMessageId()
    const row = this.db.query(`INSERT INTO messages (message_id, clanker_id, text, sha256, delivery, state, created_at, after_generation, delivered_at, acked_at, started_generation)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING *`)
      .get(messageId, input.clankerId, input.text, promptSha256(input.text), input.delivery, input.state, now, input.afterGeneration,
        input.state === "queued" ? null : now, input.state === "acked" ? now : null, input.startedGeneration ?? null) as MessageRow
    return messageFromRow(row)
  }

  /**
   * Record a message for a prompt-transport clanker: queued when the clanker is busy or
   * earlier messages still wait (so order holds), otherwise claimed for immediate delivery.
   * The check and the insert share one transaction so concurrent senders keep their order.
   */
  admitMessage(input: { clankerId: string; text: string; busy: boolean; afterGeneration: number; now?: number }): StoredMessage {
    return this.db.transaction(() => {
      const pending = this.pendingMessages(input.clankerId).length
      const queued = shouldQueue({ busy: input.busy, pending })
      return this.insertMessage({ clankerId: input.clankerId, text: input.text, delivery: queued ? "queued" : "immediate", state: queued ? "queued" : "delivered", afterGeneration: input.afterGeneration, now: input.now })
    }).immediate()
  }

  message(messageId: string): StoredMessage | undefined {
    const row = this.db.query("SELECT * FROM messages WHERE message_id = ?1").get(messageId) as MessageRow | null
    return row ? messageFromRow(row) : undefined
  }

  deleteMessage(messageId: string) { this.db.query("DELETE FROM messages WHERE message_id = ?1").run(messageId) }

  /** Messages not yet acknowledged, oldest first. */
  pendingMessages(clankerId?: string): StoredMessage[] {
    const rows = (clankerId
      ? this.db.query("SELECT * FROM messages WHERE state IN ('queued', 'delivered') AND clanker_id = ?1 ORDER BY created_at, rowid").all(clankerId)
      : this.db.query("SELECT * FROM messages WHERE state IN ('queued', 'delivered') ORDER BY created_at, rowid").all()) as MessageRow[]
    return rows.map(messageFromRow)
  }

  hasPendingMessages() {
    return !!this.db.query("SELECT 1 FROM messages WHERE state IN ('queued', 'delivered') LIMIT 1").get()
  }

  /**
   * Atomically claim the oldest queued message for delivery, unless one delivered message
   * still awaits its acknowledgement. Concurrent deliverers (daemon, waiting CLIs) cannot
   * both claim, because the check and the claim share one immediate transaction.
   */
  claimNextDelivery(clankerId: string, afterGeneration: number, now = Date.now()): StoredMessage | undefined {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM messages WHERE clanker_id = ?1 AND state = 'delivered' LIMIT 1").get(clankerId)) return undefined
      const row = this.db.query("SELECT * FROM messages WHERE clanker_id = ?1 AND state = 'queued' ORDER BY created_at, rowid LIMIT 1").get(clankerId) as MessageRow | null
      if (!row) return undefined
      this.db.query("UPDATE messages SET state = 'delivered', delivered_at = ?2, after_generation = ?3 WHERE message_id = ?1").run(row.message_id, now, afterGeneration)
      return messageFromRow({ ...row, state: "delivered", delivered_at: now, after_generation: afterGeneration })
    }).immediate()
  }

  /**
   * Track pending messages' recipients against a complete observation of the live clankers. A
   * recipient missing for `orphanAfterMs` orphans its pending messages; one seen again restarts
   * the clock, so a clanker that is resumed still gets its queue.
   */
  reconcileRecipients(present: ReadonlySet<string>, now = Date.now(), orphanAfterMs = ORPHAN_AFTER_MS): StoredMessage[] {
    return this.db.transaction(() => {
      const orphaned: StoredMessage[] = []
      const pending = this.db.query("SELECT * FROM messages WHERE state IN ('queued', 'delivered')").all() as Array<MessageRow & { missing_since: number | null }>
      for (const row of pending) {
        if (present.has(row.clanker_id)) {
          if (row.missing_since !== null) this.db.query("UPDATE messages SET missing_since = NULL WHERE message_id = ?1").run(row.message_id)
        } else if (row.missing_since === null) {
          this.db.query("UPDATE messages SET missing_since = ?2 WHERE message_id = ?1").run(row.message_id, now)
        } else if (now - row.missing_since >= orphanAfterMs) {
          this.db.query("UPDATE messages SET state = 'orphaned' WHERE message_id = ?1").run(row.message_id)
          orphaned.push({ ...messageFromRow(row), state: "orphaned" })
        }
      }
      return orphaned
    }).immediate()
  }

  /** Orphan every pending message to these clankers at once, because they were stopped on purpose. */
  orphanMessagesFor(clankerIds: readonly string[]): StoredMessage[] {
    if (!clankerIds.length) return []
    const rows = this.db.query(`UPDATE messages SET state = 'orphaned' WHERE state IN ('queued', 'delivered') AND clanker_id IN (${clankerIds.map(() => "?").join(", ")}) RETURNING *`).all(...clankerIds) as MessageRow[]
    return rows.map(messageFromRow)
  }

  /** Return a claimed message to the head of its queue after a failed hand-off. */
  requeue(messageId: string) {
    this.db.query("UPDATE messages SET state = 'queued', delivered_at = NULL WHERE message_id = ?1 AND state = 'delivered'").run(messageId)
  }

  /**
   * Acknowledge delivered messages whose hash the clanker's hook recorded in a newer turn.
   * Each observed prompt acknowledges at most one message.
   */
  acknowledge(clankerId: string, prompts: readonly PromptObservation[], now = Date.now()): StoredMessage[] {
    if (!prompts.length) return []
    return this.db.transaction(() => {
      const delivered = (this.db.query("SELECT * FROM messages WHERE clanker_id = ?1 AND state = 'delivered' ORDER BY delivered_at, rowid").all(clankerId) as MessageRow[]).map(messageFromRow)
      const used = new Set<number>()
      const acked: StoredMessage[] = []
      for (const message of delivered) {
        const index = prompts.findIndex((prompt, at) => !used.has(at) && prompt.sha256 === message.sha256 && prompt.generation > message.afterGeneration)
        if (index < 0) continue
        used.add(index)
        const startedGeneration = prompts[index]!.generation
        this.db.query("UPDATE messages SET state = 'acked', acked_at = ?2, started_generation = ?3 WHERE message_id = ?1").run(message.messageId, now, startedGeneration)
        acked.push({ ...message, state: "acked", ackedAt: now, startedGeneration })
      }
      return acked
    }).immediate()
  }
}

export const withOrchestrationStore = <T>(work: (store: OrchestrationStore) => T, path?: string): T => {
  const store = OrchestrationStore.open(path)
  try { return work(store) }
  finally { store.close() }
}

export interface SendStatus {
  messageId: string
  clankerId: string
  state: MessageState
  startedGeneration: number | null
}

/** Public delivery state: an unacknowledged message to a clanker that no longer exists is orphaned. */
export const sendStatusOf = (message: StoredMessage, clankerPresent: boolean): SendStatus => ({
  messageId: message.messageId,
  clankerId: message.clankerId,
  state: message.state !== "acked" && !clankerPresent ? "orphaned" : message.state,
  startedGeneration: message.startedGeneration,
})

/** The harness is mid-turn or waiting on a permission, or the operator's input focus is on its pane. */
export const clankerBusy = (input: { state: ClankerState; focused: boolean }) =>
  input.state === "working" || input.state === "blocked" || input.focused

/** Queue while the clanker is busy or earlier messages still wait. */
export const shouldQueue = (input: { busy: boolean; pending: number }) => input.busy || input.pending > 0

/** A queued message may be delivered once the clanker has settled and nobody is typing into it. */
export const readyForDelivery = (input: { state: ClankerState; focused: boolean }) =>
  (input.state === "done" || input.state === "idle") && !input.focused

// ---------------------------------------------------------------------------------------
// Watch: a pure event core over one poll's view, and a cursor that makes it resumable.

export type WatchEvent =
  | { type: "reported"; seq: number; at: number; clankerId: string; workshopId: string; to: string | null; state: ReportState; message: string | null; payload: object | null }
  | { type: "settled"; at: number; clankerId: string; workshopId: string; generation: number; state: ClankerState }
  | { type: "stale"; at: number; clankerId: string; workshopId: string; generation: number; lastEventAt: number }
  | { type: "exited"; at: number; clankerId: string; workshopId: string }
  | { type: "spawned"; at: number; clankerId: string; workshopId: string; parentWorkshopId: string | null }

/** `staleAt` is the `lastEventAt` the last `stale` fired for; cursors written before it existed omit it. */
export interface WatchCursorEntry { workshopId: string; settled: number; stale: number; staleAt?: number }
export interface WatchCursor { version: 1; seq: number; clankers: Record<string, WatchCursorEntry> }

export interface WatchedClanker {
  clankerId: string
  workshopId: string
  parentWorkshopId: string | null
  state: ClankerState
  generation: number
  settledGeneration: number
  lastEventAt: number
}

export interface WatchView {
  now: number
  clankers: readonly WatchedClanker[]
  /** Matching reports after the cursor's seq, in order. */
  reports: readonly ClankerReportRecord[]
  /** Newest report seq in the store; the cursor skips past unmatched reports. */
  latestSeq: number
}

export const DEFAULT_STALE_AFTER_MS = 1_800_000

/** Starting from "now": current generations, latest seq, nothing replayed. */
export const initialWatchCursor = (view: Pick<WatchView, "clankers" | "latestSeq">): WatchCursor => ({
  version: 1,
  seq: view.latestSeq,
  clankers: Object.fromEntries(view.clankers.map((clanker) => [clanker.clankerId, { workshopId: clanker.workshopId, settled: clanker.settledGeneration, stale: 0 }])),
})

export const computeWatchEvents = (cursor: WatchCursor, view: WatchView, options: { staleAfterMs?: number } = {}): WatchEvent[] => {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const events: WatchEvent[] = []
  for (const report of view.reports) {
    if (report.seq <= cursor.seq) continue
    events.push({ type: "reported", seq: report.seq, at: report.at, clankerId: report.clankerId, workshopId: report.workshopId ?? "", to: report.to, state: report.state, message: report.message, payload: report.payload })
  }
  const present = new Set<string>()
  for (const clanker of view.clankers) {
    present.add(clanker.clankerId)
    let entry = cursor.clankers[clanker.clankerId]
    if (!entry) {
      events.push({ type: "spawned", at: view.now, clankerId: clanker.clankerId, workshopId: clanker.workshopId, parentWorkshopId: clanker.parentWorkshopId })
      entry = { workshopId: clanker.workshopId, settled: 0, stale: 0 }
    }
    // A relaunched harness restarts its generations; its first settle is still news.
    const seenSettled = clanker.settledGeneration < entry.settled ? 0 : entry.settled
    if (clanker.settledGeneration > seenSettled) {
      events.push({ type: "settled", at: view.now, clankerId: clanker.clankerId, workshopId: clanker.workshopId, generation: clanker.settledGeneration, state: clanker.state })
    }
    // Once per silent stretch: any hook event after the last stale re-arms it, even within one generation.
    const staleSeen = entry.staleAt === undefined ? clanker.generation === entry.stale : clanker.lastEventAt <= entry.staleAt
    if (clanker.state === "working" && clanker.lastEventAt > 0 && view.now - clanker.lastEventAt > staleAfterMs && !staleSeen) {
      events.push({ type: "stale", at: view.now, clankerId: clanker.clankerId, workshopId: clanker.workshopId, generation: clanker.generation, lastEventAt: clanker.lastEventAt })
    }
  }
  for (const [clankerId, entry] of Object.entries(cursor.clankers)) {
    if (!present.has(clankerId)) events.push({ type: "exited", at: view.now, clankerId, workshopId: entry.workshopId })
  }
  return events
}

/** The cursor after one event has been emitted. */
export const advanceWatchCursor = (cursor: WatchCursor, event: WatchEvent): WatchCursor => {
  const clankers = { ...cursor.clankers }
  const entry = clankers[event.clankerId]
  switch (event.type) {
    case "reported": return { ...cursor, seq: Math.max(cursor.seq, event.seq) }
    case "spawned": clankers[event.clankerId] = { workshopId: event.workshopId, settled: 0, stale: 0 }; break
    case "settled": clankers[event.clankerId] = { ...(entry ?? { workshopId: event.workshopId, stale: 0 }), settled: event.generation }; break
    case "stale": clankers[event.clankerId] = { ...(entry ?? { workshopId: event.workshopId, settled: 0 }), stale: event.generation, staleAt: event.lastEventAt }; break
    case "exited": delete clankers[event.clankerId]; break
  }
  return { ...cursor, clankers }
}

/** After a poll's events are all recorded: skip unmatched reports and follow generation restarts. */
export const settleWatchCursor = (cursor: WatchCursor, view: WatchView): WatchCursor => {
  const clankers = { ...cursor.clankers }
  for (const clanker of view.clankers) {
    const entry = clankers[clanker.clankerId]
    if (entry && clanker.settledGeneration < entry.settled) clankers[clanker.clankerId] = { ...entry, settled: clanker.settledGeneration }
  }
  return { ...cursor, seq: Math.max(cursor.seq, view.latestSeq), clankers }
}

export const readWatchCursor = (path: string): WatchCursor | undefined => {
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WatchCursor>
  if (parsed.version !== 1 || typeof parsed.seq !== "number" || !parsed.clankers || typeof parsed.clankers !== "object") throw new Error(`Unrecognized watch cursor file: ${path}`)
  return parsed as WatchCursor
}

export const writeWatchCursor = (path: string, cursor: WatchCursor) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cursor)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

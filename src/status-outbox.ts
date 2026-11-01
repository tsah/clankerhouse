/**
 * The Status Event outbox: a durable spool of events and of each sink's delivery of them. An event
 * and the detection cursor that produced it commit together, so a daemon restart resumes exactly
 * where it stopped and pending deliveries simply continue. Delivery is at least once.
 */
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { stateDirFor } from "./paths"
import type { StatusCursor, StatusEvent } from "./status-events"

export const statusOutboxPath = () => `${stateDirFor()}/status-events.sqlite3`

export type DeliveryState = "pending" | "delivered" | "failed"

export interface DueDelivery { event: StatusEvent; sink: string; attempts: number }

export interface DeliveryRecord {
  eventId: string
  dedupeKey: string
  type: string
  at: number
  clankerId: string | null
  summary: string | null
  sink: string
  state: DeliveryState
  attempts: number
  nextAttemptAt: number | null
  lastAttemptAt: number | null
  lastStatus: number | null
  lastError: string | null
  deliveredAt: number | null
}

export interface SinkTotals { sink: string; pending: number; delivered: number; failed: number }

/** Finished events older than this are forgotten. */
const RETENTION_MS = 14 * 24 * 60 * 60_000
const CURSOR_KEY = "detection-cursor"

export class StatusOutbox {
  private constructor(private readonly db: Database) {}

  static open(path = statusOutboxPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    db.exec("PRAGMA busy_timeout = 5000")
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null
    if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        sink TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_attempt_at INTEGER,
        last_status INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        PRIMARY KEY (event_id, sink)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries(state, next_attempt_at);
    `)
    db.exec("PRAGMA foreign_keys = ON")
    if (existsSync(path)) chmodSync(path, 0o600)
    return new StatusOutbox(db)
  }

  close() { this.db.close() }

  cursor(): StatusCursor | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?1").get(CURSOR_KEY) as { value: string } | null
    return row ? JSON.parse(row.value) as StatusCursor : undefined
  }

  /** Forget the cursor, so that enabling hooks again starts from now rather than replaying the gap. */
  clearCursor() { this.db.query("DELETE FROM meta WHERE key = ?1").run(CURSOR_KEY) }

  /** Record events for the sinks each one matches, together with the cursor that follows them. */
  commit(cursor: StatusCursor, events: ReadonlyArray<{ event: StatusEvent; sinks: readonly string[] }>, now = Date.now()) {
    this.db.transaction(() => {
      this.db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CURSOR_KEY, JSON.stringify(cursor))
      for (const { event, sinks } of events) this.insert(event, sinks, now)
    }).immediate()
  }

  private insert(event: StatusEvent, sinks: readonly string[], now: number) {
    const inserted = this.db.query("INSERT OR IGNORE INTO events (event_id, dedupe_key, type, at, payload) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(event.id, event.dedupeKey, event.type, event.at, JSON.stringify(event))
    if (inserted.changes === 0) return false
    for (const sink of sinks) this.db.query("INSERT INTO deliveries (event_id, sink, state, next_attempt_at) VALUES (?1, ?2, 'pending', ?3)").run(event.id, sink, now)
    return true
  }

  /** An event sent once by hand: recorded for `clankers hooks status`, never retried. */
  recordOneShot(event: StatusEvent, sink: string, outcome: { ok: boolean; status?: number; error?: string }, now = Date.now()) {
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO events (event_id, dedupe_key, type, at, payload) VALUES (?1, ?2, ?3, ?4, ?5)").run(event.id, event.dedupeKey, event.type, event.at, JSON.stringify(event))
      this.db.query(`INSERT INTO deliveries (event_id, sink, state, attempts, last_attempt_at, last_status, last_error, delivered_at) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)`)
        .run(event.id, sink, outcome.ok ? "delivered" : "failed", now, outcome.status ?? null, outcome.error ?? null, outcome.ok ? now : null)
    }).immediate()
  }

  /** One sink's pending deliveries that are due, oldest first. */
  due(sink: string, now = Date.now(), limit = 50): DueDelivery[] {
    const rows = this.db.query(`SELECT d.sink, d.attempts, e.payload FROM deliveries d JOIN events e USING (event_id)
      WHERE d.sink = ?1 AND d.state = 'pending' AND d.next_attempt_at <= ?2 ORDER BY e.at, e.event_id LIMIT ?3`).all(sink, now, limit) as Array<{ sink: string; attempts: number; payload: string }>
    return rows.map((row) => ({ event: JSON.parse(row.payload) as StatusEvent, sink: row.sink, attempts: row.attempts }))
  }

  nextAttemptAt(sink: string): number | undefined {
    const row = this.db.query("SELECT MIN(next_attempt_at) AS at FROM deliveries WHERE sink = ?1 AND state = 'pending'").get(sink) as { at: number | null }
    return row.at ?? undefined
  }

  markDelivered(eventId: string, sink: string, status: number | undefined, now = Date.now()) {
    this.db.query(`UPDATE deliveries SET state = 'delivered', attempts = attempts + 1, last_attempt_at = ?3, last_status = ?4, last_error = NULL, delivered_at = ?3, next_attempt_at = NULL
      WHERE event_id = ?1 AND sink = ?2`).run(eventId, sink, now, status ?? null)
  }

  markRetry(eventId: string, sink: string, outcome: { status?: number; error: string }, nextAttemptAt: number, now = Date.now()) {
    this.db.query(`UPDATE deliveries SET attempts = attempts + 1, last_attempt_at = ?3, last_status = ?4, last_error = ?5, next_attempt_at = ?6
      WHERE event_id = ?1 AND sink = ?2`).run(eventId, sink, now, outcome.status ?? null, outcome.error, nextAttemptAt)
  }

  markFailed(eventId: string, sink: string, outcome: { status?: number; error: string }, now = Date.now()) {
    this.db.query(`UPDATE deliveries SET state = 'failed', attempts = attempts + 1, last_attempt_at = ?3, last_status = ?4, last_error = ?5, next_attempt_at = NULL
      WHERE event_id = ?1 AND sink = ?2`).run(eventId, sink, now, outcome.status ?? null, outcome.error)
  }

  /** A sink removed from the config can never drain; its deliveries stop counting as pending. */
  abandonRemovedSinks(configured: readonly string[], now = Date.now()) {
    const placeholders = configured.map(() => "?").join(", ")
    this.db.query(`UPDATE deliveries SET state = 'failed', last_error = 'sink removed from config', last_attempt_at = ?, next_attempt_at = NULL WHERE state = 'pending'${configured.length ? ` AND sink NOT IN (${placeholders})` : ""}`).run(now, ...configured)
  }

  /** Forget events with nothing left to deliver. */
  prune(now = Date.now()) {
    this.db.query("DELETE FROM events WHERE at < ?1 AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = events.event_id AND d.state = 'pending')").run(now - RETENTION_MS)
  }

  totals(): SinkTotals[] {
    return this.db.query(`SELECT sink,
      SUM(state = 'pending') AS pending, SUM(state = 'delivered') AS delivered, SUM(state = 'failed') AS failed
      FROM deliveries GROUP BY sink ORDER BY sink`).all() as SinkTotals[]
  }

  recent(limit = 20): DeliveryRecord[] {
    const rows = this.db.query(`SELECT d.*, e.dedupe_key, e.type, e.at, e.payload FROM deliveries d JOIN events e USING (event_id) ORDER BY COALESCE(d.last_attempt_at, e.at) DESC, e.at DESC LIMIT ?1`).all(limit) as Array<Record<string, unknown>>
    return rows.map((row) => {
      const event = JSON.parse(String(row.payload)) as StatusEvent
      return {
        eventId: String(row.event_id),
        dedupeKey: String(row.dedupe_key),
        type: String(row.type),
        at: Number(row.at),
        clankerId: event.clankerId,
        summary: event.summary,
        sink: String(row.sink),
        state: row.state as DeliveryState,
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at as number | null,
        lastAttemptAt: row.last_attempt_at as number | null,
        lastStatus: row.last_status as number | null,
        lastError: row.last_error as string | null,
        deliveredAt: row.delivered_at as number | null,
      }
    })
  }
}

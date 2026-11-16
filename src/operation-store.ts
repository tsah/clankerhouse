/**
 * Durable mutation operations: idempotency by key and staged checkpoints, so an interrupted mutation (such as a worktree
 * delete) resumes from its last completed stage. The only state the old unified registry held that is still truth.
 */
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDirFor } from "./paths"

export interface DurableOperationRecord {
  id: string
  idempotencyKey: string
  kind: string
  stage: string
  status: "pending" | "running" | "succeeded" | "failed"
  input: unknown
  result: unknown | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  attempts: number
}

export const operationStorePath = () => join(stateDirFor(), "operations.sqlite3")

const requiredText = (value: string, label: string) => {
  const text = value.trim()
  if (!text) throw new Error(`Missing ${label}`)
  return text
}

export class OperationStore {
  private constructor(private readonly db: Database, private readonly clock: () => number) {}

  static open(options: { dbPath?: string; now?: () => number } = {}) {
    const path = options.dbPath ?? operationStorePath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    try { chmodSync(path, 0o600) } catch {}
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(`CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      input TEXT NOT NULL CHECK (json_valid(input)),
      result TEXT CHECK (result IS NULL OR json_valid(result)),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
    )`)
    return new OperationStore(db, options.now ?? Date.now)
  }

  close() { this.db.close() }

  operation(id: string): DurableOperationRecord | undefined {
    const row = this.db.query("SELECT id, idempotency_key, kind, stage, status, input, result, error, created_at, updated_at, completed_at, attempts FROM operations WHERE id = ?1").get(id) as Record<string, unknown> | null
    if (!row) return undefined
    return {
      id: String(row.id), idempotencyKey: String(row.idempotency_key), kind: String(row.kind), stage: String(row.stage),
      status: row.status as DurableOperationRecord["status"], input: JSON.parse(String(row.input)), result: row.result === null ? null : JSON.parse(String(row.result)),
      error: row.error === null ? null : String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
      attempts: Number(row.attempts),
    }
  }

  beginOperation(idempotencyKeyValue: string, kindValue: string, input: unknown, options: { now?: number } = {}) {
    const idempotencyKey = requiredText(idempotencyKeyValue, "operation idempotency key")
    const kind = requiredText(kindValue, "operation kind")
    const serialized = JSON.stringify(input)
    if (serialized === undefined) throw new Error("Operation input must be JSON serializable")
    const existing = this.db.query("SELECT id, kind, input FROM operations WHERE idempotency_key = ?1").get(idempotencyKey) as { id: string; kind: string; input: string } | null
    if (existing) {
      if (existing.kind !== kind || existing.input !== serialized) throw new Error(`Idempotency key ${idempotencyKey} belongs to a different operation`)
      return this.operation(existing.id)!
    }
    const now = Math.trunc(options.now ?? this.clock())
    const id = randomUUID()
    this.db.query("INSERT INTO operations (id, idempotency_key, kind, stage, status, input, created_at, updated_at) VALUES (?1, ?2, ?3, 'registered', 'pending', ?4, ?5, ?5)")
      .run(id, idempotencyKey, kind, serialized, now)
    return this.operation(id)!
  }

  startOperation(id: string, options: { now?: number } = {}) {
    const now = Math.trunc(options.now ?? this.clock())
    return this.db.transaction(() => {
      const current = this.operation(id)
      if (!current) throw new Error(`Unknown operation ${id}`)
      if (current.status === "succeeded") return current
      this.db.query("UPDATE operations SET status = 'running', error = NULL, completed_at = NULL, attempts = attempts + 1, updated_at = ?2 WHERE id = ?1").run(id, now)
      return this.operation(id)!
    }).immediate()
  }

  resumableOperations(kindPrefix = "mutation.") {
    return (this.db.query("SELECT id FROM operations WHERE kind LIKE ?1 AND status IN ('pending', 'running') ORDER BY created_at, id").all(`${kindPrefix}%`) as Array<{ id: string }>).map((row) => this.operation(row.id)!)
  }

  advanceOperation(id: string, stageValue: string, status: DurableOperationRecord["status"], options: { expectedStage?: string; result?: unknown; error?: string | null; now?: number } = {}) {
    const stage = requiredText(stageValue, "operation stage")
    if (!["pending", "running", "succeeded", "failed"].includes(status)) throw new Error("Invalid operation status")
    const result = options.result === undefined ? undefined : JSON.stringify(options.result)
    const now = Math.trunc(options.now ?? this.clock())
    return this.db.transaction(() => {
      const current = this.operation(id)
      if (!current) throw new Error(`Unknown operation ${id}`)
      if (options.expectedStage !== undefined && current.stage !== options.expectedStage) throw new Error(`Operation ${id} stage mismatch`)
      if (current.status === "succeeded") {
        if (current.stage === stage && status === "succeeded" && (result === undefined || JSON.stringify(current.result) === result)) return current
        throw new Error(`Operation ${id} is already succeeded`)
      }
      this.db.query("UPDATE operations SET stage = ?2, status = ?3, result = COALESCE(?4, result), error = ?5, updated_at = ?6, completed_at = ?7 WHERE id = ?1")
        .run(id, stage, status, result ?? null, options.error ?? null, now, status === "succeeded" ? now : null)
      return this.operation(id)!
    }).immediate()
  }
}

export const openOperationStore = (options: { dbPath?: string; now?: () => number } = {}) => OperationStore.open(options)

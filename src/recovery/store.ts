import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  RECOVERY_POLICY,
  RECOVERY_SCHEMA_VERSION,
  leaseScopeKey,
  validateDesiredClankerInput,
  validateProcessIdentity,
  type DesiredClankerInput,
  type DesiredClankerRecord,
  type DesiredClankerState,
  type LeaseScope,
  type ProcessIdentity,
  type RecoveryAttempt,
  type RecoveryAttemptStatus,
  type RecoveryJournalEntry,
  type RecoveryLease,
  type RuntimeEpochs,
} from "./model"

export const recoveryStatePath = (stateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state")) =>
  join(stateHome, "clankerhouse", "recovery.sqlite3")

interface DesiredRow {
  clanker_id: string
  harness: DesiredClankerRecord["harness"]
  workshop_id: string
  workshop_path: string
  tmux_session_name: string
  tmux_window_name: string
  cwd: string
  harness_session_id: string | null
  launch_spec: string
  original_task: string
  policy_version: 1
  desired_state: DesiredClankerState
  revision: number
  created_at: number
  updated_at: number
}
interface LeaseRow {
  scope_key: string
  clanker_id: string | null
  owner_token: string
  boot_id: string
  pid: number
  process_start_ticks: number
  acquired_at: number
  renewed_at: number
  expires_at: number
}
interface AttemptRow {
  id: number
  clanker_id: string
  attempt_number: number
  trigger: string
  status: RecoveryAttemptStatus
  error: string | null
  started_at: number
  finished_at: number | null
}

const desiredColumns = "clanker_id, harness, workshop_id, workshop_path, tmux_session_name, tmux_window_name, cwd, harness_session_id, launch_spec, original_task, policy_version, desired_state, revision, created_at, updated_at"

const desiredFromRow = (row: DesiredRow): DesiredClankerRecord => ({
  clankerId: row.clanker_id,
  harness: row.harness,
  workshopId: row.workshop_id,
  workshopPath: row.workshop_path,
  tmuxSessionName: row.tmux_session_name,
  tmuxWindowName: row.tmux_window_name,
  cwd: row.cwd,
  harnessSessionId: row.harness_session_id,
  launchSpec: JSON.parse(row.launch_spec),
  originalTask: row.original_task,
  recoveryPolicyVersion: row.policy_version,
  desiredState: row.desired_state,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const scopeFromRow = (row: LeaseRow): LeaseScope => row.clanker_id === null ? { kind: "global" } : { kind: "clanker", clankerId: row.clanker_id }
const leaseFromRow = (row: LeaseRow): RecoveryLease => ({
  scope: scopeFromRow(row), ownerToken: row.owner_token, bootId: row.boot_id, pid: row.pid,
  processStartTicks: row.process_start_ticks, acquiredAt: row.acquired_at, renewedAt: row.renewed_at, expiresAt: row.expires_at,
})
const attemptFromRow = (row: AttemptRow): RecoveryAttempt => ({
  id: row.id, clankerId: row.clanker_id, attempt: row.attempt_number, trigger: row.trigger,
  status: row.status, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
})

const ensurePermissions = (dbPath: string) => {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(dbPath), 0o700)
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600)
}

const initialize = (db: Database) => {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
  if (current > RECOVERY_SCHEMA_VERSION) throw new Error(`Unsupported recovery store version ${current}`)
  if (current === RECOVERY_SCHEMA_VERSION) return
  if (current !== 0) throw new Error(`Unsupported recovery store version ${current}`)
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE desired_clankers (
      clanker_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude', 'opencode')),
      workshop_id TEXT NOT NULL,
      workshop_path TEXT NOT NULL,
      tmux_session_name TEXT NOT NULL,
      tmux_window_name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      harness_session_id TEXT,
      launch_spec TEXT NOT NULL,
      original_task TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK (policy_version = 1),
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'suspended_resource_pressure', 'tombstoned')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX desired_clankers_workshop_idx ON desired_clankers(workshop_id);
    CREATE INDEX desired_clankers_state_idx ON desired_clankers(desired_state);

    CREATE TABLE recovery_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clanker_id TEXT REFERENCES desired_clankers(clanker_id),
      event TEXT NOT NULL,
      revision INTEGER,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX recovery_journal_clanker_idx ON recovery_journal(clanker_id, id);
    CREATE TRIGGER recovery_journal_no_update BEFORE UPDATE ON recovery_journal BEGIN SELECT RAISE(ABORT, 'recovery journal is append-only'); END;
    CREATE TRIGGER recovery_journal_no_delete BEFORE DELETE ON recovery_journal BEGIN SELECT RAISE(ABORT, 'recovery journal is append-only'); END;

    CREATE TABLE recovery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clanker_id TEXT NOT NULL REFERENCES desired_clankers(clanker_id),
      attempt_number INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(clanker_id, attempt_number)
    );
    CREATE INDEX recovery_attempts_clanker_idx ON recovery_attempts(clanker_id, attempt_number);

    CREATE TABLE recovery_leases (
      scope_key TEXT PRIMARY KEY,
      clanker_id TEXT REFERENCES desired_clankers(clanker_id),
      owner_token TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_start_ticks INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      CHECK ((scope_key = 'global' AND clanker_id IS NULL) OR (scope_key = 'clanker:' || clanker_id AND clanker_id IS NOT NULL))
    );

    CREATE TABLE recovery_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

export interface OpenRecoveryStoreOptions { dbPath?: string; now?: () => number }
export interface AcquireLeaseInput extends ProcessIdentity { scope: LeaseScope; ownerToken: string; ttlMs: number; now?: number }
export interface LeaseOwnership extends ProcessIdentity { scope: LeaseScope; ownerToken: string }

export class RecoveryStore {
  readonly dbPath: string
  private readonly db: Database
  private readonly clock: () => number

  private constructor(dbPath: string, db: Database, clock: () => number) {
    this.dbPath = dbPath
    this.db = db
    this.clock = clock
  }

  static open(options: OpenRecoveryStoreOptions = {}) {
    const dbPath = options.dbPath ?? recoveryStatePath()
    ensurePermissions(dbPath)
    const previousUmask = process.umask(0o077)
    let db: Database
    try { db = new Database(dbPath, { create: true, strict: true }) }
    finally { process.umask(previousUmask) }
    try {
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("PRAGMA foreign_keys = ON")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = FULL")
      initialize(db)
      ensurePermissions(dbPath)
      return new RecoveryStore(dbPath, db, options.now ?? Date.now)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() {
    this.db.close()
    ensurePermissions(this.dbPath)
  }

  private now(value?: number) {
    const now = value ?? this.clock()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid timestamp")
    return now
  }

  private journal(clankerId: string | null, event: string, revision: number | null, payload: Record<string, unknown>, now: number) {
    this.db.query("INSERT INTO recovery_journal (clanker_id, event, revision, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(clankerId, event, revision, JSON.stringify(payload), now)
  }

  createDesired(input: DesiredClankerInput, options: { now?: number } = {}) {
    const desired = validateDesiredClankerInput(input)
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const existing = this.getDesired(desired.clankerId)
      if (existing) throw new Error(existing.desiredState === "tombstoned" ? `Clanker ${desired.clankerId} is tombstoned` : `Clanker ${desired.clankerId} already exists`)
      this.db.query(`INSERT INTO desired_clankers (${desiredColumns}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, 1, ?12, ?12)`)
        .run(desired.clankerId, desired.harness, desired.workshopId, desired.workshopPath, desired.tmuxSessionName, desired.tmuxWindowName, desired.cwd, desired.harnessSessionId, JSON.stringify(desired.launchSpec), desired.originalTask, desired.desiredState!, now)
      const record = this.getDesired(desired.clankerId)!
      this.journal(record.clankerId, "desired.created", record.revision, { desiredState: record.desiredState, harness: record.harness }, now)
      return record
    }).immediate()
  }

  getDesired(clankerId: string) {
    const row = this.db.query(`SELECT ${desiredColumns} FROM desired_clankers WHERE clanker_id = ?1`).get(clankerId) as DesiredRow | null
    return row ? desiredFromRow(row) : undefined
  }

  listDesired(options: { includeTombstoned?: boolean; workshopId?: string } = {}) {
    const rows = this.db.query(`SELECT ${desiredColumns} FROM desired_clankers WHERE (?1 = 1 OR desired_state != 'tombstoned') AND (?2 IS NULL OR workshop_id = ?2) ORDER BY created_at, clanker_id`)
      .all(options.includeTombstoned ? 1 : 0, options.workshopId ?? null) as DesiredRow[]
    return rows.map(desiredFromRow)
  }

  bindHarnessSession(clankerId: string, harnessSessionId: string, options: { expectedRevision?: number; now?: number } = {}) {
    if (!harnessSessionId || harnessSessionId.trim() !== harnessSessionId || /[\0\r\n]/.test(harnessSessionId)) throw new Error("Invalid harness session id")
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const current = this.getDesired(clankerId)
      if (!current) throw new Error(`Unknown clanker ${clankerId}`)
      if (current.desiredState === "tombstoned") throw new Error(`Clanker ${clankerId} is tombstoned`)
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) throw new Error(`Revision mismatch for clanker ${clankerId}`)
      if (current.harnessSessionId === harnessSessionId) return current
      if (current.harnessSessionId !== null) throw new Error(`Harness session mismatch for clanker ${clankerId}`)
      const revision = current.revision + 1
      this.db.query("UPDATE desired_clankers SET harness_session_id = ?2, revision = ?3, updated_at = ?4 WHERE clanker_id = ?1 AND harness_session_id IS NULL AND desired_state != 'tombstoned'")
        .run(clankerId, harnessSessionId, revision, now)
      this.journal(clankerId, "session.bound", revision, { harnessSessionId }, now)
      return this.getDesired(clankerId)!
    }).immediate()
  }

  setDesiredState(clankerId: string, desiredState: DesiredClankerState, options: { expectedRevision?: number; now?: number; reason?: string } = {}) {
    if (!["running", "stopped", "suspended_resource_pressure", "tombstoned"].includes(desiredState)) throw new Error("Invalid desired state")
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const current = this.getDesired(clankerId)
      if (!current) throw new Error(`Unknown clanker ${clankerId}`)
      if (current.desiredState === "tombstoned" && desiredState !== "tombstoned") throw new Error(`Clanker ${clankerId} is tombstoned`)
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) throw new Error(`Revision mismatch for clanker ${clankerId}`)
      if (current.desiredState === desiredState) return current
      const revision = current.revision + 1
      this.db.query("UPDATE desired_clankers SET desired_state = ?2, revision = ?3, updated_at = ?4 WHERE clanker_id = ?1").run(clankerId, desiredState, revision, now)
      this.journal(clankerId, desiredState === "tombstoned" ? "desired.tombstoned" : "desired.state_changed", revision, { from: current.desiredState, to: desiredState, ...(options.reason ? { reason: options.reason } : {}) }, now)
      return this.getDesired(clankerId)!
    }).immediate()
  }

  tombstone(clankerId: string, options: { expectedRevision?: number; now?: number; reason?: string } = {}) {
    return this.setDesiredState(clankerId, "tombstoned", options)
  }

  attestHarnessExit(clankerId: string, attemptId: number, options: { harnessSessionId: string; reason: string; now?: number }) {
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error("Invalid recovery attempt")
    if (!options.reason || options.reason.trim() !== options.reason || /[\0\r\n]/.test(options.reason)) throw new Error("Invalid harness exit reason")
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const current = this.getDesired(clankerId)
      if (!current) throw new Error(`Unknown clanker ${clankerId}`)
      const attempt = this.getAttempt(attemptId)
      if (!attempt || attempt.clankerId !== clankerId) throw new Error(`Recovery attempt ${attemptId} does not belong to ${clankerId}`)
      const latest = this.attemptsFor(clankerId).at(-1)
      if (!latest || latest.id !== attemptId) throw new Error(`Recovery attempt ${attemptId} is not latest for ${clankerId}`)
      if (attempt.status !== "succeeded") throw new Error(`Recovery attempt ${attemptId} is not succeeded`)
      if (!current.harnessSessionId) throw new Error(`Clanker ${clankerId} has no exact harness session id`)
      if (!options.harnessSessionId || current.harnessSessionId !== options.harnessSessionId) throw new Error(`Harness session mismatch for clanker ${clankerId}`)
      if (current.desiredState === "stopped") return current
      if (current.desiredState !== "running") return current
      const revision = current.revision + 1
      this.db.query("UPDATE desired_clankers SET desired_state = 'stopped', revision = ?2, updated_at = ?3 WHERE clanker_id = ?1 AND desired_state = 'running'")
        .run(clankerId, revision, now)
      this.journal(clankerId, "desired.exit_attested", revision, { from: "running", to: "stopped", attemptId, attempt: attempt.attempt, reason: options.reason }, now)
      return this.getDesired(clankerId)!
    }).immediate()
  }

  journalEntries(options: { clankerId?: string; afterId?: number; limit?: number } = {}) {
    const limit = options.limit ?? 1_000
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new Error("Invalid journal limit")
    const rows = this.db.query("SELECT id, clanker_id, event, revision, payload, created_at FROM recovery_journal WHERE (?1 IS NULL OR clanker_id = ?1) AND id > ?2 ORDER BY id LIMIT ?3")
      .all(options.clankerId ?? null, options.afterId ?? 0, limit) as Array<{ id: number; clanker_id: string | null; event: string; revision: number | null; payload: string; created_at: number }>
    return rows.map((row): RecoveryJournalEntry => ({ id: row.id, clankerId: row.clanker_id, event: row.event, revision: row.revision, payload: JSON.parse(row.payload), createdAt: row.created_at }))
  }

  beginAttempt(clankerId: string, trigger: string, options: { now?: number } = {}) {
    if (!trigger || trigger.trim() !== trigger) throw new Error("Invalid recovery trigger")
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const desired = this.getDesired(clankerId)
      if (!desired) throw new Error(`Unknown clanker ${clankerId}`)
      if (desired.desiredState === "tombstoned") throw new Error(`Clanker ${clankerId} is tombstoned`)
      const next = Number((this.db.query("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM recovery_attempts WHERE clanker_id = ?1").get(clankerId) as { next: number }).next)
      const result = this.db.query("INSERT INTO recovery_attempts (clanker_id, attempt_number, trigger, status, error, started_at, finished_at) VALUES (?1, ?2, ?3, 'running', NULL, ?4, NULL)").run(clankerId, next, trigger, now)
      this.journal(clankerId, "attempt.started", desired.revision, { attempt: next, trigger }, now)
      return this.getAttempt(Number(result.lastInsertRowid))!
    }).immediate()
  }

  finishAttempt(id: number, status: Exclude<RecoveryAttemptStatus, "running">, options: { error?: string | null; now?: number } = {}) {
    if (status !== "succeeded" && status !== "failed" && status !== "abandoned") throw new Error("Invalid attempt status")
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const current = this.getAttempt(id)
      if (!current) throw new Error(`Unknown recovery attempt ${id}`)
      if (current.status !== "running") {
        if (current.status === status && current.error === (options.error ?? null)) return current
        throw new Error(`Recovery attempt ${id} is already finished`)
      }
      this.db.query("UPDATE recovery_attempts SET status = ?2, error = ?3, finished_at = ?4 WHERE id = ?1 AND status = 'running'").run(id, status, options.error ?? null, now)
      this.journal(current.clankerId, "attempt.finished", this.getDesired(current.clankerId)?.revision ?? null, { attempt: current.attempt, status, ...(options.error ? { error: options.error } : {}) }, now)
      return this.getAttempt(id)!
    }).immediate()
  }

  getAttempt(id: number) {
    const row = this.db.query("SELECT id, clanker_id, attempt_number, trigger, status, error, started_at, finished_at FROM recovery_attempts WHERE id = ?1").get(id) as AttemptRow | null
    return row ? attemptFromRow(row) : undefined
  }

  attemptsFor(clankerId: string) {
    return (this.db.query("SELECT id, clanker_id, attempt_number, trigger, status, error, started_at, finished_at FROM recovery_attempts WHERE clanker_id = ?1 ORDER BY attempt_number").all(clankerId) as AttemptRow[]).map(attemptFromRow)
  }

  acquireLease(input: AcquireLeaseInput) {
    validateProcessIdentity(input)
    if (!input.ownerToken || input.ownerToken.trim() !== input.ownerToken) throw new Error("Invalid lease owner token")
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("Invalid lease ttl")
    const now = this.now(input.now)
    const expiresAt = now + input.ttlMs
    const key = leaseScopeKey(input.scope)
    return this.db.transaction(() => {
      if (input.scope.kind === "clanker" && !this.getDesired(input.scope.clankerId)) throw new Error(`Unknown clanker ${input.scope.clankerId}`)
      const existing = this.lease(input.scope)
      const owned = existing && existing.ownerToken === input.ownerToken && existing.bootId === input.bootId && existing.pid === input.pid && existing.processStartTicks === input.processStartTicks
      if (existing && existing.expiresAt > now && existing.bootId === input.bootId && !owned) return undefined
      const acquiredAt = owned ? existing.acquiredAt : now
      this.db.query(`INSERT INTO recovery_leases (scope_key, clanker_id, owner_token, boot_id, pid, process_start_ticks, acquired_at, renewed_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(scope_key) DO UPDATE SET clanker_id=excluded.clanker_id, owner_token=excluded.owner_token, boot_id=excluded.boot_id, pid=excluded.pid, process_start_ticks=excluded.process_start_ticks, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at, expires_at=excluded.expires_at`)
        .run(key, input.scope.kind === "clanker" ? input.scope.clankerId : null, input.ownerToken, input.bootId, input.pid, input.processStartTicks, acquiredAt, now, expiresAt)
      return this.lease(input.scope)!
    }).immediate()
  }

  lease(scope: LeaseScope) {
    const row = this.db.query("SELECT scope_key, clanker_id, owner_token, boot_id, pid, process_start_ticks, acquired_at, renewed_at, expires_at FROM recovery_leases WHERE scope_key = ?1").get(leaseScopeKey(scope)) as LeaseRow | null
    return row ? leaseFromRow(row) : undefined
  }

  renewLease(owner: LeaseOwnership, ttlMs: number, nowValue?: number) {
    validateProcessIdentity(owner)
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Invalid lease ttl")
    const now = this.now(nowValue)
    const result = this.db.query(`UPDATE recovery_leases SET renewed_at = ?6, expires_at = ?7
      WHERE scope_key = ?1 AND owner_token = ?2 AND boot_id = ?3 AND pid = ?4 AND process_start_ticks = ?5 AND expires_at > ?6`)
      .run(leaseScopeKey(owner.scope), owner.ownerToken, owner.bootId, owner.pid, owner.processStartTicks, now, now + ttlMs)
    return result.changes === 1 ? this.lease(owner.scope) : undefined
  }

  releaseLease(owner: LeaseOwnership) {
    validateProcessIdentity(owner)
    const result = this.db.query("DELETE FROM recovery_leases WHERE scope_key = ?1 AND owner_token = ?2 AND boot_id = ?3 AND pid = ?4 AND process_start_ticks = ?5")
      .run(leaseScopeKey(owner.scope), owner.ownerToken, owner.bootId, owner.pid, owner.processStartTicks)
    return result.changes === 1
  }

  getMetadata<T = unknown>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM recovery_metadata WHERE key = ?1").get(key) as { value: string } | null
    return row ? JSON.parse(row.value) as T : undefined
  }

  setMetadata(key: string, value: unknown, options: { now?: number } = {}) {
    if (!key || key.trim() !== key || key.length > 128) throw new Error("Invalid metadata key")
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error("Metadata must be JSON serializable")
    const now = this.now(options.now)
    this.db.query("INSERT INTO recovery_metadata (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, serialized, now)
  }

  observeBoot(bootId: string, options: { now?: number } = {}) {
    validateProcessIdentity({ bootId, pid: 1, processStartTicks: 0 })
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const epochs = this.runtimeEpochs()
      if (epochs.bootId !== bootId) {
        this.setMetadata("runtime.boot_id", bootId, { now })
        this.setMetadata("runtime.boot_epoch", epochs.bootEpoch + 1, { now })
        this.setMetadata("runtime.updated_at", now, { now })
      }
      return this.runtimeEpochs()
    }).immediate()
  }

  advanceTmuxEpoch(options: { now?: number } = {}) {
    const now = this.now(options.now)
    return this.db.transaction(() => {
      const epochs = this.runtimeEpochs()
      this.setMetadata("runtime.tmux_epoch", epochs.tmuxEpoch + 1, { now })
      this.setMetadata("runtime.updated_at", now, { now })
      return this.runtimeEpochs()
    }).immediate()
  }

  runtimeEpochs(): RuntimeEpochs {
    return {
      bootId: this.getMetadata<string>("runtime.boot_id") ?? null,
      bootEpoch: this.getMetadata<number>("runtime.boot_epoch") ?? 0,
      tmuxEpoch: this.getMetadata<number>("runtime.tmux_epoch") ?? 0,
      updatedAt: this.getMetadata<number>("runtime.updated_at") ?? null,
    }
  }
}

export const openRecoveryStore = (options: OpenRecoveryStoreOptions = {}) => RecoveryStore.open(options)
export { RECOVERY_POLICY }

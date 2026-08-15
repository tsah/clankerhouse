import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** The expanded, single durable registry described by ADR-0002. Legacy stores are import inputs only. */
export const REGISTRY_SCHEMA_VERSION = 2 as const

export const registryStatePath = (stateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state")) =>
  join(stateHome, "clankerhouse", "registry.sqlite3")

export interface LegacyRegistrySources {
  workshops?: string
  altKLineage?: string
  resources?: string
  recovery?: string
}

export interface ImportSummary {
  source: "workshops" | "alt-k-lineage" | "resources" | "recovery"
  schemaVersion: number
  operationId: string
  imported: number
  alreadyImported: boolean
}

export interface RegistryValidation {
  foreignKeyViolations: unknown[]
  semanticViolations: string[]
}

export interface RegistryWorkshopRecord {
  workshopId: string
  repoId: string
  canonicalPath: string
  commonDir: string
  branch: string
  parentWorkshopId: string | null
  revision: number
  createdAt: number
  updatedAt: number
}

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

export interface RegistryLeaseInput {
  scopeKey: string
  clankerId?: string | null
  ownerToken: string
  bootId: string
  pid: number
  processStartTicks: number
  ttlMs: number
  now?: number
}

interface SourceIdentity {
  kind: ImportSummary["source"]
  path: string
  schemaVersion: number
  fingerprint: string
  operationKey: string
}

type SqlRow = Record<string, unknown>

const requiredText = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}
const integer = (value: unknown, fallback = 0) => {
  const number = value === null || value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid imported integer")
  return number
}
const nullableText = (value: unknown) => value === null || value === undefined || value === "" ? null : requiredText(value, "imported text")
const jsonText = (value: unknown, fallback: unknown = {}) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? fallback)
  JSON.parse(text)
  return text
}
const hasColumn = (columns: Set<string>, name: string) => columns.has(name)
const columnsFor = (db: Database, table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
const tablesFor = (db: Database) => new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
const sourceKey = (row: SqlRow, columns: string[]) => columns.map((column) => String(row[column] ?? "")).join(":")
const payloadHash = (row: SqlRow) => createHash("sha256").update(JSON.stringify(row, Object.keys(row).sort())).digest("hex")

const ensurePermissions = (dbPath: string) => {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(dbPath), 0o700)
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600)
}

const initialize = (db: Database) => {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
  if (current > REGISTRY_SCHEMA_VERSION) throw new Error(`Unsupported durable registry version ${current}`)
  if (current === REGISTRY_SCHEMA_VERSION) return
  if (current === 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE operations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
      PRAGMA user_version = 2;
      COMMIT;
    `)
    return
  }
  if (current !== 0) throw new Error(`Unsupported durable registry version ${current}`)
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY CHECK (length(id) > 0 AND trim(id) = id),
      common_dir TEXT NOT NULL UNIQUE CHECK (length(common_dir) > 0),
      placeholder INTEGER NOT NULL DEFAULT 0 CHECK (placeholder IN (0, 1)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    );
    CREATE TABLE workshops (
      id TEXT PRIMARY KEY CHECK (length(id) > 0 AND trim(id) = id),
      repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
      canonical_path TEXT NOT NULL UNIQUE CHECK (length(canonical_path) > 0),
      branch TEXT NOT NULL CHECK (length(branch) > 0),
      parent_id TEXT REFERENCES workshops(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      placeholder INTEGER NOT NULL DEFAULT 0 CHECK (placeholder IN (0, 1)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
    CREATE INDEX workshops_repo_idx ON workshops(repo_id);
    CREATE INDEX workshops_parent_idx ON workshops(parent_id);
    CREATE TRIGGER workshops_parent_insert BEFORE INSERT ON workshops WHEN NEW.parent_id IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM workshops p WHERE p.id = NEW.parent_id AND p.repo_id = NEW.repo_id)
        THEN RAISE(ABORT, 'workshop parent must belong to the same repository') END;
    END;
    CREATE TRIGGER workshops_parent_update BEFORE UPDATE OF parent_id, repo_id ON workshops WHEN NEW.parent_id IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM workshops p WHERE p.id = NEW.parent_id AND p.repo_id = NEW.repo_id)
        THEN RAISE(ABORT, 'workshop parent must belong to the same repository') END;
      SELECT CASE WHEN EXISTS (
        WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION ALL SELECT w.parent_id FROM workshops w JOIN ancestors a ON w.id = a.id WHERE w.parent_id IS NOT NULL)
        SELECT 1 FROM ancestors WHERE id = NEW.id
      ) THEN RAISE(ABORT, 'workshop lineage cycle') END;
    END;

    CREATE TABLE managed_topology (
      id TEXT PRIMARY KEY CHECK (length(id) > 0 AND trim(id) = id),
      kind TEXT NOT NULL CHECK (kind IN ('session', 'window')),
      workshop_id TEXT NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
      parent_id TEXT REFERENCES managed_topology(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL CHECK (length(display_name) > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      CHECK ((kind = 'session' AND parent_id IS NULL) OR (kind = 'window' AND parent_id IS NOT NULL))
    );
    CREATE INDEX managed_topology_workshop_idx ON managed_topology(workshop_id, kind);
    CREATE TRIGGER managed_topology_parent_insert BEFORE INSERT ON managed_topology WHEN NEW.kind = 'window' BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM managed_topology p WHERE p.id = NEW.parent_id AND p.kind = 'session' AND p.workshop_id = NEW.workshop_id)
        THEN RAISE(ABORT, 'window requires a session parent in its Workshop') END;
    END;
    CREATE TRIGGER managed_topology_identity_immutable BEFORE UPDATE OF kind, workshop_id, parent_id ON managed_topology BEGIN
      SELECT RAISE(ABORT, 'managed topology identity is immutable');
    END;

    CREATE TABLE terminals (
      id TEXT PRIMARY KEY CHECK (length(id) > 0 AND trim(id) = id),
      workshop_id TEXT NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
      window_id TEXT NOT NULL REFERENCES managed_topology(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL CHECK (length(display_name) > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    );
    CREATE INDEX terminals_workshop_idx ON terminals(workshop_id);
    CREATE TRIGGER terminals_window_insert BEFORE INSERT ON terminals BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM managed_topology w WHERE w.id = NEW.window_id AND w.kind = 'window' AND w.workshop_id = NEW.workshop_id)
        THEN RAISE(ABORT, 'Terminal requires a window in its Workshop') END;
    END;
    CREATE TRIGGER terminals_identity_immutable BEFORE UPDATE OF workshop_id, window_id ON terminals BEGIN
      SELECT RAISE(ABORT, 'Terminal identity is immutable');
    END;

    CREATE TABLE clankers (
      id TEXT PRIMARY KEY CHECK (length(id) > 0 AND trim(id) = id),
      workshop_id TEXT NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
      terminal_id TEXT REFERENCES terminals(id) ON DELETE RESTRICT,
      harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude', 'opencode')),
      harness_session_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    );
    CREATE UNIQUE INDEX clankers_harness_session_idx ON clankers(harness, harness_session_id) WHERE harness_session_id IS NOT NULL;
    CREATE INDEX clankers_workshop_idx ON clankers(workshop_id);
    CREATE TRIGGER clankers_terminal_insert BEFORE INSERT ON clankers WHEN NEW.terminal_id IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM terminals t WHERE t.id = NEW.terminal_id AND t.workshop_id = NEW.workshop_id)
        THEN RAISE(ABORT, 'Clanker Terminal must belong to its Workshop') END;
    END;
    CREATE TRIGGER clankers_identity_immutable BEFORE UPDATE OF workshop_id, terminal_id, harness ON clankers BEGIN
      SELECT RAISE(ABORT, 'Clanker identity is immutable');
    END;

    CREATE TABLE multiplexer_locations (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('topology', 'terminal', 'clanker')),
      entity_id TEXT NOT NULL,
      topology_id TEXT REFERENCES managed_topology(id) ON DELETE CASCADE,
      terminal_id TEXT REFERENCES terminals(id) ON DELETE CASCADE,
      clanker_id TEXT REFERENCES clankers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (length(kind) > 0),
      instance_id TEXT NOT NULL CHECK (length(instance_id) > 0),
      native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
      native_window_id TEXT NOT NULL,
      native_pane_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      PRIMARY KEY (entity_kind, entity_id),
      UNIQUE (kind, instance_id, native_session_id, native_window_id, native_pane_id),
      CHECK ((entity_kind = 'topology' AND topology_id = entity_id AND terminal_id IS NULL AND clanker_id IS NULL)
        OR (entity_kind = 'terminal' AND terminal_id = entity_id AND topology_id IS NULL AND clanker_id IS NULL)
        OR (entity_kind = 'clanker' AND clanker_id = entity_id AND topology_id IS NULL AND terminal_id IS NULL))
    );
    CREATE TRIGGER multiplexer_location_shape_insert BEFORE INSERT ON multiplexer_locations BEGIN
      SELECT CASE
        WHEN NEW.entity_kind = 'topology' AND EXISTS (SELECT 1 FROM managed_topology t WHERE t.id = NEW.entity_id AND t.kind = 'session') AND (NEW.native_window_id <> '' OR NEW.native_pane_id <> '') THEN RAISE(ABORT, 'session Multiplexer Location has window or pane identity')
        WHEN NEW.entity_kind = 'topology' AND EXISTS (SELECT 1 FROM managed_topology t WHERE t.id = NEW.entity_id AND t.kind = 'window') AND (NEW.native_window_id = '' OR NEW.native_pane_id <> '') THEN RAISE(ABORT, 'window Multiplexer Location has invalid native identity')
        WHEN NEW.entity_kind IN ('terminal', 'clanker') AND (NEW.native_window_id = '' OR NEW.native_pane_id = '') THEN RAISE(ABORT, 'Terminal or Clanker Multiplexer Location requires window and pane identity')
      END;
    END;
    CREATE TRIGGER multiplexer_location_shape_update BEFORE UPDATE ON multiplexer_locations BEGIN
      SELECT RAISE(ABORT, 'Multiplexer Location claims are replaced, not mutated');
    END;

    CREATE TABLE desired_recovery (
      clanker_id TEXT PRIMARY KEY REFERENCES clankers(id) ON DELETE RESTRICT,
      workshop_path TEXT NOT NULL,
      tmux_session_name TEXT NOT NULL,
      tmux_window_name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      launch_spec TEXT NOT NULL CHECK (json_valid(launch_spec)),
      original_task TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK (policy_version IN (1, 2)),
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'suspended_resource_pressure', 'tombstoned')),
      recovery_condition TEXT NOT NULL CHECK (recovery_condition IN ('healthy', 'pending', 'recovering', 'interrupted_unknown', 'quarantined', 'suspended')),
      quarantine_reason TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      owner_unit TEXT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    );
    CREATE TABLE recovery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clanker_id TEXT NOT NULL REFERENCES clankers(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      trigger TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
      error TEXT,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      finished_at INTEGER,
      automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1)),
      boot_epoch INTEGER,
      UNIQUE (clanker_id, attempt_number)
    );
    CREATE TABLE leases (
      scope_key TEXT PRIMARY KEY,
      clanker_id TEXT REFERENCES clankers(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      pid INTEGER NOT NULL CHECK (pid > 0),
      process_start_ticks INTEGER NOT NULL CHECK (process_start_ticks >= 0),
      acquired_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      CHECK ((scope_key = 'global' AND clanker_id IS NULL) OR (scope_key = 'clanker:' || clanker_id AND clanker_id IS NOT NULL))
    );
    CREATE TABLE registry_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)), updated_at INTEGER NOT NULL);

    CREATE TABLE journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clanker_id TEXT REFERENCES clankers(id) ON DELETE RESTRICT,
      event TEXT NOT NULL,
      revision INTEGER,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      provenance_id INTEGER UNIQUE REFERENCES import_provenance(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX journal_clanker_idx ON journal(clanker_id, id);
    CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'registry journal is append-only'); END;
    CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'registry journal is append-only'); END;

    CREATE TABLE operations (
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
    );
    CREATE TABLE import_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL,
      source_table TEXT NOT NULL,
      source_key TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE (source_kind, source_path, source_table, source_key)
    );
    CREATE INDEX import_provenance_target_idx ON import_provenance(target_table, target_key);
    PRAGMA user_version = 2;
    COMMIT;
  `)
}

export class DurableRegistry {
  readonly dbPath: string
  private readonly db: Database
  private readonly clock: () => number

  private constructor(dbPath: string, db: Database, clock: () => number) {
    this.dbPath = dbPath
    this.db = db
    this.clock = clock
  }

  static open(options: { dbPath?: string; now?: () => number } = {}) {
    const dbPath = options.dbPath ?? registryStatePath()
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
      return new DurableRegistry(dbPath, db, options.now ?? Date.now)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() { this.db.close(); ensurePermissions(this.dbPath) }

  private source(kind: SourceIdentity["kind"], sourcePath: string, supportedVersions: number[]): { db: Database; identity: SourceIdentity } {
    const path = realpathSync(sourcePath)
    const before = statSync(path)
    if (!before.isFile()) throw new Error(`Legacy ${kind} source is not a regular file`)
    const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex")
    const db = new Database(path, { readonly: true, strict: true })
    try {
      db.exec("PRAGMA query_only = ON")
      const schemaVersion = Number((db.query("PRAGMA user_version").get() as { user_version: number }).user_version)
      if (!supportedVersions.includes(schemaVersion)) throw new Error(`Unsupported ${kind} schema version ${schemaVersion}`)
      const after = statSync(path)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Legacy ${kind} source changed while opening`)
      return { db, identity: { kind, path, schemaVersion, fingerprint, operationKey: `legacy-import:${kind}:${path}:${fingerprint}` } }
    } catch (error) { db.close(); throw error }
  }

  private existingOperation(identity: SourceIdentity) {
    return this.db.query("SELECT id, status, result FROM operations WHERE idempotency_key = ?1").get(identity.operationKey) as { id: string; status: string; result: string | null } | null
  }

  private runImport(identity: SourceIdentity, input: Record<string, unknown>, importer: (source: Database, operationId: string) => number, source: Database, interrupt?: () => void): ImportSummary {
    const existing = this.existingOperation(identity)
    if (existing?.status === "succeeded") {
      const result = JSON.parse(existing.result || "{}") as { imported?: number }
      return { source: identity.kind, schemaVersion: identity.schemaVersion, operationId: existing.id, imported: result.imported ?? 0, alreadyImported: true }
    }
    const now = this.clock()
    const operationId = existing?.id ?? randomUUID()
    if (!existing) this.db.query("INSERT INTO operations (id, idempotency_key, kind, stage, status, input, created_at, updated_at) VALUES (?1, ?2, 'legacy.import', 'registered', 'pending', ?3, ?4, ?4)")
      .run(operationId, identity.operationKey, JSON.stringify(input), now)
    this.db.query("UPDATE operations SET stage = 'importing', status = 'running', error = NULL, updated_at = ?2 WHERE id = ?1").run(operationId, now)
    try {
      const imported = this.db.transaction(() => {
        const count = importer(source, operationId)
        interrupt?.()
        const checked = this.validate()
        if (checked.foreignKeyViolations.length > 0 || checked.semanticViolations.length > 0) throw new Error(`Registry validation failed: ${[...checked.semanticViolations, ...checked.foreignKeyViolations.map(String)].join(", ")}`)
        this.db.query("UPDATE operations SET stage = 'complete', status = 'succeeded', result = ?2, updated_at = ?3, completed_at = ?3 WHERE id = ?1")
          .run(operationId, JSON.stringify({ imported: count, fingerprint: identity.fingerprint }), this.clock())
        return count
      }).immediate()
      return { source: identity.kind, schemaVersion: identity.schemaVersion, operationId, imported, alreadyImported: false }
    } catch (error) {
      this.db.query("UPDATE operations SET stage = 'importing', status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").run(operationId, String(error), this.clock())
      throw error
    }
  }

  private provenance(identity: SourceIdentity, table: string, key: string, targetTable: string, targetKey: string, row: SqlRow) {
    const hash = payloadHash(row)
    const previous = this.db.query("SELECT payload_hash, target_table, target_key FROM import_provenance WHERE source_kind = ?1 AND source_path = ?2 AND source_table = ?3 AND source_key = ?4")
      .get(identity.kind, identity.path, table, key) as { payload_hash: string; target_table: string; target_key: string } | null
    if (previous) {
      if (previous.payload_hash !== hash || previous.target_table !== targetTable || previous.target_key !== targetKey) throw new Error(`Legacy source row changed after import: ${table}/${key}`)
      return { imported: false, id: Number((this.db.query("SELECT id FROM import_provenance WHERE source_kind = ?1 AND source_path = ?2 AND source_table = ?3 AND source_key = ?4").get(identity.kind, identity.path, table, key) as { id: number }).id) }
    }
    const result = this.db.query("INSERT INTO import_provenance (source_kind, source_path, source_schema_version, source_table, source_key, target_table, target_key, payload_hash, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
      .run(identity.kind, identity.path, identity.schemaVersion, table, key, targetTable, targetKey, hash, this.clock())
    return { imported: true, id: Number(result.lastInsertRowid) }
  }

  private ensurePlaceholderWorkshop(workshopIdValue: unknown, pathValue?: unknown, now = this.clock()) {
    const workshopId = requiredText(workshopIdValue, "Workshop id")
    const existing = this.db.query("SELECT id FROM workshops WHERE id = ?1").get(workshopId)
    if (existing) return workshopId
    const canonicalPath = typeof pathValue === "string" && pathValue.length > 0 ? pathValue : `legacy-placeholder:${workshopId}`
    // Recovery v1/v2/v3 may retain a superseded Workshop ID after lineage was
    // re-registered for the same canonical worktree. Canonical path is already
    // unique durable identity, so join the Clanker to that Workshop rather than
    // inventing a competing placeholder or discarding recovery data.
    const existingPath = this.db.query("SELECT id FROM workshops WHERE canonical_path = ?1").get(canonicalPath) as { id: string } | null
    if (existingPath) return existingPath.id
    const commonDir = `legacy-placeholder:${workshopId}`
    const repoId = `legacy-repository:${workshopId}`
    this.db.query("INSERT OR IGNORE INTO repositories (id, common_dir, placeholder, created_at, updated_at) VALUES (?1, ?2, 1, ?3, ?3)").run(repoId, commonDir, now)
    this.db.query("INSERT INTO workshops (id, repo_id, canonical_path, branch, parent_id, revision, placeholder, created_at, updated_at) VALUES (?1, ?2, ?3, 'legacy', NULL, 1, 1, ?4, ?4)")
      .run(workshopId, repoId, canonicalPath, now)
    return workshopId
  }

  importWorkshops(sourcePath: string, options: { altK?: boolean; interruptBeforeCommit?: () => void } = {}) {
    const kind = options.altK ? "alt-k-lineage" as const : "workshops" as const
    const opened = this.source(kind, sourcePath, [0, 1])
    try {
      const tables = tablesFor(opened.db)
      const table = options.altK ? (tables.has("workspaces") ? "workspaces" : "workshops") : "workshops"
      if (!tables.has("repositories") || !tables.has(table)) throw new Error(`Malformed ${kind} store`)
      return this.runImport(opened.identity, { path: opened.identity.path, table }, (source) => {
        let count = 0
        const repos = source.query("SELECT * FROM repositories ORDER BY id").all() as SqlRow[]
        const repositoryTargets = new Map<string, string>()
        for (const row of repos) {
          const sourceId = requiredText(row.id, "repository id")
          const commonDir = requiredText(row.common_dir, "repository common directory")
          const byId = this.db.query("SELECT id, common_dir, placeholder FROM repositories WHERE id = ?1").get(sourceId) as { id: string; common_dir: string; placeholder: number } | null
          const byCommonDir = this.db.query("SELECT id, common_dir, placeholder FROM repositories WHERE common_dir = ?1").get(commonDir) as { id: string; common_dir: string; placeholder: number } | null
          if (byId && byId.common_dir !== commonDir && !byId.placeholder) throw new Error(`Repository identity conflict for ${sourceId}`)
          const targetId = byId?.id ?? byCommonDir?.id ?? sourceId
          repositoryTargets.set(sourceId, targetId)
          const imported = this.provenance(opened.identity, "repositories", sourceId, "repositories", targetId, row).imported
          if (!byId && !byCommonDir) this.db.query("INSERT INTO repositories (id, common_dir, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)")
            .run(targetId, commonDir, integer(row.created_at), integer(row.updated_at))
          else if (byId?.placeholder && !byCommonDir) this.db.query("UPDATE repositories SET common_dir = ?2, placeholder = 0, created_at = ?3, updated_at = ?4 WHERE id = ?1")
            .run(targetId, commonDir, integer(row.created_at), integer(row.updated_at))
          if (imported) count++
        }
        const rows = source.query(`SELECT * FROM ${table} ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id`).all() as SqlRow[]
        const workshopTargets = new Map<string, string>()
        const parentWritable = new Set<string>()
        // Two passes permit arbitrary parent ordering without weakening the parent FK. A current record imported first wins over an alt-k record for the same path.
        for (const row of rows) {
          const sourceId = requiredText(row.id, "Workshop id")
          const sourceRepoId = requiredText(row.repo_id, "repository id")
          const repoId = repositoryTargets.get(sourceRepoId)
          if (!repoId) throw new Error(`Unknown imported repository ${sourceRepoId}`)
          const path = requiredText(row.canonical_path ?? row.path, "Workshop canonical path")
          const byId = this.db.query("SELECT id, repo_id, canonical_path, placeholder FROM workshops WHERE id = ?1").get(sourceId) as { id: string; repo_id: string; canonical_path: string; placeholder: number } | null
          const byPath = this.db.query("SELECT id, repo_id, canonical_path, placeholder FROM workshops WHERE canonical_path = ?1").get(path) as { id: string; repo_id: string; canonical_path: string; placeholder: number } | null
          if (byId && !byId.placeholder && byId.canonical_path !== path) throw new Error(`Workshop identity conflict for ${sourceId}`)
          const target = byId ?? byPath
          const targetId = target?.id ?? sourceId
          workshopTargets.set(sourceId, targetId)
          if (!target) {
            this.db.query("INSERT INTO workshops (id, repo_id, canonical_path, branch, parent_id, revision, placeholder, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6, ?7)")
              .run(targetId, repoId, path, requiredText(row.branch ?? "legacy", "Workshop branch"), Math.max(1, integer(row.revision, 1)), integer(row.created_at), integer(row.updated_at))
            parentWritable.add(targetId)
          } else if (target.placeholder) {
            this.db.query("UPDATE workshops SET repo_id = ?2, canonical_path = ?3, branch = ?4, revision = ?5, placeholder = 0, created_at = ?6, updated_at = ?7 WHERE id = ?1")
              .run(targetId, repoId, path, requiredText(row.branch ?? "legacy", "Workshop branch"), Math.max(1, integer(row.revision, 1)), integer(row.created_at), integer(row.updated_at))
            parentWritable.add(targetId)
          }
        }
        for (const row of rows) {
          const sourceId = requiredText(row.id, "Workshop id")
          const targetId = workshopTargets.get(sourceId)!
          const imported = this.provenance(opened.identity, table, sourceId, "workshops", targetId, row).imported
          const sourceParentId = nullableText(row.parent_id)
          const parentId = sourceParentId ? workshopTargets.get(sourceParentId) : undefined
          if (sourceParentId && !parentId) throw new Error(`Unknown imported Workshop parent ${sourceParentId}`)
          if (parentWritable.has(targetId) && parentId) this.db.query("UPDATE workshops SET parent_id = ?2 WHERE id = ?1").run(targetId, parentId)
          if (imported) count++
        }
        return count
      }, opened.db, options.interruptBeforeCommit)
    } finally { opened.db.close() }
  }

  importResources(sourcePath: string, options: { interruptBeforeCommit?: () => void } = {}) {
    const opened = this.source("resources", sourcePath, [1])
    try {
      if (!tablesFor(opened.db).has("resources")) throw new Error("Malformed resources store")
      return this.runImport(opened.identity, { path: opened.identity.path }, (source) => {
        let count = 0
        const rows = source.query("SELECT * FROM resources ORDER BY CASE kind WHEN 'session' THEN 0 WHEN 'window' THEN 1 ELSE 2 END, created_at, id").all() as SqlRow[]
        for (const row of rows) {
          const id = requiredText(row.id, "managed resource id")
          const kind = requiredText(row.kind, "managed resource kind")
          const workshopId = this.ensurePlaceholderWorkshop(row.workshop_id, undefined, integer(row.created_at))
          const provenance = this.provenance(opened.identity, "resources", id, kind === "terminal" ? "terminals" : "managed_topology", id, row)
          if (!provenance.imported) continue
          if (kind === "session" || kind === "window") this.db.query("INSERT INTO managed_topology (id, kind, workshop_id, parent_id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
            .run(id, kind, workshopId, nullableText(row.parent_id), requiredText(row.display_name, "Display Name"), integer(row.created_at), integer(row.updated_at))
          else if (kind === "terminal") this.db.query("INSERT INTO terminals (id, workshop_id, window_id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .run(id, workshopId, requiredText(row.parent_id, "Terminal window id"), requiredText(row.display_name, "Display Name"), integer(row.created_at), integer(row.updated_at))
          else throw new Error(`Unsupported managed resource kind ${kind}`)
          count++
        }
        if (tablesFor(source).has("multiplexer_locations")) {
          for (const row of source.query("SELECT * FROM multiplexer_locations ORDER BY resource_id").all() as SqlRow[]) {
            const resourceId = requiredText(row.resource_id, "managed resource id")
            const terminal = this.db.query("SELECT id FROM terminals WHERE id = ?1").get(resourceId)
            const entityKind = terminal ? "terminal" : "topology"
            const provenance = this.provenance(opened.identity, "multiplexer_locations", resourceId, "multiplexer_locations", `${entityKind}:${resourceId}`, row)
            if (!provenance.imported) continue
            this.db.query(`INSERT INTO multiplexer_locations (entity_kind, entity_id, topology_id, terminal_id, clanker_id, kind, instance_id, native_session_id, native_window_id, native_pane_id, observed_at)
              VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10)`)
              .run(entityKind, resourceId, entityKind === "topology" ? resourceId : null, entityKind === "terminal" ? resourceId : null, requiredText(row.kind, "Multiplexer kind"), requiredText(row.instance_id, "Multiplexer instance id"), requiredText(row.native_session_id, "native session id"), String(row.native_window_id ?? ""), String(row.native_pane_id ?? ""), integer(row.observed_at))
            count++
          }
        }
        return count
      }, opened.db, options.interruptBeforeCommit)
    } finally { opened.db.close() }
  }

  importRecovery(sourcePath: string, options: { interruptBeforeCommit?: () => void } = {}) {
    const opened = this.source("recovery", sourcePath, [1, 2, 3])
    try {
      const tables = tablesFor(opened.db)
      if (!tables.has("desired_clankers")) throw new Error("Malformed recovery store")
      return this.runImport(opened.identity, { path: opened.identity.path, schemaVersion: opened.identity.schemaVersion }, (source) => {
        let count = 0
        const desiredColumns = columnsFor(source, "desired_clankers")
        for (const row of source.query("SELECT * FROM desired_clankers ORDER BY created_at, clanker_id").all() as SqlRow[]) {
          const id = requiredText(row.clanker_id, "Clanker id")
          const workshopId = this.ensurePlaceholderWorkshop(row.workshop_id, row.workshop_path, integer(row.created_at))
          if (!this.provenance(opened.identity, "desired_clankers", id, "desired_recovery", id, row).imported) continue
          const condition = hasColumn(desiredColumns, "recovery_condition") ? requiredText(row.recovery_condition, "recovery condition") : row.desired_state === "running" ? "pending" : "healthy"
          this.db.query("INSERT INTO clankers (id, workshop_id, terminal_id, harness, harness_session_id, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6)")
            .run(id, workshopId, requiredText(row.harness, "Clanker harness"), nullableText(row.harness_session_id), integer(row.created_at), integer(row.updated_at))
          this.db.query(`INSERT INTO desired_recovery (clanker_id, workshop_path, tmux_session_name, tmux_window_name, cwd, launch_spec, original_task, policy_version, desired_state, recovery_condition, quarantine_reason, consecutive_failures, owner_unit, revision, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`)
            .run(id, requiredText(row.workshop_path, "Workshop path"), requiredText(row.tmux_session_name, "tmux session name"), requiredText(row.tmux_window_name, "tmux window name"), requiredText(row.cwd, "Clanker cwd"), jsonText(row.launch_spec), String(row.original_task ?? ""), integer(row.policy_version, 1), requiredText(row.desired_state, "desired state"), condition, hasColumn(desiredColumns, "quarantine_reason") ? nullableText(row.quarantine_reason) : null, hasColumn(desiredColumns, "consecutive_failures") ? integer(row.consecutive_failures) : 0, hasColumn(desiredColumns, "owner_unit") ? nullableText(row.owner_unit) : null, Math.max(1, integer(row.revision, 1)), integer(row.created_at), integer(row.updated_at))
          count++
        }
        if (tables.has("recovery_attempts")) {
          const attemptColumns = columnsFor(source, "recovery_attempts")
          for (const row of source.query("SELECT * FROM recovery_attempts ORDER BY id").all() as SqlRow[]) {
            const id = requiredText(row.clanker_id, "Clanker id")
            const attempt = integer(row.attempt_number)
            const key = sourceKey(row, ["clanker_id", "attempt_number"])
            if (!this.provenance(opened.identity, "recovery_attempts", key, "recovery_attempts", key, row).imported) continue
            this.db.query("INSERT INTO recovery_attempts (clanker_id, attempt_number, trigger, status, error, started_at, finished_at, automatic, boot_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
              .run(id, attempt, requiredText(row.trigger, "recovery trigger"), requiredText(row.status, "recovery status"), nullableText(row.error), integer(row.started_at), row.finished_at === null ? null : integer(row.finished_at), hasColumn(attemptColumns, "automatic") ? integer(row.automatic) : 0, hasColumn(attemptColumns, "boot_epoch") && row.boot_epoch !== null ? integer(row.boot_epoch) : null)
            count++
          }
        }
        if (tables.has("recovery_leases")) for (const row of source.query("SELECT * FROM recovery_leases ORDER BY scope_key").all() as SqlRow[]) {
          const key = requiredText(row.scope_key, "lease scope")
          if (!this.provenance(opened.identity, "recovery_leases", key, "leases", key, row).imported) continue
          this.db.query("INSERT INTO leases (scope_key, clanker_id, owner_token, boot_id, pid, process_start_ticks, acquired_at, renewed_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
            .run(key, nullableText(row.clanker_id), requiredText(row.owner_token, "lease owner"), requiredText(row.boot_id, "boot id"), integer(row.pid), integer(row.process_start_ticks), integer(row.acquired_at), integer(row.renewed_at), integer(row.expires_at))
          count++
        }
        if (tables.has("recovery_metadata")) for (const row of source.query("SELECT * FROM recovery_metadata ORDER BY key").all() as SqlRow[]) {
          const key = requiredText(row.key, "metadata key")
          if (!this.provenance(opened.identity, "recovery_metadata", key, "registry_metadata", `recovery.${key}`, row).imported) continue
          this.db.query("INSERT INTO registry_metadata (key, value, updated_at) VALUES (?1, ?2, ?3)").run(`recovery.${key}`, jsonText(row.value), integer(row.updated_at))
          count++
        }
        if (tables.has("recovery_journal")) for (const row of source.query("SELECT * FROM recovery_journal ORDER BY id").all() as SqlRow[]) {
          const key = String(row.id)
          const provenance = this.provenance(opened.identity, "recovery_journal", key, "journal", `recovery:${key}`, row)
          if (!provenance.imported) continue
          this.db.query("INSERT INTO journal (clanker_id, event, revision, payload, created_at, provenance_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .run(nullableText(row.clanker_id), requiredText(row.event, "journal event"), row.revision === null ? null : integer(row.revision), jsonText(row.payload), integer(row.created_at), provenance.id)
          count++
        }
        return count
      }, opened.db, options.interruptBeforeCommit)
    } finally { opened.db.close() }
  }

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
    JSON.parse(serialized)
    const existing = this.db.query("SELECT id, kind, input FROM operations WHERE idempotency_key = ?1").get(idempotencyKey) as { id: string; kind: string; input: string } | null
    if (existing) {
      if (existing.kind !== kind || existing.input !== serialized) throw new Error(`Idempotency key ${idempotencyKey} belongs to a different operation`)
      return this.operation(existing.id)!
    }
    const now = integer(options.now ?? this.clock())
    const id = randomUUID()
    this.db.query("INSERT INTO operations (id, idempotency_key, kind, stage, status, input, created_at, updated_at) VALUES (?1, ?2, ?3, 'registered', 'pending', ?4, ?5, ?5)")
      .run(id, idempotencyKey, kind, serialized, now)
    return this.operation(id)!
  }

  startOperation(id: string, options: { now?: number } = {}) {
    const now = integer(options.now ?? this.clock())
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
    if (result !== undefined) JSON.parse(result)
    const now = integer(options.now ?? this.clock())
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

  appendJournal(clankerId: string | null, eventValue: string, revision: number | null, payload: unknown, options: { now?: number } = {}) {
    const event = requiredText(eventValue, "journal event")
    if (clankerId !== null && !this.db.query("SELECT id FROM clankers WHERE id = ?1").get(clankerId)) throw new Error(`Unknown Clanker ${clankerId}`)
    if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error("Invalid journal revision")
    const serialized = JSON.stringify(payload)
    if (serialized === undefined) throw new Error("Journal payload must be JSON serializable")
    JSON.parse(serialized)
    const result = this.db.query("INSERT INTO journal (clanker_id, event, revision, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(clankerId, event, revision, serialized, integer(options.now ?? this.clock()))
    return Number(result.lastInsertRowid)
  }

  acquireLease(input: RegistryLeaseInput) {
    const scopeKeyValue = requiredText(input.scopeKey, "lease scope")
    const clankerId = input.clankerId ?? null
    if ((scopeKeyValue === "global") !== (clankerId === null) || (clankerId !== null && scopeKeyValue !== `clanker:${clankerId}`)) throw new Error("Invalid lease scope identity")
    const ownerToken = requiredText(input.ownerToken, "lease owner token")
    const bootId = requiredText(input.bootId, "boot id")
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || !Number.isSafeInteger(input.processStartTicks) || input.processStartTicks < 0 || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("Invalid lease process identity or ttl")
    const now = integer(input.now ?? this.clock())
    return this.db.transaction(() => {
      if (clankerId !== null && !this.db.query("SELECT id FROM clankers WHERE id = ?1").get(clankerId)) throw new Error(`Unknown Clanker ${clankerId}`)
      const existing = this.db.query("SELECT owner_token, boot_id, pid, process_start_ticks, acquired_at, expires_at FROM leases WHERE scope_key = ?1").get(scopeKeyValue) as Record<string, string | number> | null
      const owned = existing && existing.owner_token === ownerToken && existing.boot_id === bootId && existing.pid === input.pid && existing.process_start_ticks === input.processStartTicks
      if (existing && Number(existing.expires_at) > now && existing.boot_id === bootId && !owned) return false
      const acquiredAt = owned ? Number(existing.acquired_at) : now
      this.db.query(`INSERT INTO leases (scope_key, clanker_id, owner_token, boot_id, pid, process_start_ticks, acquired_at, renewed_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(scope_key) DO UPDATE SET clanker_id=excluded.clanker_id, owner_token=excluded.owner_token, boot_id=excluded.boot_id,
          pid=excluded.pid, process_start_ticks=excluded.process_start_ticks, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at, expires_at=excluded.expires_at`)
        .run(scopeKeyValue, clankerId, ownerToken, bootId, input.pid, input.processStartTicks, acquiredAt, now, now + input.ttlMs)
      return true
    }).immediate()
  }

  releaseLease(scopeKeyValue: string, ownerTokenValue: string) {
    const scopeKey = requiredText(scopeKeyValue, "lease scope")
    const ownerToken = requiredText(ownerTokenValue, "lease owner token")
    return this.db.query("DELETE FROM leases WHERE scope_key = ?1 AND owner_token = ?2").run(scopeKey, ownerToken).changes === 1
  }

  private sourceWasImported(kind: ImportSummary["source"], sourcePath: string) {
    if (!existsSync(sourcePath)) return false
    const path = realpathSync(sourcePath)
    return Boolean(this.db.query("SELECT 1 FROM import_provenance WHERE source_kind = ?1 AND source_path = ?2 LIMIT 1").get(kind, path))
  }

  importLegacy(sources: LegacyRegistrySources, options: { oncePerSource?: boolean } = {}) {
    const summaries: ImportSummary[] = []
    const shouldImport = (kind: ImportSummary["source"], path: string | undefined) => Boolean(path && existsSync(path) && (!options.oncePerSource || !this.sourceWasImported(kind, path)))
    // Current Clankerhouse lineage is authoritative; alt-k fills only paths that it does not contain.
    if (shouldImport("workshops", sources.workshops)) summaries.push(this.importWorkshops(sources.workshops!))
    if (shouldImport("alt-k-lineage", sources.altKLineage)) summaries.push(this.importWorkshops(sources.altKLineage!, { altK: true }))
    if (shouldImport("resources", sources.resources)) summaries.push(this.importResources(sources.resources!))
    if (shouldImport("recovery", sources.recovery)) summaries.push(this.importRecovery(sources.recovery!))
    return summaries
  }

  setMetadata(keyValue: string, value: unknown, options: { now?: number } = {}) {
    const key = requiredText(keyValue, "registry metadata key")
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error("Registry metadata must be JSON serializable")
    JSON.parse(serialized)
    this.db.query(`INSERT INTO registry_metadata (key, value, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, serialized, integer(options.now ?? this.clock()))
  }

  metadata(keyValue: string): unknown | undefined {
    const row = this.db.query("SELECT value FROM registry_metadata WHERE key = ?1").get(requiredText(keyValue, "registry metadata key")) as { value: string } | null
    return row ? JSON.parse(row.value) : undefined
  }

  validate(): RegistryValidation {
    const foreignKeyViolations = this.db.query("PRAGMA foreign_key_check").all()
    const semanticViolations: string[] = []
    for (const row of this.db.query("SELECT child.id FROM workshops child JOIN workshops parent ON parent.id = child.parent_id WHERE child.repo_id <> parent.repo_id").all() as Array<{ id: string }>) semanticViolations.push(`Workshop ${row.id} has a parent in another repository`)
    for (const row of this.db.query("SELECT t.id FROM terminals t JOIN managed_topology w ON w.id = t.window_id WHERE w.kind <> 'window' OR w.workshop_id <> t.workshop_id").all() as Array<{ id: string }>) semanticViolations.push(`Terminal ${row.id} has invalid managed topology`)
    for (const row of this.db.query("SELECT c.id FROM clankers c JOIN terminals t ON t.id = c.terminal_id WHERE t.workshop_id <> c.workshop_id").all() as Array<{ id: string }>) semanticViolations.push(`Clanker ${row.id} has a Terminal in another Workshop`)
    const cycles = this.db.query(`WITH RECURSIVE lineage(origin, id, parent_id) AS (
      SELECT id, id, parent_id FROM workshops WHERE parent_id IS NOT NULL UNION ALL
      SELECT l.origin, p.id, p.parent_id FROM lineage l JOIN workshops p ON p.id = l.parent_id WHERE l.parent_id IS NOT NULL
    ) SELECT DISTINCT origin AS id FROM lineage WHERE parent_id = origin`).all() as Array<{ id: string }>
    for (const row of cycles) semanticViolations.push(`Workshop lineage cycle at ${row.id}`)
    return { foreignKeyViolations, semanticViolations }
  }

  workshops(): RegistryWorkshopRecord[] {
    return (this.db.query(`SELECT w.id, w.repo_id, w.canonical_path, r.common_dir, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at
      FROM workshops w JOIN repositories r ON r.id = w.repo_id WHERE w.placeholder = 0 ORDER BY w.canonical_path`).all() as Array<Record<string, string | number | null>>).map((row) => ({
        workshopId: String(row.id), repoId: String(row.repo_id), canonicalPath: String(row.canonical_path), commonDir: String(row.common_dir), branch: String(row.branch),
        parentWorkshopId: row.parent_id === null ? null : String(row.parent_id), revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      }))
  }

  tableCount(table: "repositories" | "workshops" | "managed_topology" | "terminals" | "clankers" | "desired_recovery" | "journal" | "leases" | "operations" | "import_provenance") {
    return Number((this.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
  }
}

export const openDurableRegistry = (options: { dbPath?: string; now?: () => number } = {}) => DurableRegistry.open(options)

/** Read-only expansion helper: new registry rows win; callers may retain a legacy fallback. */
export const readRegistryWorkshops = (dbPath = registryStatePath()): RegistryWorkshopRecord[] => {
  if (!existsSync(dbPath)) return []
  const db = new Database(resolve(dbPath), { readonly: true, strict: true })
  try {
    const version = Number((db.query("PRAGMA user_version").get() as { user_version: number }).user_version)
    if (version !== REGISTRY_SCHEMA_VERSION) throw new Error(`Unsupported durable registry version ${version}`)
    const compatibility = db.query("SELECT value FROM registry_metadata WHERE key = 'compatibility.authority'").get() as { value: string } | null
    if (compatibility && (JSON.parse(compatibility.value) as { domain?: string }).domain === "legacy-mutable") return []
    return (db.query(`SELECT w.id, w.repo_id, w.canonical_path, r.common_dir, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at
      FROM workshops w JOIN repositories r ON r.id = w.repo_id WHERE w.placeholder = 0 ORDER BY w.canonical_path`).all() as Array<Record<string, string | number | null>>).map((row) => ({
        workshopId: String(row.id), repoId: String(row.repo_id), canonicalPath: String(row.canonical_path), commonDir: String(row.common_dir), branch: String(row.branch),
        parentWorkshopId: row.parent_id === null ? null : String(row.parent_id), revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      }))
  } finally { db.close() }
}

/**
 * The clanker ledger: the durable record of every clanker Clankerhouse launched or adopted.
 * It is what survives a host or Herdr restart. Rows the daemon last saw alive in an earlier
 * Herdr server are left `open`, so after a restart the open rows that are not alive are the
 * interrupted clankers, and each names the exact harness session to resume.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDirFor, stateHomeDefault } from "./paths"

export type LedgerHarness = "pi" | "claude" | "opencode"
export type ResourceClass = "interactive" | "validation-heavy" | "untrusted"
export type LaunchSpec =
  | { version: 1; profile: string | null }
  | { version: 2; profile: string | null; resourceClass: ResourceClass }
  | { version: 3; profile: string | null; resourceClass: ResourceClass; model: string }
export type LedgerState = "open" | "closed"

export interface LedgerInput {
  clankerId: string
  harness: LedgerHarness
  workshopId: string
  workshopPath: string
  sessionLabel: string
  windowLabel: string
  cwd: string
  harnessSessionId: string | null
  launchSpec: LaunchSpec
  originalTask: string
}

export interface LedgerClanker extends LedgerInput {
  state: LedgerState
  /** Why a closed clanker ended; null while open. */
  closedReason: string | null
  /** The systemd scope the harness runs in, when it has one. */
  ownerUnit: string | null
  /** The Herdr server the clanker was last seen alive in. */
  serverEpoch: string | null
  createdAt: number
  updatedAt: number
}

const SCHEMA_VERSION = 1

export const ledgerStatePath = (stateHome = stateHomeDefault(), env: Record<string, string | undefined> = Bun.env) =>
  join(stateDirFor(stateHome, env), "clankers.sqlite3")

/** Recovery's store, imported once into a new ledger and otherwise left untouched. */
export const legacyRecoveryStatePath = (stateHome = stateHomeDefault(), env: Record<string, string | undefined> = Bun.env) =>
  join(stateDirFor(stateHome, env), "recovery.sqlite3")

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function assertText(value: unknown, field: string, options: { absolute?: boolean; max?: number } = {}): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${field}`)
  if (options.max && value.length > options.max) throw new Error(`Invalid ${field}`)
  if (options.absolute && !value.startsWith("/")) throw new Error(`${field} must be an absolute path`)
}

export const validateModelName = (value: unknown): string => {
  assertText(value, "model", { max: 512 })
  if (value.startsWith("-")) throw new Error("Invalid model")
  return value
}

const resourceClasses = ["interactive", "validation-heavy", "untrusted"]

export const validateLaunchSpec = (value: unknown): LaunchSpec => {
  if (!plainObject(value)) throw new Error("Invalid launch spec")
  const keys = Object.keys(value).sort().join(",")
  if (value.profile !== null) assertText(value.profile, "launch profile", { max: 128 })
  const profile = value.profile as string | null
  if (value.version === 1 && keys === "profile,version") return Object.freeze({ version: 1, profile })
  if (value.version === 2 && keys === "profile,resourceClass,version" && resourceClasses.includes(String(value.resourceClass))) {
    return Object.freeze({ version: 2, profile, resourceClass: value.resourceClass as ResourceClass })
  }
  if (value.version === 3 && keys === "model,profile,resourceClass,version" && resourceClasses.includes(String(value.resourceClass))) {
    return Object.freeze({ version: 3, profile, resourceClass: value.resourceClass as ResourceClass, model: validateModelName(value.model) })
  }
  throw new Error("Invalid launch spec")
}

export const launchResourceClass = (spec: LaunchSpec): ResourceClass => spec.version === 1 ? "untrusted" : spec.resourceClass
export const launchModel = (spec: LaunchSpec) => spec.version === 3 ? spec.model : undefined

const validateInput = (value: LedgerInput): LedgerInput => {
  if (!plainObject(value)) throw new Error("Invalid clanker")
  assertText(value.clankerId, "clanker id", { max: 256 })
  if (value.harness !== "pi" && value.harness !== "claude" && value.harness !== "opencode") throw new Error("Invalid harness")
  assertText(value.workshopId, "workshop id", { max: 256 })
  assertText(value.workshopPath, "workshop path", { absolute: true })
  assertText(value.sessionLabel, "session label", { max: 256 })
  assertText(value.windowLabel, "window label", { max: 256 })
  assertText(value.cwd, "cwd", { absolute: true })
  if (value.harnessSessionId !== null) assertText(value.harnessSessionId, "harness session id", { max: 512 })
  if (typeof value.originalTask !== "string" || value.originalTask.trim().length === 0 || value.originalTask.includes("\0")) throw new Error("Invalid original task")
  return { ...value, launchSpec: validateLaunchSpec(value.launchSpec) }
}

interface Row {
  clanker_id: string
  harness: LedgerHarness
  workshop_id: string
  workshop_path: string
  session_label: string
  window_label: string
  cwd: string
  harness_session_id: string | null
  launch_spec: string
  original_task: string
  state: LedgerState
  closed_reason: string | null
  owner_unit: string | null
  server_epoch: string | null
  created_at: number
  updated_at: number
}

const columns = "clanker_id, harness, workshop_id, workshop_path, session_label, window_label, cwd, harness_session_id, launch_spec, original_task, state, closed_reason, owner_unit, server_epoch, created_at, updated_at"

const fromRow = (row: Row): LedgerClanker => ({
  clankerId: row.clanker_id,
  harness: row.harness,
  workshopId: row.workshop_id,
  workshopPath: row.workshop_path,
  sessionLabel: row.session_label,
  windowLabel: row.window_label,
  cwd: row.cwd,
  harnessSessionId: row.harness_session_id,
  launchSpec: JSON.parse(row.launch_spec),
  originalTask: row.original_task,
  state: row.state,
  closedReason: row.closed_reason,
  ownerUnit: row.owner_unit,
  serverEpoch: row.server_epoch,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const ensurePermissions = (dbPath: string) => {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(dbPath), 0o700)
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600)
}

const initialize = (db: Database) => {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
  if (current > SCHEMA_VERSION) throw new Error(`Unsupported clanker ledger version ${current}`)
  if (current === SCHEMA_VERSION) return false
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE clankers (
      clanker_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude', 'opencode')),
      workshop_id TEXT NOT NULL,
      workshop_path TEXT NOT NULL,
      session_label TEXT NOT NULL,
      window_label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      harness_session_id TEXT,
      launch_spec TEXT NOT NULL CHECK (json_valid(launch_spec)),
      original_task TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
      closed_reason TEXT,
      owner_unit TEXT,
      server_epoch TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX clankers_workshop_idx ON clankers(workshop_id);
    CREATE INDEX clankers_state_idx ON clankers(state);
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `)
  return true
}

/** Copy Recovery's records: running clankers stay open, everything else is closed. */
const importLegacy = (db: Database, legacyPath: string) => {
  if (!existsSync(legacyPath)) return 0
  const legacy = new Database(legacyPath, { readonly: true })
  try {
    const present = new Set((legacy.query("PRAGMA table_info(desired_clankers)").all() as { name: string }[]).map((column) => column.name))
    if (!present.size) return 0
    const sessionLabel = present.has("preferred_session_label") ? "preferred_session_label" : "tmux_session_name"
    const windowLabel = present.has("preferred_window_label") ? "preferred_window_label" : "tmux_window_name"
    const ownerUnit = present.has("owner_unit") ? "owner_unit" : "NULL"
    const rows = legacy.query(`SELECT clanker_id, harness, workshop_id, workshop_path, ${sessionLabel} AS session_label, ${windowLabel} AS window_label, cwd, harness_session_id, launch_spec, original_task, desired_state, ${ownerUnit} AS owner_unit, created_at, updated_at FROM desired_clankers`).all() as (Omit<Row, "state" | "closed_reason" | "server_epoch"> & { desired_state: string })[]
    const insert = db.query(`INSERT OR IGNORE INTO clankers (${columns}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?15)`)
    db.transaction(() => {
      for (const row of rows) {
        const open = row.desired_state === "running"
        insert.run(row.clanker_id, row.harness, row.workshop_id, row.workshop_path, row.session_label, row.window_label, row.cwd, row.harness_session_id, row.launch_spec, row.original_task, open ? "open" : "closed", open ? null : `imported-${row.desired_state}`, row.owner_unit, row.created_at, row.updated_at)
      }
    }).immediate()
    return rows.length
  } finally { legacy.close() }
}

export interface OpenLedgerOptions { dbPath?: string; legacyPath?: string; now?: () => number }

export class ClankerLedger {
  readonly dbPath: string
  private readonly db: Database
  private readonly clock: () => number

  private constructor(dbPath: string, db: Database, clock: () => number) {
    this.dbPath = dbPath
    this.db = db
    this.clock = clock
  }

  static open(options: OpenLedgerOptions = {}) {
    const dbPath = options.dbPath ?? ledgerStatePath()
    ensurePermissions(dbPath)
    const previousUmask = process.umask(0o077)
    let db: Database
    try { db = new Database(dbPath, { create: true, strict: true }) }
    finally { process.umask(previousUmask) }
    try {
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = FULL")
      if (initialize(db)) importLegacy(db, options.legacyPath ?? (options.dbPath ? join(dirname(options.dbPath), "recovery.sqlite3") : legacyRecoveryStatePath()))
      ensurePermissions(dbPath)
      return new ClankerLedger(dbPath, db, options.now ?? Date.now)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() {
    this.db.close()
    ensurePermissions(this.dbPath)
  }

  /** Record a newly launched or adopted clanker as open. */
  record(input: LedgerInput) {
    const clanker = validateInput(input)
    const now = this.clock()
    return this.db.transaction(() => {
      if (this.get(clanker.clankerId)) throw new Error(`Clanker ${clanker.clankerId} already exists`)
      this.db.query(`INSERT INTO clankers (${columns}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', NULL, NULL, NULL, ?11, ?11)`)
        .run(clanker.clankerId, clanker.harness, clanker.workshopId, clanker.workshopPath, clanker.sessionLabel, clanker.windowLabel, clanker.cwd, clanker.harnessSessionId, JSON.stringify(clanker.launchSpec), clanker.originalTask, now)
      return this.get(clanker.clankerId)!
    }).immediate()
  }

  get(clankerId: string) {
    const row = this.db.query(`SELECT ${columns} FROM clankers WHERE clanker_id = ?1`).get(clankerId) as Row | null
    return row ? fromRow(row) : undefined
  }

  list(options: { state?: LedgerState; workshopId?: string } = {}) {
    const rows = this.db.query(`SELECT ${columns} FROM clankers WHERE (?1 IS NULL OR state = ?1) AND (?2 IS NULL OR workshop_id = ?2) ORDER BY created_at, clanker_id`)
      .all(options.state ?? null, options.workshopId ?? null) as Row[]
    return rows.map(fromRow)
  }

  /** The harness owns its session: `/clear`, a resume or a new session moves the clanker on. */
  bindSession(clankerId: string, harnessSessionId: string) {
    assertText(harnessSessionId, "harness session id", { max: 512 })
    const current = this.get(clankerId)
    if (!current) throw new Error(`Unknown clanker ${clankerId}`)
    if (current.harnessSessionId === harnessSessionId) return current
    this.db.query("UPDATE clankers SET harness_session_id = ?2, updated_at = ?3 WHERE clanker_id = ?1").run(clankerId, harnessSessionId, this.clock())
    return this.get(clankerId)!
  }

  setOwnerUnit(clankerId: string, ownerUnit: string) {
    this.db.query("UPDATE clankers SET owner_unit = ?2, updated_at = ?3 WHERE clanker_id = ?1").run(clankerId, ownerUnit, this.clock())
  }

  /** Mark a clanker open again, as when it is resumed. */
  reopen(clankerId: string) {
    this.db.query("UPDATE clankers SET state = 'open', closed_reason = NULL, server_epoch = NULL, updated_at = ?2 WHERE clanker_id = ?1").run(clankerId, this.clock())
  }

  /** Close an open clanker that ended for `reason`. */
  end(clankerId: string, reason: string) {
    this.db.query("UPDATE clankers SET state = 'closed', closed_reason = ?2, updated_at = ?3 WHERE clanker_id = ?1 AND state = 'open'").run(clankerId, reason, this.clock())
  }

  /**
   * Apply one observation of the clankers alive in Herdr server `serverEpoch`. Alive clankers
   * are open, follow their harness session and are stamped with the epoch; a tracked harness the
   * ledger has not seen is adopted. An open clanker that `missing` says has been gone long enough,
   * and was last seen in this same server or never seen at all, ended and is closed. One last
   * seen in an earlier server was interrupted by its restart and stays open.
   */
  sync(observed: readonly ObservedClanker[], serverEpoch: string, missing: (clankerId: string) => boolean) {
    const now = this.clock()
    const alive = new Set(observed.map((clanker) => clanker.clankerId))
    this.db.transaction(() => {
      for (const clanker of observed) {
        const row = this.get(clanker.clankerId)
        if (!row) {
          if (!isLedgerHarness(clanker.harness) || !clanker.harnessSessionId) continue
          this.record({
            clankerId: clanker.clankerId,
            harness: clanker.harness,
            workshopId: clanker.workshopId,
            workshopPath: clanker.workshopPath,
            sessionLabel: clanker.sessionLabel,
            windowLabel: clanker.windowLabel,
            cwd: clanker.cwd,
            harnessSessionId: clanker.harnessSessionId,
            launchSpec: { version: 1, profile: null },
            originalTask: "Adopted a live session; continue the most recent unfinished user request.",
          })
        } else if (clanker.harnessSessionId && clanker.harnessSessionId !== row.harnessSessionId) {
          this.bindSession(clanker.clankerId, clanker.harnessSessionId)
        }
        this.db.query("UPDATE clankers SET state = 'open', closed_reason = NULL, server_epoch = ?2, updated_at = ?3 WHERE clanker_id = ?1 AND (state != 'open' OR server_epoch IS NOT ?2)")
          .run(clanker.clankerId, serverEpoch, now)
      }
      for (const row of this.list({ state: "open" })) {
        if (alive.has(row.clankerId) || (row.serverEpoch !== serverEpoch && row.serverEpoch !== null) || !missing(row.clankerId)) continue
        this.end(row.clankerId, "ended")
      }
    }).immediate()
  }
}

export interface ObservedClanker {
  clankerId: string
  harness: string
  harnessSessionId?: string
  workshopId: string
  workshopPath: string
  cwd: string
  sessionLabel: string
  windowLabel: string
}

/** The Workshop id of a path with no registered Workshop. */
export const pathWorkshopId = (path: string) => `path-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`

export const isLedgerHarness = (harness: unknown): harness is LedgerHarness => harness === "pi" || harness === "claude" || harness === "opencode"

export const openClankerLedger = (options: OpenLedgerOptions = {}) => ClankerLedger.open(options)

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { instanceSlug } from "./paths"

export type ResourceKind = "session" | "window" | "terminal"

export interface MultiplexerLocation {
  kind: string
  instanceId: string
  nativeSessionId: string
  nativeWindowId: string | null
  nativePaneId: string | null
  observedAt: number
}

export interface ResourceRecord {
  id: string
  kind: ResourceKind
  workshopId: string
  parentId: string | null
  displayName: string
  createdAt: number
  updatedAt: number
  location: MultiplexerLocation | null
}

export interface NativeLocationInput {
  kind: string
  instanceId: string
  nativeSessionId: string
  nativeWindowId?: string | null
  nativePaneId?: string | null
  observedAt?: number
}

export interface UpsertResourceInput {
  id?: string
  kind: ResourceKind
  workshopId: string
  parentId?: string | null
  displayName: string
  location?: NativeLocationInput | null
}

export interface ListResourcesOptions {
  kind?: ResourceKind
  workshopId?: string
  parentId?: string | null
}

export interface OpenResourceRegistryOptions {
  dbPath?: string
  now?: () => number
}

interface ResourceRow {
  id: string
  kind: ResourceKind
  workshop_id: string
  parent_id: string | null
  display_name: string
  created_at: number
  updated_at: number
  location_kind: string | null
  instance_id: string | null
  native_session_id: string | null
  native_window_id: string | null
  native_pane_id: string | null
  observed_at: number | null
}

interface StoredLocation {
  kind: string
  instanceId: string
  nativeSessionId: string
  nativeWindowId: string
  nativePaneId: string
  observedAt: number
}

const schemaVersion = 1
const resourceColumns = `
  r.id, r.kind, r.workshop_id, r.parent_id, r.display_name, r.created_at, r.updated_at,
  l.kind AS location_kind, l.instance_id, l.native_session_id, l.native_window_id,
  l.native_pane_id, l.observed_at`

export const resourceRegistryStatePath = (stateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state"), env: Record<string, string | undefined> = Bun.env) =>
  join(stateHome, `clankerhouse${instanceSlug(env)}`, "resources.sqlite3")

const initialize = (db: Database) => {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
  if (current > schemaVersion) throw new Error(`Unsupported resource registry version ${current}`)
  if (current === schemaVersion) return
  if (current !== 0) throw new Error(`Unsupported resource registry version ${current}`)
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('session', 'window', 'terminal')),
      workshop_id TEXT NOT NULL,
      parent_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX resources_workshop_idx ON resources(workshop_id, kind);
    CREATE INDEX resources_parent_idx ON resources(parent_id);

    CREATE TABLE multiplexer_locations (
      resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      native_window_id TEXT NOT NULL,
      native_pane_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      UNIQUE(kind, instance_id, native_session_id, native_window_id, native_pane_id)
    );
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

const rowToRecord = (row: ResourceRow): ResourceRecord => ({
  id: row.id,
  kind: row.kind,
  workshopId: row.workshop_id,
  parentId: row.parent_id,
  displayName: row.display_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  location: row.location_kind === null ? null : {
    kind: row.location_kind,
    instanceId: row.instance_id!,
    nativeSessionId: row.native_session_id!,
    nativeWindowId: row.native_window_id || null,
    nativePaneId: row.native_pane_id || null,
    observedAt: row.observed_at!,
  },
})

const requiredText = (value: string, label: string) => {
  if (!value || value.trim() !== value || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

const idFor = (kind: ResourceKind) => `${kind === "session" ? "mux-session" : kind === "window" ? "mux-window" : "terminal"}-${randomUUID()}`

export class ResourceRegistry {
  readonly dbPath: string
  private readonly db: Database
  private readonly clock: () => number

  private constructor(dbPath: string, db: Database, clock: () => number) {
    this.dbPath = dbPath
    this.db = db
    this.clock = clock
  }

  static open(options: OpenResourceRegistryOptions = {}) {
    const dbPath = options.dbPath ?? resourceRegistryStatePath()
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { create: true, strict: true })
    try {
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("PRAGMA foreign_keys = ON")
      db.exec("PRAGMA journal_mode = WAL")
      initialize(db)
      return new ResourceRegistry(dbPath, db, options.now ?? Date.now)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() { this.db.close() }

  transaction<T>(operation: (registry: ResourceRegistry) => T) {
    return this.db.transaction(() => operation(this)).immediate()
  }

  private timestamp(value?: number) {
    const timestamp = value ?? this.clock()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid timestamp")
    return timestamp
  }

  private location(resourceKind: ResourceKind, input: NativeLocationInput, observedAt?: number): StoredLocation {
    const location = {
      kind: requiredText(input.kind, "multiplexer kind"),
      instanceId: requiredText(input.instanceId, "multiplexer instance id"),
      nativeSessionId: requiredText(input.nativeSessionId, "native session id"),
      nativeWindowId: input.nativeWindowId ?? "",
      nativePaneId: input.nativePaneId ?? "",
      observedAt: this.timestamp(input.observedAt ?? observedAt),
    }
    if (location.nativeWindowId) requiredText(location.nativeWindowId, "native window id")
    if (location.nativePaneId) requiredText(location.nativePaneId, "native pane id")
    if (resourceKind === "session" && (location.nativeWindowId || location.nativePaneId)) throw new Error("Session locations cannot include native window or pane ids")
    if (resourceKind === "window" && (!location.nativeWindowId || location.nativePaneId)) throw new Error("Window locations require a native window id and no pane id")
    if (resourceKind === "terminal" && (!location.nativeWindowId || !location.nativePaneId)) throw new Error("Terminal locations require native window and pane ids")
    return location
  }

  private assertParent(kind: ResourceKind, workshopId: string, parentId: string | null) {
    const expected = kind === "window" ? "session" : kind === "terminal" ? "window" : null
    if (!expected) {
      if (parentId !== null) throw new Error("Session resources cannot have a parent")
      return
    }
    if (!parentId) throw new Error(`${kind} resources require a parent`)
    const parent = this.get(parentId)
    if (!parent) throw new Error(`Unknown parent resource ${parentId}`)
    if (parent.kind !== expected) throw new Error(`${kind} resources require a ${expected} parent`)
    if (parent.workshopId !== workshopId) throw new Error("Parent resource belongs to a different workshop")
  }

  private replaceLocation(resourceId: string, location: StoredLocation) {
    const claimed = this.db.query(`
      SELECT resource_id FROM multiplexer_locations
      WHERE kind = ?1 AND instance_id = ?2 AND native_session_id = ?3 AND native_window_id = ?4 AND native_pane_id = ?5
    `).get(location.kind, location.instanceId, location.nativeSessionId, location.nativeWindowId, location.nativePaneId) as { resource_id: string } | null
    if (claimed && claimed.resource_id !== resourceId) throw new Error(`Native location is already claimed by resource ${claimed.resource_id}`)
    this.db.query(`
      INSERT INTO multiplexer_locations (resource_id, kind, instance_id, native_session_id, native_window_id, native_pane_id, observed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(resource_id) DO UPDATE SET kind = excluded.kind, instance_id = excluded.instance_id,
        native_session_id = excluded.native_session_id, native_window_id = excluded.native_window_id,
        native_pane_id = excluded.native_pane_id, observed_at = excluded.observed_at
    `).run(resourceId, location.kind, location.instanceId, location.nativeSessionId, location.nativeWindowId, location.nativePaneId, location.observedAt)
  }

  upsert(input: UpsertResourceInput, options: { now?: number } = {}) {
    if (!["session", "window", "terminal"].includes(input.kind)) throw new Error("Invalid resource kind")
    const workshopId = requiredText(input.workshopId, "workshop id")
    const displayName = requiredText(input.displayName, "display name")
    const parentId = input.parentId ?? null
    const now = this.timestamp(options.now)
    const location = input.location ? this.location(input.kind, input.location, now) : null
    return this.transaction(() => {
      let existing = input.id ? this.get(input.id) : location ? this.findByNativeLocation(location) : undefined
      if (existing) {
        if (existing.kind !== input.kind || existing.workshopId !== workshopId || existing.parentId !== parentId) throw new Error(`Resource ${existing.id} identity does not match upsert input`)
        this.assertParent(input.kind, workshopId, parentId)
        if (location) this.replaceLocation(existing.id, location)
        const changed = existing.displayName !== displayName || (location !== null && JSON.stringify(existing.location) !== JSON.stringify({ ...location, nativeWindowId: location.nativeWindowId || null, nativePaneId: location.nativePaneId || null }))
        if (changed) this.db.query("UPDATE resources SET display_name = ?2, updated_at = ?3 WHERE id = ?1").run(existing.id, displayName, now)
        return this.get(existing.id)!
      }
      this.assertParent(input.kind, workshopId, parentId)
      const id = input.id ? requiredText(input.id, "resource id") : idFor(input.kind)
      this.db.query("INSERT INTO resources (id, kind, workshop_id, parent_id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)")
        .run(id, input.kind, workshopId, parentId, displayName, now)
      if (location) this.replaceLocation(id, location)
      return this.get(id)!
    })
  }

  get(id: string) {
    const row = this.db.query(`SELECT ${resourceColumns} FROM resources r LEFT JOIN multiplexer_locations l ON l.resource_id = r.id WHERE r.id = ?1`).get(id) as ResourceRow | null
    return row ? rowToRecord(row) : undefined
  }

  list(options: ListResourcesOptions = {}) {
    const rows = this.db.query(`
      SELECT ${resourceColumns} FROM resources r LEFT JOIN multiplexer_locations l ON l.resource_id = r.id
      WHERE (?1 IS NULL OR r.kind = ?1) AND (?2 IS NULL OR r.workshop_id = ?2)
        AND (?3 = 0 OR r.parent_id IS ?4)
      ORDER BY r.created_at, r.id
    `).all(options.kind ?? null, options.workshopId ?? null, "parentId" in options ? 1 : 0, options.parentId ?? null) as ResourceRow[]
    return rows.map(rowToRecord)
  }

  findByNativeLocation(input: NativeLocationInput) {
    const windowId = input.nativeWindowId ?? ""
    const paneId = input.nativePaneId ?? ""
    const row = this.db.query(`
      SELECT ${resourceColumns} FROM resources r JOIN multiplexer_locations l ON l.resource_id = r.id
      WHERE l.kind = ?1 AND l.instance_id = ?2 AND l.native_session_id = ?3 AND l.native_window_id = ?4 AND l.native_pane_id = ?5
    `).get(input.kind, input.instanceId, input.nativeSessionId, windowId, paneId) as ResourceRow | null
    return row ? rowToRecord(row) : undefined
  }

  updateLocation(resourceId: string, input: NativeLocationInput | null, options: { now?: number } = {}) {
    const now = this.timestamp(options.now)
    return this.transaction(() => {
      const resource = this.get(resourceId)
      if (!resource) throw new Error(`Unknown resource ${resourceId}`)
      if (input === null) this.db.query("DELETE FROM multiplexer_locations WHERE resource_id = ?1").run(resourceId)
      else this.replaceLocation(resourceId, this.location(resource.kind, input, now))
      this.db.query("UPDATE resources SET updated_at = ?2 WHERE id = ?1").run(resourceId, now)
      return this.get(resourceId)!
    })
  }

  updateDisplayName(resourceId: string, displayName: string, options: { now?: number } = {}) {
    const name = requiredText(displayName, "display name")
    const now = this.timestamp(options.now)
    const changed = this.db.query("UPDATE resources SET display_name = ?2, updated_at = ?3 WHERE id = ?1").run(resourceId, name, now)
    if (changed.changes !== 1) throw new Error(`Unknown resource ${resourceId}`)
    return this.get(resourceId)!
  }
}

export const openResourceRegistry = (options: OpenResourceRegistryOptions = {}) => ResourceRegistry.open(options)

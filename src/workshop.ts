import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export type LineageMode = "off" | "best-effort" | "strict"
export interface LineageIdentity { path: string; commonDir: string; branch: string }
export interface WorkshopManifest {
  version: 1
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
export interface WorkshopRecord extends WorkshopManifest {}
export interface WorkshopDetails extends WorkshopRecord {
  parent?: WorkshopRecord
  children: WorkshopRecord[]
  exists: boolean
}
export interface WorkshopTreeNode extends WorkshopDetails { children: WorkshopTreeNode[] }
export interface ProjectSnapshot {
  repoId: string
  commonDir: string
  workshops: WorkshopRecord[]
}
export interface ReconcileResult {
  repoId: string
  commonDir: string
  workshops: WorkshopRecord[]
  removedPaths: string[]
  rewrittenManifestPaths: string[]
}
export interface LineageSnapshot { byPath: Map<string, WorkshopRecord & { childWorkshopCount: number }>; byId: Map<string, WorkshopRecord & { childWorkshopCount: number }> }

const schemaVersion = 1
const manifestVersion = 1
const manifestRelativePath = ".clankerhouse/workshop.json"
const manifestIgnoreRule = "/.clankerhouse/workshop.json"
const defaultStateHome = `${Bun.env.XDG_STATE_HOME || `${Bun.env.HOME || ""}/.local/state`}`
export const workshopStatePath = `${defaultStateHome}/clankerhouse/workshops.sqlite3`
const previousWorkshopStatePath = `${defaultStateHome}/alt-k-tui/workspaces.sqlite3`

interface RepoRow { id: string; common_dir: string; created_at: number; updated_at: number }
interface WorkshopRow {
  id: string
  repo_id: string
  canonical_path: string
  branch: string
  parent_id: string | null
  revision: number
  created_at: number
  updated_at: number
}

const canonicalPath = (path: string) => {
  const expanded = path === "~" ? Bun.env.HOME || path : path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path
  try { return realpathSync(expanded) }
  catch { return resolve(expanded) }
}

const clankerhouseDirectoryPathFor = (path: string) => `${canonicalPath(path)}/.clankerhouse`
const manifestPathFor = (path: string) => `${canonicalPath(path)}/${manifestRelativePath}`
const openStore = (dbPath = workshopStatePath) => {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null
  if (journalMode?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL")
  initializeStore(db)
  return db
}

const initializeStore = (db: Database) => {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
  if (current > schemaVersion) throw new Error(`Unsupported workshop lineage store version ${current}`)
  if (current === schemaVersion) return
  if (current === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        common_dir TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workshops (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        canonical_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        parent_id TEXT REFERENCES workshops(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workshops_repo_id_idx ON workshops(repo_id);
      CREATE INDEX IF NOT EXISTS workshops_parent_id_idx ON workshops(parent_id);
      PRAGMA user_version = 1;
    `)
    return
  }
  throw new Error(`Unsupported workshop lineage store version ${current}`)
}

const rowToRecord = (row: WorkshopRow & { common_dir?: string; repo_common_dir?: string; commonDir?: string }): WorkshopRecord => ({
  version: manifestVersion,
  workshopId: row.id,
  repoId: row.repo_id,
  canonicalPath: row.canonical_path,
  commonDir: row.common_dir || row.repo_common_dir || row.commonDir || "",
  branch: row.branch,
  parentWorkshopId: row.parent_id,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const parseManifest = (filePath: string) => {
  let raw: Partial<WorkshopManifest>
  try { raw = JSON.parse(readFileSync(filePath, "utf8")) as typeof raw }
  catch { throw new Error(`Malformed workshop manifest at ${filePath}`) }
  if (raw.version !== manifestVersion || !raw.workshopId || !raw.repoId || !raw.canonicalPath || !raw.commonDir || !raw.branch || !Number.isInteger(raw.revision) || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)) {
    throw new Error(`Malformed workshop manifest at ${filePath}`)
  }
  return {
    version: manifestVersion,
    workshopId: raw.workshopId,
    repoId: raw.repoId,
    canonicalPath: canonicalPath(raw.canonicalPath),
    commonDir: canonicalPath(raw.commonDir),
    branch: raw.branch,
    parentWorkshopId: raw.parentWorkshopId ?? null,
    revision: Number(raw.revision),
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  } satisfies WorkshopManifest
}

const trackedManifest = (path: string) => Bun.spawnSync(["git", "-C", path, "ls-files", "--error-unmatch", "--", manifestRelativePath], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
const lstatSafe = (path: string) => { try { return lstatSync(path) } catch { return undefined } }
const assertManifestParentSafe = (path: string) => {
  const directory = clankerhouseDirectoryPathFor(path)
  const stats = lstatSafe(directory)
  if (stats?.isSymbolicLink()) throw new Error(`Workshop manifest directory is a symlink: ${directory}`)
}

const worktreeExcludePath = (path: string) => {
  const result = Bun.spawnSync(["git", "-C", path, "rev-parse", "--git-path", "info/exclude"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `Unable to resolve .git/info/exclude for ${path}`)
  const resolved = result.stdout.toString().trim()
  return resolved.startsWith("/") ? resolved : resolve(path, resolved)
}

const ensureManifestIgnored = (path: string) => {
  assertManifestParentSafe(path)
  const excludePath = worktreeExcludePath(path)
  mkdirSync(dirname(excludePath), { recursive: true })
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  const lines = current.split(/\r?\n/).filter(Boolean)
  if (lines.includes(manifestIgnoreRule)) return
  const next = current.length === 0 ? `${manifestIgnoreRule}\n` : current.endsWith("\n") ? `${current}${manifestIgnoreRule}\n` : `${current}\n${manifestIgnoreRule}\n`
  const tmp = `${excludePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, next)
  renameSync(tmp, excludePath)
}

const readLocalManifest = (identity: LineageIdentity) => {
  const manifestPath = manifestPathFor(identity.path)
  assertManifestParentSafe(identity.path)
  if (trackedManifest(canonicalPath(identity.path))) throw new Error(`Refusing to overwrite tracked ${manifestRelativePath} in ${canonicalPath(identity.path)}`)
  const stats = lstatSafe(manifestPath)
  if (!stats) return undefined
  if (stats.isSymbolicLink()) throw new Error(`Workshop manifest is a symlink: ${manifestPath}`)
  const manifest = parseManifest(manifestPath)
  if (manifest.canonicalPath !== canonicalPath(identity.path) || manifest.commonDir !== canonicalPath(identity.commonDir)) {
    throw new Error(`Workshop manifest conflicts with local identity at ${manifestPath}`)
  }
  return manifest
}

const writeManifest = (identity: LineageIdentity, manifest: WorkshopManifest) => {
  const worktreePath = canonicalPath(identity.path)
  assertManifestParentSafe(worktreePath)
  if (trackedManifest(worktreePath)) throw new Error(`Refusing to overwrite tracked ${manifestRelativePath} in ${worktreePath}`)
  ensureManifestIgnored(worktreePath)
  const target = manifestPathFor(worktreePath)
  const currentStats = lstatSafe(target)
  if (currentStats?.isSymbolicLink()) throw new Error(`Workshop manifest is a symlink: ${target}`)
  if (currentStats) {
    const current = parseManifest(target)
    if (current.workshopId !== manifest.workshopId || current.repoId !== manifest.repoId || current.canonicalPath !== manifest.canonicalPath || current.commonDir !== manifest.commonDir) {
      throw new Error(`Workshop manifest conflicts with authoritative lineage at ${target}`)
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(tmp, target)
}

const repoByCommonDir = (db: Database, commonDir: string) => db.query("SELECT id, common_dir, created_at, updated_at FROM repositories WHERE common_dir = ?1").get(canonicalPath(commonDir)) as RepoRow | null
const workshopByPath = (db: Database, path: string) => db.query("SELECT id, repo_id, canonical_path, branch, parent_id, revision, created_at, updated_at FROM workshops WHERE canonical_path = ?1").get(canonicalPath(path)) as WorkshopRow | null
const workshopById = (db: Database, id: string) => db.query("SELECT id, repo_id, canonical_path, branch, parent_id, revision, created_at, updated_at FROM workshops WHERE id = ?1").get(id) as WorkshopRow | null
const workshopRowsForRepo = (db: Database, repoId: string, includeCommonDir = false) => db.query(`
  SELECT w.id, w.repo_id, w.canonical_path, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at${includeCommonDir ? ", r.common_dir" : ""}
  FROM workshops w
  JOIN repositories r ON r.id = w.repo_id
  WHERE w.repo_id = ?1
  ORDER BY w.canonical_path
`).all(repoId) as Array<WorkshopRow & { common_dir?: string }>

const ensureRepo = (db: Database, commonDir: string, preferredId: string | undefined, now: number) => {
  const canonicalCommonDir = canonicalPath(commonDir)
  const existing = repoByCommonDir(db, canonicalCommonDir)
  if (existing) {
    db.query("UPDATE repositories SET updated_at = ?2 WHERE id = ?1").run(existing.id, now)
    return { ...existing, updated_at: now }
  }
  if (preferredId) {
    const conflict = db.query("SELECT id, common_dir FROM repositories WHERE id = ?1").get(preferredId) as { id: string; common_dir: string } | null
    if (conflict && conflict.common_dir !== canonicalCommonDir) throw new Error(`Repository id ${preferredId} already belongs to ${conflict.common_dir}`)
  }
  const repo: RepoRow = { id: preferredId || randomUUID(), common_dir: canonicalCommonDir, created_at: now, updated_at: now }
  db.query("INSERT INTO repositories (id, common_dir, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)").run(repo.id, repo.common_dir, repo.created_at, repo.updated_at)
  return repo
}

const assertParentAllowed = (db: Database, childId: string, repoId: string, parentId: string | null) => {
  if (!parentId) return
  if (parentId === childId) throw new Error(`Workshop ${childId} cannot parent itself`)
  const parent = workshopById(db, parentId)
  if (!parent) throw new Error(`Parent workshop ${parentId} does not exist`)
  if (parent.repo_id !== repoId) throw new Error(`Workshop ${childId} cannot attach to parent ${parentId} from another repository`)
  let cursor: WorkshopRow | null = parent
  const seen = new Set<string>()
  while (cursor) {
    if (cursor.id === childId) throw new Error(`Workshop ${childId} cannot create a lineage cycle`)
    if (!cursor.parent_id || seen.has(cursor.parent_id)) return
    seen.add(cursor.parent_id)
    cursor = workshopById(db, cursor.parent_id)
  }
}

const upsertWorkshop = (db: Database, identity: LineageIdentity, options: { parentWorkshopId?: string | null; preserveParent?: boolean; writeProjection?: boolean; preferredManifest?: WorkshopManifest; now?: number } = {}) => {
  const canonicalIdentity = { ...identity, path: canonicalPath(identity.path), commonDir: canonicalPath(identity.commonDir) }
  const manifest = options.preferredManifest ?? readLocalManifest(canonicalIdentity)
  const now = options.now ?? Date.now()
  const repo = ensureRepo(db, canonicalIdentity.commonDir, manifest?.repoId, now)
  const existing = workshopByPath(db, canonicalIdentity.path)
  if (manifest?.workshopId) {
    const conflicting = workshopById(db, manifest.workshopId)
    if (conflicting && conflicting.canonical_path !== canonicalIdentity.path) throw new Error(`Workshop id ${manifest.workshopId} already belongs to ${conflicting.canonical_path}`)
  }
  const workshopId = existing?.id || manifest?.workshopId || randomUUID()
  const preserveParent = options.preserveParent !== false
  const desiredParent = options.parentWorkshopId !== undefined ? options.parentWorkshopId : preserveParent ? existing?.parent_id ?? manifest?.parentWorkshopId ?? null : null
  assertParentAllowed(db, workshopId, repo.id, desiredParent)
  const createdAt = existing?.created_at ?? manifest?.createdAt ?? now
  const previousRevision = existing?.revision ?? manifest?.revision ?? 0
  const changed = !existing || existing.branch !== canonicalIdentity.branch || existing.parent_id !== desiredParent || existing.repo_id !== repo.id
  const revision = changed ? Math.max(1, previousRevision + (existing ? 1 : 0)) : previousRevision || 1
  const record: WorkshopRecord = {
    version: manifestVersion,
    workshopId,
    repoId: repo.id,
    canonicalPath: canonicalIdentity.path,
    commonDir: canonicalIdentity.commonDir,
    branch: canonicalIdentity.branch,
    parentWorkshopId: desiredParent,
    revision,
    createdAt,
    updatedAt: now,
  }
  if (existing) {
    db.query("UPDATE workshops SET repo_id = ?2, branch = ?3, parent_id = ?4, revision = ?5, updated_at = ?6 WHERE id = ?1").run(record.workshopId, record.repoId, record.branch, record.parentWorkshopId, record.revision, record.updatedAt)
  } else {
    db.query("INSERT INTO workshops (id, repo_id, canonical_path, branch, parent_id, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").run(record.workshopId, record.repoId, record.canonicalPath, record.branch, record.parentWorkshopId, record.revision, record.createdAt, record.updatedAt)
  }
  if (options.writeProjection !== false) writeManifest(canonicalIdentity, record)
  return record
}

const worktreePathsForRepo = (cwd: string) => {
  const current = identifyWorkshopSync(cwd)
  const listed = Bun.spawnSync(["git", "-C", current.path, "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" })
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString().trim() || `Unable to list worktrees for ${current.path}`)
  const paths: string[] = []
  for (const line of listed.stdout.toString().split("\n")) {
    if (line.startsWith("worktree ")) paths.push(canonicalPath(line.slice("worktree ".length)))
  }
  return { current, paths }
}

export const lineageMode = (): LineageMode => {
  const mode = Bun.env.DOTFILES_WORKSHOP_LINEAGE || "best-effort"
  return mode === "off" || mode === "strict" ? mode : "best-effort"
}

export const identifyWorkshopSync = (cwd = process.cwd()): LineageIdentity => {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "pipe" })
  if (top.exitCode !== 0) throw new Error(top.stderr.toString().trim() || `Unable to resolve worktree for ${cwd}`)
  const path = canonicalPath(top.stdout.toString().trim())
  const common = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: path, stdout: "pipe", stderr: "pipe" })
  if (common.exitCode !== 0) throw new Error(common.stderr.toString().trim() || `Unable to resolve common dir for ${path}`)
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: path, stdout: "pipe", stderr: "pipe" })
  if (branch.exitCode !== 0) throw new Error(branch.stderr.toString().trim() || `Unable to resolve branch for ${path}`)
  return { path, commonDir: canonicalPath(resolve(path, common.stdout.toString().trim())), branch: branch.stdout.toString().trim() || "detached" }
}

export const persistWorkshopLineage = (identity: LineageIdentity, options: { parentWorkshopId?: string | null; preserveParent?: boolean; mode?: LineageMode; dbPath?: string } = {}) => {
  const mode = options.mode ?? lineageMode()
  if (mode === "off") return undefined
  try {
    return registerWorkshop(identity, { parentWorkshopId: options.parentWorkshopId, preserveParent: options.preserveParent, dbPath: options.dbPath })
  } catch (error) {
    if (mode === "strict") throw error
    return undefined
  }
}

export const registerWorkshop = (identity: LineageIdentity, options: { parentWorkshopId?: string | null; preserveParent?: boolean; dbPath?: string } = {}) => {
  const db = openStore(options.dbPath)
  try {
    return db.transaction(() => upsertWorkshop(db, identity, { parentWorkshopId: options.parentWorkshopId, preserveParent: options.preserveParent })).immediate()
  } finally {
    db.close()
  }
}

export const workshopForPath = (path: string, dbPath = workshopStatePath) => {
  if (!existsSync(dbPath)) return undefined
  const db = openStore(dbPath)
  try {
    const row = db.query(`
      SELECT w.id, w.repo_id, w.canonical_path, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at, r.common_dir
      FROM workshops w
      JOIN repositories r ON r.id = w.repo_id
      WHERE w.canonical_path = ?1
    `).get(canonicalPath(path)) as (WorkshopRow & { common_dir: string }) | null
    return row ? rowToRecord(row) : undefined
  } finally {
    db.close()
  }
}

export const workshopForId = (id: string, dbPath = workshopStatePath) => {
  if (!existsSync(dbPath)) return undefined
  const db = openStore(dbPath)
  try {
    const row = db.query(`
      SELECT w.id, w.repo_id, w.canonical_path, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at, r.common_dir
      FROM workshops w
      JOIN repositories r ON r.id = w.repo_id
      WHERE w.id = ?1
    `).get(id) as (WorkshopRow & { common_dir: string }) | null
    return row ? rowToRecord(row) : undefined
  } finally {
    db.close()
  }
}

export const attachWorkshopToParent = (workshopId: string, parentWorkshopId: string, dbPath = workshopStatePath) => {
  const workshop = workshopForId(workshopId, dbPath)
  if (!workshop) throw new Error(`Workshop ${workshopId} does not exist`)
  if (workshop.parentWorkshopId === parentWorkshopId) return workshop
  return registerWorkshop({ path: workshop.canonicalPath, commonDir: workshop.commonDir, branch: workshop.branch }, {
    parentWorkshopId,
    preserveParent: false,
    dbPath,
  })
}

export const detachWorkshopFromParent = (workshopId: string, dbPath = workshopStatePath) => {
  const workshop = workshopForId(workshopId, dbPath)
  if (!workshop) throw new Error(`Workshop ${workshopId} does not exist`)
  if (workshop.parentWorkshopId === null) return workshop
  return registerWorkshop({ path: workshop.canonicalPath, commonDir: workshop.commonDir, branch: workshop.branch }, {
    parentWorkshopId: null,
    preserveParent: false,
    dbPath,
  })
}

export const attachmentCandidatesForWorkshop = (workshopId: string, dbPath = workshopStatePath) => {
  const workshop = workshopForId(workshopId, dbPath)
  if (!workshop) throw new Error(`Workshop ${workshopId} does not exist`)
  const project = projectSnapshot(workshop.canonicalPath, dbPath)
  const childrenByParent = Map.groupBy(project.workshops, (candidate) => candidate.parentWorkshopId || "")
  const blocked = new Set([workshopId])
  const visitChildren = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (blocked.has(child.workshopId)) continue
      blocked.add(child.workshopId)
      visitChildren(child.workshopId)
    }
  }
  visitChildren(workshopId)
  return project.workshops.filter((candidate) => !blocked.has(candidate.workshopId) && candidate.workshopId !== workshop.parentWorkshopId)
}

export const projectSnapshot = (cwd = process.cwd(), dbPath = workshopStatePath): ProjectSnapshot => {
  const identity = identifyWorkshopSync(cwd)
  const db = openStore(dbPath)
  try {
    const repo = repoByCommonDir(db, identity.commonDir)
    if (!repo) return { repoId: "", commonDir: identity.commonDir, workshops: [] }
    return { repoId: repo.id, commonDir: repo.common_dir, workshops: workshopRowsForRepo(db, repo.id, true).map(rowToRecord) }
  } finally {
    db.close()
  }
}

const detailsForRecord = (record: WorkshopRecord, project: ProjectSnapshot) => ({
  ...record,
  parent: record.parentWorkshopId ? project.workshops.find((workshop) => workshop.workshopId === record.parentWorkshopId) : undefined,
  children: project.workshops.filter((workshop) => workshop.parentWorkshopId === record.workshopId),
  exists: existsSync(record.canonicalPath),
})

export const workshopDetails = (cwd = process.cwd(), options: { id?: string; path?: string; dbPath?: string } = {}): WorkshopDetails | undefined => {
  const dbPath = options.dbPath || workshopStatePath
  const record = options.id ? workshopForId(options.id, dbPath) : workshopForPath(options.path || cwd, dbPath)
  if (!record) return undefined
  return detailsForRecord(record, projectSnapshot(record.canonicalPath, dbPath))
}

export const workshopTree = (cwd = process.cwd(), dbPath = workshopStatePath): WorkshopTreeNode[] => {
  const project = projectSnapshot(cwd, dbPath)
  const byParent = Map.groupBy(project.workshops, (workshop) => workshop.parentWorkshopId || "")
  const buildNode = (workshop: WorkshopRecord): WorkshopTreeNode => ({
    ...detailsForRecord(workshop, project),
    children: (byParent.get(workshop.workshopId) ?? []).map(buildNode).sort((a, b) => a.branch.localeCompare(b.branch) || a.canonicalPath.localeCompare(b.canonicalPath)),
  })
  return (byParent.get("") ?? []).map(buildNode).sort((a, b) => a.branch.localeCompare(b.branch) || a.canonicalPath.localeCompare(b.canonicalPath))
}

const emptySnapshot = (): LineageSnapshot => ({ byPath: new Map(), byId: new Map() })

const addSnapshotRows = (snapshot: LineageSnapshot, dbPath: string, table: "workshops" | "workspaces") => {
  if (!existsSync(dbPath)) return
  const db = table === "workshops" ? openStore(dbPath) : new Database(dbPath, { readonly: true })
  try {
    const rows = db.query(`
      SELECT w.id, w.repo_id, w.canonical_path, w.branch, w.parent_id, w.revision, w.created_at, w.updated_at, r.common_dir,
             (SELECT COUNT(*) FROM ${table} child WHERE child.parent_id = w.id) AS child_count
      FROM ${table} w
      JOIN repositories r ON r.id = w.repo_id
    `).all() as Array<WorkshopRow & { common_dir: string; child_count: number }>
    for (const row of rows) {
      const record = { ...rowToRecord(row), childWorkshopCount: Number(row.child_count) || 0 }
      snapshot.byPath.set(record.canonicalPath, record)
      snapshot.byId.set(record.workshopId, record)
    }
  } finally {
    db.close()
  }
}

export const readLineageSnapshot = (dbPath = workshopStatePath, mode: LineageMode = lineageMode()): LineageSnapshot => {
  const snapshot = emptySnapshot()
  try {
    // Keep already-running workshops visible; current Clankerhouse records win.
    if (dbPath === workshopStatePath) addSnapshotRows(snapshot, previousWorkshopStatePath, "workspaces")
    addSnapshotRows(snapshot, dbPath, "workshops")
    return snapshot
  } catch (error) {
    if (mode === "strict") throw error
    return snapshot
  }
}

const validateBootstrapManifests = (current: LineageIdentity, manifests: Array<{ identity: LineageIdentity; manifest: WorkshopManifest }>) => {
  const repoId = manifests[0]?.manifest.repoId
  for (const { identity, manifest } of manifests) {
    if (identity.commonDir !== current.commonDir) throw new Error(`Workshop ${identity.path} belongs to ${identity.commonDir}, not ${current.commonDir}`)
    if (manifest.commonDir !== current.commonDir) throw new Error(`Workshop manifest at ${manifestPathFor(identity.path)} belongs to ${manifest.commonDir}, not ${current.commonDir}`)
    if (repoId && manifest.repoId !== repoId) throw new Error(`Workshop manifests for ${current.commonDir} disagree on repo id`)
  }
}

export const bootstrapRepositoryFromManifests = (cwd = process.cwd(), dbPath = workshopStatePath): ReconcileResult => {
  const { current, paths } = worktreePathsForRepo(cwd)
  const manifests = paths.map((path) => {
    const identity = identifyWorkshopSync(path)
    const manifest = readLocalManifest(identity)
    if (!manifest) throw new Error(`Missing workshop manifest at ${manifestPathFor(identity.path)}`)
    return { identity, manifest }
  })
  validateBootstrapManifests(current, manifests)
  const db = openStore(dbPath)
  try {
    return db.transaction(() => {
      const repo = ensureRepo(db, current.commonDir, manifests[0]?.manifest.repoId, Date.now())
      const existingRepo = workshopRowsForRepo(db, repo.id)
      if (existingRepo.length > 0) throw new Error(`Workshop lineage store already has ${existingRepo.length} row(s) for ${repo.common_dir}; clear it before bootstrap`)
      for (const { identity, manifest } of manifests) upsertWorkshop(db, identity, { preferredManifest: manifest, parentWorkshopId: null, preserveParent: false, writeProjection: false, now: manifest.updatedAt })
      for (const { identity, manifest } of manifests) upsertWorkshop(db, identity, { preferredManifest: manifest, parentWorkshopId: manifest.parentWorkshopId, preserveParent: false, writeProjection: false, now: manifest.updatedAt })
      const workshops = workshopRowsForRepo(db, repo.id, true).map(rowToRecord)
      return { repoId: repo.id, commonDir: repo.common_dir, workshops, removedPaths: [], rewrittenManifestPaths: [] } satisfies ReconcileResult
    }).immediate()
  } finally {
    db.close()
  }
}

export const reconcileRepositoryWorkshops = (cwd = process.cwd(), dbPath = workshopStatePath): ReconcileResult => {
  const { current, paths } = worktreePathsForRepo(cwd)
  const identities = paths.map((path) => identifyWorkshopSync(path))
  const db = openStore(dbPath)
  try {
    return db.transaction(() => {
      const repo = ensureRepo(db, current.commonDir, undefined, Date.now())
      const activePaths = new Set(identities.map((identity) => identity.path))
      const existingRows = workshopRowsForRepo(db, repo.id)
      const removedPaths = existingRows.filter((row) => !activePaths.has(row.canonical_path)).map((row) => row.canonical_path)
      for (const removedPath of removedPaths) db.query("DELETE FROM workshops WHERE canonical_path = ?1").run(removedPath)
      const rewrittenManifestPaths: string[] = []
      for (const identity of identities) {
        upsertWorkshop(db, identity, { writeProjection: true })
        rewrittenManifestPaths.push(manifestPathFor(identity.path))
      }
      const workshops = workshopRowsForRepo(db, repo.id, true).map(rowToRecord)
      return { repoId: repo.id, commonDir: repo.common_dir, workshops, removedPaths, rewrittenManifestPaths } satisfies ReconcileResult
    }).immediate()
  } finally {
    db.close()
  }
}

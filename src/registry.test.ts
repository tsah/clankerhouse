import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { openDurableRegistry, readRegistryWorkshops, registryStatePath } from "./registry"
import { readLineageSnapshot } from "./workshop"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-registry-"))
  roots.push(root)
  const state = join(root, "state", "clankerhouse")
  mkdirSync(state, { recursive: true })
  return { root, state, registry: join(state, "registry.sqlite3") }
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

const lineageFixture = (path: string, table = "workshops", prefix = "") => {
  const db = new Database(path, { create: true })
  db.exec(`
    CREATE TABLE repositories (id TEXT PRIMARY KEY, common_dir TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ${table} (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id), canonical_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL, parent_id TEXT REFERENCES ${table}(id), revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO repositories VALUES ('repo-${prefix}one', '/git/${prefix}repo/.git', 10, 20);
    INSERT INTO ${table} VALUES ('workshop-${prefix}root', 'repo-${prefix}one', '/work/${prefix}root', 'main', NULL, 1, 10, 20);
    INSERT INTO ${table} VALUES ('workshop-${prefix}child', 'repo-${prefix}one', '/work/${prefix}child', 'feature', 'workshop-${prefix}root', 2, 11, 21);
    PRAGMA user_version = 1;
  `)
  db.close()
}

const resourcesFixture = (path: string, workshop = "workshop-root") => {
  const db = new Database(path, { create: true })
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workshop_id TEXT NOT NULL, parent_id TEXT REFERENCES resources(id), display_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE multiplexer_locations (resource_id TEXT PRIMARY KEY REFERENCES resources(id), kind TEXT NOT NULL, instance_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL, native_window_id TEXT NOT NULL, native_pane_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
      UNIQUE(kind, instance_id, native_session_id, native_window_id, native_pane_id));
    INSERT INTO resources VALUES ('mux-session-1', 'session', '${workshop}', NULL, 'native-session-name', 30, 30);
    INSERT INTO resources VALUES ('mux-window-1', 'window', '${workshop}', 'mux-session-1', 'editor', 31, 31);
    INSERT INTO resources VALUES ('terminal-1', 'terminal', '${workshop}', 'mux-window-1', 'shell', 32, 32);
    INSERT INTO multiplexer_locations VALUES ('mux-session-1', 'tmux', 'server-epoch-a', '$1', '', '', 40);
    INSERT INTO multiplexer_locations VALUES ('mux-window-1', 'tmux', 'server-epoch-a', '$1', '@1', '', 40);
    INSERT INTO multiplexer_locations VALUES ('terminal-1', 'tmux', 'server-epoch-a', '$1', '@1', '%1', 40);
    PRAGMA user_version = 1;
  `)
  db.close()
}

const recoveryFixture = (path: string, version: 1 | 2 | 3, suffix = String(version), workshop = "workshop-root") => {
  const v2Columns = version >= 2 ? `,
      recovery_condition TEXT NOT NULL, quarantine_reason TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, owner_unit TEXT` : ""
  const v2AttemptColumns = version >= 2 ? ", automatic INTEGER NOT NULL DEFAULT 0, boot_epoch INTEGER" : ""
  const desiredValues = version >= 2
    ? `'clanker-${suffix}', 'pi', '${workshop}', '/work/root', 'repo', 'pi', '/work/root', 'ses-${suffix}', '{"version":1,"profile":"worker"}', 'recover fixture ${suffix}', 1, 'running', 'pending', NULL, 2, 'clankerhouse-pi.scope', 3, 50, 60`
    : `'clanker-${suffix}', 'pi', '${workshop}', '/work/root', 'repo', 'pi', '/work/root', 'ses-${suffix}', '{"version":1,"profile":"worker"}', 'recover fixture ${suffix}', 1, 'running', 3, 50, 60`
  const attemptValues = version >= 2
    ? `'clanker-${suffix}', 1, 'hard_reboot', 'succeeded', NULL, 61, 62, 1, 7`
    : `'clanker-${suffix}', 1, 'hard_reboot', 'succeeded', NULL, 61, 62`
  const db = new Database(path, { create: true })
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE desired_clankers (
      clanker_id TEXT PRIMARY KEY, harness TEXT NOT NULL, workshop_id TEXT NOT NULL, workshop_path TEXT NOT NULL,
      tmux_session_name TEXT NOT NULL, tmux_window_name TEXT NOT NULL, cwd TEXT NOT NULL, harness_session_id TEXT,
      launch_spec TEXT NOT NULL, original_task TEXT NOT NULL, policy_version INTEGER NOT NULL, desired_state TEXT NOT NULL
      ${v2Columns}, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE recovery_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, clanker_id TEXT REFERENCES desired_clankers(clanker_id), event TEXT NOT NULL, revision INTEGER, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE recovery_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, clanker_id TEXT NOT NULL REFERENCES desired_clankers(clanker_id), attempt_number INTEGER NOT NULL,
      trigger TEXT NOT NULL, status TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER ${v2AttemptColumns}, UNIQUE(clanker_id, attempt_number));
    CREATE TABLE recovery_leases (scope_key TEXT PRIMARY KEY, clanker_id TEXT REFERENCES desired_clankers(clanker_id), owner_token TEXT NOT NULL,
      boot_id TEXT NOT NULL, pid INTEGER NOT NULL, process_start_ticks INTEGER NOT NULL, acquired_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE recovery_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO desired_clankers VALUES (${desiredValues});
    INSERT INTO recovery_journal (clanker_id, event, revision, payload, created_at) VALUES ('clanker-${suffix}', 'desired.created', 3, '{"from":"legacy-v${version}"}', 50);
    INSERT INTO recovery_attempts (clanker_id, attempt_number, trigger, status, error, started_at, finished_at${version >= 2 ? ", automatic, boot_epoch" : ""}) VALUES (${attemptValues});
    INSERT INTO recovery_leases VALUES ('clanker:clanker-${suffix}', 'clanker-${suffix}', 'owner-${suffix}', 'boot-a', 123, 456, 60, 61, 1000);
    INSERT INTO recovery_metadata VALUES ('runtime.boot_epoch', '7', 60);
    PRAGMA user_version = ${version};
  `)
  db.close()
}

describe("single durable registry", () => {
  test("creates a private, FK-enforced registry with the complete Phase 3 durable shape", () => {
    const { root, registry } = fixture()
    expect(registryStatePath(join(root, "state"), {})).toBe(registry)
    chmodSync(dirname(registry), 0o755)
    const module = openDurableRegistry({ dbPath: registry })
    expect(module.validate()).toEqual({ foreignKeyViolations: [], semanticViolations: [] })
    module.close()
    expect(statSync(dirname(registry)).mode & 0o777).toBe(0o700)
    expect(statSync(registry).mode & 0o777).toBe(0o600)
    const raw = new Database(registry)
    raw.exec("PRAGMA foreign_keys = ON")
    const names = new Set((raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
    for (const table of ["workshops", "terminals", "managed_topology", "clankers", "desired_recovery", "journal", "leases", "multiplexer_locations", "operations", "import_provenance"]) expect(names.has(table)).toBe(true)
    expect(raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    raw.close()
  })

  test("imports current and legacy alt-k lineage plus resources without using mutable names as identity", () => {
    const { state, registry } = fixture()
    const current = join(state, "workshops.sqlite3")
    const altK = join(state, "workspaces.sqlite3")
    const resources = join(state, "resources.sqlite3")
    lineageFixture(current)
    lineageFixture(altK, "workspaces", "old-")
    resourcesFixture(resources)
    const before = [current, altK, resources].map(hash)

    const module = openDurableRegistry({ dbPath: registry, now: () => 100 })
    const summaries = module.importLegacy({ altKLineage: altK, workshops: current, resources })
    expect(summaries.map((summary) => summary.source)).toEqual(["workshops", "alt-k-lineage", "resources"])
    expect(module.tableCount("workshops")).toBe(4)
    expect(module.tableCount("managed_topology")).toBe(2)
    expect(module.tableCount("terminals")).toBe(1)
    expect(module.validate()).toEqual({ foreignKeyViolations: [], semanticViolations: [] })
    module.close()

    expect([current, altK, resources].map(hash)).toEqual(before)
    expect(readRegistryWorkshops(registry).map((row) => row.workshopId)).toContain("workshop-old-child")
    const preferred = readLineageSnapshot(current, "strict", registry)
    expect(preferred.byId.get("workshop-child")).toMatchObject({ parentWorkshopId: "workshop-root", childWorkshopCount: 0 })
  })

  for (const version of [1, 2, 3] as const) test(`imports a real recovery v${version} fixture with journal, attempt, lease and metadata`, () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    const recovery = join(state, `recovery-v${version}.sqlite3`)
    lineageFixture(lineage)
    recoveryFixture(recovery, version)
    const original = hash(recovery)
    const module = openDurableRegistry({ dbPath: registry, now: () => 1000 + version })
    module.importWorkshops(lineage)
    const imported = module.importRecovery(recovery)
    expect(imported.imported).toBe(5)
    expect(module.tableCount("clankers")).toBe(1)
    expect(module.tableCount("desired_recovery")).toBe(1)
    expect(module.tableCount("journal")).toBe(1)
    expect(module.tableCount("leases")).toBe(1)
    expect(module.validate()).toEqual({ foreignKeyViolations: [], semanticViolations: [] })
    module.close()
    expect(hash(recovery)).toBe(original)

    const raw = new Database(registry)
    expect(raw.query("SELECT recovery_condition, consecutive_failures FROM desired_recovery").get()).toEqual(version === 1
      ? { recovery_condition: "pending", consecutive_failures: 0 }
      : { recovery_condition: "pending", consecutive_failures: 2 })
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([])
    raw.close()
  })

  test("joins recovery with a superseded Workshop ID to the canonical lineage path", () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    const recovery = join(state, "recovery-superseded-workshop.sqlite3")
    lineageFixture(lineage)
    recoveryFixture(recovery, 3, "superseded", "workshop-old-id")
    const module = openDurableRegistry({ dbPath: registry })
    module.importWorkshops(lineage)
    expect(() => module.importRecovery(recovery)).not.toThrow()
    expect(module.validate()).toEqual({ foreignKeyViolations: [], semanticViolations: [] })
    module.close()

    const raw = new Database(registry, { readonly: true })
    expect(raw.query("SELECT workshop_id FROM clankers WHERE id = 'clanker-superseded'").get()).toEqual({ workshop_id: "workshop-root" })
    expect(raw.query("SELECT COUNT(*) AS count FROM workshops WHERE canonical_path = '/work/root'").get()).toEqual({ count: 1 })
    raw.close()
  })

  test("rolls an interrupted source transaction back and resumes through the same durable operation", () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    lineageFixture(lineage)
    const module = openDurableRegistry({ dbPath: registry, now: () => 500 })
    let operationId = ""
    expect(() => module.importWorkshops(lineage, { interruptBeforeCommit: () => { throw new Error("injected interruption") } })).toThrow(/injected interruption/)
    expect(module.tableCount("workshops")).toBe(0)
    expect(module.tableCount("import_provenance")).toBe(0)
    expect(module.tableCount("operations")).toBe(1)

    const resumed = module.importWorkshops(lineage)
    operationId = resumed.operationId
    expect(resumed.alreadyImported).toBe(false)
    expect(module.tableCount("workshops")).toBe(2)
    const repeated = module.importWorkshops(lineage)
    expect(repeated).toMatchObject({ operationId, alreadyImported: true, imported: resumed.imported })
    expect(module.tableCount("workshops")).toBe(2)
    expect(module.tableCount("journal")).toBe(0)
    module.close()
  })

  test("durably resumes idempotent mutations and scopes producer leases by process identity", () => {
    const { registry } = fixture()
    const module = openDurableRegistry({ dbPath: registry, now: () => 10 })
    const first = module.beginOperation("rename:workshop-1:request-7", "rename", { workshopId: "workshop-1", displayName: "new" })
    expect(module.beginOperation("rename:workshop-1:request-7", "rename", { workshopId: "workshop-1", displayName: "new" }).id).toBe(first.id)
    expect(() => module.beginOperation("rename:workshop-1:request-7", "delete", {})).toThrow(/different operation/)
    module.advanceOperation(first.id, "effect.pending", "running", { expectedStage: "registered", now: 20 })
    const complete = module.advanceOperation(first.id, "complete", "succeeded", { expectedStage: "effect.pending", result: { displayName: "new" }, now: 30 })
    expect(complete).toMatchObject({ status: "succeeded", result: { displayName: "new" }, completedAt: 30 })
    expect(module.advanceOperation(first.id, "complete", "succeeded", { result: { displayName: "new" } }).id).toBe(first.id)

    const ownerA = { scopeKey: "global", ownerToken: "owner-a", bootId: "boot-a", pid: 10, processStartTicks: 100, ttlMs: 50, now: 40 }
    expect(module.acquireLease(ownerA)).toBe(true)
    expect(module.acquireLease({ ...ownerA, ownerToken: "owner-b", pid: 11, now: 41 })).toBe(false)
    expect(module.acquireLease({ ...ownerA, ownerToken: "owner-b", bootId: "boot-b", pid: 11, now: 42 })).toBe(true)
    expect(module.releaseLease("global", "owner-a")).toBe(false)
    expect(module.releaseLease("global", "owner-b")).toBe(true)
    module.appendJournal(null, "operation.completed", null, { operationId: first.id }, { now: 31 })
    module.close()
  })

  test("enforces identity constraints, append-only journal and foreign keys at the database seam", () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    const recovery = join(state, "recovery.sqlite3")
    lineageFixture(lineage)
    recoveryFixture(recovery, 3)
    const module = openDurableRegistry({ dbPath: registry })
    module.importLegacy({ workshops: lineage, recovery })
    module.close()

    const raw = new Database(registry)
    raw.exec("PRAGMA foreign_keys = ON")
    expect(() => raw.query("UPDATE journal SET event = 'rewritten'").run()).toThrow(/append-only/)
    expect(() => raw.query("DELETE FROM journal").run()).toThrow(/append-only/)
    expect(() => raw.query("UPDATE clankers SET workshop_id = 'missing'").run()).toThrow(/immutable|FOREIGN KEY/)
    expect(() => raw.query("INSERT INTO terminals VALUES ('bad-terminal', 'workshop-root', 'missing-window', 'bad', 1, 1)").run()).toThrow(/window|FOREIGN KEY/)
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([])
    raw.close()
  })

  test("gates imported domain rows while compatibility stores remain mutable", () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    lineageFixture(lineage)
    const module = openDurableRegistry({ dbPath: registry })
    module.importLegacy({ workshops: lineage }, { oncePerSource: true })
    module.setMetadata("compatibility.authority", { domain: "legacy-mutable", operations: "registry" })
    expect(readRegistryWorkshops(registry)).toEqual([])

    const legacy = new Database(lineage)
    legacy.query("UPDATE workshops SET branch = 'fresh-legacy', revision = revision + 1 WHERE id = 'workshop-child'").run()
    legacy.close()
    expect(module.importLegacy({ workshops: lineage }, { oncePerSource: true })).toEqual([])
    expect(readLineageSnapshot(lineage, "strict", registry).byId.get("workshop-child")?.branch).toBe("fresh-legacy")
    module.close()
  })

  test("detects source-row mutation instead of silently changing imported identity", () => {
    const { state, registry } = fixture()
    const lineage = join(state, "workshops.sqlite3")
    lineageFixture(lineage)
    const module = openDurableRegistry({ dbPath: registry })
    module.importWorkshops(lineage)
    const source = new Database(lineage)
    source.query("UPDATE workshops SET branch = 'renamed' WHERE id = 'workshop-child'").run()
    source.close()
    expect(() => module.importWorkshops(lineage)).toThrow(/changed after import/)
    expect(module.workshops().find((row) => row.workshopId === "workshop-child")?.branch).toBe("feature")
    module.close()
  })
})

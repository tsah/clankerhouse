import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { RECOVERY_POLICY, type DesiredClankerInput } from "./model"
import { openRecoveryStore, recoveryStatePath } from "./store"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-recovery-"))
  roots.push(root)
  return { root, dbPath: join(root, "state", "clankerhouse", "recovery.sqlite3") }
}

const desired = (overrides: Partial<DesiredClankerInput> = {}): DesiredClankerInput => ({
  clankerId: "clanker-1",
  harness: "pi",
  workshopId: "workshop-1",
  workshopPath: "/tmp/workshop-1",
  preferredSessionLabel: "repo@recovery",
  preferredWindowLabel: "pi",
  cwd: "/tmp/workshop-1",
  harnessSessionId: null,
  launchSpec: { version: 1, profile: "worker" },
  originalTask: "Implement recovery; use this if the harness cannot resume",
  ...overrides,
})

const mode = (path: string) => statSync(path).mode & 0o777

describe("recovery store", () => {
  test("uses a separate state database and migrates once across idempotent reopen", () => {
    const { root, dbPath } = fixture()
    expect(recoveryStatePath(root, {})).toBe(join(root, "clankerhouse-herdr", "recovery.sqlite3"))
    expect(recoveryStatePath(root, {})).not.toContain("workshops.sqlite3")
    mkdirSync(dirname(dbPath), { recursive: true })
    chmodSync(dirname(dbPath), 0o755)
    const empty = new Database(dbPath, { create: true })
    empty.exec("PRAGMA user_version = 0")
    empty.close()

    const first = openRecoveryStore({ dbPath })
    first.createDesired(desired(), { now: 100 })
    first.close()
    const reopened = openRecoveryStore({ dbPath })
    expect(reopened.getDesired("clanker-1")?.revision).toBe(1)
    reopened.close()

    const raw = new Database(dbPath, { readonly: true })
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 })
    expect((raw.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
    expect(Number((raw.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous)).toBe(2)
    raw.close()
    expect(mode(dirname(dbPath))).toBe(0o700)
    expect(mode(dbPath)).toBe(0o600)
  })

  test("persists the explicit model override across reopen", () => {
    const { dbPath } = fixture()
    const launchSpec = { version: 3 as const, profile: "worker", model: "provider/future-model", resourceClass: "validation-heavy" as const }
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired({ launchSpec }))
    store.close()
    const reopened = openRecoveryStore({ dbPath })
    try { expect(reopened.getDesired("clanker-1")?.launchSpec).toEqual(launchSpec) }
    finally { reopened.close() }
  })

  test("rejects a newer schema without modifying it", () => {
    const { dbPath } = fixture()
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = new Database(dbPath, { create: true })
    raw.exec("PRAGMA user_version = 5")
    raw.close()
    expect(() => openRecoveryStore({ dbPath })).toThrow(/version 5/)
  })

  test("upgrades an actual v1 schema to accept policy version 2 without breaking foreign keys", () => {
    const { dbPath } = fixture()
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = new Database(dbPath, { create: true })
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE desired_clankers (
        clanker_id TEXT PRIMARY KEY,
        harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude', 'opencode')),
        workshop_id TEXT NOT NULL, workshop_path TEXT NOT NULL, tmux_session_name TEXT NOT NULL,
        tmux_window_name TEXT NOT NULL, cwd TEXT NOT NULL, harness_session_id TEXT,
        launch_spec TEXT NOT NULL, original_task TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK (policy_version = 1),
        desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'suspended_resource_pressure', 'tombstoned')),
        revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX desired_clankers_workshop_idx ON desired_clankers(workshop_id);
      CREATE INDEX desired_clankers_state_idx ON desired_clankers(desired_state);
      CREATE TABLE recovery_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, clanker_id TEXT REFERENCES desired_clankers(clanker_id),
        event TEXT NOT NULL, revision INTEGER, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX recovery_journal_clanker_idx ON recovery_journal(clanker_id, id);
      CREATE TRIGGER recovery_journal_no_update BEFORE UPDATE ON recovery_journal BEGIN SELECT RAISE(ABORT, 'recovery journal is append-only'); END;
      CREATE TRIGGER recovery_journal_no_delete BEFORE DELETE ON recovery_journal BEGIN SELECT RAISE(ABORT, 'recovery journal is append-only'); END;
      CREATE TABLE recovery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, clanker_id TEXT NOT NULL REFERENCES desired_clankers(clanker_id),
        attempt_number INTEGER NOT NULL, trigger TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
        error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE(clanker_id, attempt_number)
      );
      CREATE INDEX recovery_attempts_clanker_idx ON recovery_attempts(clanker_id, attempt_number);
      CREATE TABLE recovery_leases (
        scope_key TEXT PRIMARY KEY, clanker_id TEXT REFERENCES desired_clankers(clanker_id), owner_token TEXT NOT NULL,
        boot_id TEXT NOT NULL, pid INTEGER NOT NULL, process_start_ticks INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        CHECK ((scope_key = 'global' AND clanker_id IS NULL) OR (scope_key = 'clanker:' || clanker_id AND clanker_id IS NOT NULL))
      );
      CREATE TABLE recovery_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO desired_clankers VALUES ('legacy', 'pi', 'workshop-old', '/tmp/old', 'repo@old', 'pi', '/tmp/old', NULL, '{"version":1,"profile":null}', 'legacy task', 1, 'running', 1, 10, 10);
      INSERT INTO recovery_attempts (clanker_id, attempt_number, trigger, status, error, started_at, finished_at) VALUES ('legacy', 1, 'initial', 'succeeded', NULL, 10, 11);
      INSERT INTO recovery_leases VALUES ('clanker:legacy', 'legacy', 'owner', 'boot', 1, 1, 10, 10, 20);
      PRAGMA user_version = 1;
    `)
    raw.close()

    const store = openRecoveryStore({ dbPath })
    expect(store.getDesired("legacy")).toMatchObject({ recoveryPolicyVersion: 1, recoveryCondition: "pending" })
    expect(store.attemptsFor("legacy")).toHaveLength(1)
    store.createDesired(desired({ clankerId: "new-policy-2" }), { now: 100 })
    expect(store.getDesired("new-policy-2")?.recoveryPolicyVersion).toBe(2)
    store.close()

    const migrated = new Database(dbPath)
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 4 })
    expect(migrated.query("SELECT preferred_session_label, preferred_window_label FROM desired_clankers WHERE clanker_id = 'legacy'").get()).toEqual({ preferred_session_label: "repo@old", preferred_window_label: "pi" })
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect((migrated.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'desired_clankers'").get() as { sql: string }).sql).toContain("policy_version IN (1, 2)")
    expect(migrated.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'desired_clankers_%_idx' ORDER BY name").all()).toEqual([
      { name: "desired_clankers_state_idx" },
      { name: "desired_clankers_workshop_idx" },
    ])
    migrated.close()
  })

  test("couples desired mutations to append-only journal entries", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    const created = store.createDesired(desired(), { now: 100 })
    expect(created.recoveryPolicyVersion).toBe(RECOVERY_POLICY.version)
    expect(store.journalEntries().map((entry) => [entry.event, entry.revision])).toEqual([["desired.created", 1]])

    expect(() => store.setDesiredState("clanker-1", "stopped", { expectedRevision: 99, now: 110 })).toThrow(/Revision mismatch/)
    expect(store.getDesired("clanker-1")?.desiredState).toBe("running")
    expect(store.journalEntries()).toHaveLength(1)

    store.setDesiredState("clanker-1", "stopped", { expectedRevision: 1, now: 120 })
    expect(store.journalEntries().map((entry) => entry.event)).toEqual(["desired.created", "desired.state_changed"])
    store.close()

    const raw = new Database(dbPath)
    expect(() => raw.query("UPDATE recovery_journal SET event = 'changed' WHERE id = 1").run()).toThrow(/append-only/)
    expect(() => raw.query("DELETE FROM recovery_journal WHERE id = 1").run()).toThrow(/append-only/)
    raw.close()
  })

  test("supports lifecycle transitions while tombstones always win", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired(), { now: 10 })
    expect(store.setDesiredState("clanker-1", "suspended_resource_pressure", { now: 20 }).revision).toBe(2)
    expect(store.setDesiredState("clanker-1", "running", { now: 30 }).revision).toBe(3)
    expect(store.setDesiredState("clanker-1", "stopped", { now: 40 }).revision).toBe(4)
    const tombstone = store.tombstone("clanker-1", { reason: "user removed it", now: 50 })
    expect(tombstone.desiredState).toBe("tombstoned")
    expect(store.listDesired()).toEqual([])
    expect(store.listDesired({ includeTombstoned: true })).toHaveLength(1)
    expect(() => store.setDesiredState("clanker-1", "running", { now: 60 })).toThrow(/tombstoned/)
    expect(() => store.createDesired(desired(), { now: 60 })).toThrow(/tombstoned/)
    expect(store.tombstone("clanker-1", { now: 70 }).revision).toBe(tombstone.revision)
    store.close()
  })

  test("durably quarantines repeated automatic recovery and requires an explicit reset", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired({ harnessSessionId: "pi-session-exact" }), { now: 10 })
    store.markRecoveryPending("clanker-1", "pane-missing", { now: 20 })

    const first = store.admitRecovery("clanker-1", { automatic: true, bootEpoch: 2, trigger: "hard_reboot", now: 30 })
    expect(first.admitted).toBe(true)
    store.finishAttempt(first.attempt!.id, "failed", { error: "launch failed", now: 40 })
    store.markRecoveryPending("clanker-1", "launch-failed", { now: 50 })
    store.resetRecovery("clanker-1", "operator verified no tool started", { now: 55 })

    const sameBoot = store.admitRecovery("clanker-1", { automatic: true, bootEpoch: 2, trigger: "hard_reboot", now: 60 })
    expect(sameBoot).toMatchObject({ admitted: false, reason: "automatic attempt already made this boot" })
    expect(store.getDesired("clanker-1")?.recoveryCondition).toBe("quarantined")

    store.resetRecovery("clanker-1", "operator reviewed interrupted work", { now: 70 })
    expect(store.getDesired("clanker-1")).toMatchObject({ recoveryCondition: "pending", quarantineReason: null })
    const manual = store.admitRecovery("clanker-1", { automatic: false, bootEpoch: 2, trigger: "manual", now: 80 })
    expect(manual.admitted).toBe(true)
    store.close()

    const reopened = openRecoveryStore({ dbPath })
    expect(reopened.getDesired("clanker-1")?.recoveryCondition).toBe("recovering")
    reopened.close()
  })

  test("quarantines ambiguous work after a controller or host crash instead of replaying it", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired({ harnessSessionId: "pi-session-exact" }), { now: 1 })
    store.markRecoveryPending("clanker-1", "hard-reboot", { now: 2 })
    store.admitRecovery("clanker-1", { automatic: false, bootEpoch: 1, trigger: "manual", now: 3 })
    store.close()

    const afterCrash = openRecoveryStore({ dbPath })
    expect(afterCrash.markRecoveryPending("clanker-1", "owned cgroup missing after reboot", { now: 4 })).toMatchObject({ recoveryCondition: "interrupted_unknown" })
    expect(afterCrash.admitRecovery("clanker-1", { automatic: true, bootEpoch: 2, trigger: "hard_reboot", now: 5 })).toMatchObject({ admitted: false, reason: "interrupted work requires operator review" })
    afterCrash.close()
  })

  test("does not reset the breaker until a recovery is stably settled", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired({ harnessSessionId: "pi-session-exact" }), { now: 1 })
    store.markRecoveryPending("clanker-1", "reboot", { now: 2 })
    const admitted = store.admitRecovery("clanker-1", { automatic: false, bootEpoch: 1, trigger: "manual", now: 10 }).attempt!
    store.finishAttempt(admitted.id, "succeeded", { now: 20 })
    expect(store.markRecoverySettled("clanker-1", admitted.id, "idle", { now: 30 })).toBe(false)
    expect(store.markRecoveryStable("clanker-1", admitted.id, { now: 299_999 })).toBe(false)
    expect(store.getDesired("clanker-1")?.consecutiveFailures).toBe(1)
    expect(store.markRecoveryStable("clanker-1", admitted.id, { now: 300_010 })).toBe(true)
    expect(store.getDesired("clanker-1")).toMatchObject({ recoveryCondition: "healthy", consecutiveFailures: 0 })
    store.close()
  })

  test("binds an exact harness session once and rejects mismatch", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired(), { now: 10 })
    const bound = store.bindHarnessSession("clanker-1", "pi-session-exact", { expectedRevision: 1, now: 20 })
    expect(bound.harnessSessionId).toBe("pi-session-exact")
    expect(bound.revision).toBe(2)
    expect(store.bindHarnessSession("clanker-1", "pi-session-exact", { now: 30 }).revision).toBe(2)
    expect(() => store.bindHarnessSession("clanker-1", "different-session", { now: 40 })).toThrow(/mismatch/)
    expect(store.journalEntries({ clankerId: "clanker-1" }).filter((entry) => entry.event === "session.bound")).toHaveLength(1)
    store.close()
  })

  test("accepts only the latest successful harness exit attestation", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired({ harnessSessionId: "pi-session-exact" }), { now: 10 })
    const first = store.beginAttempt("clanker-1", "initial", { now: 20 })
    store.finishAttempt(first.id, "succeeded", { now: 30 })

    const stopped = store.attestHarnessExit("clanker-1", first.id, { harnessSessionId: "pi-session-exact", reason: "user-exit", now: 40 })
    expect(stopped).toMatchObject({ desiredState: "stopped", revision: 2 })
    expect(store.attestHarnessExit("clanker-1", first.id, { harnessSessionId: "pi-session-exact", reason: "duplicate", now: 50 }).revision).toBe(2)
    expect(store.journalEntries({ clankerId: "clanker-1" }).at(-1)).toMatchObject({ event: "desired.exit_attested", payload: { attemptId: first.id, reason: "user-exit" } })

    store.setDesiredState("clanker-1", "running", { now: 60 })
    const second = store.beginAttempt("clanker-1", "recovery", { now: 70 })
    expect(() => store.attestHarnessExit("clanker-1", second.id, { harnessSessionId: "pi-session-exact", reason: "early", now: 80 })).toThrow(/not succeeded/)
    store.finishAttempt(second.id, "succeeded", { now: 90 })
    expect(() => store.attestHarnessExit("clanker-1", first.id, { harnessSessionId: "pi-session-exact", reason: "stale", now: 100 })).toThrow(/not latest/)
    expect(() => store.attestHarnessExit("clanker-1", second.id, { harnessSessionId: "wrong-session", reason: "mismatch", now: 110 })).toThrow(/session mismatch/)
    expect(store.attestHarnessExit("clanker-1", second.id, { harnessSessionId: "pi-session-exact", reason: "clean-exit", now: 120 }).desiredState).toBe("stopped")
    store.close()
  })

  test("contends, renews, expires, and reclaims global and per-clanker leases", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired(), { now: 1 })
    const scope = { kind: "global" } as const
    const ownerA = { scope, ownerToken: "owner-a", bootId: "boot-a", pid: 10, processStartTicks: 100 }
    const ownerB = { scope, ownerToken: "owner-b", bootId: "boot-a", pid: 11, processStartTicks: 110 }
    expect(store.acquireLease({ ...ownerA, ttlMs: 100, now: 10 })?.ownerToken).toBe("owner-a")
    expect(store.acquireLease({ ...ownerB, ttlMs: 100, now: 20 })).toBeUndefined()
    expect(store.acquireLease({ ...ownerA, ttlMs: 100, now: 25 })?.expiresAt).toBe(125)
    expect(store.renewLease(ownerA, 100, 30)?.expiresAt).toBe(130)
    expect(store.acquireLease({ ...ownerB, ttlMs: 100, now: 129 })).toBeUndefined()
    expect(store.acquireLease({ ...ownerB, ttlMs: 100, now: 130 })?.ownerToken).toBe("owner-b")
    expect(store.releaseLease(ownerA)).toBe(false)
    expect(store.releaseLease(ownerB)).toBe(true)

    const clankerScope = { kind: "clanker", clankerId: "clanker-1" } as const
    const oldBoot = { scope: clankerScope, ownerToken: "old", bootId: "boot-a", pid: 20, processStartTicks: 200 }
    const newBoot = { scope: clankerScope, ownerToken: "new", bootId: "boot-b", pid: 21, processStartTicks: 210 }
    expect(store.acquireLease({ ...oldBoot, ttlMs: 1_000, now: 200 })?.ownerToken).toBe("old")
    expect(store.acquireLease({ ...newBoot, ttlMs: 1_000, now: 201 })?.ownerToken).toBe("new")
    expect(() => store.acquireLease({ ...newBoot, scope: { kind: "clanker", clankerId: "missing" }, ttlMs: 10, now: 202 })).toThrow(/Unknown clanker/)
    store.close()
  })

  test("persists attempts, generic metadata, and boot/multiplexer epochs", () => {
    const { dbPath } = fixture()
    const store = openRecoveryStore({ dbPath })
    store.createDesired(desired(), { now: 1 })
    const first = store.beginAttempt("clanker-1", "daemon-start", { now: 10 })
    expect(first).toMatchObject({ attempt: 1, status: "running", trigger: "daemon-start" })
    expect(store.finishAttempt(first.id, "failed", { error: "session unavailable", now: 20 })).toMatchObject({ status: "failed", finishedAt: 20 })
    const second = store.beginAttempt("clanker-1", "retry", { now: 30 })
    store.finishAttempt(second.id, "succeeded", { now: 40 })
    expect(store.attemptsFor("clanker-1").map((attempt) => [attempt.attempt, attempt.status])).toEqual([[1, "failed"], [2, "succeeded"]])

    store.setMetadata("daemon.generation", { value: 7 }, { now: 50 })
    expect(store.getMetadata<{ value: number }>("daemon.generation")).toEqual({ value: 7 })
    expect(store.runtimeEpochs()).toEqual({ bootId: null, bootEpoch: 0, multiplexerEpoch: 0, updatedAt: null })
    expect(store.observeBoot("boot-a", { now: 60 })).toEqual({ bootId: "boot-a", bootEpoch: 1, multiplexerEpoch: 0, updatedAt: 60 })
    expect(store.observeBoot("boot-a", { now: 70 }).bootEpoch).toBe(1)
    expect(store.observeBoot("boot-b", { now: 80 }).bootEpoch).toBe(2)
    expect(store.advanceMultiplexerEpoch({ now: 90 })).toEqual({ bootId: "boot-b", bootEpoch: 2, multiplexerEpoch: 1, updatedAt: 90 })
    expect(store.journalEntries({ clankerId: "clanker-1" }).map((entry) => entry.event)).toContain("attempt.finished")
    store.close()
  })
})

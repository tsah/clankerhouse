import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ledgerStatePath, openClankerLedger, validateLaunchSpec, type LedgerInput, type ObservedClanker } from "./clanker-ledger"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-ledger-"))
  roots.push(root)
  const dir = join(root, "state", "clankerhouse")
  return { root, dir, dbPath: join(dir, "clankers.sqlite3"), legacyPath: join(dir, "recovery.sqlite3") }
}

const clanker = (overrides: Partial<LedgerInput> = {}): LedgerInput => ({
  clankerId: "clanker-1",
  harness: "claude",
  workshopId: "workshop-1",
  workshopPath: "/tmp/workshop-1",
  sessionLabel: "repo@main",
  windowLabel: "claude",
  cwd: "/tmp/workshop-1",
  harnessSessionId: "session-1",
  launchSpec: { version: 1, profile: null },
  originalTask: "Fix the bug",
  ...overrides,
})

const observed = (overrides: Partial<ObservedClanker> = {}): ObservedClanker => ({
  clankerId: "clanker-1",
  harness: "claude",
  harnessSessionId: "session-1",
  workshopId: "workshop-1",
  workshopPath: "/tmp/workshop-1",
  cwd: "/tmp/workshop-1",
  sessionLabel: "repo@main",
  windowLabel: "claude",
  ...overrides,
})

describe("clanker ledger", () => {
  test("lives beside the other instance state with private permissions", () => {
    const { root, dbPath } = fixture()
    expect(ledgerStatePath(root, {})).toBe(join(root, "clankerhouse-herdr", "clankers.sqlite3"))
    openClankerLedger({ dbPath }).close()
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  test("records a clanker once and follows its harness session", () => {
    const { dbPath } = fixture()
    let now = 10
    const ledger = openClankerLedger({ dbPath, now: () => now })
    expect(ledger.record(clanker())).toMatchObject({ state: "open", harnessSessionId: "session-1", createdAt: 10, serverEpoch: null })
    expect(() => ledger.record(clanker())).toThrow(/already exists/)
    now = 20
    expect(ledger.bindSession("clanker-1", "session-2")).toMatchObject({ harnessSessionId: "session-2", updatedAt: 20 })
    expect(() => ledger.bindSession("missing", "session-2")).toThrow(/Unknown clanker/)
    ledger.close()
  })

  test("closes clankers that end in the same Herdr server and keeps interrupted ones open", () => {
    const { dbPath } = fixture()
    const ledger = openClankerLedger({ dbPath })
    for (const id of ["ended", "interrupted", "fresh", "missing-briefly"]) ledger.record(clanker({ clankerId: id }))
    const seen = (...ids: string[]) => ids.map((id) => observed({ clankerId: id }))
    ledger.sync(seen("ended", "interrupted", "missing-briefly"), "epoch-1", () => false)
    expect(ledger.get("ended")?.serverEpoch).toBe("epoch-1")

    // In the same server: a long-missing clanker ended; a briefly missing one stays open.
    ledger.sync(seen("interrupted"), "epoch-1", (id) => id === "ended")
    expect(ledger.get("ended")).toMatchObject({ state: "closed", closedReason: "ended" })
    expect(ledger.get("missing-briefly")?.state).toBe("open")
    // A clanker that has not been seen yet is closed only once it has been missing long enough.
    expect(ledger.get("fresh")?.state).toBe("open")

    // After a Herdr restart nothing is alive; clankers seen in the old server stay open.
    ledger.sync([], "epoch-2", () => true)
    expect(ledger.get("interrupted")?.state).toBe("open")
    expect(ledger.get("missing-briefly")?.state).toBe("open")
    expect(ledger.get("fresh")).toMatchObject({ state: "closed", closedReason: "ended" })

    // A closed clanker that shows up alive again is open.
    ledger.sync(seen("ended"), "epoch-2", () => false)
    expect(ledger.get("ended")).toMatchObject({ state: "open", closedReason: null, serverEpoch: "epoch-2" })
    expect(ledger.list({ state: "open" }).map((row) => row.clankerId).sort()).toEqual(["ended", "interrupted", "missing-briefly"])
    ledger.close()
  })

  test("adopts live tracked harnesses and follows their sessions", () => {
    const { dbPath } = fixture()
    const ledger = openClankerLedger({ dbPath })
    ledger.record(clanker())
    ledger.sync([
      observed({ clankerId: "clanker-1", harnessSessionId: "session-after-clear" }),
      observed({ clankerId: "adopted", harness: "pi", harnessSessionId: "pi-session" }),
      observed({ clankerId: "codex", harness: "codex", harnessSessionId: "codex-session" }),
      observed({ clankerId: "no-session", harnessSessionId: undefined }),
    ], "epoch-1", () => false)
    expect(ledger.get("clanker-1")?.harnessSessionId).toBe("session-after-clear")
    expect(ledger.get("adopted")).toMatchObject({ state: "open", harness: "pi", harnessSessionId: "pi-session", workshopId: "workshop-1", serverEpoch: "epoch-1" })
    expect(ledger.get("codex")).toBeUndefined()
    expect(ledger.get("no-session")).toBeUndefined()
    ledger.close()
  })

  test("imports Recovery's records once", () => {
    const { dir, dbPath, legacyPath } = fixture()
    mkdirSync(dir, { recursive: true })
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE desired_clankers (clanker_id TEXT PRIMARY KEY, harness TEXT, workshop_id TEXT, workshop_path TEXT, tmux_session_name TEXT, tmux_window_name TEXT, cwd TEXT,
      harness_session_id TEXT, launch_spec TEXT, original_task TEXT, desired_state TEXT, owner_unit TEXT, created_at INTEGER, updated_at INTEGER)`)
    const insert = legacy.query("INSERT INTO desired_clankers VALUES (?1, 'pi', 'w', '/tmp/w', 'repo', 'pi', '/tmp/w', ?2, '{\"version\":1,\"profile\":null}', 'task', ?3, 'clankerhouse-x-1.scope', 1, 2)")
    insert.run("running", "s-1", "running")
    insert.run("stopped", "s-2", "stopped")
    insert.run("tombstoned", null, "tombstoned")
    legacy.close()

    const ledger = openClankerLedger({ dbPath })
    expect(ledger.get("running")).toMatchObject({ state: "open", sessionLabel: "repo", windowLabel: "pi", harnessSessionId: "s-1", ownerUnit: "clankerhouse-x-1.scope", serverEpoch: null })
    expect(ledger.get("stopped")).toMatchObject({ state: "closed", closedReason: "imported-stopped" })
    expect(ledger.get("tombstoned")).toMatchObject({ state: "closed", closedReason: "imported-tombstoned" })
    ledger.end("running", "operator")
    ledger.close()

    // Reopening never imports again.
    const reopened = openClankerLedger({ dbPath })
    expect(reopened.get("running")).toMatchObject({ state: "closed", closedReason: "operator" })
    reopened.close()
  })

  test("validates launch specs", () => {
    expect(validateLaunchSpec({ version: 3, profile: null, resourceClass: "interactive", model: "opus" })).toEqual({ version: 3, profile: null, resourceClass: "interactive", model: "opus" })
    expect(() => validateLaunchSpec({ version: 3, profile: null, resourceClass: "interactive", model: "-x" })).toThrow(/model/)
    expect(() => validateLaunchSpec({ version: 2, profile: null })).toThrow(/launch spec/)
  })
})

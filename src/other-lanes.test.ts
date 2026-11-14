import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADOPTION_PLACEHOLDER, ClankerLedger, type LedgerInput } from "./clanker-ledger"
import { currentLane, foreignClankers, harnessRunsIn, isHarnessProcess, laneLedgerPath, laneName, laneWorkshopParent, moveCommand, parseUnitShow, readLaneLedger, siblingLanes, type UnitProbe, type UnitState } from "./other-lanes"
import { projectResources } from "./server/project"
import { registerWorkshop, type LineageSnapshot } from "./workshop"
import { moveClankerFromLane, movedWorkshopParent } from "./workflow"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const stateHome = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-lanes-"))
  roots.push(root)
  return root
}

const input = (id: string, overrides: Partial<LedgerInput> = {}): LedgerInput => ({
  clankerId: id,
  harness: "claude",
  workshopId: `workshop-${id}`,
  workshopPath: `/work/${id}`,
  sessionLabel: "repo@main",
  windowLabel: "claude",
  cwd: `/work/${id}`,
  harnessSessionId: `session-${id}`,
  launchSpec: { version: 2, profile: null, resourceClass: "interactive" },
  originalTask: `Task of ${id}`,
  ...overrides,
})

/** A lane ledger with the given clankers, each owned by `unit-<id>`. */
const seedLane = (home: string, lane: string, ids: string[], now = () => 1000) => {
  const ledger = ClankerLedger.open({ dbPath: laneLedgerPath(lane, home), now })
  try {
    for (const id of ids) {
      ledger.record(input(id))
      ledger.setOwnerUnit(id, `clankerhouse-${id}.scope`)
    }
  } finally { ledger.close() }
}

const running = (harness = "claude"): UnitState => ({ active: true, processes: [{ pid: 10, name: "clankerhouse-ha", argv: ["/bin/bash", "/x/clankerhouse-harness-lifecycle"] }, { pid: 11, name: harness, argv: [harness] }] })
const probeOf = (states: Record<string, UnitState>): UnitProbe => (units) => new Map(units.flatMap((unit) => states[unit] ? [[unit, states[unit]!] as const] : []))

describe("lanes", () => {
  test("lane names follow instance slugs", () => {
    expect(laneName("-herdr")).toBe("herdr")
    expect(laneName("")).toBe("default")
    expect(currentLane({ CLANKERHOUSE_INSTANCE: "hc" })).toBe("hc")
    expect(currentLane({})).toBe("herdr")
    expect(laneLedgerPath("default", "/s")).toBe("/s/clankerhouse/clankers.sqlite3")
    expect(() => laneLedgerPath("../x", "/s")).toThrow("Invalid lane")
  })

  test("sibling lanes are the other state directories that hold a ledger", () => {
    const home = stateHome()
    seedLane(home, "herdr", [])
    seedLane(home, "hc", [])
    mkdirSync(join(home, "clankerhouse-empty"))
    mkdirSync(join(home, "unrelated"))
    expect(siblingLanes(home, { CLANKERHOUSE_INSTANCE: "hc" })).toEqual(["herdr"])
    expect(siblingLanes(home, {})).toEqual(["hc"])
  })

  test("another lane's ledger is read without being written", () => {
    const home = stateHome()
    seedLane(home, "herdr", ["a", "b"])
    const path = laneLedgerPath("herdr", home)
    const before = readFileSync(path)
    expect(readLaneLedger(path, { state: "open" }).map((row) => row.clankerId)).toEqual(["a", "b"])
    expect(readLaneLedger(path, { clankerId: "b" })[0]).toMatchObject({ originalTask: "Task of b", ownerUnit: "clankerhouse-b.scope", launchSpec: { version: 2, resourceClass: "interactive" } })
    expect(readFileSync(path).equals(before)).toBe(true)
    // A missing file or a file that is no ledger reads as empty, and is not created.
    expect(readLaneLedger(join(home, "none.sqlite3"))).toEqual([])
    writeFileSync(join(home, "empty.sqlite3"), "")
    expect(readLaneLedger(join(home, "empty.sqlite3"))).toEqual([])
  })

  test("a Workshop's parent is read from the other lane's registry", () => {
    const home = stateHome()
    mkdirSync(join(home, "clankerhouse-herdr"))
    const db = new Database(join(home, "clankerhouse-herdr", "workshops.sqlite3"))
    db.exec("CREATE TABLE workshops (id TEXT, canonical_path TEXT, parent_id TEXT)")
    db.query("INSERT INTO workshops VALUES ('w1', '/work/child', 'p1'), ('w2', '/work/root', NULL)").run()
    db.close()
    expect(laneWorkshopParent("herdr", "/work/child", home)).toBe("p1")
    expect(laneWorkshopParent("herdr", "/work/root", home)).toBeNull()
    expect(laneWorkshopParent("herdr", "/work/other", home)).toBeUndefined()
    expect(laneWorkshopParent("hc", "/work/child", home)).toBeUndefined()
  })
})

describe("unit probing", () => {
  test("parses systemctl show for several units", () => {
    const units = parseUnitShow("Id=clankerhouse-a.scope\nActiveState=active\nControlGroup=/user.slice/a\n\nId=clankerhouse-b.scope\nActiveState=inactive\nControlGroup=\n")
    expect(units.get("clankerhouse-a.scope")).toEqual({ active: true, controlGroup: "/user.slice/a" })
    expect(units.get("clankerhouse-b.scope")).toEqual({ active: false, controlGroup: "" })
  })

  test("a scope runs its harness only while a harness process is in it", () => {
    expect(harnessRunsIn(running(), "claude")).toBe(true)
    expect(harnessRunsIn(running("pi"), "claude")).toBe(false)
    // A hung test job keeping the scope open is not the harness.
    expect(harnessRunsIn({ active: true, processes: [{ pid: 1, name: "bun", argv: ["bun", "test"] }] }, "claude")).toBe(false)
    expect(harnessRunsIn({ active: false, processes: [] }, "claude")).toBe(false)
    expect(harnessRunsIn(undefined, "claude")).toBe(false)
    expect(isHarnessProcess({ pid: 1, name: "node", argv: ["node", "/home/u/.npm/_npx/x/node_modules/.bin/claude"] }, "claude")).toBe(true)
  })
})

describe("clankers running on another lane", () => {
  test("lists open rows whose harness still runs and that this lane does not see", () => {
    const home = stateHome()
    seedLane(home, "herdr", ["live", "gone", "here", "hung"])
    const probe = probeOf({
      "clankerhouse-live.scope": running(),
      "clankerhouse-here.scope": running(),
      "clankerhouse-hung.scope": { active: true, processes: [{ pid: 3, name: "bun", argv: ["bun"] }] },
    })
    const rows = foreignClankers({ stateHome: home, env: { CLANKERHOUSE_INSTANCE: "hc" }, aliveHere: new Set(["here"]), probe })
    expect(rows).toEqual([{ lane: "herdr", clankerId: "live", harness: "claude", workshopId: "workshop-live", workshopPath: "/work/live", cwd: "/work/live", harnessSessionId: "session-live", ownerUnit: "clankerhouse-live.scope", updatedAt: 1000 }])
    expect(moveCommand(rows[0]!)).toBe("clankers resume live --from-lane herdr")
  })

  test("a closed row is not listed, and one clanker in two lanes is listed once from the newer row", () => {
    const home = stateHome()
    seedLane(home, "herdr", ["a", "closed"], () => 2000)
    seedLane(home, "old", ["a"], () => 1000)
    const ledger = ClankerLedger.open({ dbPath: laneLedgerPath("herdr", home) })
    try { ledger.end("closed", "ended") } finally { ledger.close() }
    const probe = probeOf({ "clankerhouse-a.scope": running(), "clankerhouse-closed.scope": running() })
    const rows = foreignClankers({ stateHome: home, env: { CLANKERHOUSE_INSTANCE: "hc" }, probe })
    expect(rows.map((row) => [row.clankerId, row.lane])).toEqual([["a", "herdr"]])
  })

  test("asks systemd nothing when no other lane has open rows", () => {
    const home = stateHome()
    seedLane(home, "hc", ["mine"])
    let asked = 0
    expect(foreignClankers({ stateHome: home, env: { CLANKERHOUSE_INSTANCE: "hc" }, probe: () => { asked += 1; return new Map() } })).toEqual([])
    expect(asked).toBe(0)
  })
})

describe("importing another lane's row", () => {
  test("keeps task, launch spec, owner unit and session; the live row wins except over a real task", () => {
    const home = stateHome()
    seedLane(home, "herdr", ["a", "b"])
    const [a, b] = readLaneLedger(laneLedgerPath("herdr", home))
    const ledger = ClankerLedger.open({ dbPath: laneLedgerPath("hc", home), now: () => 5000 })
    try {
      // `b` was adopted here earlier with a placeholder task and no owner unit.
      ledger.record(input("b", { originalTask: ADOPTION_PLACEHOLDER, harnessSessionId: "older-session", launchSpec: { version: 1, profile: null } }))
      ledger.end("b", "ended")
      const imported = ledger.importFrom(a!)
      expect(imported).toMatchObject({ state: "open", originalTask: "Task of a", ownerUnit: "clankerhouse-a.scope", harnessSessionId: "session-a", serverEpoch: null, launchSpec: { version: 2, profile: null, resourceClass: "interactive" } })
      const updated = ledger.importFrom(b!)
      expect(updated).toMatchObject({ state: "open", closedReason: null, originalTask: "Task of b", ownerUnit: "clankerhouse-b.scope", harnessSessionId: "session-b", launchSpec: { version: 2 } })
      // A placeholder from the other lane never replaces a real task here.
      expect(ledger.importFrom({ ...b!, originalTask: ADOPTION_PLACEHOLDER }).originalTask).toBe("Task of b")
      expect(() => ledger.importFrom({ ...b!, harness: "pi" })).toThrow("is a claude here")
    } finally { ledger.close() }
  })
})

describe("restoring what an adoption lost", () => {
  test("takes the task over a placeholder and the launch spec over the default, and nothing else", () => {
    const home = stateHome()
    seedLane(home, "herdr", ["a"])
    const [source] = readLaneLedger(laneLedgerPath("herdr", home))
    const ledger = ClankerLedger.open({ dbPath: laneLedgerPath("hc", home) })
    try {
      ledger.record(input("a", { originalTask: ADOPTION_PLACEHOLDER, launchSpec: { version: 1, profile: null } }))
      const { clanker, restored } = ledger.restoreFrom(source!)
      expect(restored).toEqual({ originalTask: true, launchSpec: true })
      expect(clanker).toMatchObject({ state: "open", originalTask: "Task of a", ownerUnit: null, launchSpec: { version: 2, resourceClass: "interactive" } })
      expect(ledger.restoreFrom({ ...source!, originalTask: "Other" }).restored).toEqual({ originalTask: false, launchSpec: false })
      expect(() => ledger.restoreFrom({ ...source!, harnessSessionId: "another" })).toThrow("runs another session here")
      expect(() => ledger.restoreFrom({ ...source!, clankerId: "nobody" })).toThrow("Unknown clanker")
    } finally { ledger.close() }
  })
})

describe("projection", () => {
  const lineage: LineageSnapshot = {
    byPath: new Map([["/work/live", { version: 1, workshopId: "workshop-live", repoId: "r", canonicalPath: "/work/live", commonDir: "/work/.git", branch: "live", parentWorkshopId: null, revision: 1, createdAt: 0, updatedAt: 0, childWorkshopCount: 0 }]]),
    byId: new Map(),
  }
  lineage.byId.set("workshop-live", lineage.byPath.get("/work/live")!)
  const base = { sessions: [], windows: [], directories: [], clankerReports: [], lineage, gitMetaByPath: new Map(), managedResources: new Map(), observedAt: 60_000, instanceId: "hc:test", multiplexerKind: "hc" }
  const elsewhere = { lane: "herdr", clankerId: "live", harness: "claude" as const, workshopId: "workshop-live", workshopPath: "/work/live", cwd: "/work/live", harnessSessionId: "s", ownerUnit: "u", updatedAt: 0 }

  test("a Workshop whose clanker runs on another lane shows it there, with the command that moves it", () => {
    const { sessions } = projectResources({ ...base, otherLaneClankers: [elsewhere] })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ path: "/work/live", workshopId: "workshop-live", target: { type: "directory", path: "/work/live" } })
    expect(sessions[0]!.details).toEqual([expect.objectContaining({ kind: "elsewhere", harness: "claude", status: "on the herdr server", detail: "clankers resume live --from-lane herdr", state: "unknown" })])
    expect(sessions[0]!.searchText).toContain("elsewhere")
  })

  test("joins the Workshop's existing row, and is dropped once this lane sees the clanker", () => {
    const directories = [{ path: "/work/live", branch: "live", source: "worktree" as const }]
    const joined = projectResources({ ...base, directories, otherLaneClankers: [elsewhere] }).sessions
    expect(joined).toHaveLength(1)
    expect(joined[0]!.details.map((detail) => detail.kind)).toEqual(["directory", "elsewhere"])
    const windows = [{ sessionId: "s1", session: "live", id: "t1", pane: "t1", name: "claude", title: "", command: "claude", currentPath: "/work/live", activity: 0, active: true, clankerId: "live", explicitHarness: "claude" }]
    const sessions = [{ id: "s1", name: "live", path: "/work/live", recency: 0, attached: false, workshopId: "workshop-live" }]
    const seen = projectResources({ ...base, sessions, windows, otherLaneClankers: [elsewhere] } as never).sessions
    expect(seen.flatMap((row) => row.details.map((detail) => detail.kind))).not.toContain("elsewhere")
  })
})

describe("moving a clanker from another lane", () => {
  const setup = (options: { unit?: UnitState; aliveHere?: string[]; resumeFails?: boolean } = {}) => {
    const home = stateHome()
    seedLane(home, "herdr", ["a"])
    const ledgerPath = laneLedgerPath("hc", home)
    const steps: string[] = []
    const hereRow = () => {
      const ledger = ClankerLedger.open({ dbPath: ledgerPath })
      try { return ledger.get("a") } finally { ledger.close() }
    }
    const theirRow = () => readLaneLedger(laneLedgerPath("herdr", home), { clankerId: "a" })[0]!
    const move = (extra: Record<string, unknown> = {}) => moveClankerFromLane("a", {
      lane: "herdr",
      stateHome: home,
      ledgerPath,
      env: { CLANKERHOUSE_INSTANCE: "hc" },
      probe: probeOf({ "clankerhouse-a.scope": options.unit ?? running() }),
      aliveHere: async () => new Set(options.aliveHere ?? []),
      registerWorkshop: async (lane, path) => { steps.push(`register ${lane} ${path}`) },
      stop: (unit) => { steps.push(`stop ${unit} here=${hereRow()?.state} theirs=${theirRow().state}`) },
      resume: async (id) => {
        steps.push(`resume ${id} theirs=${theirRow().state}:${theirRow().closedReason}`)
        if (options.resumeFails) throw new Error("no core")
        return { clankerId: id, pane: "t9" }
      },
      ...extra,
    })
    return { home, steps, hereRow, theirRow, move }
  }

  test("records it here, stops its old harness, closes the old row, then resumes it", async () => {
    const { steps, hereRow, move } = setup()
    const result = await move()
    expect(steps).toEqual([
      "register herdr /work/a",
      "stop clankerhouse-a.scope here=open theirs=open",
      "resume a theirs=closed:moved-to-hc",
    ])
    expect(result).toMatchObject({ clankerId: "a", from: "herdr", to: "hc", running: true, stops: "clankerhouse-a.scope", pane: "t9" })
    expect(hereRow()).toMatchObject({ state: "open", originalTask: "Task of a", ownerUnit: "clankerhouse-a.scope", harnessSessionId: "session-a", launchSpec: { version: 2, resourceClass: "interactive" } })
  })

  test("a dry run changes nothing", async () => {
    const { steps, hereRow, theirRow, move } = setup()
    expect(await move({ dryRun: true })).toMatchObject({ dryRun: true, running: true, stops: "clankerhouse-a.scope", harnessSessionId: "session-a" })
    expect(steps).toEqual([])
    expect(hereRow()).toBeUndefined()
    expect(theirRow().state).toBe("open")
  })

  test("a scope left with no harness is still stopped, and nothing is stopped when the scope is gone", async () => {
    const hung = setup({ unit: { active: true, processes: [{ pid: 1, name: "bun", argv: ["bun"] }] } })
    expect(await hung.move()).toMatchObject({ running: false, stops: "clankerhouse-a.scope" })
    expect(hung.steps[1]).toStartWith("stop clankerhouse-a.scope")
    const gone = setup({ unit: { active: false, processes: [] } })
    expect(await gone.move()).toMatchObject({ running: false, stops: null })
    expect(gone.steps.some((step) => step.startsWith("stop"))).toBe(false)
  })

  test("refuses this lane, an unknown clanker, and one this lane already runs", async () => {
    const { move } = setup({ aliveHere: ["a"] })
    await expect(move()).rejects.toThrow("already runs in lane hc")
    await expect(move({ lane: "hc" })).rejects.toThrow("is this lane")
    await expect(setup().move({ lane: "nowhere" })).rejects.toThrow("has no clanker a")
  })

  test("a failed resume after the move says how to finish it", async () => {
    const { hereRow, move } = setup({ resumeFails: true })
    await expect(move()).rejects.toThrow("moved to lane hc but did not start: no core; retry with: clankers resume a")
    expect(hereRow()?.state).toBe("open")
  })
})

describe("a moved Workshop's parent", () => {
  test("keeps this lane's record, else takes the other lane's parent when it exists here", () => {
    const home = stateHome()
    const dbPath = join(home, "hc-workshops.sqlite3")
    const repo = join(home, "repo")
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    mkdirSync(repo)
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "root")
    const [known, parent, orphan, child] = ["known", "parent", "orphan", "child"].map((name) => {
      git("worktree", "add", "-q", "-b", name, join(home, name))
      return realpathSync(join(home, name))
    }) as [string, string, string, string]
    const registered = (path: string, branch: string) => registerWorkshop({ path, commonDir: realpathSync(join(repo, ".git")), branch }, { dbPath })
    registered(known, "known")
    const parentRecord = registered(parent, "parent")
    mkdirSync(join(home, "clankerhouse-herdr"))
    const db = new Database(join(home, "clankerhouse-herdr", "workshops.sqlite3"))
    db.exec("CREATE TABLE workshops (id TEXT, canonical_path TEXT, parent_id TEXT)")
    db.query("INSERT INTO workshops VALUES ('c', ?1, ?2), ('o', ?3, 'missing-parent'), ('k', ?4, 'whatever')").run(child, parentRecord.workshopId, orphan, known)
    db.close()
    expect(movedWorkshopParent("herdr", known, { stateHome: home, dbPath })).toEqual({ preserveParent: true })
    expect(movedWorkshopParent("herdr", child, { stateHome: home, dbPath })).toEqual({ parentWorkshopId: parentRecord.workshopId, preserveParent: false })
    expect(movedWorkshopParent("herdr", orphan, { stateHome: home, dbPath })).toEqual({ preserveParent: true })
  })
})

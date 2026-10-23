import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advanceRecoveryCampaign, reconcileRecovery, RecoveryController, startRecoveryCampaign } from "./controller"
import { openRecoveryStore } from "./store"
import { GATE_LAUNCH_TIMEOUT_MS, gateStatusPrefix, readGateAdmission, RESUME_REREPORT_MS } from "./gate"
import type { ManagedMultiplexer } from "../multiplexer"
import type { ClaimKey, MultiplexerSession, NativeLocation, SpawnRequest } from "../multiplexer/interface"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("recovery reconciliation", () => {
  test("a Spot reboot campaign restores healthy sessions sequentially and preserves blocked ones", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-campaign-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    for (const id of ["healthy", "blocked"]) store.createDesired({ clankerId: id, harness: "pi", workshopId: "w", workshopPath: root, preferredSessionLabel: "w", preferredWindowLabel: id, cwd: root, harnessSessionId: `session-${id}`, launchSpec: { version: 1, profile: null }, originalTask: "continue safely" }, { now: 1 })
    store.markRecoveryPending("blocked", "reboot", { now: 2 })
    store.admitRecovery("blocked", { automatic: false, bootEpoch: 1, trigger: "manual", now: 3 })
    store.markRecoveryPending("blocked", "scope disappeared", { now: 4 })
    const campaign = startRecoveryCampaign(2, "boot-b", ["healthy", "blocked"], 5)
    expect(advanceRecoveryCampaign(campaign, store.listDesired(), ["healthy"])).toEqual({ ...campaign, pending: [], blocked: [{ clankerId: "blocked", reason: "interrupted_unknown" }], status: "completed_with_blocks" })
    store.close()
  })

  test.each([false, true])("recovery launches only one agent tab and preserves an existing session (%s)", async (existing) => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-recovery-tab-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    const requests: SpawnRequest[] = []
    const claims: Array<[NativeLocation, ClaimKey, string | null]> = []
    const sessions: MultiplexerSession[] = existing ? [{
      id: "existing-session", nativeName: "renamed-session", path: root, worktreePath: root, workshopId: "w", directoryPath: "", attached: false, recency: 1,
      windows: [{ id: "existing-window", nativeName: "pi", index: "0", active: true, panes: [] }],
    }] : []
    const multiplexer = {
      kind: "herdr",
      observe: async () => ({ kind: "herdr", instanceId: "isolated", sessions }),
      spawn: async (request: SpawnRequest) => {
        expect(store.attemptsFor("clanker-tab").at(-1)?.status).toBe("running")
        requests.push(request)
        return { nativeSessionId: existing ? "existing-session" : "new-session", nativeWindowId: "agent-window", nativePaneId: "agent-pane" }
      },
      claim: async (location: NativeLocation, key: ClaimKey, value: string | null) => { claims.push([location, key, value]) },
      ensureManagedSession: async () => {},
    } as unknown as ManagedMultiplexer
    try {
      store.createDesired({ clankerId: "clanker-tab", harness: "pi", workshopId: "w", workshopPath: root, preferredSessionLabel: "workshop", preferredWindowLabel: "pi", cwd: root, harnessSessionId: "exact-session", launchSpec: { version: 1, profile: null }, originalTask: "task" }, { now: 1 })
      const attempt = store.beginAttempt("clanker-tab", "initial", { now: 2 })
      store.finishAttempt(attempt.id, "succeeded", { now: 3 })
      const result = await reconcileRecovery(store, { now: 100, allowLaunch: true, bypassAdmission: true, multiplexer })
      expect(result.launched).toEqual(["clanker-tab"])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject(existing
        ? { scope: "window", nativeSessionId: "existing-session", name: "pi-2" }
        : { scope: "session", name: "workshop", windowName: "pi" })
      expect(requests[0]!.launch?.kind).toBe("argv")
      const argv = requests[0]!.launch?.kind === "argv" ? requests[0]!.launch.argv : []
      expect(argv).toContain("--session")
      expect(argv).toContain("exact-session")
      expect(claims).toContainEqual([{ nativeSessionId: existing ? "existing-session" : "new-session", nativeWindowId: "agent-window", nativePaneId: "agent-pane" }, "clankerId", "clanker-tab"])
    } finally { store.close() }
  })

  test("an adopted live clanker reports the resume gate to the runtime once per pane, retrying refusals", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-resume-report-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    const reports: Array<[string, string, string | null, string[]]> = []
    let refuse = true
    const multiplexer = {
      kind: "herdr",
      observe: async () => ({ kind: "herdr", instanceId: "isolated", sessions: [{ id: "w1", nativeName: "w", path: root, attached: false, recency: 1, windows: [{ id: "w1:t1", index: "1", nativeName: "pi", active: true, panes: [{ id: "w1:p4", index: "0", pid: "", command: "", title: "", currentPath: root, activity: 0, active: true, claims: { clankerId: "clanker-live", harness: "pi", harnessSessionId: "session-live" } }] }] }] }),
      reportAgentSession: async (pane: string, harness: string, sessionId: string | null, argv: string[]) => {
        reports.push([pane, harness, sessionId, argv])
        if (refuse) throw new Error("herdr pane.report_agent_session: resume_not_accepted")
        return true
      },
    } as unknown as ManagedMultiplexer
    try {
      store.createDesired({ clankerId: "clanker-live", harness: "pi", workshopId: "w", workshopPath: root, preferredSessionLabel: "w", preferredWindowLabel: "pi", cwd: root, harnessSessionId: "session-live", launchSpec: { version: 1, profile: null }, originalTask: "task" }, { now: 1 })
      for (let tick = 0; tick < 3; tick++) {
        expect((await reconcileRecovery(store, { now: 100 + tick, multiplexer })).adopted).toEqual(["clanker-live"])
        refuse = false
      }
      expect(reports).toHaveLength(2)
      expect(reports[1]).toEqual(["w1:p4", "pi", "session-live", ["clankerhouse-resume", "clanker-live"]])
      await reconcileRecovery(store, { now: 102 + RESUME_REREPORT_MS, multiplexer })
      expect(reports).toHaveLength(3)
    } finally { store.close() }
  })

  describe("Herdr-restored resume gates", () => {
    const savedRuntime = Bun.env.XDG_RUNTIME_DIR
    afterEach(() => { if (savedRuntime === undefined) delete Bun.env.XDG_RUNTIME_DIR; else Bun.env.XDG_RUNTIME_DIR = savedRuntime })
    const gateFixture = (paneClaims: Array<{ id: string; claims: Record<string, string>; sessionRef?: { agent: string; kind: "id"; value: string; source: string } }>) => {
      const root = mkdtempSync(join(tmpdir(), "clankerhouse-gate-admission-")); roots.push(root)
      Bun.env.XDG_RUNTIME_DIR = join(root, "runtime")
      const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
      store.createDesired({ clankerId: "clanker-g", harness: "claude", workshopId: "w", workshopPath: root, preferredSessionLabel: "w", preferredWindowLabel: "claude", cwd: root, harnessSessionId: "session-g", launchSpec: { version: 1, profile: null }, originalTask: "task" }, { now: 1 })
      const initial = store.beginAttempt("clanker-g", "initial", { now: 2 }); store.finishAttempt(initial.id, "succeeded", { now: 3 })
      const spawned: SpawnRequest[] = []
      const state = { available: true, panes: paneClaims }
      const multiplexer = {
        kind: "herdr",
        available: async () => state.available,
        observe: async () => ({ kind: "herdr", instanceId: "isolated", sessions: [{ id: "w1", nativeName: "w", path: root, attached: false, recency: 1, windows: [{ id: "w1:t1", index: "1", nativeName: "claude", active: true, panes: state.panes.map((pane) => ({ id: pane.id, index: "0", pid: "", command: "", title: "", currentPath: root, activity: 0, active: true, claims: pane.claims, sessionRef: pane.sessionRef })) }] }] }),
        spawn: async (request: SpawnRequest) => { spawned.push(request); return { nativeSessionId: "w1", nativeWindowId: "w1:t9", nativePaneId: "w1:p9" } },
        claim: async () => {},
        ensureManagedSession: async () => {},
      } as unknown as ManagedMultiplexer
      return { root, store, spawned, state, multiplexer }
    }

    test("a manual resume admits the clanker into its restored gate instead of creating a pane", async () => {
      const { store, spawned, multiplexer } = gateFixture([{ id: "w1:p2", claims: { recoveryGate: "clanker-g" } }])
      try {
        const pending = await reconcileRecovery(store, { now: 100, multiplexer })
        expect(pending.pending).toEqual(["clanker-g"])
        expect(readFileSync(`${gateStatusPrefix("clanker-g")}.reason`, "utf8")).toContain("clankers recovery resume clanker-g")
        const resumed = await reconcileRecovery(store, { now: 200, allowLaunch: true, bypassAdmission: true, multiplexer })
        expect(resumed.launched).toEqual(["clanker-g"])
        expect(spawned).toEqual([])
        const attempt = store.attemptsFor("clanker-g").at(-1)!
        expect(attempt.status).toBe("running")
        expect(readGateAdmission(store, "clanker-g")).toEqual({ pane: "w1:p2", attemptId: attempt.id, initial: false, admittedAt: 200 })
        expect(existsSync(`${gateStatusPrefix("clanker-g")}.admitted`)).toBe(true)
        const waiting = await reconcileRecovery(store, { now: 300, multiplexer })
        expect(waiting.skipped).toEqual([{ clankerId: "clanker-g", reason: "waiting for the resume gate to launch" }])
        expect(store.getDesired("clanker-g")!.recoveryCondition).toBe("recovering")
      } finally { store.close() }
    })

    test("an admitted gate that never launches returns its clanker to pending, not to interrupted review", async () => {
      const { store, state, multiplexer } = gateFixture([{ id: "w1:p2", claims: { recoveryGate: "clanker-g" } }])
      try {
        await reconcileRecovery(store, { now: 100, multiplexer })
        await reconcileRecovery(store, { now: 200, allowLaunch: true, bypassAdmission: true, multiplexer })
        const attempt = store.attemptsFor("clanker-g").at(-1)!
        await reconcileRecovery(store, { now: 200 + GATE_LAUNCH_TIMEOUT_MS, multiplexer })
        expect(store.getAttempt(attempt.id)).toMatchObject({ status: "abandoned", error: "resume gate did not launch" })
        expect(store.getDesired("clanker-g")!.recoveryCondition).toBe("pending")
        await reconcileRecovery(store, { now: 400_000, allowLaunch: true, bypassAdmission: true, multiplexer })
        state.panes = []
        await reconcileRecovery(store, { now: 400_001, multiplexer })
        expect(store.getDesired("clanker-g")!.recoveryCondition).toBe("pending")
        expect(store.attemptsFor("clanker-g").at(-1)).toMatchObject({ status: "abandoned", error: "resume gate pane closed before launch" })
      } finally { store.close() }
    })

    test("the fallback relaunch neither duplicates a runtime-resumed session nor spends an attempt while the multiplexer is down", async () => {
      const { store, spawned, state, multiplexer } = gateFixture([{ id: "w1:p5", claims: {}, sessionRef: { agent: "claude", kind: "id", value: "session-g", source: "herdr:claude" } }])
      try {
        await reconcileRecovery(store, { now: 100, multiplexer })
        const blocked = await reconcileRecovery(store, { now: 200, allowLaunch: true, bypassAdmission: true, multiplexer })
        expect(blocked.skipped[0]!.reason).toContain("already resumed by the multiplexer in pane w1:p5")
        state.panes = []
        state.available = false
        const down = await reconcileRecovery(store, { now: 300, allowLaunch: true, bypassAdmission: true, multiplexer })
        expect(down.skipped).toEqual([{ clankerId: "clanker-g", reason: "multiplexer unavailable" }])
        expect(store.attemptsFor("clanker-g")).toHaveLength(1)
        state.available = true
        expect((await reconcileRecovery(store, { now: 400, allowLaunch: true, bypassAdmission: true, multiplexer })).launched).toEqual(["clanker-g"])
        expect(spawned).toHaveLength(1)
      } finally { store.close() }
    })
  })

  test("simultaneous stale clankers become pending without launching on boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-controller-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    for (let index = 1; index <= 7; index++) {
      const id = `clanker-${index}`
      store.createDesired({ clankerId: id, harness: "pi", workshopId: "w", workshopPath: root, preferredSessionLabel: "w", preferredWindowLabel: `pi-${index}`, cwd: root, harnessSessionId: `session-${index}`, launchSpec: { version: 1, profile: null }, originalTask: "expensive test" }, { now: index })
      const initial = store.beginAttempt(id, "initial", { now: 20 + index }); store.finishAttempt(initial.id, "succeeded", { now: 30 + index })
    }
    const result = await reconcileRecovery(store, { trigger: "hard_reboot", now: 100 })
    expect(result.launched).toEqual([])
    expect(result.pending).toHaveLength(7)
    expect(result.skipped.every((row) => row.reason === "manual resume required")).toBe(true)
    expect(store.listDesired().every((row) => row.recoveryCondition === "pending")).toBe(true)
    store.close()
  })

  test("a Multiplexer server restart advances the multiplexer epoch once", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-server-epoch-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    let epoch: string | undefined = "server-a"
    const multiplexer = {
      kind: "herdr",
      serverEpoch: async () => epoch,
      observe: async () => ({ kind: "herdr", instanceId: "herdr:/stable.sock", sessions: [] }),
    } as unknown as ManagedMultiplexer
    const controller = new RecoveryController(store, 10, multiplexer)
    try {
      await controller.run({ once: true })
      expect(store.getMetadata<string>("runtime.server_epoch")).toBe("server-a")
      expect(store.runtimeEpochs().multiplexerEpoch).toBe(0)
      epoch = undefined
      await controller.run({ once: true })
      expect(store.runtimeEpochs().multiplexerEpoch).toBe(0)
      epoch = "server-b"
      await controller.run({ once: true })
      expect(store.getMetadata<string>("runtime.server_epoch")).toBe("server-b")
      expect(store.runtimeEpochs().multiplexerEpoch).toBe(1)
      await controller.run({ once: true })
      expect(store.runtimeEpochs().multiplexerEpoch).toBe(1)
    } finally { store.close() }
  })
})

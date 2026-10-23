import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advanceRecoveryCampaign, reconcileRecovery, RecoveryController, startRecoveryCampaign } from "./controller"
import { openRecoveryStore } from "./store"
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

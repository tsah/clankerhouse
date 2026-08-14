import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advanceRecoveryCampaign, reconcileRecovery, startRecoveryCampaign } from "./controller"
import { openRecoveryStore } from "./store"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("recovery reconciliation", () => {
  test("a Spot reboot campaign restores healthy sessions sequentially and preserves blocked ones", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-campaign-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    for (const id of ["healthy", "blocked"]) store.createDesired({ clankerId: id, harness: "pi", workshopId: "w", workshopPath: root, tmuxSessionName: "w", tmuxWindowName: id, cwd: root, harnessSessionId: `session-${id}`, launchSpec: { version: 1, profile: null }, originalTask: "continue safely" }, { now: 1 })
    store.markRecoveryPending("blocked", "reboot", { now: 2 })
    store.admitRecovery("blocked", { automatic: false, bootEpoch: 1, trigger: "manual", now: 3 })
    store.markRecoveryPending("blocked", "scope disappeared", { now: 4 })
    const campaign = startRecoveryCampaign(2, "boot-b", ["healthy", "blocked"], 5)
    expect(advanceRecoveryCampaign(campaign, store.listDesired(), ["healthy"])).toEqual({ ...campaign, pending: [], blocked: [{ clankerId: "blocked", reason: "interrupted_unknown" }], status: "completed_with_blocks" })
    store.close()
  })

  test("simultaneous stale clankers become pending without launching on boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-controller-")); roots.push(root)
    const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
    for (let index = 1; index <= 7; index++) {
      const id = `clanker-${index}`
      store.createDesired({ clankerId: id, harness: "pi", workshopId: "w", workshopPath: root, tmuxSessionName: "w", tmuxWindowName: `pi-${index}`, cwd: root, harnessSessionId: `session-${index}`, launchSpec: { version: 1, profile: null }, originalTask: "expensive test" }, { now: index })
      const initial = store.beginAttempt(id, "initial", { now: 20 + index }); store.finishAttempt(initial.id, "succeeded", { now: 30 + index })
    }
    const result = await reconcileRecovery(store, { trigger: "hard_reboot", now: 100 })
    expect(result.launched).toEqual([])
    expect(result.pending).toHaveLength(7)
    expect(result.skipped.every((row) => row.reason === "manual resume required")).toBe(true)
    expect(store.listDesired().every((row) => row.recoveryCondition === "pending")).toBe(true)
    store.close()
  })
})

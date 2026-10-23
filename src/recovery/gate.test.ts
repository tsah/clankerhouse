import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManagedMultiplexer } from "../multiplexer"
import type { ClaimKey, NativeLocation } from "../multiplexer/interface"
import { decideResumeGate, gateStatusPrefix, publishGateWait, readGateAdmission, recordGateAdmission, resumeArgv, runResumeGate, signalGateAdmitted } from "./gate"
import { openRecoveryStore } from "./store"

const roots: string[] = []
const savedEnv = { XDG_RUNTIME_DIR: Bun.env.XDG_RUNTIME_DIR, CLANKERHOUSE_INSTANCE: Bun.env.CLANKERHOUSE_INSTANCE, CLANKERHOUSE_PROCESS_OWNER: Bun.env.CLANKERHOUSE_PROCESS_OWNER }
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value }
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-gate-")); roots.push(root)
  Bun.env.XDG_RUNTIME_DIR = join(root, "runtime")
  Bun.env.CLANKERHOUSE_PROCESS_OWNER = "disabled"
  delete Bun.env.CLANKERHOUSE_INSTANCE
  const store = openRecoveryStore({ dbPath: join(root, "recovery.sqlite3") })
  store.createDesired({ clankerId: "clanker-a", harness: "claude", workshopId: "w", workshopPath: root, preferredSessionLabel: "w", preferredWindowLabel: "claude", cwd: root, harnessSessionId: "session-a", launchSpec: { version: 1, profile: null }, originalTask: "task" }, { now: 1 })
  const initial = store.beginAttempt("clanker-a", "initial", { now: 2 }); store.finishAttempt(initial.id, "succeeded", { now: 3 })
  return { root, store }
}

const fakeMultiplexer = (panes: Array<{ id: string; claims?: Record<string, string> }>) => {
  const claims: Array<[string | null, ClaimKey, string | null]> = []
  const multiplexer = {
    kind: "herdr",
    observe: async () => ({ kind: "herdr", instanceId: "isolated", sessions: [{ id: "w1", nativeName: "w", path: "/w", attached: false, recency: 1, windows: [{ id: "w1:t1", index: "1", nativeName: "t", active: true, panes: panes.map((pane) => ({ id: pane.id, index: "0", pid: "", command: "", title: "", currentPath: "/w", activity: 0, active: true, claims: pane.claims ?? {} })) }] }] }),
    claim: async (location: NativeLocation, key: ClaimKey, value: string | null) => { claims.push([location.nativePaneId, key, value]) },
  } as unknown as ManagedMultiplexer
  return { multiplexer, claims }
}

describe("resume gate", () => {
  test("reports the gate command by plain name with the instance it belongs to", () => {
    expect(resumeArgv("clanker-a", {})).toEqual(["clankerhouse-resume", "clanker-a"])
    expect(resumeArgv("clanker-a", { CLANKERHOUSE_INSTANCE: "qa" })).toEqual(["clankerhouse-resume", "--instance", "qa", "clanker-a"])
  })

  test("leaves the pane to the shell for stopped, deleted, unknown, and elsewhere-live clankers", () => {
    const { store } = fixture()
    const desired = store.getDesired("clanker-a")!
    expect(decideResumeGate({ clankerId: "gone", pane: "w1:p1" })).toMatchObject({ action: "exit" })
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p1", desired: { ...desired, desiredState: "stopped" } })).toMatchObject({ action: "exit", message: expect.stringContaining("clankers recovery start clanker-a") })
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p1", desired: { ...desired, desiredState: "tombstoned" } })).toMatchObject({ action: "exit" })
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p1", desired, livePane: "w2:p3" })).toMatchObject({ action: "exit", message: expect.stringContaining("w2:p3") })
    store.close()
  })

  test("waits with the manual resume command until Recovery admits exactly this pane", () => {
    const { store } = fixture()
    const desired = store.markRecoveryPending("clanker-a", "multiplexer restart")
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p1", desired })).toMatchObject({ action: "wait", message: expect.stringContaining("clankers recovery resume clanker-a") })
    const admitted = store.admitRecovery("clanker-a", { automatic: false, bootEpoch: 1, trigger: "manual" }).attempt!
    const admission = { pane: "w1:p2", attemptId: admitted.id, initial: false, admittedAt: 5 }
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p1", desired, admission, latestAttempt: admitted })).toMatchObject({ action: "wait" })
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p2", desired, admission, latestAttempt: admitted })).toMatchObject({ action: "launch" })
    expect(decideResumeGate({ clankerId: "clanker-a", pane: "w1:p2", desired, admission: { ...admission, launchedAt: 6 }, latestAttempt: admitted })).toMatchObject({ action: "wait" })
    store.close()
  })

  test("a waiting gate claims its pane and prints Recovery's published reason", async () => {
    const { store } = fixture()
    publishGateWait(store.markRecoveryPending("clanker-a", "multiplexer restart"), "boot quiet period")
    const { multiplexer, claims } = fakeMultiplexer([{ id: "w1:p1" }])
    const result = await runResumeGate(store, multiplexer, { clankerId: "clanker-a", pane: "w1:p1" })
    expect(result).toMatchObject({ action: "wait", message: expect.stringContaining("boot quiet period"), statusPrefix: gateStatusPrefix("clanker-a") })
    expect(claims).toEqual([["w1:p1", "recoveryGate", "clanker-a"]])
    store.close()
  })

  test("an admitted gate claims the clanker identity, records the launch, and gets the exact resume argv", async () => {
    const { store } = fixture()
    store.markRecoveryPending("clanker-a", "multiplexer restart")
    const attempt = store.admitRecovery("clanker-a", { automatic: false, bootEpoch: 1, trigger: "manual" }).attempt!
    recordGateAdmission(store, "clanker-a", { pane: "w1:p1", attemptId: attempt.id, initial: false, admittedAt: 10 })
    signalGateAdmitted("clanker-a", attempt.id)
    const { multiplexer, claims } = fakeMultiplexer([{ id: "w1:p1", claims: { recoveryGate: "clanker-a" } }])
    const result = await runResumeGate(store, multiplexer, { clankerId: "clanker-a", pane: "w1:p1", now: 20 })
    expect(result.action).toBe("launch")
    expect(result.argv).toContain("--resume")
    expect(result.argv).toContain("session-a")
    expect(result.argv).toContain(`CLANKER_ID=clanker-a`)
    expect(result.argv).toContain(`CLANKER_RECOVERY_ATTEMPT=${attempt.id}`)
    expect(result.argv).toContain("CLANKERHOUSE_WORKSHOP_ID=w")
    expect(claims).toEqual([
      ["w1:p1", "clankerId", "clanker-a"],
      ["w1:p1", "harness", "claude"],
      ["w1:p1", "recoveryAttemptId", String(attempt.id)],
      ["w1:p1", "harnessSessionId", "session-a"],
      ["w1:p1", "recoveryGate", null],
    ])
    expect(readGateAdmission(store, "clanker-a")).toMatchObject({ pane: "w1:p1", launchedAt: 20 })
    expect(existsSync(`${gateStatusPrefix("clanker-a")}.admitted`)).toBe(false)
    const again = await runResumeGate(store, multiplexer, { clankerId: "clanker-a", pane: "w1:p1" })
    expect(again.action).toBe("wait")
    store.close()
  })

  test("a gate exits when the clanker already runs in another pane", async () => {
    const { store } = fixture()
    const { multiplexer, claims } = fakeMultiplexer([{ id: "w1:p1", claims: { recoveryGate: "clanker-a" } }, { id: "w1:p2", claims: { clankerId: "clanker-a" } }])
    expect(await runResumeGate(store, multiplexer, { clankerId: "clanker-a", pane: "w1:p1" })).toMatchObject({ action: "exit" })
    expect(claims).toEqual([["w1:p1", "recoveryGate", null]])
    store.close()
  })

  test("abandoning an unlaunched admission returns the clanker to pending, not to review", () => {
    const { store } = fixture()
    store.markRecoveryPending("clanker-a", "restart")
    const attempt = store.admitRecovery("clanker-a", { automatic: false, bootEpoch: 1, trigger: "manual" }).attempt!
    const desired = store.abandonAdmission("clanker-a", attempt.id, "resume gate did not launch")
    expect(desired.recoveryCondition).toBe("pending")
    expect(store.getAttempt(attempt.id)).toMatchObject({ status: "abandoned", error: "resume gate did not launch" })
    store.close()
  })
})

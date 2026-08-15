import { describe, expect, test } from "bun:test"
import type { DesiredClankerRecord } from "./model"
import { decideRecovery, type RecoveryDecisionInput } from "./planner"

const desired = (overrides: Partial<DesiredClankerRecord> = {}): DesiredClankerRecord => ({
  clankerId: "clanker-1",
  harness: "pi",
  workshopId: "workshop-1",
  workshopPath: "/work",
  tmuxSessionName: "work",
  tmuxWindowName: "pi",
  cwd: "/work",
  harnessSessionId: "session-1",
  launchSpec: { version: 1, profile: null },
  originalTask: "test",
  desiredState: "running",
  recoveryPolicyVersion: 2,
  recoveryCondition: "pending",
  quarantineReason: null,
  consecutiveFailures: 0,
  ownerUnit: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const input = (overrides: Partial<RecoveryDecisionInput> = {}): RecoveryDecisionInput => ({
  desired: desired(),
  matchingPanes: [],
  allowLaunch: true,
  automaticCandidate: true,
  backoffRemainingMs: 0,
  activeRecoveries: 0,
  ...overrides,
})

describe("Recovery planner functional core", () => {
  test("adopts only one exact matching live Clanker", () => {
    expect(decideRecovery(input({ matchingPanes: [{ pane: "%1", harness: "pi", harnessSessionId: "session-1" }] }))).toMatchObject({ type: "adopt", pane: "%1" })
    expect(decideRecovery(input({ matchingPanes: [{ pane: "%1", harness: "claude", harnessSessionId: "session-1" }] }))).toMatchObject({ type: "block", code: "live-harness-mismatch" })
    expect(decideRecovery(input({ matchingPanes: [{ pane: "%1", harness: "pi", harnessSessionId: "other" }] }))).toMatchObject({ type: "block", code: "live-session-mismatch" })
    expect(decideRecovery(input({ matchingPanes: [{ pane: "%1", harness: "pi", harnessSessionId: "session-1" }, { pane: "%2", harness: "pi", harnessSessionId: "session-1" }] }))).toMatchObject({ type: "block", code: "duplicate-live-clanker" })
  })

  test("never launches stopped, suspended, tombstoned, interrupted, or quarantined desired state", () => {
    for (const desiredState of ["stopped", "suspended_resource_pressure", "tombstoned"] as const) {
      expect(decideRecovery(input({ desired: desired({ desiredState }) })).type).toBe("ignore")
    }
    expect(decideRecovery(input({ desired: desired({ recoveryCondition: "interrupted_unknown" }) }))).toMatchObject({ type: "block", code: "interrupted-unknown" })
    expect(decideRecovery(input({ desired: desired({ recoveryCondition: "quarantined", quarantineReason: "breaker" }) }))).toMatchObject({ type: "block", code: "quarantined", reason: "breaker" })
  })

  test("marks vanished healthy work pending before considering launch", () => {
    expect(decideRecovery(input({ desired: desired({ recoveryCondition: "healthy" }) }))).toMatchObject({ type: "mark-pending", code: "missing-owned-pane" })
    expect(decideRecovery(input({ desired: desired({ recoveryCondition: "recovering" }) }))).toMatchObject({ type: "mark-pending", code: "missing-owned-pane" })
  })

  test("requires launch permission and active-campaign membership", () => {
    expect(decideRecovery(input({ allowLaunch: false }))).toMatchObject({ type: "pending", code: "manual-resume-required" })
    expect(decideRecovery(input({ automaticCandidate: false }))).toMatchObject({ type: "pending", code: "automatic-candidate-excluded" })
  })

  test("applies deterministic backoff and global admission limits", () => {
    expect(decideRecovery(input({ backoffRemainingMs: 1234 }))).toEqual({ type: "defer", code: "backoff", reason: "backoff 1234ms", retryAfterMs: 1234 })
    expect(decideRecovery(input({ activeRecoveries: 1 }))).toMatchObject({ type: "defer", code: "global-recovery-limit" })
    expect(decideRecovery(input())).toEqual({ type: "consider-admission", code: "eligible", reason: "candidate is eligible for host admission" })
  })

  test("is deterministic for equal prepared observations", () => {
    const prepared = input({ backoffRemainingMs: 50 })
    expect(JSON.stringify(decideRecovery(prepared))).toBe(JSON.stringify(decideRecovery(structuredClone(prepared))))
  })
})

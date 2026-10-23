import { RECOVERY_POLICY, type DesiredClankerRecord } from "./model"

export interface RecoveryPaneObservation {
  pane: string
  harness: string
  harnessSessionId: string
}

export interface RecoveryDecisionInput {
  desired: DesiredClankerRecord
  matchingPanes: readonly RecoveryPaneObservation[]
  allowLaunch: boolean
  automaticCandidate: boolean
  backoffRemainingMs: number
  activeRecoveries: number
  maxActiveRecoveries?: number
}

export type RecoveryDecision =
  | { type: "ignore"; code: "desired-not-running"; reason: string }
  | { type: "block"; code: "duplicate-live-clanker" | "live-harness-mismatch" | "live-session-mismatch" | "interrupted-unknown" | "quarantined"; reason: string; pane?: string }
  | { type: "adopt"; code: "exact-live-clanker"; pane: string; reason: string }
  | { type: "mark-pending"; code: "missing-owned-pane"; reason: string }
  | { type: "pending"; code: "manual-resume-required" | "automatic-candidate-excluded"; reason: string }
  | { type: "defer"; code: "backoff" | "global-recovery-limit"; reason: string; retryAfterMs?: number }
  | { type: "consider-admission"; code: "eligible"; reason: string }

/**
 * Pure Recovery policy for one freshly observed Clanker. The imperative shell applies
 * one returned decision, re-reads durable state when it changes, and decides again.
 * That existing async shell is an explicit future Effect-service migration seam.
 */
export const decideRecovery = (input: RecoveryDecisionInput): RecoveryDecision => {
  const { desired, matchingPanes } = input
  if (desired.desiredState !== "running") return { type: "ignore", code: "desired-not-running", reason: `desired state is ${desired.desiredState}` }
  if (matchingPanes.length > 1) return { type: "block", code: "duplicate-live-clanker", reason: "ambiguous duplicate live panes" }
  if (matchingPanes.length === 1) {
    const pane = matchingPanes[0]!
    if (pane.harness && pane.harness !== desired.harness) return { type: "block", code: "live-harness-mismatch", pane: pane.pane, reason: "live harness mismatch" }
    if (pane.harnessSessionId && desired.harnessSessionId && pane.harnessSessionId !== desired.harnessSessionId) return { type: "block", code: "live-session-mismatch", pane: pane.pane, reason: "live harness session mismatch" }
    return { type: "adopt", code: "exact-live-clanker", pane: pane.pane, reason: "one exact live Clanker matches desired identity" }
  }
  if (desired.recoveryCondition === "healthy" || desired.recoveryCondition === "recovering") return { type: "mark-pending", code: "missing-owned-pane", reason: "no owned live pane" }
  if (!input.allowLaunch) return {
    type: "pending",
    code: input.automaticCandidate ? "manual-resume-required" : "automatic-candidate-excluded",
    reason: desired.recoveryCondition === "interrupted_unknown" ? "interrupted work requires operator review" : "manual resume required",
  }
  if (!input.automaticCandidate) return { type: "pending", code: "automatic-candidate-excluded", reason: "candidate is not in the active Recovery campaign" }
  if (desired.recoveryCondition === "interrupted_unknown") return { type: "block", code: "interrupted-unknown", reason: "interrupted work requires reset after operator review" }
  if (desired.recoveryCondition === "quarantined") return { type: "block", code: "quarantined", reason: desired.quarantineReason || "quarantined" }
  if (input.backoffRemainingMs > 0) return { type: "defer", code: "backoff", reason: `backoff ${input.backoffRemainingMs}ms`, retryAfterMs: input.backoffRemainingMs }
  if (input.activeRecoveries >= (input.maxActiveRecoveries ?? RECOVERY_POLICY.maxActiveRecoveries)) return { type: "defer", code: "global-recovery-limit", reason: "global recovery admission limit reached" }
  return { type: "consider-admission", code: "eligible", reason: "candidate is eligible for host admission" }
}

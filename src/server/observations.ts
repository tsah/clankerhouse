import { normalizeReportedState, type ClankerState } from "../model"
import type { ClankerReport } from "./resources"

export interface LifecycleObservation {
  pane: string
  clankerId?: string
  harness?: string
  state?: ClankerState
  reportedState?: string
  updatedAt: number
  hookEvent?: string
  harnessSessionId?: string
  recoveryAttemptId?: string
}

export interface OwnedClankerIdentity {
  pane: string
  clankerId: string
  harness: string
  harnessSessionId?: string
  recoveryAttemptId?: string
}

export type UnmatchedObservationReason =
  | "no-owned-identity"
  | "clanker-id-mismatch"
  | "harness-mismatch"
  | "harness-session-mismatch"
  | "recovery-attempt-mismatch"
  | "incomplete-observation"

export interface UnmatchedClankerObservation {
  observation: LifecycleObservation
  reason: UnmatchedObservationReason
}

export interface ClankerObservationReconciliation {
  matchedByPane: ReadonlyMap<string, ClankerReport>
  observedByPane: ReadonlyMap<string, LifecycleObservation>
  unmatchedByPane: ReadonlyMap<string, readonly UnmatchedClankerObservation[]>
  superseded: readonly ClankerReport[]
}

const states = new Set<ClankerState>(["failed", "blocked", "working", "done", "idle", "unknown"])
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

export const parseClankerObservation = (value: unknown): LifecycleObservation | undefined => {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const clankerId = text(raw.clankerId)
  const harness = text(raw.harness) ?? text(raw.agent)
  const pane = text(raw.pane)
  const reportedState = text(raw.state)
  const state = reportedState && states.has(reportedState as ClankerState) ? reportedState as ClankerState : undefined
  if (!pane) return undefined
  const hookEvent = text(raw.hookEvent)
  return {
    ...(clankerId ? { clankerId } : {}),
    ...(harness ? { harness } : {}),
    pane,
    ...(state ? { state: normalizeReportedState(state, hookEvent) } : {}),
    ...(reportedState && !state ? { reportedState } : {}),
    updatedAt: Number(raw.updatedAt ?? 0) || 0,
    ...(hookEvent ? { hookEvent } : {}),
    ...(text(raw.harnessSessionId) ? { harnessSessionId: text(raw.harnessSessionId) } : {}),
    ...(text(raw.recoveryAttemptId) ? { recoveryAttemptId: text(raw.recoveryAttemptId) } : {}),
  }
}

const exactMatch = (identity: OwnedClankerIdentity, observation: LifecycleObservation): observation is ClankerReport =>
  Boolean(observation.clankerId && observation.harness && observation.state)
  && identity.pane === observation.pane
  && identity.clankerId === observation.clankerId
  && identity.harness === observation.harness
  && (!identity.harnessSessionId || identity.harnessSessionId === observation.harnessSessionId)
  && (!identity.recoveryAttemptId || identity.recoveryAttemptId === observation.recoveryAttemptId)

const mismatchReason = (identity: OwnedClankerIdentity | undefined, observation: LifecycleObservation): UnmatchedObservationReason => {
  if (!observation.clankerId || !observation.harness || !observation.state) return "incomplete-observation"
  if (!identity) return "no-owned-identity"
  if (identity.clankerId !== observation.clankerId) return "clanker-id-mismatch"
  if (identity.harness !== observation.harness) return "harness-mismatch"
  if (identity.harnessSessionId && identity.harnessSessionId !== observation.harnessSessionId) return "harness-session-mismatch"
  return "recovery-attempt-mismatch"
}

const observationKey = (observation: LifecycleObservation) => [
  observation.clankerId ?? "",
  observation.harness ?? "",
  observation.harnessSessionId ?? "",
  observation.recoveryAttemptId ?? "",
].join("\0")

export const selectCurrentLifecycleObservations = (observations: readonly LifecycleObservation[]): LifecycleObservation[] =>
  [...Map.groupBy(observations, (observation) => observation.pane).values()]
    .map((paneObservations) => paneObservations
      .toSorted((left, right) => right.updatedAt - left.updatedAt || observationKey(right).localeCompare(observationKey(left)))[0]!)

export const reconcileClankerObservations = (
  identities: readonly OwnedClankerIdentity[],
  observations: readonly LifecycleObservation[],
): ClankerObservationReconciliation => {
  const identitiesByPane = Map.groupBy(identities, (identity) => identity.pane)
  const matchedByPane = new Map<string, ClankerReport>()
  const observedByPane = new Map<string, LifecycleObservation>()
  const unmatchedByPane = new Map<string, UnmatchedClankerObservation[]>()
  const superseded: ClankerReport[] = []

  for (const [pane, paneObservations] of Map.groupBy(observations, (observation) => observation.pane)) {
    const paneIdentities = identitiesByPane.get(pane) ?? []
    const matching = paneObservations
      .filter((observation): observation is ClankerReport => paneIdentities.some((identity) => exactMatch(identity, observation)))
      .sort((left, right) => right.updatedAt - left.updatedAt || observationKey(right).localeCompare(observationKey(left)))
    const selected = matching[0]
    if (selected) matchedByPane.set(pane, selected)
    superseded.push(...matching.slice(1))
    const observed = paneObservations
      .filter((observation) => !observation.clankerId && observation.harness && observation.state && observation.harnessSessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt || observationKey(right).localeCompare(observationKey(left)))[0]
    if (observed) observedByPane.set(pane, observed)

    const matched = new Set<LifecycleObservation>(matching)
    const unmatched = paneObservations
      .filter((observation) => !matched.has(observation))
      .map((observation) => ({
        observation,
        reason: mismatchReason(paneIdentities[0], observation),
      }))
    if (unmatched.length > 0) unmatchedByPane.set(pane, unmatched)
  }

  return { matchedByPane, observedByPane, unmatchedByPane, superseded }
}

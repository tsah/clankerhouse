/**
 * Recovery attestation: bind a live harness session to its durable clanker, adopting the
 * clanker on first sight, and settle the Recovery attempt that launched it. The CLI runs
 * this for `clankers recovery attest`; the daemon runs it for spooled lifecycle hooks.
 */
import { createHash } from "node:crypto"
import { listClankers } from "../clanker-api"
import { resolveRecoveredClankerIncidents } from "../incidents"
import { workshopForPath } from "../workshop"
import type { RecoveryStore } from "./store"

export const adoptDesired = async (store: RecoveryStore, id: string, sessionId: string) => {
  const matches = (await listClankers()).filter((row) => row.id === id)
  if (matches.length !== 1) throw new Error(matches.length > 1 ? `Ambiguous live panes for ${id}` : `Unknown clanker ${id}`)
  const live = matches[0]!
  if (live.harness !== "pi" && live.harness !== "claude" && live.harness !== "opencode") throw new Error(`Harness ${live.harness} does not support durable recovery`)
  const path = live.worktreePath || live.cwd
  const workshop = workshopForPath(path)
  const desired = store.createDesired({
    clankerId: id,
    harness: live.harness,
    workshopId: workshop?.workshopId || `path-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`,
    workshopPath: path,
    tmuxSessionName: live.session,
    tmuxWindowName: live.name || live.harness,
    cwd: live.cwd || path,
    harnessSessionId: sessionId,
    launchSpec: { version: 1, profile: null },
    originalTask: "Autonomously continue the most recent unfinished user request.",
  })
  const adoption = store.beginAttempt(id, "adopted-live-session")
  store.finishAttempt(adoption.id, "succeeded")
  return desired
}

export interface HarnessAttestation { clankerId: string; harnessSessionId: string; state?: string; attemptId?: number }

export const attestHarnessSession = async (store: RecoveryStore, { clankerId: id, harnessSessionId, state, attemptId }: HarnessAttestation) => {
  const desired = store.getDesired(id) ? store.bindHarnessSession(id, harnessSessionId) : await adoptDesired(store, id, harnessSessionId)
  if (attemptId !== undefined) {
    const attempt = store.getAttempt(attemptId)
    if (!attempt || attempt.clankerId !== id) throw new Error(`Recovery attempt ${attemptId} does not belong to ${id}`)
    store.finishAttempt(attemptId, "succeeded")
    if (state) store.markRecoverySettled(id, attemptId, state)
    if (store.getDesired(id)?.recoveryCondition === "healthy") resolveRecoveredClankerIncidents(id)
  }
  return { clankerId: id, harnessSessionId: desired.harnessSessionId, attested: true }
}

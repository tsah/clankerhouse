/**
 * Stopping a Workshop releases its live resources and keeps everything durable. Its worktree,
 * branch, Labels, and lineage stay; its clankers are no longer wanted running, so Recovery
 * leaves them alone; their pending messages are orphaned; its Multiplexer sessions close.
 */
import type { DesiredClankerState } from "./recovery/model"

export interface StopCandidateSession {
  id: string
  workshopId?: string
  /** Canonical worktree, directory, and current paths the session claims or shows. */
  paths: readonly string[]
  clankerIds: readonly string[]
}

export interface StopCandidateClanker {
  clankerId: string
  workshopId: string
  /** Canonical. */
  workshopPath: string
  desiredState: DesiredClankerState
}

export interface WorkshopStopPlan {
  sessionIds: string[]
  /** Clankers whose desired state must become stopped. */
  stop: string[]
  /** Every clanker of the Workshop, live or registered, whose pending messages are orphaned. */
  clankerIds: string[]
}

export const workshopStopPlan = (input: {
  path: string
  workshopId?: string
  sessions: readonly StopCandidateSession[]
  desired: readonly StopCandidateClanker[]
}): WorkshopStopPlan => {
  const sessions = input.sessions.filter((session) => (input.workshopId && session.workshopId === input.workshopId) || session.paths.includes(input.path))
  const registered = input.desired.filter((row) => row.desiredState !== "tombstoned" && ((input.workshopId && row.workshopId === input.workshopId) || row.workshopPath === input.path))
  return {
    sessionIds: sessions.map((session) => session.id),
    stop: registered.filter((row) => row.desiredState !== "stopped").map((row) => row.clankerId),
    clankerIds: [...new Set([...registered.map((row) => row.clankerId), ...sessions.flatMap((session) => session.clankerIds)])],
  }
}

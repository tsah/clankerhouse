/**
 * Stopping a Workshop releases its live resources and keeps everything durable. Its worktree,
 * branch, Labels, and lineage stay; its clankers are closed in the ledger, so they are not
 * listed as interrupted; their pending messages are orphaned; its Multiplexer sessions close.
 */
import type { LedgerState } from "./clanker-ledger"

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
  state: LedgerState
}

export interface WorkshopStopPlan {
  sessionIds: string[]
  /** Open clankers to close. */
  stop: string[]
  /** Every clanker of the Workshop, live or registered, whose pending messages are orphaned. */
  clankerIds: string[]
}

export const workshopStopPlan = (input: {
  path: string
  workshopId?: string
  sessions: readonly StopCandidateSession[]
  clankers: readonly StopCandidateClanker[]
}): WorkshopStopPlan => {
  const sessions = input.sessions.filter((session) => (input.workshopId && session.workshopId === input.workshopId) || session.paths.includes(input.path))
  const registered = input.clankers.filter((row) => (input.workshopId && row.workshopId === input.workshopId) || row.workshopPath === input.path)
  return {
    sessionIds: sessions.map((session) => session.id),
    stop: registered.filter((row) => row.state === "open").map((row) => row.clankerId),
    clankerIds: [...new Set([...registered.map((row) => row.clankerId), ...sessions.flatMap((session) => session.clankerIds)])],
  }
}

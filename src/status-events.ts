/**
 * Status Events: what a clanker's Observations and Reports mean to something outside the host.
 *
 * A pure core in the style of `clankers watch`: one view plus a durable cursor gives the events
 * to publish and the next cursor. The caller commits both in one transaction (`status-outbox.ts`),
 * so a restart neither repeats nor loses a transition. Nothing here touches the clock or the disk.
 *
 * Herdr's `done` and `idle` differ only in whether the operator has seen the turn, so they are one
 * phase: `done -> idle` is the operator looking at a tab, not news.
 */
import type { ClankerState } from "./model"
import type { ClankerReportRecord, StoredMessage } from "./orchestration"

export const EVENT_VERSION = 1

export type StatusEventType = "clanker.settled" | "clanker.blocked" | "clanker.exited" | "clanker.crashed" | "message.stuck" | "hooks.test" | `report.${string}` | `marker.${string}`

/** The clanker facts every event carries; an exited clanker's come from the cursor. */
export interface ClankerFacts {
  workshopId: string | null
  workshop: string | null
  title: string | null
  repo: string | null
  branch: string | null
  worktree: string | null
  pane: string | null
  harness: string | null
}

export const NO_FACTS: ClankerFacts = { workshopId: null, workshop: null, title: null, repo: null, branch: null, worktree: null, pane: null, harness: null }

export interface StatusEvent extends ClankerFacts {
  version: typeof EVENT_VERSION
  id: string
  /** Stable per transition; a receiver drops repeats of a key it has seen, since delivery is at least once. */
  dedupeKey: string
  type: StatusEventType
  timestamp: string
  at: number
  host: string
  clankerId: string | null
  oldState: string | null
  newState: string | null
  summary: string | null
  prUrl: string | null
  details: Record<string, unknown>
  test?: true
}

export type DraftEvent = Pick<StatusEvent, "dedupeKey" | "type" | "at" | "clankerId" | "oldState" | "newState" | "details"> & { facts: ClankerFacts; summary: string | null; prUrl?: string | null }

export interface ViewedClanker {
  clankerId: string
  state: ClankerState
  settledGeneration: number
  facts: ClankerFacts
  /** The clanker's last words this turn, when the harness exposes them. Read only when an event needs it. */
  lastText?: () => string | null
  prUrl?: () => string | null
}

export interface ViewedMarker { name: string; path: string; facts: ClankerFacts; clankerId: string | null }

export interface StatusView {
  now: number
  clankers: readonly ViewedClanker[]
  /** Reports after the cursor's seq, oldest first. */
  reports: readonly ClankerReportRecord[]
  latestSeq: number
  /** Messages still `delivered` past the stuck threshold. */
  stuckMessages: readonly StoredMessage[]
  markers: readonly ViewedMarker[]
  /** The ledger's closing reason for a clanker, when it has one. */
  closedReason: (clankerId: string) => string | null | undefined
  factsForReport?: (report: ClankerReportRecord) => { facts: ClankerFacts; prUrl: string | null }
}

export interface DetectOptions {
  debounceMs: number
  exitGraceMs: number
}

type Phase = "working" | "blocked" | "settled"

interface PendingTransition { phase: Phase; state: ClankerState; settled: number; since: number }

export interface CursorClanker {
  phase: Phase
  state: ClankerState
  settled: number
  facts: ClankerFacts
  pending?: PendingTransition
  missingSince?: number
}

export interface StatusCursor {
  version: 1
  seq: number
  clankers: Record<string, CursorClanker>
  /** Stuck message ids already announced and still stuck. */
  messages: string[]
  /** `name\0worktree` of markers already announced and still present. */
  markers: string[]
}

const phaseOf = (state: ClankerState): Phase | undefined =>
  state === "working" ? "working" : state === "blocked" ? "blocked" : state === "done" || state === "idle" ? "settled" : undefined

const markerKey = (marker: Pick<ViewedMarker, "name" | "facts">) => `${marker.name}\0${marker.facts.worktree ?? ""}`

/** Starting from now: everything already true is the baseline, and nothing is replayed. */
export const initialStatusCursor = (view: Pick<StatusView, "clankers" | "latestSeq" | "stuckMessages" | "markers">): StatusCursor => ({
  version: 1,
  seq: view.latestSeq,
  clankers: Object.fromEntries(view.clankers.flatMap((clanker) => {
    const phase = phaseOf(clanker.state)
    return phase ? [[clanker.clankerId, { phase, state: clanker.state, settled: clanker.settledGeneration, facts: clanker.facts }]] : []
  })),
  messages: view.stuckMessages.map((message) => message.messageId),
  markers: view.markers.map(markerKey),
})

const excerptLimit = 500

/** One line of at most `limit` characters. */
export const excerpt = (text: string | null | undefined, limit = excerptLimit) => {
  if (!text) return null
  const collapsed = text.replace(/[\p{Cc}\s]+/gu, " ").trim()
  if (!collapsed) return null
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`
}

const PR_URL = /https?:\/\/[^\s"'<>)\]]+\/(?:pull|merge_requests)\/\d+/

/** The newest PR a clanker named: a `pr` label, a Report's payload, then any URL in its words. Clankerhouse never asks the forge. */
export const findPrUrl = (sources: { labels?: Record<string, string>; payload?: Record<string, unknown> | null; texts?: ReadonlyArray<string | null | undefined> }) => {
  const declared = [sources.payload?.prUrl, sources.payload?.pr_url, sources.payload?.pr, sources.labels?.pr, sources.labels?.pr_url, sources.labels?._pr]
  for (const value of declared) {
    const match = typeof value === "string" ? value.match(PR_URL) : null
    if (match) return match[0]
  }
  for (const text of sources.texts ?? []) {
    const match = text?.match(PR_URL)
    if (match) return match[0]
  }
  return null
}

export interface StatusStep {
  cursor: StatusCursor
  events: DraftEvent[]
  /** When a held transition next matures, so the caller can look again then. */
  nextDueAt: number | undefined
}

const transitionEvent = (clankerId: string, entry: CursorClanker, clanker: ViewedClanker, phase: Phase, now: number): DraftEvent | undefined => {
  if (phase === "working") return undefined
  const type = phase === "blocked" ? "clanker.blocked" : "clanker.settled"
  const lastText = clanker.lastText?.() ?? null
  return {
    dedupeKey: `${type}:${clankerId}:${now}`,
    type, at: now, clankerId,
    oldState: entry.state,
    newState: clanker.state,
    facts: clanker.facts,
    summary: excerpt(lastText),
    prUrl: clanker.prUrl?.() ?? findPrUrl({ texts: [lastText] }),
    details: { settledGeneration: clanker.settledGeneration },
  }
}

export const computeStatusEvents = (cursor: StatusCursor, view: StatusView, options: DetectOptions): StatusStep => {
  const { now } = view
  const events: DraftEvent[] = []
  const clankers = { ...cursor.clankers }
  let nextDueAt: number | undefined
  const dueAt = (at: number) => { nextDueAt = nextDueAt === undefined ? at : Math.min(nextDueAt, at) }

  for (const report of view.reports) {
    if (report.seq <= cursor.seq || report.state === "working") continue
    const known = view.factsForReport?.(report)
    const entry = clankers[report.clankerId]
    events.push({
      dedupeKey: `report:${report.seq}`,
      type: `report.${report.state}`,
      at: report.at,
      clankerId: report.clankerId,
      oldState: null,
      newState: view.clankers.find((clanker) => clanker.clankerId === report.clankerId)?.state ?? entry?.state ?? null,
      facts: entry?.facts ?? known?.facts ?? NO_FACTS,
      summary: excerpt(report.message),
      prUrl: findPrUrl({ payload: report.payload, texts: [report.message] }) ?? known?.prUrl ?? null,
      details: { seq: report.seq, reportState: report.state, to: report.to, ...(report.payload ? { payload: report.payload } : {}) },
    })
  }

  const present = new Set<string>()
  for (const clanker of view.clankers) {
    present.add(clanker.clankerId)
    const phase = phaseOf(clanker.state)
    const known = clankers[clanker.clankerId]
    if (!phase) {
      if (known) clankers[clanker.clankerId] = { ...known, facts: clanker.facts, missingSince: undefined }
      continue
    }
    // A new clanker that opens at a prompt is not news; one already blocked or finished is.
    const entry: CursorClanker = { ...(known ?? { phase: phase === "settled" && clanker.settledGeneration === 0 ? "settled" : "working", state: "unknown", settled: 0, facts: clanker.facts }), facts: clanker.facts, missingSince: undefined }
    // A relaunch restarts generations; its first settle is still a new turn.
    if (clanker.settledGeneration < entry.settled) entry.settled = 0
    const changed = phase !== entry.phase || (phase === "settled" && clanker.settledGeneration > entry.settled)
    if (!changed) {
      // Back where it was announced: whatever was held was a flap.
      clankers[clanker.clankerId] = { ...entry, state: clanker.state, settled: Math.max(entry.settled, clanker.settledGeneration), pending: undefined }
      continue
    }
    const held = entry.pending
    const pending: PendingTransition = held && held.phase === phase && held.settled === clanker.settledGeneration ? held : { phase, state: clanker.state, settled: clanker.settledGeneration, since: now }
    if (now - pending.since < options.debounceMs) {
      clankers[clanker.clankerId] = { ...entry, pending }
      dueAt(pending.since + options.debounceMs)
      continue
    }
    const event = transitionEvent(clanker.clankerId, entry, clanker, phase, now)
    if (event) events.push(event)
    clankers[clanker.clankerId] = { phase, state: clanker.state, settled: Math.max(entry.settled, clanker.settledGeneration), facts: clanker.facts }
  }

  for (const [clankerId, entry] of Object.entries(clankers)) {
    if (present.has(clankerId)) continue
    const missingSince = entry.missingSince ?? now
    if (now - missingSince < options.exitGraceMs) {
      clankers[clankerId] = { ...entry, missingSince }
      dueAt(missingSince + options.exitGraceMs)
      continue
    }
    const closedReason = view.closedReason(clankerId)
    const deliberate = Boolean(closedReason) && closedReason !== "ended"
    const active = entry.phase !== "settled" || (entry.pending !== undefined && entry.pending.phase !== "settled")
    // The harness wrapper records no exit status, so an unplanned end mid-turn is what counts as a crash.
    const type = active && !deliberate ? "clanker.crashed" : "clanker.exited"
    events.push({
      dedupeKey: `${type}:${clankerId}:${now}`,
      type, at: now, clankerId,
      oldState: entry.pending?.state ?? entry.state,
      newState: "exited",
      facts: entry.facts,
      summary: closedReason && closedReason !== "ended" ? `Closed: ${closedReason}` : null,
      details: { ...(closedReason ? { closedReason } : {}) },
    })
    delete clankers[clankerId]
  }

  const stuckIds = new Set(view.stuckMessages.map((message) => message.messageId))
  const announced = new Set(cursor.messages)
  for (const message of view.stuckMessages) {
    if (announced.has(message.messageId)) continue
    const clanker = view.clankers.find((candidate) => candidate.clankerId === message.clankerId)
    const deliveredAt = message.deliveredAt ?? message.createdAt
    events.push({
      dedupeKey: `message.stuck:${message.messageId}`,
      type: "message.stuck",
      at: now,
      clankerId: message.clankerId,
      oldState: "delivered",
      newState: "delivered",
      facts: clanker?.facts ?? clankers[message.clankerId]?.facts ?? NO_FACTS,
      summary: excerpt(`Message not acknowledged after ${Math.round((now - deliveredAt) / 1000)}s: ${message.text}`, 200),
      details: { messageId: message.messageId, deliveredAt, stuckSeconds: Math.round((now - deliveredAt) / 1000) },
    })
  }

  const presentMarkers = new Set(view.markers.map(markerKey))
  const announcedMarkers = new Set(cursor.markers)
  for (const marker of view.markers) {
    if (announcedMarkers.has(markerKey(marker))) continue
    announcedMarkers.add(markerKey(marker))
    events.push({
      dedupeKey: `marker.${marker.name}:${marker.facts.worktree ?? ""}:${now}`,
      type: `marker.${marker.name}`,
      at: now,
      clankerId: marker.clankerId,
      oldState: "absent",
      newState: "present",
      facts: marker.facts,
      summary: `${marker.path} appeared in ${marker.facts.worktree ?? "a worktree"}`,
      details: { path: marker.path },
    })
  }

  return {
    cursor: { version: 1, seq: Math.max(cursor.seq, view.latestSeq), clankers, messages: [...stuckIds], markers: [...presentMarkers] },
    events,
    nextDueAt,
  }
}

/** Fill in what every published event carries. */
export const publishableEvent = (draft: DraftEvent, identity: { id: string; host: string }): StatusEvent => ({
  version: EVENT_VERSION,
  id: identity.id,
  dedupeKey: draft.dedupeKey,
  type: draft.type,
  timestamp: new Date(draft.at).toISOString(),
  at: draft.at,
  host: identity.host,
  clankerId: draft.clankerId,
  ...draft.facts,
  oldState: draft.oldState,
  newState: draft.newState,
  summary: draft.summary,
  prUrl: draft.prUrl ?? null,
  details: draft.details,
})

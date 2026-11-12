/**
 * Needs Me: why a Workshop waits on the operator, decided once in the daemon's snapshot so the picker's needs-me views (Alt-I, Alt-E),
 * the Herdr app's count and any later reader agree. Pure: the daemon gathers the facts (Reports, the ledger, label
 * times, the clanker's last words) and this decides.
 *
 * A Workshop where a clanker is working and nothing is asked of the operator is not listed.
 */
import type { DetailRow, SessionRow, Target } from "./model"
import type { ClankerReportRecord } from "./orchestration"
import { DONE_LABEL } from "./labels"

/** Most pressing first, which decides a Workshop's one reason. The picker sorts by age and breaks ties by this (native-client needs_me_rank). */
export const NEEDS_ME_REASONS = ["asked", "blocked", "finished", "failed", "crashed", "your-move", "ready", "stale"] as const
export type NeedsMeReason = typeof NEEDS_ME_REASONS[number]

export interface NeedsMe {
  reason: NeedsMeReason
  /** Epoch ms the reason has held since. */
  since: number
  /** A word on the reason: the blocked kind, the label value, `clean`. */
  detail?: string
  /** The first line of the clanker's own question or report. */
  excerpt?: string
  /** The clanker that needs attention, so Enter lands on it. */
  clankerId?: string
  /** Snoozed (Alt-S) until this epoch ms; the snooze holds only while the reason it hid is the same. */
  snoozedUntil?: number
  /** The unsettled Workshop this one waits on (its `waits-on` label), by name. */
  waitingOn?: string
}

export interface NeedsMeFacts {
  now: number
  /** The newest Report of each clanker. */
  latestReport: (clankerId: string) => ClankerReportRecord | undefined
  /** When the clanker's current turn started; a Report older than that was answered. */
  turnStartedAt: (clankerId: string) => number | undefined
  /** The clanker's last words this turn, read only for a finished clanker with nothing better. */
  lastText: (clankerId: string) => string | null | undefined
  /** Interrupted Clankers of this Workshop: open in the ledger, last seen in an earlier server. */
  interrupted: (workshopId: string) => ReadonlyArray<{ clankerId: string; at: number }>
  /** The Workshop's `_snooze` label: the reason it hid, that reason's since, and when it wears off. */
  snooze: (workshopId: string) => Snooze | undefined
  /** The name of the Workshop its `waits-on` label names, while that one is open and not done. */
  waitingOn: (workshopId: string) => string | undefined
  /** Label pairs that mean "your move", with when the Workshop got each. */
  yourMoveLabel: (workshopId: string) => { value: string; at: number } | undefined
  /** No activity for this long makes an open Workshop stale (the Reaper's retention). */
  staleAfterMs: number
  /** Clean and idle for this long makes it ready to close. */
  readyAfterMs: number
}

const EXCERPT_LIMIT = 160

/** The hidden label Alt-S writes, `REASON:SINCE:UNTIL` in epoch ms, and the label that names a Workshop it waits on. */
export const SNOOZE_KEY = "_snooze"
export const WAITS_ON_KEY = "waits-on"

export interface Snooze { reason: string; since: number; until: number }

export const parseSnooze = (value: string | undefined): Snooze | undefined => {
  const match = value?.match(/^([a-z-]+):(\d+):(\d+)$/)
  return match ? { reason: match[1]!, since: Number(match[2]), until: Number(match[3]) } : undefined
}

/** Snoozed or waiting on another Workshop: still listed, after everything else, and not counted as needing you. */
export const deferred = (reason: Pick<NeedsMe, "snoozedUntil" | "waitingOn"> | undefined) => Boolean(reason?.snoozedUntil || reason?.waitingOn)

/** The first non-empty line, collapsed and cut to fit one row. */
export const firstLine = (text: string | null | undefined, limit = EXCERPT_LIMIT) => {
  const line = text?.split("\n").map((candidate) => candidate.replace(/[\p{Cc}\s]+/gu, " ").trim()).find(Boolean)
  if (!line) return undefined
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

const rank = (reason: NeedsMeReason) => NEEDS_ME_REASONS.indexOf(reason)
const morePressing = (left: NeedsMe, right: NeedsMe) => rank(left.reason) - rank(right.reason) || left.since - right.since

/** A Workshop's clanker rows: owned clankers, and harnesses the Multiplexer observes without a claim. */
const clankerDetails = (row: SessionRow) => (row.details ?? []).filter((detail) => detail.kind === "clanker" || (detail.kind === "observation" && detail.harness && detail.observation?.confidence !== "rejected"))

/** A Report filed before the clanker's current turn began was answered by whatever started that turn. */
const currentReport = (clankerId: string | undefined, facts: NeedsMeFacts) => {
  const report = clankerId ? facts.latestReport(clankerId) : undefined
  return report && report.at >= (facts.turnStartedAt(clankerId!) ?? 0) ? report : undefined
}

const clankerReasons = (detail: DetailRow, facts: NeedsMeFacts): NeedsMe[] => {
  const reasons: NeedsMe[] = []
  const id = detail.clankerId
  const current = currentReport(id, facts)
  const excerpt = firstLine(current?.message)
  const which = id ? { clankerId: id } : {}
  if (current?.state === "question") reasons.push({ reason: "asked", since: current.at, ...(excerpt ? { excerpt } : {}), ...which })
  if (current?.state === "blocked") reasons.push({ reason: "blocked", since: current.at, ...(excerpt ? { excerpt } : {}), ...which })
  if (current?.state === "failed") reasons.push({ reason: "failed", since: current.at, ...(excerpt ? { excerpt } : {}), ...which })
  if (detail.state === "blocked") {
    // The lifecycle hook sees blocked only for permission prompts (ADR-0011); the harness names any other kind.
    const said = firstLine(detail.blockedMessage)
    reasons.push({ reason: "blocked", since: detail.updatedAt || facts.now, detail: detail.blockedKind || "permission prompt", ...(said ? { excerpt: said } : {}), ...which })
  }
  if (detail.state === "failed") reasons.push({ reason: "failed", since: detail.updatedAt || facts.now, ...which })
  if (detail.state === "done") {
    const said = excerpt ?? (id ? firstLine(facts.lastText(id)) : undefined)
    reasons.push({ reason: "finished", since: detail.updatedAt || facts.now, ...(said ? { excerpt: said } : {}), ...which })
  }
  if (detail.gone) reasons.push({ reason: "crashed", since: detail.updatedAt || facts.now, detail: "harness exited", ...which })
  return reasons
}

/** The newest observed use of a Workshop, in epoch ms. */
export const lastActivityAt = (row: SessionRow) => Math.max(row.recency * 1000, ...row.details.map((detail) => detail.updatedAt || 0))

/**
 * The Workshop's most pressing reason to need the operator, or undefined. Only open Workshops (a live Multiplexer
 * session) are judged; a sessionless one was stopped or closed.
 */
export const needsMe = (row: SessionRow, facts: NeedsMeFacts): NeedsMe | undefined => {
  if (row.target.type !== "session") return undefined
  const details = clankerDetails(row)
  // Done is the operator saying the work is finished: what is left to tell them is a question, a block, a
  // failure, or that it can be closed now.
  const done = row.labels?.includes(DONE_LABEL.value) ?? false
  const reasons = details.flatMap((detail) => clankerReasons(detail, facts)).filter((reason) => !done || reason.reason !== "finished")
  const workshopId = row.workshopId
  if (workshopId) {
    for (const interrupted of facts.interrupted(workshopId)) reasons.push({ reason: "crashed", since: interrupted.at, detail: "interrupted", clankerId: interrupted.clankerId })
  }
  const working = details.some((detail) => detail.state === "working")
  if (workshopId && !working) {
    const label = facts.yourMoveLabel(workshopId)
    const idleSince = lastActivityAt(row)
    const idleFor = facts.now - idleSince
    if (label && !done) {
      // A clanker that settled after asking left its question as its last words.
      const settled = details.find((detail) => (detail.state === "done" || detail.state === "idle") && detail.clankerId)
      const said = settled ? firstLine(currentReport(settled.clankerId, facts)?.message) ?? firstLine(facts.lastText(settled.clankerId!)) : undefined
      reasons.push({ reason: "your-move", since: label.at, detail: label.value, ...(said ? { excerpt: said } : {}), ...(settled ? { clankerId: settled.clankerId } : {}) })
    } else if (reasons.length === 0 && row.flags === "clean" && idleFor >= facts.readyAfterMs) {
      reasons.push({ reason: "ready", since: idleSince, detail: "clean" })
    } else if (reasons.length === 0 && idleFor >= facts.staleAfterMs) {
      reasons.push({ reason: "stale", since: idleSince })
    }
  }
  const chosen = reasons.toSorted(morePressing)[0]
  if (!chosen || !workshopId) return chosen
  // Something new (another reason, or the same one again later) ends a snooze, and so does its day running out.
  const snooze = facts.snooze(workshopId)
  if (snooze && snooze.reason === chosen.reason && snooze.since === Math.round(chosen.since) && facts.now < snooze.until) chosen.snoozedUntil = snooze.until
  const waitingOn = facts.waitingOn(workshopId)
  if (waitingOn) chosen.waitingOn = waitingOn
  return chosen
}

/** `N need you · M open`: open means a live session, and a Workshop counts once however many it has. */
export const needsMeCounts = (rows: readonly Pick<SessionRow, "target" | "workshopId" | "path" | "needsMe">[]) => {
  const open = new Set<string>()
  const needing = new Set<string>()
  for (const row of rows) {
    if (row.target.type !== "session") continue
    const key = row.workshopId ?? row.path
    open.add(key)
    if (row.needsMe && !deferred(row.needsMe)) needing.add(key)
  }
  return { needsMe: needing.size, open: open.size }
}

/** Unset or empty: needs-input and waiting-for-approval stages. Otherwise a comma list of KEY=VALUE pairs; `none` lists no label. */
export const yourMoveLabels = (env: Record<string, string | undefined> = Bun.env) => {
  const configured = env.CLANKERHOUSE_YOUR_MOVE_LABELS?.trim()
  if (!configured) return [{ key: "stage", value: "needs-input" }, { key: "stage", value: "waiting-for-approval" }]
  if (configured === "none") return []
  return configured.split(",").flatMap((pair) => {
    const [key, value] = pair.trim().split("=")
    return key && value ? [{ key, value }] : []
  })
}

export const READY_AFTER_MS = 86_400_000

/**
 * The picker's own list order (native-client needs_me_rank): age orders the list and this only breaks its ties, so it
 * groups coarser than NEEDS_ME_REASONS. An unknown reason from a newer daemon ranks last.
 */
export const needsMeListRank = (reason: string) =>
  reason === "asked" || reason === "blocked" ? 0 : reason === "finished" ? 1 : reason === "failed" || reason === "crashed" ? 2 : reason === "your-move" ? 3 : 4

/** Freshest first (Alt-I), eldest first (Alt-E), or every open Workshop in the snapshot's order (the flat list, Alt-F/Alt-K). */
export type NeedsMeOrder = "freshest" | "eldest" | "flat"

type ListedRow = Pick<SessionRow, "target" | "workshopId" | "needsMe">

/**
 * The rows the picker's needs-me views list, in their order (native-client needs_me_sessions, pinned to it by
 * src/fixtures/needs-me-order.json): open Workshops with a reason, one row each (its most pressing: deferred last,
 * then rank, then the eldest), deferred after everything else, then age, then rank. `flat` keeps every open Workshop,
 * one row each, in the snapshot's order, with or without a reason.
 */
export const needsMeList = <Row extends ListedRow>(rows: readonly Row[], order: NeedsMeOrder): Row[] => {
  const chosen: Row[] = []
  const key = (row: Row) => [Number(deferred(row.needsMe)), needsMeListRank(row.needsMe!.reason), row.needsMe!.since] as const
  const before = (left: readonly number[], right: readonly number[]) => {
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]!
    return false
  }
  for (const row of rows) {
    if (row.target.type !== "session" || (order !== "flat" && !row.needsMe)) continue
    const same = row.workshopId ? chosen.findIndex((known) => known.workshopId === row.workshopId) : -1
    if (same < 0) chosen.push(row)
    else if (order !== "flat" && before(key(row), key(chosen[same]!))) chosen[same] = row
  }
  if (order === "flat") return chosen
  return chosen.toSorted((left, right) => {
    const [l, r] = [left.needsMe!, right.needsMe!]
    const age = order === "eldest" ? l.since - r.since : r.since - l.since
    return Number(deferred(l)) - Number(deferred(r)) || age || needsMeListRank(l.reason) - needsMeListRank(r.reason)
  })
}

/** A row of `clankers needs-me --json`: the Workshop, where Enter lands, and why it is listed. */
export interface NeedsMeEntry {
  position: number
  workshopId: string | null
  name: string
  session: string
  title: string | null
  project: string | null
  branch: string
  path: string
  /** The multiplexer address of the clanker's pane (hc terminal id, Herdr pane id), or null when the row has none. */
  pane: string | null
  clankerId: string | null
  /** That clanker's state, as the flat list shows it. */
  state: string | null
  /** The target Enter in the picker opens: the clanker's window, else the session. */
  target: Target
  reason: NeedsMeReason | string | null
  since: number | null
  detail: string | null
  excerpt: string | null
  deferred: boolean
  snoozedUntil: number | null
  waitingOn: string | null
  /** Visible labels, KEY=VALUE (title and hidden `_` keys left out). */
  labels: Record<string, string>
  /** When the Workshop was created, epoch ms; null when the registry does not know it. */
  createdAt: number | null
}

const windowOf = (detail: DetailRow | undefined) => detail && (detail.target.type === "window" || detail.target.type === "opencode") ? detail.target : undefined
const paneOf = (target: Target | undefined) => {
  if (!target || target.type === "directory" || target.type === "session") return null
  return target.location?.nativePaneId ?? target.pane ?? null
}

/** One listed row as the dump prints it. Labels and createdAt come from the Workshop registry, which the snapshot does not carry. */
export const needsMeEntry = (row: SessionRow, position: number, registry: { labels?: Record<string, string>; createdAt?: number }): NeedsMeEntry => {
  const reason = row.needsMe
  const clankers = clankerDetails(row)
  const needing = reason?.clankerId ? clankers.find((detail) => detail.clankerId === reason.clankerId) : undefined
  // Enter lands on the clanker that needs attention when it is still on screen (native-client needs_me_target).
  const target = windowOf(needing) ?? row.target
  const shown = needing ?? clankers.find((detail) => windowOf(detail))
  return {
    position,
    workshopId: row.workshopId ?? null,
    name: row.name,
    session: row.target.type === "directory" ? "" : row.target.session,
    title: row.title ?? null,
    project: row.project ?? null,
    branch: row.branch ?? "",
    path: row.path,
    pane: paneOf(windowOf(shown)),
    clankerId: reason?.clankerId ?? shown?.clankerId ?? null,
    state: shown?.state ?? null,
    target,
    reason: reason?.reason ?? null,
    since: reason?.since ?? null,
    detail: reason?.detail ?? null,
    excerpt: reason?.excerpt ?? null,
    deferred: deferred(reason),
    snoozedUntil: reason?.snoozedUntil ?? null,
    waitingOn: reason?.waitingOn ?? null,
    labels: { ...registry.labels },
    createdAt: registry.createdAt ?? null,
  }
}

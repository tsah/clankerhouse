/**
 * `clankers settled`: every open session where nothing is in progress, each with the last replies its agent stopped
 * on, for a reader that decides what the operator has to act on (Decision Flow). Broader than Needs Me: a session is
 * listed whether or not it needs the operator, and the reader applies its own skip rules.
 *
 * Not in progress: an open session (a live Multiplexer session) none of whose clankers is working. Blocked, failed,
 * finished, idle, unknown and exited clankers, and sessions with no clanker at all, are all listed.
 */
import type { DetailRow, SessionRow, Target } from "./model"
import { deferred, needsMeList, type NeedsMe } from "./needs-me"
import type { LastMessage, LastMessages, LastMessagesSource } from "./last-messages"

/** created: the Workshop made first comes first (the default). freshest/eldest: the Needs-me rows in the picker's order (Alt-I, Alt-E), then the rest by when they last changed, the same way round. flat: the snapshot's order. */
export const SETTLED_ORDERS = ["created", "freshest", "eldest", "flat"] as const
export type SettledOrder = typeof SETTLED_ORDERS[number]

export interface SettledClanker {
  clankerId: string | null
  pane: string | null
  harness: string | null
  state: string
}

export interface SettledEntry {
  /** Stable while the session lives: pass it to --after to get the next row, or to --key to get this one again. */
  key: string
  position: number
  session: string
  name: string
  title: string | null
  workshopId: string | null
  project: string | null
  branch: string
  /** The session's folder, the Workshop's checkout. */
  cwd: string
  /** The multiplexer address of the main clanker's pane (hc terminal id, Herdr pane id). */
  pane: string | null
  harness: string | null
  /** The main clanker's state: blocked, failed, done, idle or unknown; null for a session with no clanker. */
  state: string | null
  clankerId: string | null
  /** The harness's turn counter for the main clanker (lifecycle generation), and the last one that settled. */
  turn: number | null
  settledTurn: number | null
  /** When the main clanker last changed state, epoch ms. */
  lastStatusAt: number | null
  /** When the Workshop was created, epoch ms; null for a session the registry does not know. */
  createdAt: number | null
  /** Visible Workshop labels, KEY=VALUE. */
  labels: Record<string, string>
  /** The `ticket` label, else a label value or the branch shaped like a ticket key (TWE-2080). */
  ticket: string | null
  stage: string | null
  /** The newest pull request the session linked (Claude's pr-link), else a `pr` label, else the newest pull request URL in its last replies. */
  pr: { number: number | null; url: string | null } | null
  /** Why it needs the operator, as the picker's needs-me view says, or null when it is not listed there. */
  needsMe: (Pick<NeedsMe, "reason" | "since"> & { detail: string | null; deferred: boolean; snoozedUntil: number | null; waitingOn: string | null }) | null
  /** Every clanker in the session. */
  clankers: SettledClanker[]
  /** The final reply of each of the main clanker's last turns, newest first, full text from the harness's own log. */
  lastMessages: LastMessage[]
  lastMessagesSource: LastMessagesSource | null
  /** The log they were read from (Claude transcript, Pi session file), or null. */
  lastMessagesPath: string | null
  /** The target Enter in the picker would open. */
  target: Target
}

export interface SettledDependencies {
  /** The pane's lifecycle report (src/clanker-api paneReport). */
  report: (pane: string) => Record<string, unknown> | undefined
  lastMessages: (harness: string | undefined, report: Record<string, unknown> | undefined) => LastMessages
  labels: (workshopId: string) => Record<string, string>
  createdAt: (workshopId: string) => number | undefined
}

const clankerDetails = (row: SessionRow) => (row.details ?? []).filter((detail) => detail.kind === "clanker" || (detail.kind === "observation" && detail.harness && detail.observation?.confidence !== "rejected"))

const paneOf = (detail: DetailRow | undefined) => {
  const target = detail?.target
  if (!target || target.type === "directory" || target.type === "session") return null
  return target.location?.nativePaneId ?? target.pane ?? null
}

/** Open sessions where no clanker is working. */
export const settledSessions = <Row extends Pick<SessionRow, "target" | "details">>(rows: readonly Row[]): Row[] =>
  rows.filter((row) => row.target.type === "session" && !(row.details ?? []).some((detail) => detail.state === "working"))

/** The clanker a row is about: the one that needs the operator, else the most recently changed. */
const mainClanker = (row: SessionRow) => {
  const clankers = clankerDetails(row)
  return clankers.find((detail) => row.needsMe?.clankerId && detail.clankerId === row.needsMe.clankerId)
    ?? clankers.toSorted((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0]
}

export const settledKey = (row: Pick<SessionRow, "target">) => row.target.type === "directory" ? row.target.path : (row.target.resourceId ?? row.target.session)

const lastChange = (row: SessionRow) => mainClanker(row)?.updatedAt || row.recency * 1000 || 0

/** The rows in the asked order. `createdAt` breaks no ties itself: a row the registry does not know comes last. */
export const orderSettled = (rows: readonly SessionRow[], order: SettledOrder, createdAt: (workshopId: string) => number | undefined): SessionRow[] => {
  if (order === "flat") return [...rows]
  if (order === "created") {
    const created = (row: SessionRow) => (row.workshopId ? createdAt(row.workshopId) : undefined) ?? Number.POSITIVE_INFINITY
    return rows.toSorted((left, right) => created(left) - created(right) || lastChange(left) - lastChange(right) || left.name.localeCompare(right.name))
  }
  // The Needs-me rows as the picker lists them; a Workshop's other sessions and the rest follow by when they last changed.
  const listed = needsMeList(rows, order)
  const chosen = new Set(listed)
  const rest = rows.filter((row) => !chosen.has(row))
  const deferredRows = listed.filter((row) => deferred(row.needsMe))
  const pressing = listed.filter((row) => !deferred(row.needsMe))
  const byChange = rest.toSorted((left, right) => order === "eldest" ? lastChange(left) - lastChange(right) : lastChange(right) - lastChange(left))
  return [...pressing, ...byChange, ...deferredRows]
}

const TICKET = /^[A-Z][A-Z0-9]+-\d+$/

/** The `ticket` label, else any label value shaped like a ticket key, else one at the start of the branch (twe-2131-scope → TWE-2131). */
export const ticketOf = (labels: Record<string, string>, branch: string) => {
  if (labels.ticket) return labels.ticket
  const valued = Object.values(labels).find((value) => TICKET.test(value))
  if (valued) return valued
  // A project key is 2 to 5 letters, so a dated branch such as scratch-11-03 is not one.
  return branch.match(/^([a-z]{2,5}-\d+)(?:-|$)/i)?.[1]?.toUpperCase() ?? null
}

/** The newest GitHub pull request URL in the replies, newest reply first. */
export const prInText = (messages: readonly LastMessage[]) => {
  for (const message of messages) {
    const urls = [...message.text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g)]
    const last = urls.at(-1)
    if (last) return { number: Number(last[1]), url: last[0] }
  }
  return null
}

const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null

/** One row as the command prints it; reads the main clanker's report and its harness's log. */
export const settledEntry = (row: SessionRow, position: number, dependencies: SettledDependencies, withMessages = true): SettledEntry => {
  const main = mainClanker(row)
  const pane = paneOf(main)
  const report = pane ? dependencies.report(pane) : undefined
  const read = withMessages && main ? dependencies.lastMessages(main.harness, report) : undefined
  const labels = row.workshopId ? dependencies.labels(row.workshopId) : {}
  const reason = row.needsMe
  const prLabel = labels.pr
  return {
    key: settledKey(row),
    position,
    session: row.target.type === "directory" ? "" : row.target.session,
    name: row.name,
    title: row.title ?? null,
    workshopId: row.workshopId ?? null,
    project: row.project ?? null,
    branch: row.branch ?? "",
    cwd: row.path,
    pane,
    harness: main?.harness ?? null,
    state: main?.state ?? null,
    clankerId: main?.clankerId ?? null,
    turn: numberOrNull(report?.generation),
    settledTurn: numberOrNull(report?.settledGeneration),
    lastStatusAt: Math.max(main?.updatedAt || 0, numberOrNull(report?.updatedAt) ?? 0) || null,
    createdAt: (row.workshopId ? dependencies.createdAt(row.workshopId) : undefined) ?? null,
    labels,
    ticket: ticketOf(labels, row.branch ?? ""),
    stage: labels.stage ?? null,
    pr: read?.pr ?? (prLabel ? { number: Number(prLabel.match(/(\d+)$/)?.[1] ?? NaN) || null, url: /^https?:/.test(prLabel) ? prLabel : null } : null) ?? prInText(read?.messages ?? []),
    needsMe: reason ? { reason: reason.reason, since: reason.since, detail: reason.detail ?? null, deferred: deferred(reason), snoozedUntil: reason.snoozedUntil ?? null, waitingOn: reason.waitingOn ?? null } : null,
    clankers: clankerDetails(row).map((detail) => ({ clankerId: detail.clankerId ?? null, pane: paneOf(detail), harness: detail.harness ?? null, state: detail.state })),
    lastMessages: read?.messages ?? [],
    lastMessagesSource: read?.source ?? null,
    lastMessagesPath: read?.path ?? null,
    target: row.target,
  }
}

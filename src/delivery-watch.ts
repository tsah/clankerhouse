/**
 * The delivery watch: every message either lands in its recipient's session or someone hears why not.
 *
 * Each pass looks at messages still pending, ones that failed, and ones that landed after their sender was told they
 * had not. A clanker sender gets one notice when its message has been held for a while (with the reason), one when
 * it failed, and one when a held or failed message lands after all. A hold that waiting will not fix (the recipient
 * is out of usage, gone, silent, or never took the hand-off), or one that has lasted hours, is escalated to the
 * operator: a `message.undelivered` Status Event for the sinks (the phone push) and a needs-me row, one push per
 * recipient while its earlier escalation is still open.
 *
 * Reports go out here too. `clankers report --to X` used to reach X only if X ran `clankers watch` on the right
 * scope; a question, block, failure or done Report that no watch has shown within a minute is now handed to the
 * addressee's live clanker as a message.
 */
import { holdReasons, sendClanker, type HoldReason } from "./clanker-api"
import { openClankerLedger } from "./clanker-ledger"
import type { ManagedMultiplexer } from "./multiplexer"
import { OrchestrationStore, type ClankerReportRecord, type DeliveryWatchFields, type StoredMessage } from "./orchestration"

/** A held message's sender hears why after this long; a hold that will not fix itself reaches the operator after the second. */
export const NOTICE_AFTER_MS = Number(Bun.env.CLANKERHOUSE_DELIVERY_NOTICE_MS ?? 10 * 60_000) || 10 * 60_000
export const ESCALATE_AFTER_MS = Number(Bun.env.CLANKERHOUSE_DELIVERY_ESCALATE_MS ?? 45 * 60_000) || 45 * 60_000
/** Any hold this old reaches the operator, broken or not. */
export const ESCALATE_ANY_AFTER_MS = 3 * 60 * 60_000
/** A Report whose addressee has no live clanker this long is given up on, and its reporter told. */
export const REPORT_UNDELIVERABLE_MS = 10 * 60_000

/** Who sends the watch's own notices; their failures are not noticed again. */
export const DELIVERY_WATCH_SENDER = "clankerhouse"

export type WatchedMessage = StoredMessage & DeliveryWatchFields

export type DeliveryWatchAction =
  | { kind: "notice"; notice: "held" | "failed" | "landed"; to: string | null; text: string }
  | { kind: "escalate"; reason: string }

/** Failure reasons worth the operator's attention; the rest (stopped on purpose, a relaunch) only tell the sender. */
const ESCALATED_FAILURES = new Set(["undelivered", "recipient-missing"])

const orphanText = (reason: string | null) => {
  switch (reason) {
    case "undelivered": return "it was handed over but never submitted (the recipient's hook did not see it, nor does its transcript have it)"
    case "recipient-missing": return "the recipient stopped running and did not come back within 30 minutes"
    case "stopped": return "the recipient's Workshop was stopped"
    case "harness-replaced": return "the recipient's harness was relaunched; the message was addressed to the earlier launch"
    default: return reason ?? "unknown reason"
  }
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + " UTC"
const age = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

/**
 * What to do about one message now. `hold` is why a pending message has not landed; `name` names its recipient.
 * Pure: the pass records each action's mark whether or not the notice could be sent.
 */
export const deliveryWatchActions = (message: WatchedMessage, hold: HoldReason | undefined, name: string, now: number): DeliveryWatchAction[] => {
  // The watch's own notices are not watched, or a sender that cannot be told would be told so forever.
  if (message.sender === DELIVERY_WATCH_SENDER) return []
  const to = message.sender.startsWith("clanker-") && message.sender !== message.clankerId ? message.sender : null
  const what = `Your message ${message.messageId} to ${name} (${message.clankerId}), sent ${clock(message.createdAt)}`
  const check = `Check it with: clankers send-status ${message.messageId}`
  if (message.state === "acked") {
    if (message.noticeKind !== "held" && message.noticeKind !== "failed") return []
    return [{ kind: "notice", notice: "landed", to, text: `[clankerhouse delivery] ${what}, landed after all at ${clock(message.ackedAt ?? now)}. Disregard the earlier notice.` }]
  }
  if (message.state === "orphaned") {
    if (message.noticeKind === "failed") return []
    const actions: DeliveryWatchAction[] = [{ kind: "notice", notice: "failed", to, text: `[clankerhouse delivery] ${what}, was NOT delivered: ${orphanText(message.orphanReason)}. Resend it if it still matters. ${check}` }]
    // A routine proves and reports its own wakes.
    if (ESCALATED_FAILURES.has(message.orphanReason ?? "") && message.escalatedAt === null && !message.sender.startsWith("routine:")) actions.push({ kind: "escalate", reason: orphanText(message.orphanReason) })
    return actions
  }
  if (!hold) return []
  const held = now - message.createdAt
  const actions: DeliveryWatchAction[] = []
  if (held >= NOTICE_AFTER_MS && message.noticeKind === null) {
    actions.push({ kind: "notice", notice: "held", to, text: `[clankerhouse delivery] ${what}, is still not delivered after ${age(held)}: ${hold.text}. It stays queued and goes in when the recipient can take it; you will hear again if it lands or fails. ${check}` })
  }
  const escalate = (hold.broken && held >= ESCALATE_AFTER_MS) || held >= ESCALATE_ANY_AFTER_MS
  if (escalate && message.escalatedAt === null && !message.sender.startsWith("routine:")) actions.push({ kind: "escalate", reason: hold.text })
  return actions
}

/** One escalation, for the sinks (the operator's phone) and the needs-me list. */
export interface DeliveryEscalation { message: WatchedMessage; name: string; reason: string; at: number; pushed: boolean }

export interface DeliveryWatchDependencies {
  multiplexer?: ManagedMultiplexer
  storePath?: string
  now?: () => number
  /** Send a notice to a clanker; the default is `clankers send` from `clankerhouse`. */
  send?: (to: string, text: string, requestId: string, sender?: string) => Promise<unknown>
  /** Publish escalations whose push is due (one per recipient); returns how many sinks took them. */
  escalate?: (escalations: DeliveryEscalation[]) => void | Promise<void>
  /** Resolve a Report's addressee (a clanker or Workshop id) to a live clanker id. */
  addressee?: (to: string, live: ReadonlySet<string>) => string | undefined
  log?: (line: string) => void
}

const withLedger = <T>(work: (ledger: ReturnType<typeof openClankerLedger>) => T): T => {
  const ledger = openClankerLedger()
  try { return work(ledger) } finally { ledger.close() }
}

/** The live clanker a Report addressed to `to` reaches: that clanker, else the newest live clanker of that Workshop (or of the addressed clanker's Workshop). */
export const reportAddressee = (to: string, live: ReadonlySet<string>): string | undefined => {
  if (live.has(to)) return to
  try {
    return withLedger((ledger) => {
      const workshopId = to.startsWith("clanker-") ? ledger.get(to)?.workshopId : to
      if (!workshopId) return undefined
      return ledger.list({ workshopId }).filter((row) => live.has(row.clankerId)).toSorted((left, right) => right.createdAt - left.createdAt)[0]?.clankerId
    })
  } catch { return undefined }
}

const reportText = (report: ClankerReportRecord, name: string) =>
  `[clankerhouse report ${report.seq} from ${name} (${report.clankerId}), state ${report.state}]\n${report.message ?? "(no message)"}${report.payload ? `\nPayload: ${JSON.stringify(report.payload).slice(0, 2000)}` : ""}\n(No \`clankers watch\` showed you this Report, so it was delivered as a message.)`

/** One pass of the delivery watch. Returns what it did, for the runner's log. */
export async function runDeliveryWatch(dependencies: DeliveryWatchDependencies = {}) {
  const now = (dependencies.now ?? Date.now)()
  const log = dependencies.log ?? (() => {})
  const send = dependencies.send ?? ((to, text, requestId, sender = DELIVERY_WATCH_SENDER) => sendClanker(to, text, { delivery: "auto", requestId, sender, source: "delivery-watch" }, dependencies.multiplexer))
  const store = OrchestrationStore.open(dependencies.storePath)
  const done: string[] = []
  try {
    const candidates = store.deliveryWatchCandidates()
    const reports = store.unpushedReports(now)
    if (!candidates.length && !reports.length) return done
    const { reasons, nameOf, landed, live } = await holdReasons(candidates, dependencies.multiplexer, now, true)
    const escalations: DeliveryEscalation[] = []
    const openEscalations = new Set(store.escalatedMessages().map((message) => message.clankerId))
    for (const candidate of candidates) {
      const name = nameOf(candidate.clankerId)
      // Before telling anyone an undelivered message failed, its transcript gets the last word.
      const message = landed.has(candidate.messageId) && store.landUndelivered(candidate.messageId, now) ? { ...candidate, state: "acked" as const, ackedAt: now } : candidate
      for (const action of deliveryWatchActions(message, reasons.get(message.messageId), name, now)) {
        if (action.kind === "notice") {
          store.markNotice(message.messageId, action.notice, now)
          if (!action.to) { done.push(`${message.messageId}: ${action.notice} (sender ${message.sender} is not a clanker; not told)`); continue }
          try {
            await send(action.to, action.text, `delivery-${action.notice}:${message.messageId}`)
            done.push(`${message.messageId}: told ${action.to} it ${action.notice === "held" ? "is held" : action.notice}`)
          } catch (error) {
            done.push(`${message.messageId}: could not tell ${action.to} (${error instanceof Error ? error.message : String(error)})`)
          }
        } else {
          store.markEscalated(message.messageId, action.reason, now)
          // One push per recipient while an earlier escalation for it is still open; every message still gets its row.
          const pushed = !openEscalations.has(message.clankerId)
          openEscalations.add(message.clankerId)
          escalations.push({ message: { ...message, escalatedAt: now, escalationReason: action.reason }, name, reason: action.reason, at: now, pushed })
          done.push(`${message.messageId}: escalated to the operator${pushed ? "" : " (row only; this recipient already has an open push)"}: ${action.reason}`)
        }
      }
    }
    if (escalations.length) await dependencies.escalate?.(escalations)
    const addressee = dependencies.addressee ?? reportAddressee
    for (const report of reports) {
      const target = addressee(report.to!, live)
      if (!target) {
        // Nobody to hand it to for 10 minutes: the reporter hears, once, instead of the Report vanishing after a day.
        if (now - report.at >= REPORT_UNDELIVERABLE_MS) {
          store.markReportPushed(report.seq, now)
          if (report.clankerId.startsWith("clanker-")) {
            await send(report.clankerId, `[clankerhouse delivery] Your ${report.state} Report ${report.seq} to ${report.to} reached nobody: no live clanker answers for ${report.to}, and no \`clankers watch\` showed it. Send it with \`clankers send\` to a live clanker, or tell the operator.`, `report-undeliverable:${report.seq}`).catch(() => undefined)
          }
          done.push(`report ${report.seq}: no live addressee for ${report.to}; told ${report.clankerId}`)
        }
        continue
      }
      if (target === report.clankerId) { store.markReportPushed(report.seq, now); continue }
      try {
        await send(target, reportText(report, nameOf(report.clankerId)), `report:${report.seq}`, report.clankerId)
        store.markReportPushed(report.seq, now)
        done.push(`report ${report.seq}: delivered to ${target}`)
      } catch (error) {
        done.push(`report ${report.seq}: could not deliver to ${target} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    for (const line of done) log(line)
    return done
  } finally { store.close() }
}

/** One escalation as a Status Event draft, for the sinks that want `message.*` (the operator's phone). */
export const deliveryEscalationEvent = (escalation: DeliveryEscalation, workshop?: { id: string; path: string; branch: string }) => {
  const { message } = escalation
  const from = message.sender.startsWith("routine:") ? `routine ${message.sender.slice(8)}` : message.sender
  return {
    dedupeKey: `message.undelivered:${message.messageId}`,
    type: "message.undelivered" as const,
    at: escalation.at,
    clankerId: message.clankerId,
    oldState: message.state,
    newState: "undelivered",
    summary: `Message to ${escalation.name} from ${from} not delivered: ${escalation.reason}`,
    facts: { workshopId: workshop?.id ?? null, workshop: escalation.name, title: escalation.name, repo: null, branch: workshop?.branch ?? null, worktree: workshop?.path ?? null, pane: null, harness: null },
    details: { messageId: message.messageId, sender: message.sender, name: escalation.name, reason: escalation.reason, queuedAt: message.createdAt },
  }
}

/**
 * Status hooks in the daemon: after each projection refresh, turn the current herd into Status
 * Events, commit them to the outbox, and deliver them to the configured sinks on their own
 * schedule. Without a config this costs one file check per refresh. Delivery never holds up
 * detection, a slow sink never holds up another sink, and nothing here runs on a harness hook.
 */
import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { hostname } from "node:os"
import { basename, join } from "node:path"
import { listClankerReportFacts, type ClankerReportFacts, type PaneMetadata } from "./clanker-api"
import { liveClaudeText } from "./clanker-list"
import { openClankerLedger } from "./clanker-ledger"
import { TITLE_KEY } from "./labels"
import type { ManagedMultiplexer } from "./multiplexer"
import { withOrchestrationStore, type ClankerReportRecord } from "./orchestration"
import { NO_FACTS, computeStatusEvents, findPrUrl, initialStatusCursor, publishableEvent, type ClankerFacts, type DraftEvent, type StatusCursor, type StatusEvent, type StatusView, type ViewedMarker } from "./status-events"
import { StatusOutbox, statusOutboxPath, type DeliveryRecord, type SinkTotals } from "./status-outbox"
import { hooksConfigExists, hooksConfigPath, openSink, readHooksConfig, redactedSink, retryDelayMs, sinkWants, type HooksConfig, type Sink } from "./status-sinks"
import { clankerWorkshopPaths } from "./watch"
import { allWorkshopLabels, listWorkshopRecords, type WorkshopRecord } from "./workshop"

export type StatusViewSource = (config: HooksConfig, cursor: StatusCursor | undefined) => Promise<StatusView | undefined>

export interface StatusHookOptions {
  view: StatusViewSource
  /** Ask for a fresh observation; the daemon answers with `observed()` after its next refresh. */
  requestObservation: () => void
  configPath?: string
  outboxPath?: string
  now?: () => number
  log?: (message: string) => void
}

const DELIVERY_BATCH = 20

export class StatusHookRuntime {
  private config: HooksConfig | undefined
  private signature = ""
  private outbox: StatusOutbox | undefined
  private sinks = new Map<string, Sink>()
  private observing = false
  private observeAgain = false
  private draining = false
  private drainAgain = false
  private stopped = false
  private detectTimer: ReturnType<typeof setTimeout> | undefined
  private deliveryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pausedUntil = new Map<string, number>()
  private readonly logged = new Map<string, string>()
  private readonly now: () => number
  private readonly host = hostname()

  constructor(private readonly options: StatusHookOptions) {
    this.now = options.now ?? Date.now
  }

  private logOnce(topic: string, message: string) {
    if (this.logged.get(topic) === message) return
    this.logged.set(topic, message)
    ;(this.options.log ?? console.error)(`Status hooks: ${message}`)
  }

  private open() { return (this.outbox ??= StatusOutbox.open(this.options.outboxPath)) }

  /** The current config, following edits; a broken edit keeps the last good one and says so once. */
  private loadConfig() {
    const path = this.options.configPath ?? hooksConfigPath()
    if (!hooksConfigExists(path)) {
      if (this.signature !== "absent") this.disable()
      return undefined
    }
    let signature = "unreadable"
    try {
      const stat = statSync(path)
      signature = `${stat.mtimeMs}:${stat.size}:${stat.mode}`
      if (signature === this.signature) return this.config
      this.signature = signature
      this.config = readHooksConfig(path)
      this.sinks = new Map(this.config.sinks.map((sink) => [sink.name, openSink(sink)]))
      this.pausedUntil.clear()
      this.logged.delete("config")
      this.open().abandonRemovedSinks(this.config.sinks.map((sink) => sink.name), this.now())
      this.open().prune(this.now())
    } catch (error) {
      this.signature = signature
      this.logOnce("config", `${error instanceof Error ? error.message : String(error)}${this.config ? "; keeping the last good config" : ""}`)
    }
    return this.config
  }

  /** With hooks off, nothing tracks transitions, so turning them on again starts from now. */
  private disable() {
    this.config = undefined
    this.signature = "absent"
    this.sinks = new Map()
    const path = this.options.outboxPath ?? statusOutboxPath()
    if (!existsSync(path)) return
    try { this.open().clearCursor() }
    catch (error) { this.logOnce("outbox", `outbox unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** Called after a projection refresh: never throws, and passes overlap into one more pass. */
  observed() {
    if (this.stopped) return Promise.resolve()
    if (this.observing) { this.observeAgain = true; return Promise.resolve() }
    this.observing = true
    return (async () => {
      try {
        do {
          this.observeAgain = false
          await this.detect()
          if (!this.stopped && this.config?.sinks.length) void this.drain()
        } while (this.observeAgain && !this.stopped)
        this.logged.delete("detect")
      } catch (error) {
        this.logOnce("detect", `detection failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally { this.observing = false }
    })()
  }

  private async detect() {
    const config = this.loadConfig()
    if (!config?.sinks.length) return
    const outbox = this.open()
    const cursor = outbox.cursor()
    const view = await this.options.view(config, cursor)
    if (!view || this.stopped) return
    if (!cursor) return outbox.commit(initialStatusCursor(view), [], view.now)
    const step = computeStatusEvents(cursor, view, config.detect)
    const events = step.events.flatMap((draft) => {
      const sinks = config.sinks.filter((sink) => sinkWants(sink, draft.type)).map((sink) => sink.name)
      return sinks.length ? [{ event: this.publishable(draft), sinks }] : []
    })
    outbox.commit(step.cursor, events, view.now)
    clearTimeout(this.detectTimer)
    this.detectTimer = undefined
    if (step.nextDueAt !== undefined) {
      this.detectTimer = setTimeout(() => this.options.requestObservation(), Math.max(0, step.nextDueAt - this.now()) + 10)
    }
  }

  private publishable(draft: DraftEvent): StatusEvent { return publishableEvent(draft, { id: randomUUID(), host: this.host }) }

  private async drain() {
    if (this.stopped) return
    if (this.draining) { this.drainAgain = true; return }
    this.draining = true
    try {
      do {
        this.drainAgain = false
        const config = this.config
        if (!config) return
        await Promise.all(config.sinks.map((sink) => this.drainSink(sink.name, config)))
      } while (this.drainAgain && !this.stopped)
      this.logged.delete("delivery")
    } catch (error) {
      this.logOnce("delivery", `delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.draining = false
      this.armDelivery()
    }
  }

  /** In order, until nothing is due or the sink fails; a failing sink pauses without touching the others. */
  private async drainSink(name: string, config: HooksConfig) {
    const sink = this.sinks.get(name), outbox = this.open()
    if (!sink) return
    while (!this.stopped && (this.pausedUntil.get(name) ?? 0) <= this.now()) {
      const due = outbox.due(name, this.now(), DELIVERY_BATCH)
      if (!due.length) return
      for (const delivery of due) {
        if (this.stopped) return
        const result = await sink.send(delivery.event, config.delivery.timeoutMs)
        const now = this.now()
        if (result.ok) {
          outbox.markDelivered(delivery.event.id, name, result.status, now)
          this.logged.delete(`sink:${name}`)
          continue
        }
        this.logOnce(`sink:${name}`, `sink ${name}: ${result.error}`)
        if (!result.retryable || now - delivery.event.at >= config.delivery.giveUpMs) {
          outbox.markFailed(delivery.event.id, name, result, now)
          continue
        }
        const delay = retryDelayMs(delivery.attempts + 1, config.delivery, result.retryAfterMs)
        outbox.markRetry(delivery.event.id, name, result, now + delay, now)
        this.pausedUntil.set(name, now + delay)
        return
      }
    }
  }

  private armDelivery() {
    clearTimeout(this.deliveryTimer)
    this.deliveryTimer = undefined
    if (this.stopped || !this.config) return
    const next = this.config.sinks.flatMap((sink) => {
      const at = this.open().nextAttemptAt(sink.name)
      return at === undefined ? [] : [Math.max(at, this.pausedUntil.get(sink.name) ?? 0)]
    })
    if (!next.length) return
    this.deliveryTimer = setTimeout(() => { void this.drain() }, Math.max(0, Math.min(...next) - this.now()) + 10)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.detectTimer)
    clearTimeout(this.deliveryTimer)
    // An attempt still in flight stays pending and goes out again after the restart.
    try { this.outbox?.close() } catch {}
    this.outbox = undefined
  }
}

const textOf = (report: ClankerReportRecord | null) => report?.message ?? null

export interface LiveStatusSources {
  /** The panes of the newest observation; undefined before there is one. */
  panes: () => readonly PaneMetadata[] | undefined
  multiplexer: () => ManagedMultiplexer
}

/** One complete view from the daemon's own observation, so it costs the Multiplexer nothing extra. */
export const liveStatusView = (sources: LiveStatusSources): StatusViewSource => {
  const pathOf = clankerWorkshopPaths()
  return async (config, cursor) => {
    const panes = sources.panes()
    if (!panes) return undefined
    const rows = await listClankerReportFacts({ multiplexer: sources.multiplexer(), panes: [...panes], strict: true })
    const workshops = listWorkshopRecords()
    const labels = allWorkshopLabels()
    const byPath = new Map(workshops.map((workshop) => [workshop.canonicalPath, workshop]))
    const byId = new Map(workshops.map((workshop) => [workshop.workshopId, workshop]))
    const factsOf = (workshop: WorkshopRecord | undefined, row?: ClankerReportFacts, worktree?: string): ClankerFacts => {
      const title = workshop ? labels.get(workshop.workshopId)?.[TITLE_KEY] ?? null : null
      const common = workshop?.commonDir.replace(/\/\.git\/?$/, "")
      return {
        workshopId: workshop?.workshopId ?? null,
        workshop: title || workshop?.branch || row?.clanker.session || null,
        title,
        repo: common ? basename(common) : null,
        branch: workshop?.branch ?? null,
        worktree: workshop?.canonicalPath ?? worktree ?? null,
        pane: row?.clanker.pane ?? null,
        harness: row?.clanker.harness ?? null,
      }
    }
    return withOrchestrationStore((store) => {
      const latestSeq = store.latestSeq()
      const now = Date.now()
      const live = new Set(rows.map((row) => row.clanker.id))
      const stuckMessages = store.pendingMessages().filter((message) => message.state === "delivered" && live.has(message.clankerId) && now - (message.deliveredAt ?? message.createdAt) >= config.detect.stuckMessageMs)
      const clankers = rows.map((row) => {
        const worktree = pathOf(row.clanker)
        const workshop = byPath.get(worktree)
        const lastReport = () => withOrchestrationStore((reports) => reports.lastReportFor(row.clanker.id))
        return {
          clankerId: row.clanker.id,
          state: row.clanker.state,
          settledGeneration: row.clanker.settledGeneration,
          facts: factsOf(workshop, row, worktree),
          lastText: () => (row.clanker.harness === "claude" ? liveClaudeText(row.clanker, row) : row.latestReply) ?? textOf(lastReport()),
          prUrl: () => {
            const report = lastReport()
            return findPrUrl({ labels: workshop ? labels.get(workshop.workshopId) : undefined, payload: report?.payload, texts: [report?.message] })
          },
        }
      })
      const seen = new Set<string>()
      const markers: ViewedMarker[] = clankers.flatMap((clanker) => {
        const { worktree } = clanker.facts
        if (!worktree || seen.has(worktree)) return []
        seen.add(worktree)
        return Object.entries(config.detect.markers).flatMap(([name, path]) => existsSync(join(worktree, path)) ? [{ name, path, facts: clanker.facts, clankerId: clanker.clankerId }] : [])
      })
      return {
        now,
        clankers,
        reports: cursor ? store.reportsSince(cursor.seq) : [],
        latestSeq,
        stuckMessages,
        markers,
        closedReason: (clankerId) => {
          const ledger = openClankerLedger()
          try { return ledger.get(clankerId)?.closedReason }
          finally { ledger.close() }
        },
        factsForReport: (report) => {
          const workshop = report.workshopId ? byId.get(report.workshopId) : undefined
          return { facts: workshop ? factsOf(workshop) : NO_FACTS, prUrl: workshop ? findPrUrl({ labels: labels.get(workshop.workshopId) }) : null }
        },
      }
    })
  }
}

export interface HooksStatus {
  config: { path: string; state: "absent" | "ok" | "invalid"; error?: string; sinks: Array<ReturnType<typeof redactedSink>> }
  totals: SinkTotals[]
  recent: DeliveryRecord[]
}

/** Read-only: neither the config nor the outbox is created by asking. */
export const hooksStatus = (options: { limit?: number; configPath?: string; outboxPath?: string } = {}): HooksStatus => {
  const path = options.configPath ?? hooksConfigPath()
  let config: HooksStatus["config"] = { path, state: "absent", sinks: [] }
  if (hooksConfigExists(path)) {
    try { config = { path, state: "ok", sinks: readHooksConfig(path).sinks.map(redactedSink) } }
    catch (error) { config = { path, state: "invalid", error: error instanceof Error ? error.message : String(error), sinks: [] } }
  }
  const outboxPath = options.outboxPath ?? statusOutboxPath()
  if (!existsSync(outboxPath)) return { config, totals: [], recent: [] }
  const outbox = StatusOutbox.open(outboxPath)
  try { return { config, totals: outbox.totals(), recent: outbox.recent(options.limit ?? 20) } }
  finally { outbox.close() }
}

export const sampleEvent = (now = Date.now(), overrides: Partial<StatusEvent> = {}): StatusEvent => ({
  ...publishableEvent({
    dedupeKey: `hooks.test:${randomUUID()}`,
    type: "hooks.test",
    at: now,
    clankerId: "clanker-00000000-0000-0000-0000-000000000000",
    oldState: "working",
    newState: "done",
    facts: { workshopId: "00000000-0000-0000-0000-000000000000", workshop: "Sample Workshop", title: "Sample Workshop", repo: "sample-repo", branch: "sample-branch", worktree: "/path/to/sample-worktree", pane: "w1-1", harness: "claude" },
    summary: "This is a sample event from clankers hooks test.",
    prUrl: null,
    details: {},
  }, { id: randomUUID(), host: hostname() }),
  test: true,
  ...overrides,
})

/** Send one sample to each sink once, ignoring its event filter, and record the outcome. */
export const sendHooksTest = async (options: { sink?: string; configPath?: string; outboxPath?: string; now?: () => number } = {}) => {
  const config = readHooksConfig(options.configPath ?? hooksConfigPath())
  const selected = options.sink ? config.sinks.filter((sink) => sink.name === options.sink) : config.sinks
  if (options.sink && !selected.length) throw new Error(`No sink named ${options.sink}`)
  if (!selected.length) throw new Error("No sinks are configured")
  const now = options.now ?? Date.now
  const results = await Promise.all(selected.map(async (sink) => {
    const event = sampleEvent(now())
    const outcome = await openSink(sink).send(event, config.delivery.timeoutMs)
    return { sink: sink.name, event, outcome }
  }))
  const outbox = StatusOutbox.open(options.outboxPath)
  try { for (const { sink, event, outcome } of results) outbox.recordOneShot(event, sink, outcome.ok ? { ok: true, status: outcome.status } : { ok: false, status: outcome.status, error: outcome.error }, now()) }
  finally { outbox.close() }
  return results.map(({ sink, event, outcome }) => ({ sink, dedupeKey: event.dedupeKey, ...outcome }))
}

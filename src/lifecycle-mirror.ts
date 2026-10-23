/**
 * Mirrors harness lifecycle reports into the Multiplexer's own agent status (ADR-0007), so
 * Herdr's sidebar, waits, notifications, and seen tracking agree with Clankerhouse.
 *
 * The daemon feeds it from the hook spool (Claude) and from socket lifecycle reports (Pi),
 * never the hot-path hook. Herdr has no "done": a settled turn is reported `idle`, and Herdr
 * itself marks it unseen (`done`) unless the operator is looking at its tab. Herdr derives
 * that only from a working or blocked → idle transition, so a settle whose `working` the
 * spool coalesced away is preceded by a synthetic `working`. A session end releases the
 * pane back to Herdr's own detection.
 */
import type { Multiplexer } from "./multiplexer/interface"

export type MirrorTarget = Pick<Multiplexer, "reportAgentState" | "releaseAgent">

export interface MirrorReport {
  pane: string
  harness: string
  state: string
  harnessSessionId?: string
  /** Turn counter of the report; a settle of a newer turn is a new completion. */
  generation?: number
  updatedAt?: number
}

/** Harnesses whose lifecycle Clankerhouse reports itself; Herdr observes the rest on its own. */
export const MIRRORED_HARNESSES = new Set(["claude", "pi"])
/**
 * A report older than this (one left in the spool while the daemon was down, say) is not
 * mirrored: Herdr never releases a pane held for a harness whose process it did not see exit.
 */
export const MIRROR_MAX_AGE_MS = 30_000

type HerdrState = "idle" | "working" | "blocked"
interface Mirrored { harness: string; state: HerdrState | "released"; generation: number }

const herdrState = (state: string): HerdrState | "release" | undefined =>
  state === "working" || state === "blocked" ? state
    : state === "done" || state === "idle" ? "idle"
    : state === "unknown" ? "release"
    : undefined

export class LifecycleMirror {
  private readonly mirrored = new Map<string, Mirrored>()
  private readonly waiting = new Map<string, MirrorReport>()
  private readonly running = new Set<string>()
  private readonly failures = new Map<string, string>()

  /**
   * `onHoldChanged` runs after the mirror releases a pane or holds it again: a release also drops the pane's Herdr
   * resume command, so Recovery reports its gate again on the next reconcile instead of waiting for its re-report period.
   */
  constructor(private readonly target: () => MirrorTarget, private readonly options: { now?: () => number; log?: (message: string) => void; onHoldChanged?: (pane: string) => void } = {}) {}

  /** Mirror the newest report for its pane; reports that arrive while one is in flight replace each other. */
  offer(report: MirrorReport): Promise<void> {
    if (!MIRRORED_HARNESSES.has(report.harness) || !herdrState(report.state)) return Promise.resolve()
    this.waiting.set(report.pane, report)
    return this.drain(report.pane)
  }

  private async drain(pane: string) {
    if (this.running.has(pane)) return
    this.running.add(pane)
    try {
      for (let next = this.waiting.get(pane); next; next = this.waiting.get(pane)) {
        this.waiting.delete(pane)
        await this.apply(next)
      }
    } finally { this.running.delete(pane) }
  }

  private async apply(report: MirrorReport) {
    const now = this.options.now?.() ?? Date.now()
    if (report.updatedAt && now - report.updatedAt > MIRROR_MAX_AGE_MS) return
    const target = this.target()
    if (!target.reportAgentState || !target.releaseAgent) return
    const desired = herdrState(report.state)!
    const previous = this.mirrored.get(report.pane)
    const generation = report.generation ?? 0
    try {
      if (desired === "release") {
        if (previous?.state === "released" && previous.harness === report.harness) return
        await target.releaseAgent(report.pane, report.harness)
        this.mirrored.set(report.pane, { harness: report.harness, state: "released", generation })
        this.options.onHoldChanged?.(report.pane)
      } else {
        const sameHarness = previous?.harness === report.harness
        const newTurn = report.state === "done" && (!sameHarness || generation > previous!.generation)
        if (sameHarness && previous!.state === desired && !newTurn) return
        if (newTurn && !(sameHarness && (previous!.state === "working" || previous!.state === "blocked"))) {
          await target.reportAgentState(report.pane, report.harness, "working", report.harnessSessionId)
        }
        await target.reportAgentState(report.pane, report.harness, desired, report.harnessSessionId)
        if (!sameHarness || previous!.state === "released") this.options.onHoldChanged?.(report.pane)
        this.mirrored.set(report.pane, { harness: report.harness, state: desired, generation: Math.max(generation, sameHarness ? previous!.generation : 0) })
      }
      this.failures.delete(report.pane)
    } catch (error) {
      // Herdr's agent status is presentation; the hook's own record stays authoritative, so a failure is logged once and the next report retries.
      const message = error instanceof Error ? error.message : String(error)
      if (this.failures.get(report.pane) !== message) (this.options.log ?? console.error)(`Mirroring ${report.harness} state on ${report.pane} to the Multiplexer failed: ${message}`)
      this.failures.set(report.pane, message)
    }
  }
}

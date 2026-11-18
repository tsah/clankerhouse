import { describe, expect, test } from "bun:test"
import type { DetailRow, SessionRow } from "./model"
import type { Routine } from "./routines"
import { annotateDesks, isDeskLabels, routineRunLabel, type DeskFacts } from "./desks"

// Saturday 2026-11-21 19:00 UTC, which is 20:00 in Amsterdam.
const SATURDAY_EVENING = Date.UTC(2026, 10, 21, 19, 0)
const THURSDAY_MORNING = Date.UTC(2026, 10, 19, 6, 45)

const clanker = (clankerId: string): DetailRow => ({
  kind: "clanker", harness: "claude", status: "", detail: "", title: "claude", age: "", state: "idle", updatedAt: 0, clankerId,
  target: { type: "window", session: "s", windowId: "w", pane: "p" },
})

const row = (workshopId: string, details: DetailRow[] = []): SessionRow => ({
  name: workshopId, path: `/w/${workshopId}`, branch: workshopId, flags: "", markers: [], age: "", recency: 0,
  target: { type: "session", session: workshopId }, details, searchText: "", workshopId,
})

const routine = (clankerId: string, nextFireAt: number | null, extra: Partial<Routine> = {}): Routine => ({
  routineId: `routine-${clankerId}-${nextFireAt}`, clankerId, name: null, cron: "0 20 * * 6", timeZone: "Europe/Amsterdam", message: "Run",
  state: "active", createdAt: 0, createdBy: clankerId, updatedAt: 0, nextFireAt, lastScheduledAt: null, lastFiredAt: null,
  lastMessageId: null, lastOutcome: null, lastError: null, endedReason: null, ...extra,
})

const facts = (labels: Record<string, Record<string, string>>, extra: Partial<DeskFacts> = {}): DeskFacts => ({
  labels: (workshopId) => labels[workshopId],
  reportAt: () => undefined,
  routines: [],
  clankerWorkshop: () => undefined,
  ...extra,
})

describe("desks", () => {
  test("only role=desk makes a desk; a desk tag under another key does not", () => {
    expect(isDeskLabels({ role: "desk" })).toBe(true)
    expect(isDeskLabels({ stage: "desk" })).toBe(false)
    expect(isDeskLabels(undefined)).toBe(false)
    const rows = [row("lint"), row("other")]
    annotateDesks(rows, facts({ lint: { role: "desk" }, other: { kind: "desk" } }))
    expect(rows[0]!.desk).toEqual({ routines: 0 })
    expect(rows[1]!.desk).toBeUndefined()
  })

  test("a desk carries its report link and when it was set", () => {
    const rows = [row("retro")]
    annotateDesks(rows, facts({ retro: { role: "desk", report: "https://claude.ai/artifact/abc" } }, { reportAt: () => 1234 }))
    expect(rows[0]!.desk).toEqual({ routines: 0, report: "https://claude.ai/artifact/abc", reportAt: 1234 })
  })

  test("a desk's next run is the soonest active Routine of its clankers, in the Routine's own zone", () => {
    const rows = [row("lint", [clanker("c-lint")]), row("slop", [clanker("c-slop")])]
    annotateDesks(rows, facts({ lint: { role: "desk" }, slop: { role: "desk" } }, {
      routines: [
        routine("c-lint", SATURDAY_EVENING + 7 * 86_400_000, { name: "later" }),
        routine("c-lint", SATURDAY_EVENING, { name: "lint-sweep" }),
        routine("c-lint", THURSDAY_MORNING, { state: "ended" }),
        // A Routine whose clanker is not on screen is found through the ledger.
        routine("c-gone", THURSDAY_MORNING, { name: "linear-sweep" }),
      ],
      clankerWorkshop: (clankerId) => (clankerId === "c-gone" ? "slop" : undefined),
    }))
    expect(rows[0]!.desk).toEqual({ routines: 2, nextRunAt: SATURDAY_EVENING, nextRun: "Sat 20:00 lint-sweep" })
    expect(rows[1]!.desk).toEqual({ routines: 1, nextRunAt: THURSDAY_MORNING, nextRun: "Thu 07:45 linear-sweep" })
  })

  test("a run is named by weekday and wall-clock time", () => {
    expect(routineRunLabel(SATURDAY_EVENING, "Europe/Amsterdam")).toBe("Sat 20:00")
    expect(routineRunLabel(SATURDAY_EVENING, "UTC")).toBe("Sat 19:00")
  })

  test("Routines of Workshops that are not desks are left alone", () => {
    const rows = [row("plain", [clanker("c1")])]
    annotateDesks(rows, facts({}, { routines: [routine("c1", SATURDAY_EVENING)] }))
    expect(rows[0]!.desk).toBeUndefined()
  })
})

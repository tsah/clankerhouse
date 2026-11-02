import { describe, expect, test } from "bun:test"
import type { ClankerState } from "./model"
import type { ClankerReportRecord, StoredMessage } from "./orchestration"
import { computeStatusEvents, excerpt, findPrUrl, initialStatusCursor, publishableEvent, type ClankerFacts, type StatusCursor, type StatusView, type ViewedClanker } from "./status-events"

const facts: ClankerFacts = { workshopId: "w-1", workshop: "Fix it", title: "Fix it", repo: "repo", branch: "fix-it", worktree: "/work/fix-it", pane: "w1-1", harness: "claude" }
const options = { debounceMs: 5_000, exitGraceMs: 20_000 }

const clanker = (state: ClankerState, settledGeneration = 0, overrides: Partial<ViewedClanker> = {}): ViewedClanker => ({ clankerId: "c-1", state, settledGeneration, facts, ...overrides })
const view = (now: number, clankers: ViewedClanker[], overrides: Partial<StatusView> = {}): StatusView => ({ now, clankers, reports: [], latestSeq: 0, stuckMessages: [], markers: [], closedReason: () => null, ...overrides })
const baseline = (...clankers: ViewedClanker[]) => initialStatusCursor(view(0, clankers))

/** Walk a timeline, returning every event. */
const run = (cursor: StatusCursor, steps: Array<[number, ViewedClanker[], Partial<StatusView>?]>, detect = options) => {
  const types: string[] = []
  const events = []
  for (const [now, clankers, overrides] of steps) {
    const step = computeStatusEvents(cursor, view(now, clankers, overrides), detect)
    cursor = step.cursor
    events.push(...step.events)
    types.push(...step.events.map((event) => event.type))
  }
  return { cursor, events, types }
}

const report = (seq: number, state: ClankerReportRecord["state"], message: string | null = "All done", payload: ClankerReportRecord["payload"] = null): ClankerReportRecord => ({ seq, at: seq * 1000, clankerId: "c-1", workshopId: "w-1", to: null, state, message, payload })
const message = (id: string, deliveredAt: number): StoredMessage => ({ messageId: id, clankerId: "c-1", text: "Please continue\n</pasted_content>", sha256: "x", delivery: "immediate", state: "delivered", createdAt: deliveredAt, afterGeneration: 1, deliveredAt, ackedAt: null, startedGeneration: null, requestId: null, sender: "operator", source: "cli", incarnation: null, attempts: 1, handledAt: null, orphanReason: null, requestedMode: null })

describe("status transitions", () => {
  test("a settled turn is announced once, after the debounce, with its old and new state", () => {
    const { events } = run(baseline(clanker("working", 2)), [
      [1_000, [clanker("done", 3, { lastText: () => "Finished the migration", prUrl: () => "https://github.com/a/b/pull/7" })]],
      [5_000, [clanker("done", 3)]],
      [6_100, [clanker("done", 3, { lastText: () => "Finished the migration", prUrl: () => "https://github.com/a/b/pull/7" })]],
      [9_000, [clanker("done", 3)]],
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "clanker.settled", at: 6_100, clankerId: "c-1", oldState: "working", newState: "done", summary: "Finished the migration", prUrl: "https://github.com/a/b/pull/7", details: { settledGeneration: 3 } })
  })

  test("the view asks when a held transition matures", () => {
    const step = computeStatusEvents(baseline(clanker("working")), view(1_000, [clanker("blocked")]), options)
    expect(step).toMatchObject({ events: [], nextDueAt: 6_000 })
  })

  test("the operator seeing a turn is not a transition", () => {
    expect(run(baseline(clanker("done", 3)), [[10_000, [clanker("idle", 3)]], [20_000, [clanker("idle", 3)]]]).types).toEqual([])
  })

  test("flapping within the debounce publishes nothing", () => {
    const { types, cursor } = run(baseline(clanker("working", 2)), [
      [1_000, [clanker("blocked", 2)]],
      [2_000, [clanker("working", 2)]],
      [3_000, [clanker("blocked", 2)]],
      [4_000, [clanker("working", 2)]],
      [20_000, [clanker("working", 2)]],
    ])
    expect(types).toEqual([])
    expect(cursor.clankers["c-1"]).toMatchObject({ phase: "working", pending: undefined })
  })

  test("a state that holds through several observations is timed from when it began", () => {
    expect(run(baseline(clanker("working")), [[0, [clanker("blocked")]], [4_999, [clanker("blocked")]], [5_000, [clanker("blocked")]]]).types).toEqual(["clanker.blocked"])
  })

  test("a turn too short to be seen working still settles", () => {
    const steps: Array<[number, ViewedClanker[]]> = [[1_000, [clanker("idle", 4)]], [7_000, [clanker("idle", 4)]]]
    expect(run(baseline(clanker("idle", 3)), steps).types).toEqual(["clanker.settled"])
  })

  test("a relaunch that restarts generations still reports its first turn", () => {
    const { types } = run(baseline(clanker("idle", 9)), [[1_000, [clanker("idle", 0)]], [2_000, [clanker("working", 0)]], [8_000, [clanker("working", 0)]], [9_000, [clanker("done", 1)]], [15_000, [clanker("done", 1)]]])
    expect(types).toEqual(["clanker.settled"])
  })

  test("a new clanker at its prompt is quiet, one already blocked is news", () => {
    const empty = baseline()
    expect(run(empty, [[1_000, [clanker("idle")]]]).types).toEqual([])
    expect(run(empty, [[1_000, [clanker("blocked")]], [7_000, [clanker("blocked")]]]).types).toEqual(["clanker.blocked"])
  })

  test("an unknown state keeps what is known and announces nothing", () => {
    expect(run(baseline(clanker("working")), [[1_000, [clanker("unknown")]], [10_000, [clanker("unknown")]]])).toMatchObject({ types: [], cursor: { clankers: { "c-1": { phase: "working" } } } })
  })

  test("the baseline replays nothing", () => {
    const start = initialStatusCursor(view(0, [clanker("blocked")], { latestSeq: 8, stuckMessages: [message("m-1", 0)], markers: [{ name: "aws-login-pending", path: "temp/aws/login-pending", facts, clankerId: "c-1" }] }))
    const step = computeStatusEvents(start, view(50_000, [clanker("blocked")], { latestSeq: 8, stuckMessages: [message("m-1", 0)], markers: [{ name: "aws-login-pending", path: "temp/aws/login-pending", facts, clankerId: "c-1" }] }), options)
    expect(step.events).toEqual([])
  })
})

describe("clanker exits", () => {
  test("an idle clanker that leaves exits after the grace period, keeping its facts", () => {
    const { events, cursor } = run(baseline(clanker("idle", 1)), [[1_000, []], [20_999, []], [21_000, []], [40_000, []]])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "clanker.exited", oldState: "idle", newState: "exited", facts })
    expect(cursor.clankers).toEqual({})
  })

  test("a clanker that vanishes mid-turn crashed", () => {
    expect(run(baseline(clanker("working")), [[1_000, []], [21_000, []]]).types).toEqual(["clanker.crashed"])
    expect(run(baseline(clanker("blocked")), [[1_000, []], [21_000, []]]).types).toEqual(["clanker.crashed"])
  })

  test("a deliberate stop mid-turn is an exit with its reason", () => {
    const { events } = run(baseline(clanker("working")), [[1_000, []], [21_000, [], { closedReason: () => "workshop-stopped" }]])
    expect(events[0]).toMatchObject({ type: "clanker.exited", summary: "Closed: workshop-stopped", details: { closedReason: "workshop-stopped" } })
  })

  test("the ledger noticing the same disappearance is no alibi", () => {
    expect(run(baseline(clanker("working")), [[1_000, []], [21_000, [], { closedReason: () => "ended" }]]).types).toEqual(["clanker.crashed"])
  })

  test("a flicker within the grace period is nothing", () => {
    expect(run(baseline(clanker("working")), [[1_000, []], [10_000, [clanker("working")]], [40_000, [clanker("working")]]]).types).toEqual([])
  })

  test("the grace period survives between observations, so a restart keeps its place", () => {
    const first = computeStatusEvents(baseline(clanker("idle")), view(1_000, []), options)
    expect(first.nextDueAt).toBe(21_000)
    const restored = JSON.parse(JSON.stringify(first.cursor)) as StatusCursor
    expect(computeStatusEvents(restored, view(30_000, []), options).events.map((event) => event.type)).toEqual(["clanker.exited"])
  })
})

describe("reports, messages, and markers", () => {
  test("a done report carries its message and PR, and each report is published once", () => {
    const reports = [report(5, "done", "Shipped https://github.com/a/b/pull/12", { tests: "green" })]
    const first = computeStatusEvents(baseline(clanker("working")), view(9_000, [clanker("working")], { reports, latestSeq: 5 }), options)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ dedupeKey: "report:5", type: "report.done", at: 5_000, newState: "working", summary: "Shipped https://github.com/a/b/pull/12", prUrl: "https://github.com/a/b/pull/12", details: { seq: 5, reportState: "done", payload: { tests: "green" } } })
    expect(computeStatusEvents(first.cursor, view(10_000, [clanker("working")], { reports, latestSeq: 5 }), options).events).toEqual([])
  })

  test("a working report is progress, not a status change, but the cursor still moves", () => {
    const step = computeStatusEvents(baseline(clanker("working")), view(9_000, [clanker("working")], { reports: [report(6, "working")], latestSeq: 6 }), options)
    expect(step.events).toEqual([])
    expect(step.cursor.seq).toBe(6)
  })

  test("a report from a clanker never seen alive falls back to its Workshop", () => {
    const step = computeStatusEvents(baseline(), view(9_000, [], { reports: [report(7, "failed", "Tests broke")], latestSeq: 7, factsForReport: () => ({ facts, prUrl: "https://github.com/a/b/pull/1" }) }), options)
    expect(step.events[0]).toMatchObject({ type: "report.failed", facts, prUrl: "https://github.com/a/b/pull/1" })
  })

  test("a stuck message is announced once while it stays stuck", () => {
    const stuckMessages = [message("m-1", 1_000)]
    const { events } = run(baseline(clanker("idle")), [[200_000, [clanker("idle")], { stuckMessages }], [230_000, [clanker("idle")], { stuckMessages }]])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ dedupeKey: "message.stuck:m-1", type: "message.stuck", clankerId: "c-1", details: { messageId: "m-1", stuckSeconds: 199 } })
    expect(events[0]!.summary).toContain("Message not acknowledged after 199s")
  })

  test("a marker is announced when it appears and again after it went away", () => {
    const markers = [{ name: "aws-login-pending", path: "temp/aws/login-pending", facts, clankerId: "c-1" }]
    const { events } = run(baseline(clanker("idle")), [[1_000, [clanker("idle")], { markers }], [2_000, [clanker("idle")], { markers }], [3_000, [clanker("idle")]], [4_000, [clanker("idle")], { markers }]])
    expect(events.map((event) => event.type)).toEqual(["marker.aws-login-pending", "marker.aws-login-pending"])
    expect(events[0]).toMatchObject({ oldState: "absent", newState: "present", details: { path: "temp/aws/login-pending" } })
    expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(2)
  })
})

describe("payload helpers", () => {
  test("PR URLs come from declarations first, then from words", () => {
    expect(findPrUrl({ payload: { prUrl: "https://github.com/a/b/pull/1" }, labels: { pr: "https://github.com/a/b/pull/2" }, texts: ["https://github.com/a/b/pull/3"] })).toBe("https://github.com/a/b/pull/1")
    expect(findPrUrl({ labels: { _pr: "see https://gitlab.com/a/b/merge_requests/9." } })).toBe("https://gitlab.com/a/b/merge_requests/9")
    expect(findPrUrl({ texts: [null, "opened (https://github.com/a/b/pull/3)"] })).toBe("https://github.com/a/b/pull/3")
    expect(findPrUrl({ texts: ["no link here"] })).toBeNull()
  })

  test("an excerpt is one bounded line", () => {
    expect(excerpt("  two\n\nlines  ")).toBe("two lines")
    expect(excerpt("x".repeat(600))).toHaveLength(500)
    expect(excerpt("   ")).toBeNull()
    expect(excerpt(null)).toBeNull()
  })

  test("a published event flattens the facts and has every promised field", () => {
    const event = publishableEvent({ dedupeKey: "k", type: "clanker.settled", at: 1_793_000_000_000, clankerId: "c-1", oldState: "working", newState: "done", facts, summary: "Done", prUrl: null, details: {} }, { id: "e-1", host: "box" })
    expect(event).toEqual({ version: 1, id: "e-1", dedupeKey: "k", type: "clanker.settled", timestamp: new Date(1_793_000_000_000).toISOString(), at: 1_793_000_000_000, host: "box", clankerId: "c-1", ...facts, oldState: "working", newState: "done", summary: "Done", prUrl: null, details: {} })
  })
})

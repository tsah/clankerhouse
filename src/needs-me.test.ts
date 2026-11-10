import { describe, expect, test } from "bun:test"
import type { ClankerState, DetailRow, SessionRow } from "./model"
import type { ClankerReportRecord } from "./orchestration"
import { firstLine, needsMe, needsMeCounts, parseSnooze, yourMoveLabels, type NeedsMeFacts } from "./needs-me"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = 100 * DAY

const clanker = (state: ClankerState, updatedAt: number, extra: Partial<DetailRow> = {}): DetailRow => ({
  kind: "clanker", harness: "claude", status: "", detail: "", title: "claude", age: "", state, updatedAt, clankerId: "c1",
  target: { type: "window", session: "s", windowId: "w", pane: "p" }, ...extra,
})

const row = (details: DetailRow[], extra: Partial<SessionRow> = {}): SessionRow => ({
  name: "s", path: "/w", branch: "b", flags: "dirty", markers: [], age: "", recency: Math.floor((now - HOUR) / 1000),
  target: { type: "session", session: "s" }, details, searchText: "", workshopId: "ws", ...extra,
})

const report = (state: ClankerReportRecord["state"], at: number, message: string | null = null): ClankerReportRecord =>
  ({ seq: 1, at, clankerId: "c1", workshopId: "ws", to: null, state, message, payload: null })

const facts = (extra: Partial<NeedsMeFacts> = {}): NeedsMeFacts => ({
  now,
  latestReport: () => undefined,
  turnStartedAt: () => undefined,
  lastText: () => null,
  interrupted: () => [],
  snooze: () => undefined,
  waitingOn: () => undefined,
  yourMoveLabel: () => undefined,
  staleAfterMs: 7 * DAY,
  readyAfterMs: DAY,
  ...extra,
})

describe("needs me", () => {
  test("a working clanker with nothing asked is not listed", () => {
    expect(needsMe(row([clanker("working", now - HOUR)]), facts())).toBeUndefined()
    expect(needsMe(row([clanker("idle", now - HOUR)]), facts())).toBeUndefined()
  })

  test("a question filed this turn is listed with its first line, even while the clanker works on", () => {
    const asked = facts({ latestReport: () => report("question", now - 2 * HOUR, "\nRoll back the pool change?\nOr raise the timeout."), turnStartedAt: () => now - 3 * HOUR })
    expect(needsMe(row([clanker("idle", now - HOUR)]), asked)).toEqual({ reason: "asked", since: now - 2 * HOUR, excerpt: "Roll back the pool change?", clankerId: "c1" })
    expect(needsMe(row([clanker("working", now - HOUR)]), asked)?.reason).toBe("asked")
  })

  test("a question from before the current turn was answered", () => {
    const answered = facts({ latestReport: () => report("question", now - 2 * HOUR, "?"), turnStartedAt: () => now - HOUR })
    expect(needsMe(row([clanker("idle", now - HOUR)]), answered)).toBeUndefined()
  })

  test("a permission prompt is blocked, naming the kind the harness gave", () => {
    expect(needsMe(row([clanker("blocked", now - HOUR)]), facts())).toEqual({ reason: "blocked", since: now - HOUR, detail: "permission prompt", clankerId: "c1" })
    expect(needsMe(row([clanker("blocked", now - HOUR, { blockedKind: "question", blockedMessage: "Which env?" })]), facts()))
      .toEqual({ reason: "blocked", since: now - HOUR, detail: "question", excerpt: "Which env?", clankerId: "c1" })
  })

  test("a finished turn not yet seen carries the clanker's last words", () => {
    const said = facts({ lastText: () => "Done: 14 files changed, tests pass.\n\nDetails…" })
    expect(needsMe(row([clanker("done", now - 3 * HOUR)]), said)).toEqual({ reason: "finished", since: now - 3 * HOUR, excerpt: "Done: 14 files changed, tests pass.", clankerId: "c1" })
  })

  test("failed, crashed and interrupted clankers are listed", () => {
    expect(needsMe(row([clanker("failed", now - HOUR)]), facts())?.reason).toBe("failed")
    expect(needsMe(row([clanker("unknown", now - HOUR, { gone: true })]), facts())).toMatchObject({ reason: "crashed", detail: "harness exited" })
    expect(needsMe(row([]), facts({ interrupted: () => [{ clankerId: "c9", at: now - 2 * DAY }] })))
      .toEqual({ reason: "crashed", since: now - 2 * DAY, detail: "interrupted", clankerId: "c9" })
  })

  test("a your-move label lists an idle Workshop, with what its clanker last said", () => {
    const labelled = facts({ yourMoveLabel: () => ({ value: "needs-input", at: now - 5 * HOUR }), lastText: () => "Which of the two designs?" })
    expect(needsMe(row([clanker("idle", now - 4 * HOUR)]), labelled))
      .toEqual({ reason: "your-move", since: now - 5 * HOUR, detail: "needs-input", excerpt: "Which of the two designs?", clankerId: "c1" })
    // While a clanker works the label is old news.
    expect(needsMe(row([clanker("working", now - HOUR)]), labelled)).toBeUndefined()
  })

  test("the most pressing reason wins: asked over a finished sibling, a finished turn over a label", () => {
    const sibling = clanker("done", now - 9 * HOUR, { clankerId: "c2" })
    const asked = facts({ latestReport: (id) => id === "c1" ? report("question", now - HOUR, "?") : undefined, yourMoveLabel: () => ({ value: "needs-input", at: now - DAY }) })
    expect(needsMe(row([clanker("idle", now - HOUR), sibling]), asked)?.reason).toBe("asked")
    expect(needsMe(row([sibling]), facts({ yourMoveLabel: () => ({ value: "needs-input", at: now - DAY }) }))?.reason).toBe("finished")
  })

  test("clean and idle a day is ready to close; idle for the retention period is stale", () => {
    const old = Math.floor((now - 2 * DAY) / 1000)
    expect(needsMe(row([clanker("idle", now - 2 * DAY)], { flags: "clean", recency: old }), facts())).toEqual({ reason: "ready", since: now - 2 * DAY, detail: "clean" })
    expect(needsMe(row([clanker("idle", now - 2 * DAY)], { flags: "dirty", recency: old }), facts())).toBeUndefined()
    expect(needsMe(row([], { flags: "dirty", recency: Math.floor((now - 9 * DAY) / 1000) }), facts())).toEqual({ reason: "stale", since: now - 9 * DAY })
    // Recent clanker activity keeps it fresh whatever the session's own recency says.
    expect(needsMe(row([clanker("idle", now - HOUR)], { flags: "clean", recency: old }), facts())).toBeUndefined()
  })

  test("a Done Workshop is listed only for a question, a block, a failure, or as ready to close", () => {
    const done = { labels: ["done"], flags: "clean", recency: Math.floor((now - 2 * DAY) / 1000) }
    const labelled = facts({ yourMoveLabel: () => ({ value: "waiting-for-approval", at: now - 3 * DAY }) })
    // Neither its label nor an unseen finished turn lists it; clean and idle, it can be closed now.
    expect(needsMe(row([clanker("done", now - 2 * DAY)], done), labelled)).toMatchObject({ reason: "ready" })
    expect(needsMe(row([clanker("done", now - HOUR)], { ...done, recency: Math.floor((now - HOUR) / 1000) }), labelled)).toBeUndefined()
    expect(needsMe(row([clanker("blocked", now - 2 * DAY)], done), labelled)).toMatchObject({ reason: "blocked" })
  })

  test("a label row quotes only what its clanker said this turn", () => {
    const labelled = facts({
      yourMoveLabel: () => ({ value: "needs-input", at: now - 5 * HOUR }),
      latestReport: () => report("done", now - 3 * DAY, "Old news."),
      turnStartedAt: () => now - 6 * HOUR,
      lastText: () => "Which of the two?",
    })
    expect(needsMe(row([clanker("idle", now - 4 * HOUR)]), labelled)?.excerpt).toBe("Which of the two?")
  })

  test("only open Workshops are judged; a sessionless row was stopped or closed", () => {
    const sessionless = row([], { target: { type: "directory", path: "/w" }, recency: 0 })
    expect(needsMe(sessionless, facts())).toBeUndefined()
    // An unmanaged session still shows a blocked harness, but no workshop-level reason.
    expect(needsMe(row([], { workshopId: undefined, recency: 0 }), facts())).toBeUndefined()
  })

  test("a snooze holds until the reason changes or its day runs out", () => {
    const asked = facts({ latestReport: () => report("question", now - HOUR, "Which?") })
    const snoozed = (value: string) => needsMe(row([clanker("idle", now - HOUR)]), { ...asked, snooze: () => parseSnooze(value) })
    expect(snoozed(`asked:${now - HOUR}:${now + DAY}`)).toMatchObject({ reason: "asked", snoozedUntil: now + DAY })
    // Asked again later: something new.
    expect(snoozed(`asked:${now - 2 * HOUR}:${now + DAY}`)?.snoozedUntil).toBeUndefined()
    expect(snoozed(`finished:${now - HOUR}:${now + DAY}`)?.snoozedUntil).toBeUndefined()
    expect(snoozed(`asked:${now - HOUR}:${now - 1}`)?.snoozedUntil).toBeUndefined()
    expect(parseSnooze("garbage")).toBeUndefined()
  })

  test("a Workshop waiting on an unsettled one says so", () => {
    const waiting = facts({ latestReport: () => report("question", now - HOUR), waitingOn: () => "pr one" })
    expect(needsMe(row([clanker("idle", now - HOUR)]), waiting)).toMatchObject({ reason: "asked", waitingOn: "pr one" })
  })

  test("counts each open Workshop once", () => {
    const listed = { reason: "asked" as const, since: 1 }
    expect(needsMeCounts([
      row([], { needsMe: listed }),
      row([], { needsMe: listed, target: { type: "session", session: "s2" } }),
      row([], { workshopId: "other" }),
      row([], { workshopId: "gone", target: { type: "directory", path: "/g" }, needsMe: listed }),
    ])).toEqual({ needsMe: 1, open: 2 })
    // Snoozed and waiting rows are listed, not counted.
    expect(needsMeCounts([
      row([], { needsMe: { ...listed, snoozedUntil: 2 } }),
      row([], { workshopId: "w2", needsMe: { ...listed, waitingOn: "x" } }),
    ])).toEqual({ needsMe: 0, open: 2 })
  })

  test("first line and the label setting", () => {
    expect(firstLine("  \n  a   b \n c")).toBe("a b")
    expect(firstLine("x".repeat(200))).toHaveLength(160)
    expect(firstLine(null)).toBeUndefined()
    expect(yourMoveLabels({})).toEqual([{ key: "stage", value: "needs-input" }, { key: "stage", value: "waiting-for-approval" }])
    expect(yourMoveLabels({ CLANKERHOUSE_YOUR_MOVE_LABELS: "review=me, bad" })).toEqual([{ key: "review", value: "me" }])
    expect(yourMoveLabels({ CLANKERHOUSE_YOUR_MOVE_LABELS: "none" })).toEqual([])
  })
})

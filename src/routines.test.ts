import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addRoutine, cancelRoutine, listRoutines, updateRoutine } from "./routine-api"
import { RoutineStore, defaultRoutineTimeZone, fireDueRoutines, formatWallClock, nextCronTime, parseCron, wallClock, withRoutineStore, type Routine } from "./routines"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const storePath = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-routines-"))
  roots.push(root)
  return join(root, "orchestration.sqlite3")
}

const AMS = "Europe/Amsterdam"
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString()
const next = (cron: string, after: string, zone = "UTC") => iso(nextCronTime(parseCron(cron), at(after), zone))

describe("cron expressions", () => {
  test("parses lists, ranges, steps, names, macros and Sunday as 7", () => {
    const schedule = parseCron("*/15 9-17/4 1,15 jan-mar MON-fri")
    expect([...schedule.minutes]).toEqual([0, 15, 30, 45])
    expect([...schedule.hours]).toEqual([9, 13, 17])
    expect([...schedule.daysOfMonth]).toEqual([1, 15])
    expect([...schedule.months]).toEqual([1, 2, 3])
    expect([...schedule.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0])
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45])
    expect(parseCron("@daily").expression).toBe("@daily")
    expect([...parseCron("@hourly").minutes]).toEqual([0])
  })

  test("rejects malformed expressions with a reason", () => {
    for (const [expression, reason] of [
      ["", /empty/], ["* * * *", /five fields/], ["60 * * * *", /outside 0-59/], ["* 24 * * *", /outside 0-23/],
      ["* * 0 * *", /outside 1-31/], ["* * * 13 *", /outside 1-12/], ["* * * * 8", /outside 0-7/], ["*/0 * * * *", /step/],
      ["5-1 * * * *", /backwards/], ["a * * * *", /Invalid minute/], ["1,,2 * * * *", /Empty list/], ["@often", /Unknown cron macro/],
    ] as const) expect(() => parseCron(expression)).toThrow(reason)
  })

  test("finds the next matching minute strictly after a time", () => {
    expect(next("0 9 * * *", "2026-11-10T08:59:30Z")).toBe("2026-11-10T09:00:00.000Z")
    expect(next("0 9 * * *", "2026-11-10T09:00:00Z")).toBe("2026-11-11T09:00:00.000Z")
    expect(next("*/5 * * * *", "2026-11-10T09:01:00Z")).toBe("2026-11-10T09:05:00.000Z")
    // 2026-11-10 is a Tuesday; the next weekday-only 08:30 after Friday evening is Monday.
    expect(next("30 8 * * 1-5", "2026-11-13T20:00:00Z")).toBe("2026-11-16T08:30:00.000Z")
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z")
    expect(next("0 0 31 2 *", "2026-03-01T00:00:00Z")).toBeNull()
  })

  test("both restricted day fields match either, as in Vixie cron", () => {
    // The 1st of the month or any Monday; 2026-11-16 is a Monday, 2026-12-01 a Tuesday.
    expect(next("0 12 1 * 1", "2026-11-10T00:00:00Z")).toBe("2026-11-16T12:00:00.000Z")
    expect(next("0 12 1 * 1", "2026-11-30T13:00:00Z")).toBe("2026-12-01T12:00:00.000Z")
    // A star-step day field stays unrestricted, so only the weekday applies.
    expect(next("0 12 */1 * 1", "2026-11-10T00:00:00Z")).toBe("2026-11-16T12:00:00.000Z")
  })

  test("reads the fields in the routine's zone, across daylight-saving changes", () => {
    // Amsterdam is UTC+1 in winter and UTC+2 in summer.
    expect(next("0 9 * * *", "2026-11-10T07:00:00Z", AMS)).toBe("2026-11-10T08:00:00.000Z")
    expect(next("0 9 * * *", "2026-07-10T06:00:00Z", AMS)).toBe("2026-07-10T07:00:00.000Z")
    // Spring forward on 2027-03-28: 02:30 never happens that day, so it fires the next day.
    expect(next("30 2 * * *", "2027-03-27T12:00:00Z", AMS)).toBe("2027-03-29T00:30:00.000Z")
    // 09:00 either side of the change.
    expect(next("0 9 * * *", "2027-03-27T09:00:00Z", AMS)).toBe("2027-03-28T07:00:00.000Z")
    // Half-hour zones stay on their own wall clock.
    expect(next("0 9 * * *", "2026-11-10T00:00:00Z", "Asia/Kolkata")).toBe("2026-11-10T03:30:00.000Z")
    expect(wallClock(at("2026-11-10T08:00:00Z"), AMS)).toMatchObject({ hour: 9, minute: 0, weekday: 2 })
    expect(formatWallClock(at("2026-11-10T08:00:00Z"), AMS)).toBe("2026-11-10 09:00 Europe/Amsterdam (Tue)")
  })

  test("searching a sparse expression is fast", () => {
    const started = performance.now()
    expect(next("0 0 29 2 1", "2026-01-01T00:00:00Z")).not.toBeNull()
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test("the default zone is CLANKERHOUSE_TIMEZONE, else TZ, and is validated", () => {
    expect(defaultRoutineTimeZone({ CLANKERHOUSE_TIMEZONE: AMS, TZ: "UTC" })).toBe(AMS)
    expect(defaultRoutineTimeZone({ TZ: ":Asia/Tokyo" })).toBe("Asia/Tokyo")
    expect(() => defaultRoutineTimeZone({ CLANKERHOUSE_TIMEZONE: "Mars/Olympus" })).toThrow(/Unknown time zone/)
    expect(typeof defaultRoutineTimeZone({})).toBe("string")
  })
})

describe("routine store", () => {
  test("adds, updates, lists and cancels, persisting across reopen", () => {
    const path = storePath()
    const now = at("2026-11-10T07:00:00Z")
    const added = withRoutineStore((store) => store.add({ clankerId: "clanker-a", cron: "0 9 * * *", timeZone: AMS, message: "check PRs", name: "morning", createdBy: "clanker-a", now }), path)
    expect(added).toMatchObject({ clankerId: "clanker-a", cron: "0 9 * * *", timeZone: AMS, state: "active", nextFireAt: at("2026-11-10T08:00:00Z"), name: "morning" })
    expect(added.routineId).toMatch(/^routine-[0-9a-f]{12}$/)
    // A new message keeps the schedule; a new cron reschedules from now.
    const renamed = withRoutineStore((store) => store.update(added.routineId, { message: "check CI" }, now + 1), path)
    expect(renamed).toMatchObject({ message: "check CI", nextFireAt: added.nextFireAt })
    const moved = withRoutineStore((store) => store.update(added.routineId, { cron: "30 10 * * *" }, now + 2), path)
    expect(moved.nextFireAt).toBe(at("2026-11-10T09:30:00Z"))
    expect(() => withRoutineStore((store) => store.update(added.routineId, { cron: "0 0 31 2 *" }), path)).toThrow(/never fires/)
    expect(() => withRoutineStore((store) => store.add({ clankerId: "c", cron: "* * * * *", timeZone: "UTC", message: "  ", createdBy: "c" }), path)).toThrow(/must not be empty/)
    expect(withRoutineStore((store) => store.list({ clankerId: "clanker-a" }), path).map((routine) => routine.routineId)).toEqual([added.routineId])
    expect(withRoutineStore((store) => store.list({ clankerId: "clanker-b" }), path)).toEqual([])
    withRoutineStore((store) => store.cancel(added.routineId), path)
    expect(withRoutineStore((store) => store.get(added.routineId), path)).toBeUndefined()
    expect(() => withRoutineStore((store) => store.cancel(added.routineId), path)).toThrow(/Unknown routine/)
  })
})

describe("firing", () => {
  const setup = (cron = "0 9 * * *", zone = AMS, created = "2026-11-10T07:00:00Z") => {
    const path = storePath()
    const routine = withRoutineStore((store) => store.add({ clankerId: "clanker-a", cron, timeZone: zone, message: "wake up", createdBy: "clanker-a", now: at(created) }), path)
    const sent: Array<{ routine: Routine; requestId: string }> = []
    const send = async (target: Routine, requestId: string) => { sent.push({ routine: target, requestId }); return { messageId: `msg-${sent.length}`, delivery: "immediate" } }
    return { path, routine, sent, send }
  }

  test("fires once when due, through the send path, then waits for the next occurrence", async () => {
    const { path, routine, sent, send } = setup()
    expect(await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T07:59:59Z") })).toEqual([])
    const fired = await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T08:00:10Z") })
    expect(fired).toEqual([{ routineId: routine.routineId, clankerId: "clanker-a", scheduledAt: at("2026-11-10T08:00:00Z"), outcome: "fired", messageId: "msg-1" }])
    expect(sent.map((entry) => [entry.routine.message, entry.requestId])).toEqual([["wake up", `${routine.routineId}:${at("2026-11-10T08:00:00Z")}`]])
    // A second pass in the same minute does nothing.
    expect(await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T08:00:25Z") })).toEqual([])
    const stored = withRoutineStore((store) => store.get(routine.routineId)!, path)
    expect(stored).toMatchObject({ lastMessageId: "msg-1", lastFiredAt: at("2026-11-10T08:00:10Z"), lastScheduledAt: at("2026-11-10T08:00:00Z"), nextFireAt: at("2026-11-11T08:00:00Z"), lastError: null })
  })

  test("concurrent passes wake the clanker once", async () => {
    const { path, sent, send } = setup()
    const now = () => at("2026-11-10T08:00:05Z")
    await Promise.all([fireDueRoutines({ send, storePath: path, now }), fireDueRoutines({ send, storePath: path, now })])
    expect(sent).toHaveLength(1)
  })

  test("missed occurrences collapse into the newest, and one older than the catch-up window is skipped", async () => {
    const { path, sent, send } = setup("*/10 * * * *", "UTC", "2026-11-10T07:00:00Z")
    // The daemon was down from 07:05 to 07:45: fire once, for 07:40.
    const fired = await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T07:45:00Z") })
    expect(fired.map((entry) => [entry.outcome, iso(entry.scheduledAt)])).toEqual([["fired", "2026-11-10T07:40:00.000Z"]])
    expect(sent).toHaveLength(1)
    // A year of missed minutes is not walked one by one.
    const minutely = setup("* * * * *", "UTC", "2025-11-10T00:00:00Z")
    const started = performance.now()
    const caughtUp = await fireDueRoutines({ send: minutely.send, storePath: minutely.path, now: () => at("2026-11-10T07:45:30Z") })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(caughtUp.map((entry) => [entry.outcome, iso(entry.scheduledAt)])).toEqual([["fired", "2026-11-10T07:45:00.000Z"]])
    const daily = setup("0 9 * * *", "UTC", "2026-11-09T00:00:00Z")
    const skipped = await fireDueRoutines({ send: daily.send, storePath: daily.path, now: () => at("2026-11-09T12:00:00Z") })
    expect(skipped.map((entry) => entry.outcome)).toEqual(["skipped-missed"])
    expect(daily.sent).toHaveLength(0)
    expect(withRoutineStore((store) => store.get(daily.routine.routineId)!, daily.path)).toMatchObject({ nextFireAt: at("2026-11-10T09:00:00Z"), lastOutcome: "skipped-missed" })
  })

  test("skips a wake while the previous one is still queued", async () => {
    const { path, sent, send } = setup("* * * * *", "UTC")
    await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T07:01:00Z") })
    const second = await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T07:02:00Z"), stillQueued: (id) => id === "msg-1" })
    expect(second.map((entry) => entry.outcome)).toEqual(["skipped-queued"])
    expect(sent).toHaveLength(1)
    const third = await fireDueRoutines({ send, storePath: path, now: () => at("2026-11-10T07:03:00Z"), stillQueued: () => false })
    expect(third.map((entry) => entry.outcome)).toEqual(["fired"])
  })

  test("a failed send is recorded and retried at the next occurrence; a closed clanker ends the routine", async () => {
    const { path, routine } = setup("* * * * *", "UTC")
    const unavailable = async () => { throw Object.assign(new Error("Unknown clanker clanker-a"), { code: "NOT_FOUND" }) }
    const failed = await fireDueRoutines({ send: unavailable, storePath: path, now: () => at("2026-11-10T07:01:00Z"), clankerEnded: () => false })
    expect(failed.map((entry) => entry.outcome)).toEqual(["failed"])
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path)).toMatchObject({ state: "active", lastError: "Unknown clanker clanker-a" })
    const ended = await fireDueRoutines({ send: unavailable, storePath: path, now: () => at("2026-11-10T07:02:00Z"), clankerEnded: () => true })
    expect(ended.map((entry) => entry.outcome)).toEqual(["ended"])
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path)).toMatchObject({ state: "ended", endedReason: "clanker closed", nextFireAt: null })
    expect(await fireDueRoutines({ send: unavailable, storePath: path, now: () => at("2026-11-10T07:03:00Z") })).toEqual([])
    expect(withRoutineStore((store) => store.list({}), path)).toEqual([])
    expect(withRoutineStore((store) => store.list({ includeEnded: true }), path)).toHaveLength(1)
  })
})

describe("routine ownership", () => {
  test("a clanker registers for itself, and needs --clanker to touch another clanker's routine", async () => {
    const path = storePath()
    const self = { self: "clanker-a" }
    const mine = await addRoutine({ cron: "0 9 * * 1-5", message: "standup", timeZone: AMS }, self, { storePath: path, now: at("2026-11-10T07:00:00Z") })
    expect(mine).toMatchObject({ clankerId: "clanker-a", createdBy: "clanker-a", timeZone: AMS })
    expect(mine.nextFire).toMatch(/09:00 Europe\/Amsterdam/)
    // The zone defaults from the environment and is stored with the routine.
    const defaulted = await addRoutine({ cron: "0 9 * * *", message: "x" }, self, { storePath: path, env: { CLANKERHOUSE_TIMEZONE: AMS }, now: at("2026-11-10T07:00:01Z") })
    expect(defaulted.timeZone).toBe(AMS)
    await expect(addRoutine({ cron: "0 9 * * *", message: "x" }, { self: null }, { storePath: path })).rejects.toThrow(/--clanker ID/)

    expect(listRoutines({}, self, { storePath: path }).routines.map((routine) => routine.routineId)).toEqual([mine.routineId, defaulted.routineId])
    expect(listRoutines({}, { self: "clanker-b" }, { storePath: path }).routines).toEqual([])
    expect(listRoutines({}, { self: null }, { storePath: path }).routines).toHaveLength(2)
    expect(listRoutines({ all: true }, { self: "clanker-b" }, { storePath: path }).routines).toHaveLength(2)

    const other = { self: "clanker-b" }
    expect(() => updateRoutine(mine.routineId, { message: "hijack" }, other, { storePath: path })).toThrow(/belongs to clanker clanker-a/)
    expect(() => cancelRoutine(mine.routineId, other, { storePath: path })).toThrow(/belongs to clanker clanker-a/)
    expect(() => cancelRoutine(mine.routineId, other, { storePath: path, clanker: "clanker-c" })).toThrow(/does not belong to clanker clanker-c/)
    expect(() => updateRoutine(mine.routineId, {}, self, { storePath: path })).toThrow(/Nothing to update/)
    expect(() => cancelRoutine("routine-000000000000", self, { storePath: path })).toThrow(/Unknown routine/)
    expect(updateRoutine(mine.routineId, { message: "standup notes" }, self, { storePath: path }).message).toBe("standup notes")
    // The operator, outside any clanker, may manage any routine.
    expect(cancelRoutine(mine.routineId, { self: null }, { storePath: path }).cancelled).toBe(true)
    expect(cancelRoutine(defaulted.routineId, other, { storePath: path, clanker: "clanker-a" }).cancelled).toBe(true)
  })

  test("the store is shared with the orchestration database", () => {
    const path = storePath()
    const store = RoutineStore.open(path)
    try { expect(store.list()).toEqual([]) } finally { store.close() }
  })
})

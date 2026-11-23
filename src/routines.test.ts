import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addRoutine, cancelRoutine, listRoutines, updateRoutine } from "./routine-api"
import { RoutineStore, defaultRoutineTimeZone, fireDueRoutines, formatWallClock, nextCronTime, parseCron, wallClock, withRoutineStore, type FireRoutinesDeps, type Routine, type RoutineDeliveryProof, type RoutineNotice } from "./routines"

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

  test("a failed send is recorded and notified once; a closed clanker with no workshop ends the routine loudly", async () => {
    const { path, routine } = setup("* * * * *", "UTC")
    const notices: RoutineNotice[] = []
    const notify = (notice: RoutineNotice) => { notices.push(notice) }
    const unavailable = async () => { throw Object.assign(new Error("Unknown clanker clanker-a"), { code: "NOT_FOUND" }) }
    const failed = await fireDueRoutines({ send: unavailable, notify, storePath: path, now: () => at("2026-11-10T07:01:00Z"), clankerEnded: () => false })
    expect(failed.map((entry) => [entry.outcome, entry.notified])).toEqual([["failed", true]])
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path)).toMatchObject({ state: "active", lastError: "delivery to clanker-a failed: Unknown clanker clanker-a", alert: { kind: "broken" }, missedAt: at("2026-11-10T07:01:00Z") })
    // The next fire fails too: still one notification for this breakage.
    const again = await fireDueRoutines({ send: unavailable, notify, storePath: path, now: () => at("2026-11-10T07:02:00Z"), clankerEnded: () => false })
    expect(again.map((entry) => [entry.outcome, entry.notified])).toEqual([["failed", false]])
    expect(notices.map((notice) => notice.kind)).toEqual(["broken"])
    const ended = await fireDueRoutines({ send: unavailable, notify, storePath: path, now: () => at("2026-11-10T07:03:00Z"), clankerEnded: () => true })
    expect(ended.map((entry) => entry.outcome)).toEqual(["ended"])
    expect(notices.map((notice) => notice.kind)).toEqual(["broken", "ended"])
    expect(notices[1]!.reason).toMatch(/closed and the routine has no workshop/)
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path)).toMatchObject({ state: "ended", nextFireAt: null, alert: { kind: "ended" }, missedAt: null })
    expect(await fireDueRoutines({ send: unavailable, storePath: path, now: () => at("2026-11-10T07:04:00Z") })).toEqual([])
    expect(withRoutineStore((store) => store.list({}), path)).toEqual([])
    expect(withRoutineStore((store) => store.list({ includeEnded: true }), path)).toHaveLength(1)
    expect(withRoutineStore((store) => store.alerts(at("2026-11-10T07:05:00Z")), path).map((entry) => entry.routineId)).toEqual([routine.routineId])
    expect(withRoutineStore((store) => store.alerts(at("2026-11-20T07:05:00Z")), path)).toEqual([])
  })
})

describe("routines follow their workshop", () => {
  const setup = (cron = "* * * * *") => {
    const path = storePath()
    const routine = withRoutineStore((store) => store.add({ clankerId: "clanker-old", workshopId: "ws-1", cron, timeZone: "UTC", message: "sweep", createdBy: "clanker-old", now: at("2026-11-10T07:00:00Z") }), path)
    const sent: Array<{ requestId: string; clankerId: string }> = []
    const notices: RoutineNotice[] = []
    let live: string | undefined = undefined
    let proof: RoutineDeliveryProof = "landed"
    const resumes: string[] = []
    let resumeError: string | undefined
    const deps = (iso: string): FireRoutinesDeps => ({
      storePath: path,
      now: () => at(iso),
      workshop: (current) => ({ kind: "open", workshopId: current.workshopId }),
      liveClanker: async () => live,
      resume: async (current) => {
        resumes.push(current.routineId)
        if (resumeError) throw new Error(resumeError)
        live = "clanker-resumed"
        return "clanker-resumed"
      },
      send: async (_routine, requestId, clankerId) => { sent.push({ requestId, clankerId }); return { messageId: `msg-${sent.length}`, delivery: "immediate" } },
      proof: async () => proof,
      retype: async () => true,
      notify: (notice) => { notices.push(notice) },
      proofMs: 120_000,
    })
    const stored = () => withRoutineStore((store) => store.get(routine.routineId)!, path)
    return {
      path, routine, sent, notices, resumes, deps, stored,
      setLive: (id: string | undefined) => { live = id },
      setProof: (value: RoutineDeliveryProof) => { proof = value },
      failResume: (why: string | undefined) => { resumeError = why },
    }
  }

  test("a wake goes to the workshop's live clanker, which then owns the routine", async () => {
    const t = setup()
    t.setLive("clanker-new")
    const fired = await fireDueRoutines(t.deps("2026-11-10T07:01:00Z"))
    expect(fired.map((entry) => [entry.outcome, entry.clankerId])).toEqual([["fired", "clanker-new"]])
    expect(t.sent).toEqual([{ requestId: `${t.routine.routineId}:${at("2026-11-10T07:01:00Z")}`, clankerId: "clanker-new" }])
    expect(t.stored()).toMatchObject({ clankerId: "clanker-new", workshopId: "ws-1", proof: { messageId: "msg-1", clankerId: "clanker-new" } })
    expect(t.resumes).toEqual([])
    // The next pass sees the wake in the session.
    const proven = await fireDueRoutines(t.deps("2026-11-10T07:01:20Z"))
    expect(proven.map((entry) => entry.outcome)).toEqual(["landed"])
    expect(t.stored()).toMatchObject({ proof: null, lastOutcome: "landed" })
  })

  test("with no live clanker, the workshop's last session is resumed and then woken", async () => {
    const t = setup()
    const fired = await fireDueRoutines(t.deps("2026-11-10T07:01:00Z"))
    expect(fired.map((entry) => [entry.outcome, entry.clankerId])).toEqual([["resumed", "clanker-resumed"]])
    expect(t.resumes).toEqual([t.routine.routineId])
    expect(t.sent.map((entry) => entry.clankerId)).toEqual(["clanker-resumed"])
    expect(t.stored().lastOutcome).toBe("fired after resume (immediate)")
    expect(t.notices).toEqual([])
  })

  test("a failed resume is notified once, and the last missed fire runs once when a clanker is back", async () => {
    const t = setup()
    t.failResume("quota exhausted")
    await fireDueRoutines(t.deps("2026-11-10T07:01:00Z"))
    await fireDueRoutines(t.deps("2026-11-10T07:02:00Z"))
    await fireDueRoutines(t.deps("2026-11-10T07:03:00Z"))
    expect(t.notices.map((notice) => [notice.kind, notice.routine.routineId])).toEqual([["broken", t.routine.routineId]])
    expect(t.notices[0]!.reason).toMatch(/resuming its last session failed: quota exhausted/)
    expect(t.stored()).toMatchObject({ alert: { kind: "broken" }, missedAt: at("2026-11-10T07:03:00Z") })
    expect(t.sent).toEqual([])
    // Between fires a clanker comes back (the operator resumed it): only the newest missed fire runs, once.
    t.setLive("clanker-back")
    const caught = await fireDueRoutines(t.deps("2026-11-10T07:03:30Z"))
    expect(caught.map((entry) => [entry.outcome, entry.scheduledAt])).toEqual([["caught-up", at("2026-11-10T07:03:00Z")]])
    expect(t.sent).toEqual([{ requestId: `${t.routine.routineId}:${at("2026-11-10T07:03:00Z")}`, clankerId: "clanker-back" }])
    expect(t.stored()).toMatchObject({ missedAt: null, clankerId: "clanker-back" })
    // Its proof lands: the routine works again and the alert clears.
    const landed = await fireDueRoutines(t.deps("2026-11-10T07:03:45Z"))
    expect(landed.map((entry) => entry.outcome)).toEqual(["landed"])
    expect(t.stored()).toMatchObject({ alert: null, proof: null })
    expect(t.sent).toHaveLength(1)
  })

  test("a catch-up never resumes: it waits for a clanker to come back", async () => {
    const t = setup()
    t.failResume("startup dialog")
    await fireDueRoutines(t.deps("2026-11-10T07:01:00Z"))
    expect(t.resumes).toHaveLength(1)
    await fireDueRoutines(t.deps("2026-11-10T07:01:30Z"))
    expect(t.resumes).toHaveLength(1)
    expect(t.stored().missedAt).toBe(at("2026-11-10T07:01:00Z"))
  })

  test("an unreachable Multiplexer neither resumes nor alarms: the fire waits for catch-up", async () => {
    const t = setup()
    const blind = { ...t.deps("2026-11-10T07:01:00Z"), liveClanker: async () => { throw new Error("rex unreachable") } }
    const fired = await fireDueRoutines(blind)
    expect(fired.map((entry) => [entry.outcome, entry.notified])).toEqual([["failed", false]])
    expect(t.resumes).toEqual([])
    expect(t.notices).toEqual([])
    expect(t.stored()).toMatchObject({ alert: null, missedAt: at("2026-11-10T07:01:00Z") })
    t.setLive("clanker-a")
    const caught = await fireDueRoutines(t.deps("2026-11-10T07:01:30Z"))
    expect(caught.map((entry) => entry.outcome)).toEqual(["caught-up"])
  })

  test("a workshop marked done or gone ends the routine, loudly, once", async () => {
    const t = setup()
    const done = { ...t.deps("2026-11-10T07:01:00Z"), workshop: () => ({ kind: "ended" as const, reason: "its workshop /w is marked done" }) }
    const ended = await fireDueRoutines(done)
    expect(ended.map((entry) => entry.outcome)).toEqual(["ended"])
    expect(t.notices.map((notice) => [notice.kind, notice.reason])).toEqual([["ended", "its workshop /w is marked done"]])
    expect(t.stored()).toMatchObject({ state: "ended", endedReason: "its workshop /w is marked done", alert: { kind: "ended" } })
    expect(await fireDueRoutines({ ...done, now: () => at("2026-11-10T07:02:00Z") })).toEqual([])
    expect(t.notices).toHaveLength(1)
    expect(t.sent).toEqual([])
  })

  test("a wake that never reaches the session is typed once more, then counts as a breakage", async () => {
    const t = setup("0 9 * * *")
    t.setLive("clanker-a")
    t.setProof("unconfirmed")
    await fireDueRoutines(t.deps("2026-11-10T09:00:05Z"))
    // Inside the proof window nothing happens.
    expect((await fireDueRoutines(t.deps("2026-11-10T09:01:00Z"))).map((entry) => entry.outcome)).toEqual([])
    expect((await fireDueRoutines(t.deps("2026-11-10T09:02:10Z"))).map((entry) => entry.outcome)).toEqual(["retyped"])
    expect(t.stored()).toMatchObject({ proof: { retyped: true, since: at("2026-11-10T09:02:10Z") } })
    expect((await fireDueRoutines(t.deps("2026-11-10T09:03:00Z"))).map((entry) => entry.outcome)).toEqual([])
    const lost = await fireDueRoutines(t.deps("2026-11-10T09:04:20Z"))
    expect(lost.map((entry) => [entry.outcome, entry.notified])).toEqual([["failed", true]])
    expect(t.notices[0]!.reason).toMatch(/never reached the session, even after typing it again/)
    // A message that may still sit in the input box is not sent again.
    expect(t.stored()).toMatchObject({ proof: null, missedAt: null, alert: { kind: "broken" } })
    expect(t.sent).toHaveLength(1)
  })

  test("a queued wake waits without a deadline; a lost one is delivered again", async () => {
    const t = setup("0 9 * * *")
    t.setLive("clanker-a")
    t.setProof("queued")
    await fireDueRoutines(t.deps("2026-11-10T09:00:05Z"))
    expect((await fireDueRoutines(t.deps("2026-11-10T09:30:00Z"))).map((entry) => entry.outcome)).toEqual([])
    t.setProof("lost")
    t.setLive(undefined)
    const again = await fireDueRoutines(t.deps("2026-11-10T09:31:00Z"))
    expect(again.map((entry) => [entry.outcome, entry.clankerId, entry.scheduledAt])).toEqual([["resumed", "clanker-resumed", at("2026-11-10T09:00:00Z")]])
    // The redelivery has its own request id, so it is not a replay of the lost message.
    expect(t.sent.map((entry) => entry.requestId)).toEqual([`${t.routine.routineId}:${at("2026-11-10T09:00:00Z")}`, `${t.routine.routineId}:${at("2026-11-10T09:00:00Z")}:again-${at("2026-11-10T09:31:00Z")}`])
    // Lost again: one alert, no loop.
    const twice = await fireDueRoutines(t.deps("2026-11-10T09:32:00Z"))
    expect(twice.map((entry) => [entry.outcome, entry.notified])).toEqual([["failed", true]])
    expect(t.notices[0]!.reason).toMatch(/dropped twice/)
    expect(await fireDueRoutines(t.deps("2026-11-10T09:33:00Z"))).toEqual([])
    expect(t.sent).toHaveLength(2)
  })

  test("a pass resumes at most a few workshops; the rest wait quietly for their next fire", async () => {
    const t = setup()
    const others = [1, 2].map(() => withRoutineStore((store) => store.add({ clankerId: "clanker-x", workshopId: "ws-2", cron: "* * * * *", timeZone: "UTC", message: "m", createdBy: "x", now: at("2026-11-10T07:00:00Z") }), t.path))
    t.failResume("session gone")
    const fired = await fireDueRoutines({ ...t.deps("2026-11-10T07:01:00Z"), resumesPerPass: 2 })
    expect(t.resumes).toHaveLength(2)
    expect(fired.filter((entry) => entry.notified)).toHaveLength(2)
    expect(fired.filter((entry) => entry.outcome === "failed" && !entry.notified)).toHaveLength(1)
    expect(others).toHaveLength(2)
  })

  test("a closed clanker with no workshop ends its routine instead of being resumed", async () => {
    const path = storePath()
    const routine = withRoutineStore((store) => store.add({ clankerId: "clanker-a", cron: "* * * * *", timeZone: "UTC", message: "x", createdBy: "clanker-a", now: at("2026-11-10T07:00:00Z") }), path)
    const resumes: string[] = []
    const notices: RoutineNotice[] = []
    const ended = await fireDueRoutines({ storePath: path, now: () => at("2026-11-10T07:01:00Z"), workshop: () => ({ kind: "open", workshopId: null }), liveClanker: async () => undefined,
      resume: async () => { resumes.push("x"); return "clanker-a" }, clankerEnded: () => true, notify: (notice) => { notices.push(notice) }, send: async () => ({ messageId: "m", delivery: "immediate" }) })
    expect(ended.map((entry) => entry.outcome)).toEqual(["ended"])
    expect(resumes).toEqual([])
    expect(notices.map((notice) => notice.kind)).toEqual(["ended"])
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path).state).toBe("ended")
  })

  test("a routine from before workshops owned routines is bound to its workshop at its first fire", async () => {
    const path = storePath()
    const routine = withRoutineStore((store) => store.add({ clankerId: "clanker-a", cron: "* * * * *", timeZone: "UTC", message: "x", createdBy: "clanker-a", now: at("2026-11-10T07:00:00Z") }), path)
    expect(routine.workshopId).toBeNull()
    await fireDueRoutines({ storePath: path, now: () => at("2026-11-10T07:01:00Z"), workshop: () => ({ kind: "open", workshopId: "ws-9" }), send: async () => ({ messageId: "m", delivery: "immediate" }) })
    expect(withRoutineStore((store) => store.get(routine.routineId)!, path).workshopId).toBe("ws-9")
    expect(withRoutineStore((store) => store.list({ workshopId: "ws-9" }), path).map((entry) => entry.routineId)).toEqual([routine.routineId])
  })

  test("a store from before workshops owned routines gains the new columns", () => {
    const path = storePath()
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(path, { create: true })
    db.exec(`CREATE TABLE routines (routine_id TEXT PRIMARY KEY, clanker_id TEXT NOT NULL, name TEXT, cron TEXT NOT NULL, time_zone TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, next_fire_at INTEGER, last_scheduled_at INTEGER, last_fired_at INTEGER,
      last_message_id TEXT, last_outcome TEXT, last_error TEXT, ended_reason TEXT)`)
    db.exec("INSERT INTO routines VALUES ('routine-old', 'clanker-a', NULL, '* * * * *', 'UTC', 'x', 'active', 1, 'clanker-a', 1, 2, NULL, NULL, NULL, NULL, NULL, NULL)")
    db.close()
    expect(withRoutineStore((store) => store.get("routine-old"), path)).toMatchObject({ workshopId: null, alert: null, missedAt: null, proof: null })
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

  test("a clanker sees and manages its workshop's routines, whichever clanker took their last wake", async () => {
    const path = storePath()
    const old = { self: "clanker-old", workshopId: "ws-1" }
    const added = await addRoutine({ cron: "0 9 * * *", message: "sweep", timeZone: AMS }, old, { storePath: path })
    expect(added.workshopId).toBe("ws-1")
    const successor = { self: "clanker-new", workshopId: "ws-1" }
    expect(listRoutines({}, successor, { storePath: path }).routines.map((routine) => routine.routineId)).toEqual([added.routineId])
    expect(listRoutines({}, { self: "clanker-x", workshopId: "ws-2" }, { storePath: path }).routines).toEqual([])
    expect(updateRoutine(added.routineId, { name: "sweep" }, successor, { storePath: path }).name).toBe("sweep")
    expect(() => cancelRoutine(added.routineId, { self: "clanker-x", workshopId: "ws-2" }, { storePath: path })).toThrow(/belongs to clanker/)
  })

  test("the store is shared with the orchestration database", () => {
    const path = storePath()
    const store = RoutineStore.open(path)
    try { expect(store.list()).toEqual([]) } finally { store.close() }
  })
})

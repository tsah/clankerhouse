import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_PAYLOAD_BYTES, ORPHAN_AFTER_MS, OrchestrationStore, advanceWatchCursor, computeWatchEvents, initialWatchCursor, parseReportPayload, parseReportState, promptSha256,
  readWatchCursor, readyForDelivery, reportAddressee, sendStatusOf, settleWatchCursor, writeWatchCursor, clankerBusy,
  type WatchCursor, type WatchEvent, type WatchView, type WatchedClanker,
} from "./orchestration"
import { runWatch, watchedWorkshopIds } from "./watch"
import type { WorkshopRecord } from "./workshop"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-orchestration-"))
  roots.push(root)
  return root
}

describe("report input", () => {
  test("addresses the parent by default, honors --to and --no-parent, and records without a parent", () => {
    expect(reportAddressee({ workshopId: "w-child", parentWorkshopId: "w-parent" })).toBe("w-parent")
    expect(reportAddressee({ workshopId: "w-child", parentWorkshopId: "w-parent", to: "clanker-other" })).toBe("clanker-other")
    expect(reportAddressee({ workshopId: "w-child", parentWorkshopId: "w-parent", noParent: true })).toBeNull()
    expect(reportAddressee({ workshopId: "w-root", parentWorkshopId: null })).toBeNull()
    expect(reportAddressee({ workshopId: null, parentWorkshopId: null })).toBeNull()
    expect(() => reportAddressee({ workshopId: "w", parentWorkshopId: null, to: "x", noParent: true })).toThrow(/mutually exclusive/)
  })

  test("accepts only a JSON object of at most 64 KiB", () => {
    expect(parseReportPayload('{"options":["7d","30d"]}')).toEqual({ options: ["7d", "30d"] })
    expect(parseReportPayload(undefined)).toBeNull()
    expect(parseReportPayload("  \n")).toBeNull()
    for (const invalid of ["[]", "null", "3", '"text"', "{nope"]) expect(() => parseReportPayload(invalid)).toThrow(/JSON object|not valid JSON/)
    const atLimit = JSON.stringify({ text: "x".repeat(MAX_PAYLOAD_BYTES - 11) })
    expect(Buffer.byteLength(atLimit)).toBe(MAX_PAYLOAD_BYTES)
    expect(parseReportPayload(atLimit)).toMatchObject({ text: expect.any(String) })
    expect(() => parseReportPayload(JSON.stringify({ text: "x".repeat(MAX_PAYLOAD_BYTES) }))).toThrow(/exceeds 65536 bytes/)
  })

  test("names the valid report states", () => {
    expect(parseReportState("question")).toBe("question")
    expect(() => parseReportState("settled")).toThrow(/question\|blocked\|done\|failed\|working/)
    expect(() => parseReportState(undefined)).toThrow(/--state is required/)
  })
})

describe("report store", () => {
  test("keeps ordered reports across reopen and finds each clanker's newest", () => {
    const path = join(temporary(), "orchestration.sqlite3")
    let store = OrchestrationStore.open(path)
    const first = store.appendReport({ clankerId: "clanker-a", workshopId: "w-a", to: "w-p", state: "working", message: null, payload: null })
    const second = store.appendReport({ clankerId: "clanker-a", workshopId: "w-a", to: "w-p", state: "question", message: "Which retention?", payload: { options: ["7d", "30d"] } })
    store.appendReport({ clankerId: "clanker-b", workshopId: "w-b", to: null, state: "done", message: null, payload: null })
    store.close()
    store = OrchestrationStore.open(path)
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(store.lastReportFor("clanker-a")).toEqual(second)
    expect(store.lastReportFor("clanker-missing")).toBeNull()
    expect(store.latestSeq()).toBe(second.seq + 1)
    expect(store.reportsAfter(first.seq, { workshopIds: ["w-a"] }).map((report) => report.seq)).toEqual([second.seq])
    expect(store.reportsAfter(0, { to: ["w-p"], clankerIds: ["clanker-b"] })).toHaveLength(3)
    expect(store.reportsAfter(0, {})).toEqual([])
    store.close()
  })
})

describe("queued prompt delivery", () => {
  test("hashes prompts exactly like the native hook", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex")
    expect(promptSha256("abc")).toBe(sha("abc"))
    expect(promptSha256("\n  a\r\nb \t\n")).toBe(sha("a\nb"))
  })

  test("queues behind busy, focused, or waiting clankers and delivers one unacknowledged message at a time in order", () => {
    const store = OrchestrationStore.open(join(temporary(), "orchestration.sqlite3"))
    const idle = { state: "done" as const, focused: false }
    expect(clankerBusy({ state: "working", focused: false })).toBe(true)
    expect(clankerBusy({ state: "blocked", focused: false })).toBe(true)
    expect(clankerBusy({ state: "idle", focused: true })).toBe(true)
    expect(clankerBusy(idle)).toBe(false)
    expect(readyForDelivery(idle)).toBe(true)
    expect(readyForDelivery({ state: "idle", focused: true })).toBe(false)

    const immediate = store.admitMessage({ clankerId: "clanker-c", text: "first", busy: false, afterGeneration: 3, now: 1 })
    expect(immediate).toMatchObject({ state: "delivered", delivery: "immediate" })
    // The first is delivered but unacknowledged, so the next one waits even though the clanker looks idle.
    const second = store.admitMessage({ clankerId: "clanker-c", text: "second", busy: false, afterGeneration: 3, now: 2 })
    const third = store.admitMessage({ clankerId: "clanker-c", text: "third", busy: true, afterGeneration: 3, now: 3 })
    expect([second.state, third.state]).toEqual(["queued", "queued"])
    expect(store.claimNextDelivery("clanker-c", 3)).toBeUndefined()

    // An identical prompt from an older turn does not acknowledge it.
    expect(store.acknowledge("clanker-c", [{ sha256: promptSha256("first"), generation: 3 }])).toEqual([])
    expect(store.acknowledge("clanker-c", [{ sha256: promptSha256("first"), generation: 4 }]).map((message) => message.messageId)).toEqual([immediate.messageId])
    expect(store.message(immediate.messageId)).toMatchObject({ state: "acked", startedGeneration: 4 })

    const claimed = store.claimNextDelivery("clanker-c", 4)!
    expect(claimed.messageId).toBe(second.messageId)
    expect(store.claimNextDelivery("clanker-c", 4)).toBeUndefined()
    store.requeue(claimed.messageId)
    expect(store.claimNextDelivery("clanker-c", 4)!.messageId).toBe(second.messageId)
    store.acknowledge("clanker-c", [{ sha256: promptSha256("second"), generation: 5 }])
    expect(store.claimNextDelivery("clanker-c", 5)!.messageId).toBe(third.messageId)
    store.close()
  })

  test("reports unacknowledged messages to a vanished clanker as orphaned", () => {
    const store = OrchestrationStore.open(join(temporary(), "orchestration.sqlite3"))
    const queued = store.admitMessage({ clankerId: "clanker-gone", text: "hello", busy: true, afterGeneration: 1 })
    expect(sendStatusOf(queued, true)).toEqual({ messageId: queued.messageId, clankerId: "clanker-gone", state: "queued", startedGeneration: null })
    expect(sendStatusOf(queued, false).state).toBe("orphaned")
    store.acknowledge("clanker-gone", [])
    expect(store.claimNextDelivery("clanker-other", 1)).toBeUndefined()
    store.close()
  })

  test("stops waiting for a recipient that stays missing, but not for one that comes back", () => {
    const path = join(temporary(), "orchestration.sqlite3")
    const store = OrchestrationStore.open(path)
    const gone = store.admitMessage({ clankerId: "clanker-gone", text: "hello", busy: true, afterGeneration: 1, now: 0 })
    const unacked = store.admitMessage({ clankerId: "clanker-gone-2", text: "sent", busy: false, afterGeneration: 1, now: 0 })
    const back = store.admitMessage({ clankerId: "clanker-back", text: "later", busy: true, afterGeneration: 1, now: 0 })

    expect(store.reconcileRecipients(new Set(), 1_000)).toEqual([])
    // Missing for less than the grace period, then present again: the clock restarts.
    expect(store.reconcileRecipients(new Set(["clanker-back"]), 1_000 + ORPHAN_AFTER_MS / 2)).toEqual([])
    const orphaned = store.reconcileRecipients(new Set(), 1_000 + ORPHAN_AFTER_MS)
    expect(orphaned.map((message) => message.messageId).sort()).toEqual([gone.messageId, unacked.messageId].sort())
    expect(store.message(gone.messageId)).toMatchObject({ state: "orphaned" })
    expect(sendStatusOf(store.message(unacked.messageId)!, true).state).toBe("orphaned")
    expect(store.pendingMessages().map((message) => message.messageId)).toEqual([back.messageId])
    store.close()

    // The state survives reopening, and nothing claims an orphaned message.
    const reopened = OrchestrationStore.open(path)
    expect(reopened.claimNextDelivery("clanker-gone", 2)).toBeUndefined()
    expect(reopened.orphanMessagesFor(["clanker-back"]).map((message) => message.messageId)).toEqual([back.messageId])
    expect(reopened.hasPendingMessages()).toBe(false)
    reopened.close()
  })

  test("adds the missing-recipient clock to a store created before it existed", () => {
    const path = join(temporary(), "orchestration.sqlite3")
    const legacy = new Database(path, { create: true })
    legacy.exec(`CREATE TABLE messages (message_id TEXT PRIMARY KEY, clanker_id TEXT NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, after_generation INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER, started_generation INTEGER)`)
    legacy.exec(`INSERT INTO messages VALUES ('msg-old', 'clanker-gone', 'x', 'h', 'queued', 'queued', 0, 1, NULL, NULL, NULL)`)
    legacy.close()
    const store = OrchestrationStore.open(path)
    store.reconcileRecipients(new Set(), 0)
    expect(store.reconcileRecipients(new Set(), ORPHAN_AFTER_MS).map((message) => message.messageId)).toEqual(["msg-old"])
    store.close()
  })
})

const clanker = (overrides: Partial<WatchedClanker> = {}): WatchedClanker => ({
  clankerId: "clanker-a", workshopId: "w-a", parentWorkshopId: "w-p", state: "working", generation: 1, settledGeneration: 0, lastEventAt: 1_000, ...overrides,
})
const view = (overrides: Partial<WatchView> = {}): WatchView => ({ now: 2_000, clankers: [], reports: [], latestSeq: 0, ...overrides })
const report = (seq: number) => ({ seq, at: seq, clankerId: "clanker-a", workshopId: "w-a", to: "w-p", state: "question" as const, message: "?", payload: { n: seq } })
const apply = (cursor: WatchCursor, current: WatchView, options = {}) => {
  const events = computeWatchEvents(cursor, current, options)
  for (const event of events) cursor = advanceWatchCursor(cursor, event)
  return { events, cursor: settleWatchCursor(cursor, current) }
}

describe("watch events", () => {
  test("starts from now and emits reported, settled, stale, spawned, and exited exactly once each", () => {
    let cursor = initialWatchCursor({ clankers: [clanker({ settledGeneration: 2, generation: 2, state: "done" })], latestSeq: 7 })
    expect(cursor).toEqual({ version: 1, seq: 7, clankers: { "clanker-a": { workshopId: "w-a", settled: 2, stale: 0 } } })
    let step = apply(cursor, view({ clankers: [clanker({ settledGeneration: 2, generation: 2, state: "done" })], latestSeq: 7 }))
    expect(step.events).toEqual([])

    const current = view({
      clankers: [clanker({ generation: 3, settledGeneration: 3, state: "done" }), clanker({ clankerId: "clanker-b", workshopId: "w-b", generation: 1, settledGeneration: 0, state: "working", lastEventAt: 2_000 })],
      reports: [report(8)],
      latestSeq: 9,
    })
    step = apply(step.cursor, current)
    expect(step.events.map((event) => event.type)).toEqual(["reported", "settled", "spawned"])
    expect(step.events[0]).toEqual({ type: "reported", seq: 8, at: 8, clankerId: "clanker-a", workshopId: "w-a", to: "w-p", state: "question", message: "?", payload: { n: 8 } })
    expect(step.events[1]).toMatchObject({ type: "settled", clankerId: "clanker-a", generation: 3, state: "done" })
    expect(step.events[2]).toEqual({ type: "spawned", at: 2_000, clankerId: "clanker-b", workshopId: "w-b", parentWorkshopId: "w-p" })
    expect(step.cursor.seq).toBe(9)
    expect(apply(step.cursor, current).events).toEqual([])

    const later = view({ now: 2_000 + 1_801_000, clankers: current.clankers, latestSeq: 9 })
    step = apply(step.cursor, later)
    expect(step.events).toEqual([{ type: "stale", at: later.now, clankerId: "clanker-b", workshopId: "w-b", generation: 1, lastEventAt: 2_000 }])
    expect(apply(step.cursor, later).events).toEqual([])
    expect(apply(step.cursor, later, { staleAfterMs: 10 }).events).toEqual([])

    step = apply(step.cursor, view({ now: later.now, clankers: [current.clankers[1]!], latestSeq: 9 }))
    expect(step.events).toEqual([{ type: "exited", at: later.now, clankerId: "clanker-a", workshopId: "w-a" }])
    expect(step.cursor.clankers["clanker-a"]).toBeUndefined()
  })

  test("announces the first settle of a relaunched clanker whose generations restarted", () => {
    let cursor: WatchCursor = { version: 1, seq: 0, clankers: { "clanker-a": { workshopId: "w-a", settled: 5, stale: 0 } } }
    let step = apply(cursor, view({ clankers: [clanker({ generation: 1, settledGeneration: 0 })] }))
    expect(step.events).toEqual([])
    expect(step.cursor.clankers["clanker-a"]!.settled).toBe(0)
    step = apply(step.cursor, view({ clankers: [clanker({ generation: 1, settledGeneration: 1, state: "done" })] }))
    expect(step.events.map((event) => event.type)).toEqual(["settled"])
  })

  test("follows new child and descendant Workshops", () => {
    const record = (workshopId: string, parentWorkshopId: string | null) => ({ workshopId, parentWorkshopId }) as WorkshopRecord
    const workshops = [record("w-p", null), record("w-a", "w-p"), record("w-b", "w-p"), record("w-a1", "w-a"), record("w-x", null)]
    expect([...watchedWorkshopIds(workshops, "w-p", false)].sort()).toEqual(["w-a", "w-b"])
    expect([...watchedWorkshopIds(workshops, "w-p", true)].sort()).toEqual(["w-a", "w-a1", "w-b"])
  })
})

describe("watch loop", () => {
  const scripted = (views: WatchView[]) => {
    let index = 0
    return async (seq: number | undefined) => {
      const current = views[Math.min(index++, views.length - 1)]!
      return { ...current, reports: seq === undefined ? [] : current.reports.filter((entry) => entry.seq > seq) }
    }
  }

  test("persists a baseline, resumes exactly once from the cursor, and times out with 124", async () => {
    const cursorFile = join(temporary(), "watch.cursor")
    const baseline = view({ clankers: [clanker()], latestSeq: 1 })
    const emitted: WatchEvent[] = []
    await expect(runWatch({ view: scripted([baseline]), emit: (event) => emitted.push(event), cursorFile, timeoutMs: 0, sleep: async () => {} })).rejects.toMatchObject({ code: "TIMEOUT", exitCode: 124 })
    expect(emitted).toEqual([])
    expect(readWatchCursor(cursorFile)).toMatchObject({ seq: 1, clankers: { "clanker-a": { settled: 0 } } })

    const next = view({ clankers: [clanker({ generation: 1, settledGeneration: 1, state: "done" })], reports: [report(2)], latestSeq: 2 })
    await runWatch({ view: scripted([next]), emit: (event) => emitted.push(event), cursorFile, once: true, sleep: async () => {} })
    expect(emitted.map((event) => event.type)).toEqual(["reported", "settled"])
    emitted.length = 0
    await expect(runWatch({ view: scripted([next]), emit: (event) => emitted.push(event), cursorFile, once: true, timeoutMs: 0, sleep: async () => {} })).rejects.toMatchObject({ exitCode: 124 })
    expect(emitted).toEqual([])
  })

  test("repeats, never loses, an event whose cursor write was interrupted", async () => {
    const cursorFile = join(temporary(), "watch.cursor")
    writeWatchCursor(cursorFile, { version: 1, seq: 0, clankers: {} })
    const current = view({ reports: [report(1), report(2)], latestSeq: 2 })
    const emitted: number[] = []
    let writes = 0
    const crashing = (path: string, cursor: WatchCursor) => {
      if (++writes === 2) throw new Error("killed between emit and record")
      writeWatchCursor(path, cursor)
    }
    await expect(runWatch({ view: scripted([current]), emit: (event) => emitted.push((event as { seq: number }).seq), cursorFile, once: true, writeCursor: crashing, sleep: async () => {} })).rejects.toThrow(/killed/)
    expect(emitted).toEqual([1, 2])
    expect(readWatchCursor(cursorFile)!.seq).toBe(1)
    await runWatch({ view: scripted([current]), emit: (event) => emitted.push((event as { seq: number }).seq), cursorFile, once: true, sleep: async () => {} })
    expect(emitted).toEqual([1, 2, 2])
    expect(readWatchCursor(cursorFile)!.seq).toBe(2)
  })

  test("keeps polling through an unreachable Multiplexer instead of reporting exits", async () => {
    let calls = 0
    const emitted: WatchEvent[] = []
    const flaky = async () => {
      calls += 1
      if (calls === 2) throw new Error("multiplexer down")
      return view({ clankers: calls === 1 ? [clanker()] : [clanker({ settledGeneration: 1, state: "done" })] })
    }
    await runWatch({ view: flaky, emit: (event) => emitted.push(event), once: true, sleep: async () => {} })
    expect(emitted.map((event) => event.type)).toEqual(["settled"])
  })
})

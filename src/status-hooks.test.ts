import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialStatusCursor, type ClankerFacts, type StatusCursor, type StatusEvent, type StatusView, type ViewedClanker } from "./status-events"
import { StatusHookRuntime, hooksStatus, sampleEvent, sendHooksTest } from "./status-hooks"
import { StatusOutbox } from "./status-outbox"
import type { ClankerState } from "./model"

const roots: string[] = []
const runtimes: StatusHookRuntime[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const facts: ClankerFacts = { workshopId: "w-1", workshop: "Fix it", title: "Fix it", repo: "repo", branch: "fix-it", worktree: "/work/fix-it", pane: "w1-1", harness: "claude" }
const clanker = (state: ClankerState, settledGeneration = 0): ViewedClanker => ({ clankerId: "c-1", state, settledGeneration, facts })

const until = async (predicate: () => boolean, timeoutMs = 3_000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

/** A receiver whose reply the test controls; it records each attempt's body. */
const receiver = () => {
  const received: StatusEvent[] = []
  const state = { status: 200, keys: [] as (string | null)[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      state.keys.push(request.headers.get("x-sender-key"))
      received.push(await request.json() as StatusEvent)
      return new Response("", { status: state.status })
    },
  })
  servers.push(server)
  return { received, state, url: `http://127.0.0.1:${server.port}/hook` }
}

const fixture = (url: string, extra = "") => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-status-"))
  roots.push(root)
  const configPath = join(root, "hooks.toml")
  const outboxPath = join(root, "state", "status-events.sqlite3")
  writeFileSync(configPath, `[detect]\ndebounce_seconds = 0\nexit_grace_seconds = 0\n[delivery]\nretry_base_seconds = 0.02\nretry_max_seconds = 0.05\ngive_up_after_seconds = 3600\ntimeout_seconds = 2\n${extra}\n[[sinks]]\nname = "groky"\nurl = "${url}"\n[sinks.headers]\nX-Sender-Key = "sekret"\n`, { mode: 0o600 })
  let current: Partial<StatusView> & { clankers: ViewedClanker[] } = { clankers: [] }
  const requested = { count: 0 }
  const build = (): StatusView => ({ now: Date.now(), reports: [], latestSeq: 0, stuckMessages: [], markers: [], closedReason: () => null, ...current })
  const start = (log: (line: string) => void = () => {}) => {
    const runtime = new StatusHookRuntime({ view: async () => build(), requestObservation: () => { requested.count += 1 }, configPath, outboxPath, log })
    runtimes.push(runtime)
    return runtime
  }
  return { root, configPath, outboxPath, set: (clankers: ViewedClanker[], overrides: Partial<StatusView> = {}) => { current = { ...overrides, clankers } }, start, requested }
}

const outboxOf = (path: string) => {
  const outbox = StatusOutbox.open(path)
  try { return { totals: outbox.totals(), recent: outbox.recent(), cursor: outbox.cursor() } }
  finally { outbox.close() }
}

describe("status hook runtime", () => {
  test("a transition reaches the webhook with its secret header, once", async () => {
    const sink = receiver()
    const { set, start, outboxPath } = fixture(sink.url)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    expect(sink.received).toEqual([])
    set([clanker("done", 1)])
    await runtime.observed()
    await until(() => sink.received.length === 1)
    await runtime.observed()
    await Bun.sleep(30)
    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]).toMatchObject({ type: "clanker.settled", clankerId: "c-1", oldState: "working", newState: "done", repo: "repo", branch: "fix-it" })
    expect(sink.state.keys).toEqual(["sekret"])
    await until(() => outboxOf(outboxPath).totals[0]?.delivered === 1)
  })

  test("a failing webhook is retried with the same dedupe key until it recovers", async () => {
    const sink = receiver()
    sink.state.status = 503
    const { set, start, outboxPath } = fixture(sink.url)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("blocked")])
    await runtime.observed()
    await until(() => sink.received.length >= 2)
    const failing = outboxOf(outboxPath)
    expect(failing.totals[0]).toMatchObject({ pending: 1, delivered: 0 })
    expect(failing.recent[0]).toMatchObject({ state: "pending", lastStatus: 503, lastError: "HTTP 503" })
    sink.state.status = 200
    await until(() => outboxOf(outboxPath).totals[0]?.delivered === 1)
    expect(new Set(sink.received.map((event) => event.dedupeKey)).size).toBe(1)
    expect(outboxOf(outboxPath).recent[0]!.attempts).toBeGreaterThanOrEqual(3)
  })

  test("a rejected event fails for good and does not hold back the next", async () => {
    const sink = receiver()
    sink.state.status = 401
    const { set, start, outboxPath } = fixture(sink.url)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("blocked")])
    await runtime.observed()
    await until(() => outboxOf(outboxPath).totals[0]?.failed === 1)
    await Bun.sleep(60)
    expect(sink.received).toHaveLength(1)
    sink.state.status = 200
    set([clanker("done", 1)])
    await runtime.observed()
    await until(() => outboxOf(outboxPath).totals[0]?.delivered === 1)
  })

  test("an event past the give-up age fails rather than retrying forever", async () => {
    const sink = receiver()
    sink.state.status = 503
    const { set, start, outboxPath, configPath } = fixture(sink.url)
    writeFileSync(configPath, (await Bun.file(configPath).text()).replace("give_up_after_seconds = 3600", "give_up_after_seconds = 0"))
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("blocked")])
    await runtime.observed()
    await until(() => outboxOf(outboxPath).totals[0]?.failed === 1)
    expect(sink.received).toHaveLength(1)
  })

  test("pending events survive a daemon restart and go out from the spool", async () => {
    const sink = receiver()
    sink.state.status = 503
    const { set, start, outboxPath } = fixture(sink.url)
    const first = start()
    set([clanker("working")])
    await first.observed()
    set([clanker("blocked")])
    await first.observed()
    await until(() => sink.received.length >= 1)
    first.stop()

    sink.state.status = 200
    const second = start()
    await second.observed()
    await until(() => outboxOf(outboxPath).totals[0]?.delivered === 1)
    expect(new Set(sink.received.map((event) => event.dedupeKey)).size).toBe(1)
  })

  test("a restart resumes from the durable cursor: a transition during the downtime is seen, nothing repeats", async () => {
    const sink = receiver()
    const { set, start, outboxPath } = fixture(sink.url)
    const first = start()
    set([clanker("working")])
    await first.observed()
    first.stop()

    set([clanker("done", 1)])
    const second = start()
    await second.observed()
    await until(() => sink.received.length === 1)
    second.stop()

    const third = start()
    await third.observed()
    await Bun.sleep(30)
    expect(sink.received).toHaveLength(1)
    expect(outboxOf(outboxPath).cursor?.clankers["c-1"]).toMatchObject({ phase: "settled", settled: 1 })
  })

  test("with no config nothing is created at all", async () => {
    const sink = receiver()
    const { set, start, configPath, outboxPath, root } = fixture(sink.url)
    rmSync(configPath)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("done", 1)])
    await runtime.observed()
    expect(existsSync(outboxPath)).toBe(false)
    expect(existsSync(join(root, "state"))).toBe(false)
    expect(sink.received).toEqual([])
  })

  test("removing the config and adding it back starts from now", async () => {
    const sink = receiver()
    const { set, start, configPath, outboxPath } = fixture(sink.url)
    const text = await Bun.file(configPath).text()
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    rmSync(configPath)
    await runtime.observed()
    expect(outboxOf(outboxPath).cursor).toBeUndefined()
    set([clanker("done", 1)])
    writeFileSync(configPath, text, { mode: 0o600 })
    await runtime.observed()
    await runtime.observed()
    await Bun.sleep(30)
    expect(sink.received).toEqual([])
  })

  test("a config edit takes effect at once, and a bad edit keeps the last good one", async () => {
    const first = receiver(), second = receiver()
    const { set, start, configPath } = fixture(first.url)
    const logs: string[] = []
    const runtime = start((line) => logs.push(line))
    set([clanker("working")])
    await runtime.observed()
    const good = await Bun.file(configPath).text()
    writeFileSync(configPath, "not [valid")
    utimesSync(configPath, new Date(), new Date(Date.now() + 1_000))
    await runtime.observed()
    await runtime.observed()
    expect(logs.filter((line) => line.includes("not valid TOML") && line.includes("keeping the last good config"))).toHaveLength(1)
    writeFileSync(configPath, good.replace(first.url, second.url))
    utimesSync(configPath, new Date(), new Date(Date.now() + 2_000))
    set([clanker("blocked")])
    await runtime.observed()
    await until(() => second.received.length === 1)
    expect(first.received).toEqual([])
    expect(logs.every((line) => !line.includes("sekret") && !line.includes(first.url))).toBe(true)
  })

  test("an insecure config is refused, and the sink is never called", async () => {
    const sink = receiver()
    const { set, start, configPath, outboxPath } = fixture(sink.url)
    chmodSync(configPath, 0o644)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("done", 1)])
    await runtime.observed()
    expect(sink.received).toEqual([])
    expect(hooksStatus({ configPath, outboxPath }).config).toMatchObject({ state: "invalid", error: expect.stringContaining("chmod 600") })
  })

  test("a held transition asks for another look when it matures", async () => {
    const sink = receiver()
    const { set, start, configPath, requested } = fixture(sink.url)
    writeFileSync(configPath, (await Bun.file(configPath).text()).replace("debounce_seconds = 0", "debounce_seconds = 0.02"))
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("blocked")])
    await runtime.observed()
    expect(sink.received).toEqual([])
    await until(() => requested.count === 1)
    await runtime.observed()
    await until(() => sink.received.length === 1)
  })

  test("a slow sink does not hold up detection", async () => {
    let release: (() => void) | undefined
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await new Promise<void>((resolve) => { release = resolve }); return new Response("") } })
    servers.push(server)
    const { set, start, outboxPath } = fixture(`http://127.0.0.1:${server.port}/`)
    const runtime = start()
    set([clanker("working")])
    await runtime.observed()
    set([clanker("blocked")])
    await runtime.observed()
    await until(() => release !== undefined)
    const started = Date.now()
    set([clanker("working")])
    await runtime.observed()
    expect(Date.now() - started).toBeLessThan(200)
    expect(outboxOf(outboxPath).cursor?.clankers["c-1"]?.phase).toBe("working")
    release!()
    await until(() => outboxOf(outboxPath).totals[0]?.delivered === 1)
  })

  test("a failing view is logged once and detection carries on", async () => {
    const sink = receiver()
    const { configPath, outboxPath } = fixture(sink.url)
    const logs: string[] = []
    let fail = true
    const runtime = new StatusHookRuntime({
      view: async () => {
        if (fail) throw new Error("observation failed")
        return { now: Date.now(), reports: [], latestSeq: 0, stuckMessages: [], markers: [], closedReason: () => null, clankers: [] }
      },
      requestObservation: () => {}, configPath, outboxPath, log: (line) => logs.push(line),
    })
    runtimes.push(runtime)
    await runtime.observed()
    await runtime.observed()
    expect(logs).toHaveLength(1)
    fail = false
    await runtime.observed()
    expect(outboxOf(outboxPath).cursor).toBeDefined()
  })
})

describe("outbox", () => {
  const dbPath = () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-outbox-"))
    roots.push(root)
    return join(root, "status-events.sqlite3")
  }
  const cursor: StatusCursor = initialStatusCursor({ clankers: [], latestSeq: 0, stuckMessages: [], markers: [] })

  test("is private, and a dedupe key is recorded once", () => {
    const path = dbPath()
    const outbox = StatusOutbox.open(path)
    expect(statSync(path).mode & 0o077).toBe(0)
    const event = sampleEvent(1_000)
    outbox.commit(cursor, [{ event, sinks: ["a", "b"] }], 1_000)
    outbox.commit(cursor, [{ event: { ...event, id: "other" }, sinks: ["a"] }], 2_000)
    expect(outbox.due("a", 2_000)).toHaveLength(1)
    expect(outbox.due("b", 2_000)).toHaveLength(1)
    outbox.close()
  })

  test("a retry waits for its time", () => {
    const outbox = StatusOutbox.open(dbPath())
    const event = sampleEvent(1_000)
    outbox.commit(cursor, [{ event, sinks: ["a"] }], 1_000)
    outbox.markRetry(event.id, "a", { error: "HTTP 500", status: 500 }, 5_000, 1_000)
    expect(outbox.due("a", 4_999)).toEqual([])
    expect(outbox.due("a", 5_000)).toMatchObject([{ attempts: 1 }])
    expect(outbox.nextAttemptAt("a")).toBe(5_000)
    outbox.close()
  })

  test("a removed sink's deliveries stop pending, a kept sink's stay", () => {
    const outbox = StatusOutbox.open(dbPath())
    outbox.commit(cursor, [{ event: sampleEvent(1_000), sinks: ["gone", "kept"] }], 1_000)
    outbox.abandonRemovedSinks(["kept"], 2_000)
    expect(outbox.totals()).toEqual([{ sink: "gone", pending: 0, delivered: 0, failed: 1 }, { sink: "kept", pending: 1, delivered: 0, failed: 0 }])
    outbox.abandonRemovedSinks([], 3_000)
    expect(outbox.totals()[1]).toMatchObject({ pending: 0, failed: 1 })
    outbox.close()
  })

  test("pruning keeps recent and pending events", () => {
    const outbox = StatusOutbox.open(dbPath())
    const old = sampleEvent(1_000), pending = sampleEvent(2_000), recent = sampleEvent(30 * 86_400_000)
    outbox.commit(cursor, [{ event: old, sinks: ["a"] }, { event: pending, sinks: ["a"] }, { event: recent, sinks: ["a"] }], 3_000)
    outbox.markDelivered(old.id, "a", 200)
    outbox.markDelivered(recent.id, "a", 200)
    outbox.prune(30 * 86_400_000)
    expect(outbox.recent().map((row) => row.eventId).sort()).toEqual([pending.id, recent.id].sort())
    outbox.close()
  })
})

describe("clankers hooks", () => {
  test("test sends a sample to every sink and status shows the outcome without any secret", async () => {
    const sink = receiver()
    const { configPath, outboxPath } = fixture(sink.url)
    const results = await sendHooksTest({ configPath, outboxPath })
    expect(results).toMatchObject([{ sink: "groky", ok: true, status: 200 }])
    expect(sink.received[0]).toMatchObject({ type: "hooks.test", test: true })
    expect(sink.state.keys).toEqual(["sekret"])

    const status = hooksStatus({ configPath, outboxPath })
    expect(status.totals).toEqual([{ sink: "groky", pending: 0, delivered: 1, failed: 0 }])
    expect(status.recent[0]).toMatchObject({ sink: "groky", type: "hooks.test", state: "delivered", attempts: 1, lastStatus: 200 })
    expect(status.config).toMatchObject({ state: "ok", sinks: [{ name: "groky", kind: "webhook", headers: ["X-Sender-Key"] }] })
    expect(JSON.stringify(status)).not.toContain("sekret")
  })

  test("a failed test is reported and recorded, and is not retried", async () => {
    const sink = receiver()
    sink.state.status = 500
    const { configPath, outboxPath } = fixture(sink.url)
    expect(await sendHooksTest({ configPath, outboxPath })).toMatchObject([{ ok: false, status: 500, error: "HTTP 500" }])
    expect(hooksStatus({ configPath, outboxPath })).toMatchObject({ totals: [{ pending: 0, failed: 1 }], recent: [{ state: "failed", lastError: "HTTP 500" }] })
  })

  test("test can target one sink and rejects an unknown one", async () => {
    const sink = receiver()
    const { configPath, outboxPath } = fixture(sink.url)
    await expect(sendHooksTest({ configPath, outboxPath, sink: "nope" })).rejects.toThrow("No sink named nope")
    expect(await sendHooksTest({ configPath, outboxPath, sink: "groky" })).toHaveLength(1)
  })

  test("status reports an absent config without creating anything", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-status-"))
    roots.push(root)
    const outboxPath = join(root, "status-events.sqlite3")
    expect(hooksStatus({ configPath: join(root, "hooks.toml"), outboxPath })).toEqual({ config: { path: join(root, "hooks.toml"), state: "absent", sinks: [] }, totals: [], recent: [] })
    expect(existsSync(outboxPath)).toBe(false)
  })
})

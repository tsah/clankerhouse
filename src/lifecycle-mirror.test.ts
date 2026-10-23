import { describe, expect, test } from "bun:test"
import { LifecycleMirror, MIRROR_MAX_AGE_MS, type MirrorTarget } from "./lifecycle-mirror"

const recorder = (fail?: () => Error | undefined) => {
  const calls: string[] = []
  const target: MirrorTarget = {
    async reportAgentState(pane, harness, state, session) {
      const error = fail?.()
      if (error) throw error
      calls.push(`${pane} ${harness} ${state}${session ? ` ${session}` : ""}`)
    },
    async releaseAgent(pane, harness) { calls.push(`${pane} ${harness} release`) },
  }
  return { calls, target }
}

const now = 1_000_000
const report = (state: string, generation?: number, extra: Record<string, unknown> = {}) => ({ pane: "w1:p1", harness: "claude", state, harnessSessionId: "s1", generation, updatedAt: now, ...extra })

describe("lifecycle mirror", () => {
  test("maps lifecycle states onto herdr states and skips repeats", async () => {
    const { calls, target } = recorder()
    const mirror = new LifecycleMirror(() => target, { now: () => now })
    await mirror.offer(report("idle", 0))
    await mirror.offer(report("idle", 0))
    await mirror.offer(report("working", 1))
    await mirror.offer(report("working", 1))
    await mirror.offer(report("blocked", 1))
    await mirror.offer(report("done", 1))
    // A settle point re-sent for the same turn is not a second completion.
    await mirror.offer(report("done", 1))
    expect(calls).toEqual(["w1:p1 claude idle s1", "w1:p1 claude working s1", "w1:p1 claude blocked s1", "w1:p1 claude idle s1"])
  })

  test("precedes a settle whose working was coalesced away with working, so herdr records the completion", async () => {
    const { calls, target } = recorder()
    const mirror = new LifecycleMirror(() => target, { now: () => now })
    await mirror.offer(report("done", 1))
    await mirror.offer(report("done", 2))
    expect(calls).toEqual(["w1:p1 claude working s1", "w1:p1 claude idle s1", "w1:p1 claude working s1", "w1:p1 claude idle s1"])
  })

  test("releases the pane when the session ends, once", async () => {
    const { calls, target } = recorder()
    const mirror = new LifecycleMirror(() => target, { now: () => now })
    await mirror.offer(report("working", 1))
    await mirror.offer(report("unknown", 1))
    await mirror.offer(report("unknown", 1))
    await mirror.offer(report("idle", 0, { harnessSessionId: "s2" }))
    expect(calls).toEqual(["w1:p1 claude working s1", "w1:p1 claude release", "w1:p1 claude idle s2"])
  })

  test("announces each release and each re-hold of a pane, so Recovery re-reports its resume gate", async () => {
    const { target } = recorder()
    const changed: string[] = []
    const mirror = new LifecycleMirror(() => target, { now: () => now, onHoldChanged: (pane) => changed.push(pane) })
    await mirror.offer(report("working", 1))
    await mirror.offer(report("idle", 1))
    await mirror.offer(report("unknown", 1))
    await mirror.offer(report("unknown", 1))
    await mirror.offer(report("working", 2))
    expect(changed).toEqual(["w1:p1", "w1:p1", "w1:p1"])
  })

  test("ignores harnesses herdr observes itself, unknown states, and stale reports", async () => {
    const { calls, target } = recorder()
    const mirror = new LifecycleMirror(() => target, { now: () => now })
    await mirror.offer(report("working", 1, { harness: "codex" }))
    await mirror.offer(report("working", 1, { harness: "opencode" }))
    await mirror.offer(report("present", 1))
    await mirror.offer(report("working", 1, { updatedAt: now - MIRROR_MAX_AGE_MS - 1 }))
    await mirror.offer(report("working", 1, { harness: "pi" }))
    expect(calls).toEqual(["w1:p1 pi working s1"])
  })

  test("sends only the newest report of a pane that changed while one was in flight", async () => {
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const target: MirrorTarget = {
      async reportAgentState(pane, _harness, state) { calls.push(`${pane} ${state}`); if (calls.length === 1) await gate },
      async releaseAgent() {},
    }
    const mirror = new LifecycleMirror(() => target, { now: () => now })
    const first = mirror.offer(report("working", 1))
    void mirror.offer(report("blocked", 1))
    void mirror.offer(report("working", 1, { pane: "w1:p2" }))
    void mirror.offer(report("idle", 1))
    release()
    await first
    expect(calls.sort()).toEqual(["w1:p1 idle", "w1:p1 working", "w1:p2 working"])
  })

  test("logs a failure once and retries it with the next report", async () => {
    let failing = true
    const { calls, target } = recorder(() => failing ? new Error("herdr down") : undefined)
    const logged: string[] = []
    const mirror = new LifecycleMirror(() => target, { now: () => now, log: (message) => logged.push(message) })
    await mirror.offer(report("working", 1))
    await mirror.offer(report("working", 1))
    expect(logged).toHaveLength(1)
    failing = false
    await mirror.offer(report("working", 1))
    expect(calls).toEqual(["w1:p1 claude working s1"])
  })

  test("does nothing on a Multiplexer without pushed agent status", async () => {
    const mirror = new LifecycleMirror(() => ({}), { now: () => now })
    await mirror.offer(report("working", 1))
  })
})

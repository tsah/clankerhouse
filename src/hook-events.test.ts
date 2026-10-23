import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseHookStateRequest, takeHookStateRequests, watchHookStateRequests, type HookStateRequest } from "./hook-events"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const spool = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-hook-events-"))
  roots.push(root)
  return root
}
const request = { pane: "w1:p2", clankerId: "clanker-1", harnessSessionId: "session-1", state: "done", updatedAt: 1, harness: "claude", generation: 3 }

describe("spooled hook requests", () => {
  test("parses the hook's request and rejects incomplete or malformed ones", () => {
    expect(parseHookStateRequest(request)).toEqual({ pane: "w1:p2", clankerId: "clanker-1", harnessSessionId: "session-1", state: "done", harness: "claude", generation: 3, updatedAt: 1 })
    // Hooks that predate lifecycle mirroring name no harness or generation.
    expect(parseHookStateRequest({ ...request, harness: undefined, generation: undefined })).toEqual({ pane: "w1:p2", clankerId: "clanker-1", harnessSessionId: "session-1", state: "done", updatedAt: 1 })
    for (const broken of [null, "x", { ...request, clankerId: "" }, { ...request, harnessSessionId: undefined }, { ...request, state: 3 }]) {
      expect(parseHookStateRequest(broken)).toBeUndefined()
    }
  })

  test("takes each pending request once, ignoring in-flight temporary files", () => {
    const directory = spool()
    writeFileSync(join(directory, "w1_p2.json"), JSON.stringify(request))
    writeFileSync(join(directory, "w1_p3.json"), "{not json")
    writeFileSync(join(directory, "w1_p4.123.tmp"), JSON.stringify(request))
    expect(takeHookStateRequests(directory)).toEqual([parseHookStateRequest(request)!])
    expect(readdirSync(directory)).toEqual(["w1_p4.123.tmp"])
    expect(takeHookStateRequests(directory)).toEqual([])
    expect(takeHookStateRequests(join(directory, "missing"))).toEqual([])
  })

  test("applies existing requests at start and new ones as they arrive", async () => {
    const directory = spool()
    writeFileSync(join(directory, "a.json"), JSON.stringify({ ...request, pane: "a" }))
    const applied: HookStateRequest[] = []
    const stop = watchHookStateRequests(directory, async (next) => { applied.push(next) })
    try {
      const until = async (count: number) => { for (let tick = 0; tick < 200 && applied.length < count; tick++) await Bun.sleep(5) }
      await until(1)
      writeFileSync(join(directory, "b.json"), JSON.stringify({ ...request, pane: "b" }))
      await until(2)
      expect(applied.map((next) => next.pane)).toEqual(["a", "b"])
      expect(existsSync(join(directory, "b.json"))).toBe(false)
    } finally { stop() }
  })

  test("keeps applying requests by polling when change notification is unavailable", async () => {
    const directory = spool()
    const applied: HookStateRequest[] = []
    const exhausted = (() => { throw new Error("EMFILE: too many open files, watch") }) as unknown as typeof import("node:fs").watch
    const stop = watchHookStateRequests(directory, async (next) => { applied.push(next) }, 30_000, 20, exhausted)
    try {
      writeFileSync(join(directory, "late.json"), JSON.stringify({ ...request, pane: "late" }))
      for (let tick = 0; tick < 200 && applied.length < 1; tick++) await Bun.sleep(5)
      expect(applied.map((next) => next.pane)).toEqual(["late"])
    } finally { stop() }
  })
})

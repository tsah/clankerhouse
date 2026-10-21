import { describe, expect, test } from "bun:test"
import { parseRequest } from "./protocol"

const mutation = (intent: unknown) => parseRequest({ version: 1, id: "request", method: "mutation.submit", params: { idempotencyKey: "key", intent } })

describe("mutation protocol target set", () => {
  test("accepts absorb, reparent, start, stop, and recovery intents", () => {
    const intents = [
      { type: "absorb", target: { type: "session", session: "repo", management: "unmanaged", location: { kind: "herdr", instanceId: "server", nativeSessionId: "$1", nativeWindowId: null, nativePaneId: null } } },
      { type: "reparent", workshopId: "child", parentWorkshopId: "parent", session: "repo" },
      { type: "start", clankerId: "clanker-1", force: true },
      { type: "stop", clankerId: "clanker-1", confirmed: true, reason: "operator" },
      { type: "recovery", clankerId: "clanker-1", action: "resume", force: true },
      { type: "create", repository: "/repo/main", branch: "feature", create: false, remoteRef: "origin/feature" },
    ]
    for (const intent of intents) expect(mutation(intent)).toMatchObject({ method: "mutation.submit", params: { intent } })
  })

  test("open intents carry only the target", () => {
    const intent = { type: "open", target: { type: "session", session: "child" } }
    expect(mutation(intent)).toMatchObject({ method: "mutation.submit", params: { intent } })
  })

  test("accepts well-formed label and done intents and rejects malformed labels", () => {
    for (const intent of [
      { type: "label", path: "/repo/feature", key: "stage", value: "retro" },
      { type: "label", path: "/repo/feature", key: "stage", value: null },
      { type: "done", path: "/repo/feature" },
      { type: "workshop.stop", path: "/repo/feature" },
      { type: "label", path: "/repo/feature", key: "title", value: "Migrate the adapter" },
      { type: "create", repository: "/repo", branch: "migrate-the-adapter", create: true, title: "Migrate the adapter" },
      { type: "create", repository: "/repo", branch: "spawned", create: true, deferSession: true },
    ]) expect(mutation(intent)).toMatchObject({ method: "mutation.submit", params: { intent } })
    expect(mutation({ type: "create", repository: "/repo", branch: "b", create: true, title: "bad\ttitle" })).toMatchObject({ params: { intent: { type: "create", branch: "b" } } })
    expect((mutation({ type: "create", repository: "/repo", branch: "b", create: true, title: "bad\ttitle" }) as { params: { intent: object } }).params.intent).not.toHaveProperty("title")
    for (const intent of [
      { type: "label", path: "/repo/feature", key: "Stage", value: "retro" },
      { type: "label", path: "/repo/feature", key: "stage", value: "two words" },
      { type: "label", path: "/repo/feature", key: "stage" },
      { type: "label", key: "stage", value: "retro" },
      { type: "done" },
      { type: "workshop.stop" },
    ]) expect(mutation(intent)).toMatchObject({ ok: false, error: { code: "bad_request" } })
  })

  test("requires destructive stop confirmation and a known recovery action", () => {
    expect(mutation({ type: "stop", clankerId: "clanker-1" })).toMatchObject({ ok: false, error: { code: "bad_request" } })
    expect(mutation({ type: "recovery", clankerId: "clanker-1", action: "guess" })).toMatchObject({ ok: false, error: { code: "bad_request" } })
  })
})

describe("observation protocol", () => {
  test("accepts sequenced pane lifecycle observations", () => {
    const report = { source: "opencode:42", seq: 7, pane: "%4", harness: "opencode", state: "working" as const, updatedAt: 123, harnessSessionId: "session-1", generation: 1, settledGeneration: 0 }
    expect(parseRequest({ version: 1, id: "report", method: "observation.report", params: report })).toEqual({ version: 1, id: "report", method: "observation.report", params: report })
  })

  test("rejects unsequenced or malformed lifecycle observations", () => {
    expect(parseRequest({ version: 1, id: "report", method: "observation.report", params: { pane: "%4", harness: "opencode", state: "working", updatedAt: 1 } })).toMatchObject({ ok: false, error: { code: "bad_request" } })
    expect(parseRequest({ version: 1, id: "report", method: "observation.report", params: { source: "opencode", seq: 1, pane: "%4", harness: "opencode", state: "invented", updatedAt: 1 } })).toMatchObject({ ok: false, error: { code: "bad_request" } })
  })
})

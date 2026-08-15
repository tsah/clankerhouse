import { describe, expect, test } from "bun:test"
import { parseRequest } from "./protocol"

const mutation = (intent: unknown) => parseRequest({ version: 1, id: "request", method: "mutation.submit", params: { idempotencyKey: "key", intent } })

describe("mutation protocol target set", () => {
  test("accepts absorb, reparent, start, stop, and recovery intents", () => {
    const intents = [
      { type: "absorb", target: { type: "tmux_session", session: "repo", management: "unmanaged", location: { kind: "tmux", instanceId: "server", nativeSessionId: "$1", nativeWindowId: null, nativePaneId: null } } },
      { type: "reparent", workshopId: "child", parentWorkshopId: "parent", session: "repo" },
      { type: "start", clankerId: "clanker-1", force: true },
      { type: "stop", clankerId: "clanker-1", confirmed: true, reason: "operator" },
      { type: "recovery", clankerId: "clanker-1", action: "resume", force: true },
    ]
    for (const intent of intents) expect(mutation(intent)).toMatchObject({ method: "mutation.submit", params: { intent } })
  })

  test("preserves an explicit requesting client on open intents", () => {
    const intent = { type: "open", target: { type: "tmux_session", session: "child" }, client: "/dev/pts/9" }
    expect(mutation(intent)).toMatchObject({ method: "mutation.submit", params: { intent } })
    expect(mutation({ ...intent, client: "" })).toMatchObject({ ok: false, error: { code: "bad_request" } })
  })

  test("requires destructive stop confirmation and a known recovery action", () => {
    expect(mutation({ type: "stop", clankerId: "clanker-1" })).toMatchObject({ ok: false, error: { code: "bad_request" } })
    expect(mutation({ type: "recovery", clankerId: "clanker-1", action: "guess" })).toMatchObject({ ok: false, error: { code: "bad_request" } })
  })
})

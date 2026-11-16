import { describe, expect, test } from "bun:test"
import { parseMutationIntent } from "./mutation-intent"

const mutation = (intent: unknown) => parseMutationIntent(intent)

describe("mutation intents", () => {
  test("accepts absorb, reparent, and create intents", () => {
    const intents = [
      { type: "absorb", target: { type: "session", session: "repo", management: "unmanaged", location: { kind: "rex", instanceId: "server", nativeSessionId: "session:1", nativeWindowId: null, nativePaneId: null } } },
      { type: "reparent", workshopId: "child", parentWorkshopId: "parent", session: "repo" },
      { type: "create", repository: "/repo/main", branch: "feature", create: false, remoteRef: "origin/feature" },
    ]
    for (const intent of intents) expect(mutation(intent)).toMatchObject(intent)
  })

  test("open intents carry only the target", () => {
    const intent = { type: "open", target: { type: "session", session: "child" } }
    expect(mutation(intent) as unknown).toEqual(intent)
  })

  test("accepts well-formed label and done intents and rejects malformed labels", () => {
    for (const intent of [
      { type: "label", path: "/repo/feature", key: "stage", value: "retro" },
      { type: "label", path: "/repo/feature", key: "stage", value: null },
      { type: "label", workshopId: "ws-merged", key: "stage", value: "retro" },
      { type: "done", path: "/repo/feature" },
      { type: "workshop.stop", path: "/repo/feature" },
      { type: "label", path: "/repo/feature", key: "title", value: "Migrate the adapter" },
      { type: "create", repository: "/repo", branch: "migrate-the-adapter", create: true, title: "Migrate the adapter" },
      { type: "create", repository: "/repo", branch: "spawned", create: true, deferSession: true },
      { type: "create", repository: "/repo", branch: "child", create: true, deferSession: true, parentWorkshopId: "ws-parent" },
      { type: "create", repository: "/repo", branch: "top-level", create: true, deferSession: true, parentWorkshopId: null },
    ]) expect(mutation(intent)).toMatchObject(intent)
    expect(mutation({ type: "create", repository: "/repo", branch: "b", create: true, title: "bad\ttitle" })).toMatchObject({ type: "create", branch: "b" })
    expect(mutation({ type: "create", repository: "/repo", branch: "b", create: true, title: "bad\ttitle" })).not.toHaveProperty("title")
    expect(mutation({ type: "create", repository: "/repo", branch: "b", create: true })).not.toHaveProperty("parentWorkshopId")
    for (const intent of [
      { type: "label", path: "/repo/feature", key: "Stage", value: "retro" },
      { type: "label", path: "/repo/feature", key: "stage", value: "two words" },
      { type: "label", path: "/repo/feature", key: "stage" },
      { type: "label", key: "stage", value: "retro" },
      { type: "label", path: "/repo/feature", workshopId: "ws-merged", key: "stage", value: "retro" },
      { type: "done" },
      { type: "workshop.stop" },
    ]) expect(mutation(intent)).toBeUndefined()
  })

  test("rejects the retired Recovery intents", () => {
    for (const type of ["start", "stop", "recovery"]) expect(mutation({ type, clankerId: "clanker-1", confirmed: true, action: "resume" })).toBeUndefined()
  })
})

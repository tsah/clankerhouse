import { describe, expect, test } from "bun:test"
import { advanceProjection, parseProjectionSnapshot, shouldApplyProjection } from "./projection"

describe("resource projection snapshots", () => {
  test("accepts legacy cache payloads without revisions", () => {
    expect(parseProjectionSnapshot({
      version: 10,
      generatedAt: 100,
      sessions: [{ name: "legacy" }],
    }, 10)).toEqual({
      version: 10,
      revision: { source: "legacy", sequence: 100 },
      generatedAt: 100,
      sessions: [{ name: "legacy" }],
    })
  })

  test("advances one writer sequence without changing projected resources", () => {
    const first = advanceProjection(undefined, [{ name: "first" }], 10, "writer-a", 100)
    const second = advanceProjection(first, [{ name: "second" }], 10, "writer-a", 200)

    expect(first).toEqual({ version: 10, revision: { source: "writer-a", sequence: 1 }, generatedAt: 100, sessions: [{ name: "first" }] })
    expect(second).toEqual({ version: 10, revision: { source: "writer-a", sequence: 2 }, generatedAt: 200, sessions: [{ name: "second" }] })
  })

  test("starts a new sequence for a replacement writer", () => {
    const previous = advanceProjection(undefined, [], 10, "writer-a", 100)
    expect(advanceProjection(previous, [], 10, "writer-b", 200).revision).toEqual({ source: "writer-b", sequence: 1 })
  })

  test("rejects incompatible or malformed snapshots", () => {
    expect(parseProjectionSnapshot({ version: 9, generatedAt: 100, sessions: [] }, 10)).toBeUndefined()
    expect(parseProjectionSnapshot({ version: 10, revision: { source: "writer", sequence: -1 }, generatedAt: 100, sessions: [] }, 10)).toBeUndefined()
    expect(parseProjectionSnapshot({ version: 10, revision: { source: "", sequence: 1 }, generatedAt: 100, sessions: [] }, 10)).toBeUndefined()
    expect(parseProjectionSnapshot({ version: 10, generatedAt: 100, sessions: {} }, 10)).toBeUndefined()
  })

  test("deduplicates one writer while accepting restarts and legacy writers", () => {
    const current = { source: "writer-a", sequence: 4 }
    expect(shouldApplyProjection(current, { source: "writer-a", sequence: 4 })).toBe(false)
    expect(shouldApplyProjection(current, { source: "writer-a", sequence: 3 })).toBe(false)
    expect(shouldApplyProjection(current, { source: "writer-a", sequence: 5 })).toBe(true)
    expect(shouldApplyProjection(current, { source: "writer-b", sequence: 1 })).toBe(true)
    expect(shouldApplyProjection(current, { source: "legacy", sequence: 300 })).toBe(true)
  })
})

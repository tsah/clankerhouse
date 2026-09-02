import { describe, expect, test } from "bun:test"
import { parseClankerObservation, reconcileClankerObservations, selectCurrentLifecycleObservations, type OwnedClankerIdentity } from "./observations"
import type { ClankerReport } from "./resources"

const identity = (overrides: Partial<OwnedClankerIdentity> = {}): OwnedClankerIdentity => ({
  pane: "%1",
  clankerId: "clanker-current",
  harness: "pi",
  ...overrides,
})
const observation = (overrides: Partial<ClankerReport> = {}): ClankerReport => ({
  pane: "%1",
  clankerId: "clanker-current",
  harness: "pi",
  state: "working",
  updatedAt: 10,
  ...overrides,
})

describe("Clanker observations", () => {
  test("parses current and legacy reports without consulting ambient state", () => {
    expect(parseClankerObservation({ clankerId: "id", agent: "pi", pane: "%1", state: "done", hookEvent: "session_start", updatedAt: "12" })).toEqual({
      clankerId: "id", harness: "pi", pane: "%1", state: "idle", hookEvent: "session_start", updatedAt: 12,
    })
    expect(parseClankerObservation({ clankerId: "", harness: "pi", pane: "%1", state: "working" })).toEqual({ harness: "pi", pane: "%1", state: "working", updatedAt: 0 })
    expect(parseClankerObservation({ clankerId: "id", harness: "pi", pane: "%1", state: "invented" })).toEqual({ clankerId: "id", harness: "pi", pane: "%1", reportedState: "invented", updatedAt: 0 })
    expect(parseClankerObservation({ clankerId: "id", harness: "pi", state: "working" })).toBeUndefined()
  })

  test("selects only the newest current lifecycle observation for each pane", () => {
    const priorSession = observation({ harnessSessionId: "session-old", updatedAt: 10, state: "done" })
    const currentSession = observation({ harnessSessionId: "session-current", updatedAt: 20 })
    const otherPane = observation({ pane: "%2", clankerId: "clanker-other", updatedAt: 15 })

    expect(selectCurrentLifecycleObservations([priorSession, currentSession, otherPane])).toEqual([currentSession, otherPane])
  })

  test("selects the newest exact attestation and separates superseded evidence", () => {
    const older = observation({ updatedAt: 10 })
    const newer = observation({ updatedAt: 20, state: "done" })
    const result = reconcileClankerObservations([identity()], [older, newer])
    expect(result.matchedByPane.get("%1")).toEqual(newer)
    expect(result.superseded).toEqual([older])
    expect(result.unmatchedByPane.size).toBe(0)
  })

  test("requires owned session and recovery correlation when declared", () => {
    const owned = identity({ harnessSessionId: "session-new", recoveryAttemptId: "attempt-new" })
    const priorSession = observation({ harnessSessionId: "session-old", recoveryAttemptId: "attempt-new" })
    const priorAttempt = observation({ harnessSessionId: "session-new", recoveryAttemptId: "attempt-old" })
    const result = reconcileClankerObservations([owned], [priorSession, priorAttempt])
    expect(result.matchedByPane.size).toBe(0)
    expect(result.unmatchedByPane.get("%1")?.map((entry) => entry.reason)).toEqual(["harness-session-mismatch", "recovery-attempt-mismatch"])
  })

  test("preserves rejected current-pane observations without manufacturing identity", () => {
    const stale = observation({ clankerId: "clanker-old", state: "done", updatedAt: 30 })
    const unowned = observation({ pane: "%2", clankerId: "external" })
    const result = reconcileClankerObservations([identity()], [stale, unowned])
    expect(result.unmatchedByPane.get("%1")?.[0]?.reason).toBe("clanker-id-mismatch")
    expect(result.unmatchedByPane.get("%2")?.[0]?.reason).toBe("no-owned-identity")
    expect(stale.state).toBe("done")
  })

  test("preserves pane-addressable evidence with incomplete identity or state", () => {
    const incomplete = [
      parseClankerObservation({ harness: "pi", pane: "%1", state: "working", updatedAt: 20 }),
      parseClankerObservation({ clankerId: "clanker-current", harness: "pi", pane: "%1", state: "invented", updatedAt: 30 }),
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    const result = reconcileClankerObservations([identity()], incomplete)

    expect(result.matchedByPane.size).toBe(0)
    expect(result.unmatchedByPane.get("%1")?.map((entry) => entry.reason)).toEqual(["incomplete-observation", "incomplete-observation"])
  })

  test("accepts identity-free harness state as observed evidence when session-addressable", () => {
    const observed = parseClankerObservation({ harness: "opencode", pane: "%2", state: "working", harnessSessionId: "session-root", updatedAt: 20 })!
    const result = reconcileClankerObservations([], [observed])

    expect(result.observedByPane.get("%2")).toEqual(observed)
    expect(result.unmatchedByPane.get("%2")?.[0]?.reason).toBe("incomplete-observation")
    expect(result.matchedByPane.size).toBe(0)
  })
})

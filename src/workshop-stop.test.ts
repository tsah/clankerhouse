import { describe, expect, test } from "bun:test"
import { workshopStopPlan } from "./workshop-stop"

describe("workshop stop plan", () => {
  const sessions = [
    { id: "w1", workshopId: "workshop-a", paths: ["/repo/a"], clankerIds: ["clanker-live", "clanker-a1"] },
    { id: "w2", paths: ["/repo/a"], clankerIds: [] },
    { id: "w3", workshopId: "workshop-b", paths: ["/repo/b"], clankerIds: ["clanker-b"] },
    { id: "w4", workshopId: "workshop-a", paths: ["/elsewhere"], clankerIds: [] },
  ]
  const clankers = [
    { clankerId: "clanker-a1", workshopId: "workshop-a", workshopPath: "/repo/a", state: "open" as const },
    { clankerId: "clanker-a2", workshopId: "path-123", workshopPath: "/repo/a", state: "open" as const },
    { clankerId: "clanker-a3", workshopId: "workshop-a", workshopPath: "/repo/a", state: "closed" as const },
    { clankerId: "clanker-b", workshopId: "workshop-b", workshopPath: "/repo/b", state: "open" as const },
  ]

  test("closes every session of the Workshop by id or path and closes its open clankers", () => {
    expect(workshopStopPlan({ path: "/repo/a", workshopId: "workshop-a", sessions, clankers })).toEqual({
      sessionIds: ["w1", "w2", "w4"],
      stop: ["clanker-a1", "clanker-a2"],
      clankerIds: ["clanker-a1", "clanker-a2", "clanker-a3", "clanker-live"],
    })
  })

  test("matches by path alone for a directory with no Workshop record", () => {
    expect(workshopStopPlan({ path: "/repo/b", sessions, clankers })).toEqual({ sessionIds: ["w3"], stop: ["clanker-b"], clankerIds: ["clanker-b"] })
  })

  test("is empty, not an error, when the Workshop is already stopped", () => {
    expect(workshopStopPlan({ path: "/repo/c", workshopId: "workshop-c", sessions, clankers })).toEqual({ sessionIds: [], stop: [], clankerIds: [] })
  })
})

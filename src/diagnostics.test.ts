import { describe, expect, test } from "bun:test"
import { diagnoseProjection } from "./diagnostics"
import type { SessionRow, Target } from "./model"

const row = (name: string, target: Target, overrides: Partial<SessionRow> = {}): SessionRow => ({
  name,
  path: target.type === "directory" ? target.path : `/work/${name}`,
  branch: "main",
  flags: "",
  markers: [],
  age: "",
  recency: 1,
  target,
  details: [],
  searchText: name,
  availableActions: ["open"],
  ...overrides,
})

const session = (name: string, overrides: Partial<SessionRow> = {}) => row(name, { type: "tmux_session", session: name }, overrides)

describe("projection diagnostics functional core", () => {
  test("accepts a unique, sorted tree and classifies neutral unknown resources as expected", () => {
    const parent = session("parent", { workshopId: "parent", childWorkshopCount: 1, recency: 2 })
    const child = session("child", { workshopId: "child", parentWorkshopId: "parent", recency: 1 })
    const directory = row("archive", { type: "directory", path: "/work/archive" }, { directorySource: "zoxide", recency: 0 })
    const report = diagnoseProjection([parent, child, directory])

    expect(report.healthy).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.counts).toMatchObject({ resources: 3, tmuxSessions: 2, directories: 1, expectedUnknownResources: 3, renderedSessionRows: 3 })
  })

  test("detects duplicate target and Workshop identities in projection and rendering", () => {
    const rows = [
      session("live", { workshopId: "same" }),
      row("alias", { type: "directory", path: "/work/alias" }, { workshopId: "same" }),
      session("child", { workshopId: "child", parentWorkshopId: "same" }),
      session("live", { workshopId: "other" }),
    ]
    const report = diagnoseProjection(rows)

    expect(report.healthy).toBe(false)
    expect(report.issues.map((entry) => entry.code)).toContain("duplicate-target")
    expect(report.issues.map((entry) => entry.code)).toContain("ambiguous-workshop")
  })

  test("reports suspicious names, incomplete managed identity, unknown Clankers, and path mismatch", () => {
    const managed = row(" strange\n", { type: "directory", path: "/target" }, {
      path: "/displayed",
      management: "managed",
      details: [{ kind: "clanker", harness: "pi", status: "", detail: "", title: "worker", age: "", state: "unknown", target: { type: "tmux_window", session: "work", windowId: "@1", pane: "%1" }, updatedAt: 0 }],
    })
    const report = diagnoseProjection([managed])
    const codes = report.issues.map((entry) => entry.code)

    expect(codes).toEqual(expect.arrayContaining(["incomplete-managed-identity", "suspicious-name", "directory-path-mismatch", "unknown-clanker-state"]))
    expect(report.counts.unknownClankers).toBe(1)
  })

  test("reports rejected runtime evidence without treating it as an unhealthy managed identity", () => {
    const observed = session("observed", {
      details: [{
        kind: "observation", harness: "pi", status: "reported working", detail: "rejected lifecycle identity: clanker-id-mismatch", title: "stale report", age: "1m", state: "unknown",
        target: { type: "tmux_window", session: "observed", windowId: "@1", pane: "%1" }, updatedAt: 10,
        observation: { source: "lifecycle", confidence: "rejected", state: "working", observedAt: 10, reason: "clanker-id-mismatch" },
      }],
    })
    const report = diagnoseProjection([observed])

    expect(report.healthy).toBe(true)
    expect(report.counts).toMatchObject({ observations: 1, rejectedObservations: 1, unknownClankers: 0 })
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "rejected-runtime-observation", severity: "info" }))
  })

  test("detects lineage cycles and projection sorting drift", () => {
    const first = session("old-idle", { workshopId: "a", parentWorkshopId: "b", recency: 1 })
    const second = session("new-idle", { workshopId: "b", parentWorkshopId: "a", recency: 2 })
    const report = diagnoseProjection([first, second])

    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["lineage-cycle", "projection-sort-drift"]))
    expect(report.healthy).toBe(false)
  })
})

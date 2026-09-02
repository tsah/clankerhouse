import { describe, expect, test } from "bun:test"
import { buildTreeRows, compareProjectedSessions, defaultExpandedLineageSessions, normalizeReportedState, sessionState, stateWithSeen, structuredSearch } from "./model"
import type { DetailRow, SessionRow, Target, TreeRow } from "./model"

const sessionTarget = (session: string): Target => ({ type: "tmux_session", session })
const windowTarget = (session: string, suffix: string): Target => ({ type: "tmux_window", session, windowId: `@${suffix}`, pane: `%${suffix}` })

const detail = (session: string, title: string, suffix: string, state: TreeRow["state"] = "unknown", kind = "window"): DetailRow => ({
  kind: ["pi", "claude", "opencode", "codex"].includes(kind) ? "clanker" : kind,
  harness: ["pi", "claude", "opencode", "codex"].includes(kind) ? kind : undefined,
  status: kind === "window" ? "zsh" : state,
  detail: "",
  title,
  age: "1m",
  state,
  target: windowTarget(session, suffix),
  completionKey: `window:@${suffix}`,
  updatedAt: Number.parseInt(suffix, 10) || 0,
})

const session = (name: string, options: Partial<SessionRow> & { details?: SessionRow["details"] } = {}): SessionRow => ({
  name,
  path: options.path ?? `/tmp/${name}`,
  branch: options.branch ?? name,
  flags: options.flags ?? "clean",
  markers: options.markers ?? [],
  age: options.age ?? "1m",
  recency: options.recency ?? 100,
  target: options.target ?? sessionTarget(name),
  details: options.details ?? [detail(name, `${name}-window`, `${name}-1`)],
  searchText: options.searchText ?? "",
  directorySource: options.directorySource,
  workshopId: options.workshopId,
  parentWorkshopId: options.parentWorkshopId,
  childWorkshopCount: options.childWorkshopCount,
  lineageLabel: options.lineageLabel,
  lineageSearchText: options.lineageSearchText,
  activitySource: options.activitySource,
  frecency: options.frecency,
})

const labeledRows = (rows: TreeRow[]) => rows.map((row) => `${row.depth}:${row.detail ? row.detail.title : row.session.name}`)
const sessionRows = (rows: TreeRow[]) => rows.filter((row) => !row.detail)
const rowFor = (rows: TreeRow[], name: string) => rows.find((row) => !row.detail && row.session.name === name)

describe("clanker state", () => {
  test("treats session-start completion as idle", () => {
    expect(normalizeReportedState("working")).toBe("working")
    expect(normalizeReportedState("blocked")).toBe("blocked")
    expect(normalizeReportedState("done", "session_start")).toBe("idle")
  })

  test("acknowledges only the observed completion generation", () => {
    expect(stateWithSeen("done", 200, 0)).toBe("done")
    expect(stateWithSeen("done", 200, 200)).toBe("idle")
    expect(stateWithSeen("done", 300, 200)).toBe("done")
    expect(stateWithSeen("blocked", 300, 400)).toBe("blocked")
  })

  test("aggregates by actionable state precedence", () => {
    const aggregate = session("aggregate")
    aggregate.details = (["unknown", "idle", "done", "working", "blocked"] as const).map((state, index) => ({ ...detail("aggregate", `detail-${index}`, `agg-${index}`), state }))
    expect(sessionState(aggregate)).toBe("blocked")
    aggregate.details.pop()
    expect(sessionState(aggregate)).toBe("working")
    aggregate.details.pop()
    expect(sessionState(aggregate)).toBe("done")
  })

  test("sorts projection rows only by last seen, regardless of status", () => {
    const rows = [
      session("working", { recency: 10, details: [detail("working", "pi", "01", "working", "pi")] }),
      session("failed", { recency: 20, details: [detail("failed", "terminated", "02", "failed", "incident")] }),
      session("ready", { recency: 30, details: [detail("ready", "pi", "03", "done", "pi")] }),
      session("idle", { recency: 40, details: [detail("idle", "pi", "04", "idle", "pi")] }),
      session("neutral", { recency: 50 }),
    ]

    expect([...rows].sort(compareProjectedSessions).map((row) => row.name)).toEqual(["neutral", "idle", "ready", "failed", "working"])
  })

  test("reports live replacement work instead of a prior reboot loss", () => {
    const rebootLoss = { ...detail("recovered", "lost clanker", "06", "failed", "incident"), status: "lost on reboot" }
    const live = detail("recovered", "pi", "07", "working", "pi")
    const recovered = session("recovered", { details: [rebootLoss, live] })
    expect(sessionState(recovered)).toBe("working")

    const termination = { ...rebootLoss, status: "terminated" }
    expect(sessionState(session("terminated", { details: [termination, live] }))).toBe("failed")
    expect(sessionState(session("still-lost", { details: [rebootLoss] }))).toBe("failed")
  })
})

describe("structured search", () => {
  test("does not span a single term across field boundaries", () => {
    expect(structuredSearch([
      { text: "zsh", weight: 20 },
      { text: "false-positive", weight: 20 },
      { text: "root", weight: 20 },
    ], "z-root")).toBeUndefined()
  })

  test("keeps fuzzy abbreviations useful within a field", () => {
    expect(structuredSearch([{ text: "z-root", weight: 20 }], "zr")?.score).toBeGreaterThan(0)
  })
})

describe("session tree", () => {
  const groupedSessions = [
    session("y-root", { workshopId: "y", lineageSearchText: "y root", recency: 500 }),
    session("b-child", { workshopId: "b", parentWorkshopId: "a", lineageSearchText: "b a", recency: 490 }),
    session("a-root", { workshopId: "a", childWorkshopCount: 2, lineageLabel: "⇣2", lineageSearchText: "a child-count-2", recency: 480 }),
    session("d-grandchild", { workshopId: "d", parentWorkshopId: "c", lineageSearchText: "d c a", recency: 470, details: [detail("d-grandchild", "deep-window", "41", "done")] }),
    session("c-child", { workshopId: "c", parentWorkshopId: "a", childWorkshopCount: 1, lineageLabel: "⇣1", lineageSearchText: "c a", recency: 460 }),
    session("z-root", { workshopId: "z", lineageSearchText: "z root", recency: 450 }),
  ]

  test("renders recursive hierarchy with separate lineage and detail expansion", () => {
    const rows = buildTreeRows(groupedSessions, "", {
      expandedLineageSessions: new Set(groupedSessions.map((row) => row.name)),
      expandedDetailSessions: new Set(groupedSessions.map((row) => row.name)),
    })
    expect(labeledRows(rows)).toEqual([
      "0:y-root",
      "1:y-root-window",
      "0:a-root",
      "1:a-root-window",
      "1:c-child",
      "2:c-child-window",
      "2:d-grandchild",
      "3:deep-window",
      "1:b-child",
      "2:b-child-window",
      "0:z-root",
      "1:z-root-window",
    ])
    expect(sessionRows(rows).map((row) => [row.session.name, row.depth, row.detail])).toEqual([
      ["y-root", 0, undefined],
      ["a-root", 0, undefined],
      ["c-child", 1, undefined],
      ["d-grandchild", 2, undefined],
      ["b-child", 1, undefined],
      ["z-root", 0, undefined],
    ])
    expect(rows.find((row) => !row.detail && row.session.name === "d-grandchild")?.target).toEqual(sessionTarget("d-grandchild"))
    expect(rows.find((row) => row.detail?.title === "deep-window")?.target).toEqual(windowTarget("d-grandchild", "41"))
  })

  test("keeps bottom-up ordering while each lineage subtree stays contiguous", () => {
    const expanded = new Set(groupedSessions.map((row) => row.name))
    const rows = buildTreeRows(groupedSessions, "", { expandedLineageSessions: expanded, expandedDetailSessions: expanded, bottomUp: true })
    expect(labeledRows(rows)).toEqual([
      "1:y-root-window",
      "0:y-root",
      "2:b-child-window",
      "1:b-child",
      "3:deep-window",
      "2:d-grandchild",
      "2:c-child-window",
      "1:c-child",
      "1:a-root-window",
      "0:a-root",
      "1:z-root-window",
      "0:z-root",
    ])
  })

  test("puts the most recently seen subtree nearest the bottom prompt", () => {
    const working = session("working", { recency: 100, details: [detail("working", "pi", "91", "working", "pi")] })
    const ready = session("ready", { recency: 200, details: [detail("ready", "pi", "92", "done", "pi")] })
    const idle = session("idle", { recency: 300, details: [detail("idle", "pi", "93", "idle", "pi")] })

    const rows = sessionRows(buildTreeRows([working, ready, idle], "", { bottomUp: true }))
    expect(rows.map((row) => row.session.name)).toEqual(["idle", "ready", "working"])
    expect([...rows].reverse().map((row) => row.session.name)).toEqual(["working", "ready", "idle"])
  })

  test("puts the current session nearest the prompt without hiding active work", () => {
    const current = session("current", { details: [detail("current", "pi", "97", "done", "pi")] })
    const working = session("working", { details: [detail("working", "pi", "98", "working", "pi")] })
    const failed = session("failed", { details: [detail("failed", "incident", "99", "failed", "incident")] })
    const rows = sessionRows(buildTreeRows([failed, working, current], "", {
      prioritySessionKeys: new Set(["session:current"]),
      bottomUp: true,
    }))

    expect([...rows].reverse().map((row) => row.session.name)).toEqual(["working", "failed", "current"])
  })

  test("puts a nested current session nearest the prompt within its Workshop", () => {
    const root = session("root", { workshopId: "root", details: [detail("root", "shell", "root-pane")] })
    const working = session("working", { workshopId: "working-id", parentWorkshopId: "root", details: [detail("working", "pi", "working-pane", "working", "pi")] })
    const current = session("current", { workshopId: "current-id", parentWorkshopId: "root", details: [detail("current", "pi", "current-pane", "idle", "pi")] })
    const rows = buildTreeRows([root, current, working], "", {
      expandedLineageSessions: new Set(["root"]),
      prioritySessionKeys: new Set(["session:current"]),
      bottomUp: true,
    })

    expect([...rows].reverse().filter((row) => !row.detail).map((row) => row.session.name)).toEqual(["root", "working", "current"])
  })

  test("sorts a lineage subtree by its most recently seen descendant", () => {
    const root = session("root", { workshopId: "root", recency: 10 })
    const child = session("child", { workshopId: "child", parentWorkshopId: "root", recency: 90 })
    const other = session("other", { recency: 50 })

    const rows = sessionRows(buildTreeRows([root, child, other], "", {
      expandedLineageSessions: new Set(["root"]),
      bottomUp: true,
    }))
    expect([...rows].reverse().map((row) => row.session.name)).toEqual(["other", "root", "child"])
  })

  test("does not let unknown Clanker status override last-seen lineage ordering", () => {
    const root = session("root", { workshopId: "root", recency: 100, details: [detail("root", "shell", "root-pane")] })
    const unknown = session("unknown", { workshopId: "unknown", parentWorkshopId: "root", recency: 200, details: [detail("unknown", "opencode", "unknown-pane", "unknown", "clanker")] })
    const neutral = session("neutral", { recency: 150, details: [detail("neutral", "shell", "neutral-pane")] })

    const rows = sessionRows(buildTreeRows([neutral, root, unknown], "", {
      expandedLineageSessions: new Set(["root"]),
      bottomUp: true,
    }))
    expect([...rows].reverse().map((row) => row.session.name)).toEqual(["neutral", "root", "unknown"])
  })

  test("collapsing lineage hides descendants while leaving compact session rows", () => {
    const rows = buildTreeRows(groupedSessions, "", {
      expandedLineageSessions: new Set(["y-root", "z-root"]),
      expandedDetailSessions: new Set(),
    })
    expect(labeledRows(rows)).toEqual([
      "0:y-root",
      "0:a-root",
      "0:z-root",
    ])
    expect(rowFor(rows, "a-root")?.expandable).toBe(true)
    expect(rowFor(rows, "a-root")?.expanded).toBe(false)
    expect(rowFor(rows, "a-root")?.detailsExpandable).toBe(true)
    expect(rowFor(rows, "a-root")?.detailsExpanded).toBe(false)
  })

  test("defaults expand lineages with fewer than ten fully expanded rows, including failures", () => {
    expect(defaultExpandedLineageSessions(groupedSessions)).toEqual(new Set(["a-root", "c-child"]))

    const crowded = [
      session("crowded-root", { workshopId: "crowded", childWorkshopCount: 3, details: [detail("crowded-root", "crowded-window", "51")] }),
      session("child-one", { workshopId: "crowded-1", parentWorkshopId: "crowded" }),
      session("child-two", { workshopId: "crowded-2", parentWorkshopId: "crowded" }),
      session("child-three", { workshopId: "crowded-3", parentWorkshopId: "crowded" }),
    ]
    expect(defaultExpandedLineageSessions(crowded)).toEqual(new Set(["crowded-root"]))

    const activeCrowded = [
      session("active-root", { workshopId: "active-root" }),
      session("active-one", { workshopId: "active-1", parentWorkshopId: "active-root" }),
      session("active-two", { workshopId: "active-2", parentWorkshopId: "active-root" }),
      session("active-three", { workshopId: "active-3", parentWorkshopId: "active-root" }),
      session("active-four", { workshopId: "active-4", parentWorkshopId: "active-root", details: [detail("active-four", "pi", "52", "working", "pi")] }),
    ]
    expect(defaultExpandedLineageSessions(activeCrowded)).toEqual(new Set(["active-root"]))

    const readyCrowded = activeCrowded.map((row) => row.name === "active-four"
      ? session("active-four", { workshopId: "active-4", parentWorkshopId: "active-root", details: [detail("active-four", "pi", "53", "done", "pi")] })
      : row)
    expect(defaultExpandedLineageSessions(readyCrowded)).toEqual(new Set(["active-root"]))

    const failed = [
      session("failed-root", { workshopId: "failed-root", details: [detail("failed-root", "incident", "54", "failed", "incident")] }),
      session("neutral-child", { workshopId: "neutral-child", parentWorkshopId: "failed-root" }),
    ]
    expect(defaultExpandedLineageSessions(failed)).toEqual(new Set(["failed-root"]))

    const lineage = (rowCount: number) => [
      session(`root-${rowCount}`, { workshopId: `root-${rowCount}` }),
      ...Array.from({ length: rowCount - 1 }, (_, index) => session(`child-${rowCount}-${index}`, {
        workshopId: `child-${rowCount}-${index}`,
        parentWorkshopId: `root-${rowCount}`,
      })),
    ]
    expect(defaultExpandedLineageSessions(lineage(9))).toEqual(new Set(["root-9"]))
    expect(defaultExpandedLineageSessions(lineage(10))).toEqual(new Set())
    expect(defaultExpandedLineageSessions([session("leaf")])).toEqual(new Set())
  })

  test("gives process and lifecycle observations on one pane distinct rendered keys", () => {
    const process = {
      ...detail("observed", "pi", "55", "unknown", "observation"),
      observation: { source: "process", confidence: "observed", state: "present", observedAt: 10 } as const,
    }
    const rejected = {
      ...process,
      title: "pi report",
      observation: { source: "lifecycle", confidence: "rejected", state: "working", observedAt: 11, reason: "no-owned-identity" } as const,
    }
    const rows = buildTreeRows([session("observed", { details: [process, rejected] })], "", {
      expandedDetailSessions: new Set(["observed"]),
    })
    const keys = rows.filter((row) => row.detail).map((row) => row.key)
    expect(new Set(keys).size).toBe(2)
    expect(keys).toContain("window:observed:@55:observation:process:observed:")
    expect(keys).toContain("window:observed:@55:observation:lifecycle:rejected:no-owned-identity")
  })

  test("explicit detail expansion is independent from lineage expansion", () => {
    const rows = buildTreeRows(groupedSessions, "", {
      expandedLineageSessions: new Set(["a-root", "c-child"]),
      expandedDetailSessions: new Set(["d-grandchild"]),
    })
    expect(labeledRows(rows)).toEqual([
      "0:y-root",
      "0:a-root",
      "1:c-child",
      "2:d-grandchild",
      "3:deep-window",
      "1:b-child",
      "0:z-root",
    ])
    expect(rowFor(rows, "b-child")?.expandable).toBe(false)
    expect(rowFor(rows, "b-child")?.detailsExpandable).toBe(true)
    expect(rowFor(rows, "d-grandchild")?.detailsExpanded).toBe(true)
  })

  test("retains complete ancestor context for descendant detail matches", () => {
    const rows = buildTreeRows(groupedSessions, "deep")
    expect(labeledRows(rows)).toEqual([
      "0:a-root",
      "1:c-child",
      "2:d-grandchild",
      "3:deep-window",
    ])
    expect(rowFor(rows, "a-root")?.expanded).toBe(true)
    expect(rowFor(rows, "c-child")?.expanded).toBe(true)
    expect(rowFor(rows, "d-grandchild")?.detailsExpanded).toBe(false)
  })

  test("a matching session exposes lineage context without exploding every detail row", () => {
    const rows = buildTreeRows(groupedSessions, "a child-count-2")
    expect(labeledRows(rows)).toEqual([
      "0:a-root",
      "1:c-child",
      "2:d-grandchild",
      "1:b-child",
    ])
    expect(rows[0]?.searchText).toContain("child-count-2")
  })

  test("keeps hyphenated terms inside a single field while preserving fuzzy abbreviations", () => {
    const falsePositive = session("false-positive", {
      branch: "root",
      details: [detail("false-positive", "shell", "71")],
    })
    const rows = buildTreeRows([groupedSessions.at(-1)!, falsePositive], "z-root")
    expect(sessionRows(rows).map((row) => row.session.name)).toEqual(["z-root"])
    expect(sessionRows(buildTreeRows([groupedSessions.at(-1)!, falsePositive], "zr")).map((row) => row.session.name)).toEqual(["z-root"])
  })

  test("non-empty queries keep only directly matching detail rows even after explicit expansion", () => {
    const rows = buildTreeRows([
      session("root", { workshopId: "root", details: [detail("root", "root-main", "81"), detail("root", "root-log", "82")] }),
      session("child", { workshopId: "child", parentWorkshopId: "root", details: [detail("child", "exact-hit", "83"), detail("child", "unrelated-log", "84")] }),
    ], "exact-hit", {
      expandedLineageSessions: new Set(["root"]),
      expandedDetailSessions: new Set(["root", "child"]),
    })
    expect(labeledRows(rows)).toEqual([
      "0:root",
      "1:child",
      "2:exact-hit",
    ])
  })

  test("keeps aggregate state from descendants hidden by filtering", () => {
    const root = session("state-root", { workshopId: "state-root", details: [detail("state-root", "root-idle", "61", "idle")] })
    const visible = session("visible-child", { workshopId: "visible", parentWorkshopId: "state-root", details: [detail("visible-child", "visible-ready", "62", "done")] })
    const hidden = session("hidden-child", { workshopId: "hidden", parentWorkshopId: "state-root", details: [detail("hidden-child", "hidden-blocked", "63", "blocked")] })
    const rows = buildTreeRows([root, visible, hidden], "visible-child")
    expect(rowFor(rows, "state-root")?.state).toBe("blocked")
  })

  test("treats orphaned parents as roots", () => {
    const orphan = session("orphan", { workshopId: "orphan", parentWorkshopId: "missing" })
    const rows = buildTreeRows([orphan, session("plain")], "")
    expect(sessionRows(rows).map((row) => row.session.name)).toEqual(["orphan", "plain"])
    expect(rowFor(rows, "orphan")?.parentSessionKey).toBeUndefined()
  })

  test("breaks stale cycles defensively instead of duplicating rows", () => {
    const a = session("cycle-a", { workshopId: "cycle-a", parentWorkshopId: "cycle-b" })
    const b = session("cycle-b", { workshopId: "cycle-b", parentWorkshopId: "cycle-a" })
    const rows = buildTreeRows([a, b], "")
    expect(sessionRows(rows).map((row) => row.session.name)).toEqual(["cycle-a", "cycle-b"])
    expect(rows.filter((row) => !row.detail)).toHaveLength(2)
  })

  test("preserves ungrouped sessions as compact roots until details are explicitly expanded", () => {
    const flat = [session("flat-one"), session("flat-two")]
    expect(labeledRows(buildTreeRows(flat, ""))).toEqual([
      "0:flat-one",
      "0:flat-two",
    ])
    expect(labeledRows(buildTreeRows(flat, "", { expandedDetailSessions: new Set(["flat-one", "flat-two"]) }))).toEqual([
      "0:flat-one",
      "1:flat-one-window",
      "0:flat-two",
      "1:flat-two-window",
    ])
  })
})

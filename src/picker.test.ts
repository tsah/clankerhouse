import { describe, expect, test } from "bun:test"
import { buildTreeRows } from "./model"
import type { DetailRow, SessionRow, Target, TreeRow } from "./model"
import { bestMatchIndex, pickSelection, refreshSessionsAuthoritatively, selectedItem, treeRowAnchor, visibleSlice } from "./picker"

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
  details: options.details ?? [detail(name, `${name}-window`, "1")],
  searchText: options.searchText ?? "",
  workshopId: options.workshopId,
  parentWorkshopId: options.parentWorkshopId,
  childWorkshopCount: options.childWorkshopCount,
  lineageLabel: options.lineageLabel,
  lineageSearchText: options.lineageSearchText,
  activitySource: options.activitySource,
  frecency: options.frecency,
})

describe("picker helpers", () => {
  const groupedSessions = [
    session("y-root", { workshopId: "y", lineageSearchText: "y root", recency: 500 }),
    session("b-child", { workshopId: "b", parentWorkshopId: "a", lineageSearchText: "b a", recency: 490 }),
    session("a-root", { workshopId: "a", childWorkshopCount: 2, lineageLabel: "⇣2", lineageSearchText: "a child-count-2", recency: 480 }),
    session("d-grandchild", { workshopId: "d", parentWorkshopId: "c", lineageSearchText: "d c a", recency: 470, details: [detail("d-grandchild", "deep-window", "41", "done")] }),
    session("c-child", { workshopId: "c", parentWorkshopId: "a", childWorkshopCount: 1, lineageLabel: "⇣1", lineageSearchText: "c a", recency: 460 }),
    session("z-root", { workshopId: "z", lineageSearchText: "z root", recency: 450 }),
  ]

  test("keeps the highest-quality direct match selected in bottom-up search trees", () => {
    const rows = buildTreeRows(groupedSessions, "child-count-2", { bottomUp: true })
    expect(bestMatchIndex(rows)).toBe(rows.findIndex((row) => row.session.name === "a-root" && !row.detail))
    expect(pickSelection(rows, 0, "child-count-2")).toEqual(rows.find((row) => row.session.name === "a-root" && !row.detail))
  })

  test("moves from an ancestor anchor to a directly matching descendant", () => {
    const sessions = [
      session("search-root", { workshopId: "root" }),
      session("search-child", { workshopId: "child", parentWorkshopId: "root", details: [detail("search-child", "exact-hit", "51")] }),
    ]
    const unfiltered = buildTreeRows(sessions, "", { expandedLineageSessions: new Set(["search-root"]), bottomUp: true })
    const root = unfiltered.find((row) => !row.detail && row.session.name === "search-root")
    const filtered = buildTreeRows(sessions, "exact-hit", { bottomUp: true })
    expect(pickSelection(filtered, 0, "exact-hit", treeRowAnchor(root))?.detail?.title).toBe("exact-hit")
  })

  test("enter helpers keep the picker open when nothing is selected", () => {
    expect(selectedItem([], 0)).toBeUndefined()
    expect(pickSelection([], 0, "no matches")).toBeUndefined()
  })

  test("cache refresh is authoritative while selection restores by stable tree identity", () => {
    const currentRows = buildTreeRows(groupedSessions, "", { bottomUp: true })
    const selected = currentRows.find((row) => row.session.name === "c-child" && !row.detail)
    const refreshed = [groupedSessions[5]!, groupedSessions[4]!, groupedSessions[2]!, groupedSessions[3]!]
    const nextSessions = refreshSessionsAuthoritatively(groupedSessions, refreshed)
    expect(nextSessions).toEqual(refreshed)

    const nextRows = buildTreeRows(nextSessions, "", {
      expandedLineageSessions: new Set(["a-root", "c-child"]),
      bottomUp: true,
    })
    const restored = pickSelection(nextRows, 0, "", treeRowAnchor(selected))
    expect(restored?.session.name).toBe("c-child")
  })

  test("slices bottom-up rows at the bottom, middle, and top without jumps", () => {
    const rows = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
    expect(visibleSlice(rows, 0, 4)).toEqual(["3", "2", "1", "0"])
    expect(visibleSlice(rows, 5, 4)).toEqual(["7", "6", "5", "4"])
    expect(visibleSlice(rows, 9, 4)).toEqual(["9", "8", "7", "6"])
  })
})

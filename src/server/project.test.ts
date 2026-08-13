import { describe, expect, test } from "bun:test"
import type { ResourceIncident } from "../incidents"
import type { LineageSnapshot, WorkshopRecord } from "../workshop"
import { projectResources, type ProjectInputs } from "./project"
import type { TmuxSession, TmuxWindow } from "./resources"

const observedAt = 3_700_000
const tmuxServerKey = "tmux:/tmp/test.sock"
const emptyLineage = (): LineageSnapshot => ({ byPath: new Map(), byId: new Map() })
const tmuxSession = (overrides: Partial<TmuxSession> = {}): TmuxSession => ({
  name: "repo@work",
  recency: 3_600,
  path: "/tmp/work",
  attached: false,
  worktreePath: "/tmp/work",
  directoryPath: "",
  ...overrides,
})
const tmuxWindow = (overrides: Partial<TmuxWindow> = {}): TmuxWindow => ({
  session: "repo@work",
  id: "@1",
  index: "0",
  name: "main",
  pane: "%1",
  pid: "101",
  command: "zsh",
  title: "shell",
  activity: 3_600,
  active: false,
  ...overrides,
})
const inputs = (overrides: Partial<ProjectInputs> = {}): ProjectInputs => ({
  sessions: [],
  windows: [],
  opencodes: [],
  directories: [],
  clankerReports: [],
  seen: new Map(),
  lineage: emptyLineage(),
  incidents: [],
  gitMetaByPath: new Map(),
  detectedHarnessByPane: new Map(),
  codexPanes: new Set(),
  observedAt,
  tmuxServerKey,
  home: "/home/test",
  ...overrides,
})

const workshop = (overrides: Partial<WorkshopRecord & { childWorkshopCount: number }> = {}): WorkshopRecord & { childWorkshopCount: number } => ({
  version: 1,
  workshopId: "workshop-child",
  repoId: "repo-1",
  canonicalPath: "/tmp/child",
  commonDir: "/tmp/repo/.git",
  branch: "child",
  parentWorkshopId: "workshop-parent",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  childWorkshopCount: 2,
  ...overrides,
})

const incident = (): ResourceIncident => ({
  version: 1,
  id: "pressure-1",
  kind: "resource_pressure_termination",
  occurredAt: 100_000,
  status: "open",
  clanker: { clankerId: "clanker-dead", harness: "pi", sessionName: "lost", worktreePath: "/tmp/lost" },
})

describe("session resource projection", () => {
  test("projects prepared git, window, and age data without consulting wall-clock time", () => {
    const prepared = inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow()],
      gitMetaByPath: new Map([["/tmp/work", { branch: "feature", flags: "dirty" }]]),
    })

    const originalNow = Date.now
    Date.now = () => 999_999_999
    try {
      const first = projectResources(prepared)
      Date.now = () => 1
      const second = projectResources(prepared)
      expect(second).toEqual(first)
      expect(first.sessions[0]).toMatchObject({ name: "repo@work", branch: "feature", flags: "dirty", age: "1m" })
      expect(first.sessions[0]?.details[0]).toMatchObject({ kind: "window", title: "main", age: "1m", target: { type: "tmux_window", windowId: "@1" } })
      expect(first.effects).toEqual([])
    } finally {
      Date.now = originalNow
    }
  })

  test("returns focused completion and activity writes as explicit effects", () => {
    const seen = new Map<string, number>()
    const result = projectResources(inputs({
      sessions: [tmuxSession({ attached: true })],
      windows: [tmuxWindow({ command: "pi", name: "pi", title: "π working", active: true })],
      clankerReports: [{ harness: "pi", pane: "%1", state: "done", updatedAt: 3_650_000 }],
      seen,
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "pi", state: "idle", completionKey: `${tmuxServerKey}:pane:%1` })
    expect(result.effects).toEqual([
      { type: "markDirectoryActivity", path: "/tmp/work", source: "active", updatedAt: observedAt, minIntervalMs: 60_000 },
      { type: "markDirectoryActivity", path: "/tmp/work", source: "clanker", updatedAt: 3_650_000, minIntervalMs: 0 },
      { type: "markSeen", key: `${tmuxServerKey}:pane:%1`, seenAt: observedAt },
    ])
    expect(seen.size).toBe(0)
  })

  test("associates OpenCode panes, suppresses duplicate window details, and preserves ready state", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow()],
      opencodes: [{ directory: "/tmp/work", status: "completed", detail: "", title: "reviewer", age: "5s", session: "repo@work", pane: "repo@work:0.0", updatedAt: 3_690_000, stablePane: "%1" }],
    }))

    expect(result.sessions[0]?.markers).toEqual(["oc"])
    expect(result.sessions[0]?.details).toHaveLength(1)
    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "opencode", title: "reviewer", state: "done", target: { type: "opencode", pane: "%1" } })
    expect(result.effects).toEqual([{ type: "markDirectoryActivity", path: "/tmp/work", source: "clanker", updatedAt: 3_690_000, minIntervalMs: 0 }])
  })

  test("uses prepared process detections for wrapped harness classification", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ title: "✓ complete" })],
      detectedHarnessByPane: new Map([["%1", "codex"]]),
    }))
    expect(result.sessions[0]?.markers).toEqual(["codex"])
    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "codex", state: "done" })
  })

  test("projects lineage and sessionless directories while removing occupied paths", () => {
    const record = workshop()
    const lineage: LineageSnapshot = { byPath: new Map([[record.canonicalPath, record]]), byId: new Map([[record.workshopId, record]]) }
    const result = projectResources(inputs({
      directories: [
        { path: "/tmp/child", source: "worktree", branch: "child", activityAt: 3_640_000, activitySource: "edited" },
        { path: "/tmp/child", source: "zoxide", branch: "", frecency: 10 },
      ],
      lineage,
    }))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ name: "/tmp/child", age: "1m", workshopId: "workshop-child", parentWorkshopId: "workshop-parent", childWorkshopCount: 2, lineageLabel: "↖ ⇣2" })
  })

  test("applies and sorts incidents using the prepared observation time", () => {
    const result = projectResources(inputs({ incidents: [incident()] }))
    expect(result.sessions[0]).toMatchObject({ name: "lost", age: "1h", recency: 100 })
    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "incident", age: "1h", state: "failed" })
  })
})

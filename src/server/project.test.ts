import { describe, expect, test } from "bun:test"
import type { ResourceIncident } from "../incidents"
import type { LineageSnapshot, WorkshopRecord } from "../workshop"
import { sessionState } from "../model"
import { projectResources, type ProjectInputs } from "./project"
import type { TmuxSession, TmuxWindow } from "./resources"

const observedAt = 3_700_000
const tmuxServerKey = "tmux:/tmp/test.sock"
const emptyLineage = (): LineageSnapshot => ({ byPath: new Map(), byId: new Map() })
const tmuxSession = (overrides: Partial<TmuxSession> = {}): TmuxSession => ({
  id: "$1",
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
  sessionId: "$1",
  id: "@1",
  index: "0",
  name: "main",
  pane: "%1",
  pid: "101",
  currentPath: "/tmp/work",
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
  managedResources: new Map(),
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
  test("projects workshop labels as searchable tags on live and sessionless rows", () => {
    const workshop = (workshopId: string, canonicalPath: string, labels?: Record<string, string>) => ({ version: 1 as const, workshopId, repoId: "repo", canonicalPath, commonDir: "/tmp/repo/.git", branch: workshopId, parentWorkshopId: null, revision: 1, createdAt: 1, updatedAt: 1, childWorkshopCount: 0, labels })
    const live = workshop("live", "/tmp/work", { stage: "retro", owner: "tsah", title: "Rework the parser" })
    const idle = workshop("idle", "/tmp/idle", { stage: "merged" })
    const lineage: LineageSnapshot = { byPath: new Map([[live.canonicalPath, live], [idle.canonicalPath, idle]]), byId: new Map([[live.workshopId, live], [idle.workshopId, idle]]) }

    const projected = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow()],
      directories: [{ path: "/tmp/idle", branch: "idle", source: "worktree" }],
      lineage,
    })).sessions
    const liveRow = projected.find((row) => row.path === "/tmp/work")
    const idleRow = projected.find((row) => row.path === "/tmp/idle")
    expect(liveRow?.labels).toEqual(["tsah", "retro"])
    expect(liveRow?.searchText).toContain("retro")
    expect(liveRow?.title).toBe("Rework the parser")
    expect(liveRow?.project).toBe("repo")
    expect(idleRow?.project).toBe("repo")
    expect(liveRow?.searchText).toContain("rework the parser")
    expect(idleRow?.title).toBeUndefined()
    // A sessionless Workshop can still be titled.
    expect(idleRow?.availableActions).toContain("rename")
    expect(idleRow?.labels).toEqual(["merged"])
    expect(idleRow?.searchText).toContain("merged")
    expect(projectResources(inputs({ sessions: [tmuxSession()], windows: [tmuxWindow()] })).sessions[0]?.labels).toEqual([])
  })

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
      windows: [tmuxWindow({ command: "pi", name: "pi", title: "π working", active: true, clankerId: "clanker-1", explicitHarness: "pi" })],
      clankerReports: [{ clankerId: "clanker-1", harness: "pi", pane: "%1", state: "done", updatedAt: 3_650_000 }],
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

  test("projects a bound active OpenCode root session as working", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-stale", harnessSessionId: "session-stale" })],
      opencodes: [{ directory: "/tmp/work", status: "generating", detail: "session running", title: "active task", age: "1s", session: "repo@work", pane: "repo@work:0.0", updatedAt: 3_699_000, stablePane: "%1", harnessSessionId: "session-root" }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "opencode", state: "working", title: "active task" })
    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
  })

  test("retains OpenCode ownership when the projected root matches pane metadata", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", harnessSessionId: "session-root" })],
      opencodes: [{ directory: "/tmp/work", status: "generating", detail: "session running", title: "active task", age: "1s", session: "repo@work", pane: "repo@work:0.0", updatedAt: 3_699_000, stablePane: "%1", harnessSessionId: "session-root" }],
    }))

    expect(result.sessions[0]?.details[0]?.clankerId).toBe("clanker-current")
  })

  test("uses the exact active OpenCode session when a legacy process has no lifecycle report", () => {
    const active = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", explicitHarness: "opencode", harnessSessionId: "session-root" })],
      activeOpenCodeSessions: new Set(["session-root"]),
    }))
    expect(active.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "opencode", state: "working", clankerId: "clanker-current" })

    const reported = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", explicitHarness: "opencode", harnessSessionId: "session-root" })],
      activeOpenCodeSessions: new Set(["session-root"]),
      clankerReports: [{ clankerId: "clanker-current", harness: "opencode", pane: "%1", state: "done", updatedAt: 3_650_000, harnessSessionId: "session-root" }],
    }))
    expect(reported.sessions[0]?.details[0]).toMatchObject({ state: "done" })
  })

  test("does not infer OpenCode ownership when both session IDs are absent", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-unverified" })],
      opencodes: [{ directory: "/tmp/work", status: "done", detail: "awaiting next task", title: "task", age: "1s", session: "repo@work", pane: "repo@work:0.0", updatedAt: 3_699_000, stablePane: "%1" }],
    }))

    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
  })

  test("reports process resemblance without creating Clanker identity", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ title: "✓ complete" })],
      detectedHarnessByPane: new Map([["%1", "codex"]]),
    }))
    expect(result.sessions[0]?.markers).toEqual(["codex"])
    expect(result.sessions[0]?.details[0]).toMatchObject({
      kind: "observation",
      harness: "codex",
      status: "process observed",
      state: "unknown",
      observation: { source: "process", confidence: "observed", state: "present", observedAt },
    })
    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
  })

  test("projects Herdr agent status as observed working state without creating Clanker identity", () => {
    const result = projectResources(inputs({
      multiplexerKind: "herdr",
      tmuxServerKey: "herdr:/tmp/test.sock",
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ agentStatus: { agent: "pi", status: "working" } })],
    }))

    expect(result.sessions[0]?.markers).toEqual(["pi"])
    expect(result.sessions[0]?.details).toHaveLength(1)
    expect(result.sessions[0]?.details[0]).toMatchObject({
      kind: "observation",
      harness: "pi",
      state: "working",
      observation: { source: "runtime", confidence: "observed", state: "working", observedAt },
      target: { location: { kind: "herdr" } },
    })
    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
  })

  test("keeps Herdr working state visible alongside a rejected identity claim", () => {
    const result = projectResources(inputs({
      multiplexerKind: "herdr",
      tmuxServerKey: "herdr:/tmp/test.sock",
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ agentStatus: { agent: "pi", status: "working" } })],
      clankerReports: [{ pane: "%1", clankerId: "unowned-clanker", harness: "pi", state: "working", updatedAt: 3_690_000 }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "observation", state: "working", observation: { source: "runtime" } })
    expect(result.sessions[0]?.details[1]).toMatchObject({ kind: "observation", state: "unknown", observation: { confidence: "rejected", reason: "no-owned-identity" } })
    expect(sessionState(result.sessions[0]!)).toBe("working")
  })

  test("projects matching identity-free OpenCode lifecycle as observed working state", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ command: "opencode2", harnessSessionId: "session-root" })],
      detectedHarnessByPane: new Map([["%1", "opencode"]]),
      clankerReports: [{ pane: "%1", harness: "opencode", harnessSessionId: "session-root", state: "working", updatedAt: 3_690_000 }],
    }))

    expect(result.sessions[0]?.details).toHaveLength(1)
    expect(result.sessions[0]?.details[0]).toMatchObject({
      kind: "observation",
      harness: "opencode",
      status: "reported working",
      state: "working",
      observation: { source: "lifecycle", confidence: "observed", state: "working", observedAt: 3_690_000 },
    })
    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
  })

  test("rejects a service-global OpenCode report without exact selected-session evidence", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ command: "opencode2" })],
      detectedHarnessByPane: new Map([["%1", "opencode"]]),
      clankerReports: [{ pane: "%1", harness: "opencode", harnessSessionId: "session-from-another-pane", state: "blocked", updatedAt: 3_690_000 }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "observation", state: "unknown", observation: { source: "process" } })
    expect(result.sessions[0]?.details[1]).toMatchObject({ state: "unknown", observation: { confidence: "rejected", reason: "incomplete-observation" } })
  })

  test("does not create Clanker identity from a stale report on a reused pane", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-old" })],
      clankerReports: [{ clankerId: "clanker-old", harness: "pi", pane: "%1", state: "unknown", updatedAt: 3_650_000, hookEvent: "session_shutdown" }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "window", state: "unknown" })
    expect(result.sessions[0]?.details[0]?.clankerId).toBeUndefined()
    expect(result.sessions[0]?.details[1]).toMatchObject({
      kind: "observation",
      harness: "pi",
      state: "unknown",
      observation: { source: "lifecycle", confidence: "rejected", reason: "no-owned-identity", state: "unknown" },
    })
  })

  test("uses the exact current Clanker report even when a stale pane report is newer", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", explicitHarness: "pi" })],
      clankerReports: [
        { clankerId: "clanker-old", harness: "pi", pane: "%1", state: "unknown", updatedAt: 3_650_000 },
        { clankerId: "clanker-current", harness: "pi", pane: "%1", state: "working", updatedAt: 3_640_000 },
      ],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", harness: "pi", state: "working", clankerId: "clanker-current" })
    expect(result.sessions[0]?.details[0]?.observation).toMatchObject({ source: "lifecycle", confidence: "attested", state: "working" })
    expect(result.sessions[0]?.details[1]).toMatchObject({ kind: "observation", state: "unknown", observation: { confidence: "rejected", reason: "clanker-id-mismatch", state: "unknown" } })
  })

  test("does not apply a prior harness session report to a replacement", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", explicitHarness: "pi", harnessSessionId: "session-new" })],
      clankerReports: [{ clankerId: "clanker-current", harness: "pi", pane: "%1", state: "done", updatedAt: 3_650_000, harnessSessionId: "session-old" }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", state: "unknown", clankerId: "clanker-current" })
    expect(result.sessions[0]?.details[1]?.observation).toMatchObject({ confidence: "rejected", reason: "harness-session-mismatch", state: "done" })
  })

  test("does not apply a prior recovery attempt report to a replacement", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow({ clankerId: "clanker-current", explicitHarness: "opencode", harnessSessionId: "session-root", recoveryAttemptId: "attempt-new" })],
      clankerReports: [{ clankerId: "clanker-current", harness: "opencode", pane: "%1", state: "done", updatedAt: 3_650_000, harnessSessionId: "session-root", recoveryAttemptId: "attempt-old" }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "clanker", state: "unknown", clankerId: "clanker-current" })
    expect(result.sessions[0]?.details[1]?.observation).toMatchObject({ confidence: "rejected", reason: "recovery-attempt-mismatch", state: "done" })
  })

  test("projects incomplete lifecycle evidence as rejected instead of suppressing it", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      windows: [tmuxWindow()],
      clankerReports: [{ pane: "%1", harness: "pi", state: "working", updatedAt: 3_690_000 }],
    }))

    expect(result.sessions[0]?.details[0]).toMatchObject({ kind: "window", state: "unknown" })
    expect(result.sessions[0]?.details[1]).toMatchObject({
      kind: "observation",
      harness: "pi",
      state: "unknown",
      observation: { source: "lifecycle", confidence: "rejected", state: "working", reason: "incomplete-observation" },
    })
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

  test("does not project a durable Workshop without current directory evidence", () => {
    const parent = workshop({ workshopId: "workshop-parent", canonicalPath: "/tmp/parent", branch: "main", parentWorkshopId: null, childWorkshopCount: 1 })
    const child = workshop({ childWorkshopCount: 0 })
    const lineage: LineageSnapshot = {
      byPath: new Map([[parent.canonicalPath, parent], [child.canonicalPath, child]]),
      byId: new Map([[parent.workshopId, parent], [child.workshopId, child]]),
    }
    const result = projectResources(inputs({
      directories: [{ path: child.canonicalPath, source: "worktree", branch: child.branch }],
      lineage,
    }))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions.filter((row) => row.workshopId === parent.workshopId)).toHaveLength(0)
    expect(result.sessions.find((row) => row.workshopId === child.workshopId)?.parentWorkshopId).toBe(parent.workshopId)
  })

  test("projects authoritative attachment candidate IDs without a client repository cache", () => {
    const parent = workshop({ workshopId: "parent", canonicalPath: "/tmp/parent", parentWorkshopId: null })
    const source = workshop({ workshopId: "source", canonicalPath: "/tmp/source", parentWorkshopId: parent.workshopId })
    const child = workshop({ workshopId: "child", canonicalPath: "/tmp/child", parentWorkshopId: source.workshopId })
    const candidate = workshop({ workshopId: "candidate", canonicalPath: "/tmp/candidate", parentWorkshopId: null })
    const outsider = workshop({ workshopId: "outsider", repoId: "repo-2", commonDir: "/tmp/other/.git", canonicalPath: "/tmp/outsider", parentWorkshopId: null })
    const records = [parent, source, child, candidate, outsider]
    const lineage: LineageSnapshot = {
      byPath: new Map(records.map((record) => [record.canonicalPath, record])),
      byId: new Map(records.map((record) => [record.workshopId, record])),
    }
    const result = projectResources(inputs({
      directories: records.map((record) => ({ path: record.canonicalPath, source: "worktree" as const, branch: record.branch })),
      lineage,
    }))

    expect(result.sessions.find((row) => row.workshopId === source.workshopId)).toMatchObject({
      target: { type: "directory" },
      availableActions: expect.arrayContaining(["attach", "detach"]),
      attachmentCandidateWorkshopIds: [candidate.workshopId],
    })
  })

  test("projects only the preferred Workshop identity for a compatibility path", () => {
    const superseded = workshop({ workshopId: "workshop-old", canonicalPath: "/tmp/shared", parentWorkshopId: null })
    const preferred = workshop({ workshopId: "workshop-current", canonicalPath: "/tmp/shared", parentWorkshopId: null })
    const lineage: LineageSnapshot = {
      byPath: new Map([[preferred.canonicalPath, preferred]]),
      byId: new Map([[superseded.workshopId, superseded], [preferred.workshopId, preferred]]),
    }
    const result = projectResources(inputs({
      directories: [{ path: preferred.canonicalPath, source: "worktree", branch: preferred.branch }],
      lineage,
    }))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ path: "/tmp/shared", workshopId: "workshop-current" })
  })

  test("canonicalizes a superseded parent reference to the preferred identity", () => {
    const superseded = workshop({ workshopId: "workshop-old", canonicalPath: "/tmp/shared", parentWorkshopId: null, childWorkshopCount: 1 })
    const preferred = workshop({ workshopId: "workshop-current", canonicalPath: "/tmp/shared", parentWorkshopId: null, childWorkshopCount: 0 })
    const child = workshop({ workshopId: "workshop-child", canonicalPath: "/tmp/child", parentWorkshopId: superseded.workshopId, childWorkshopCount: 0 })
    const lineage: LineageSnapshot = {
      byPath: new Map([[preferred.canonicalPath, preferred], [child.canonicalPath, child]]),
      byId: new Map([[superseded.workshopId, superseded], [preferred.workshopId, preferred], [child.workshopId, child]]),
    }
    const result = projectResources(inputs({
      directories: [
        { path: preferred.canonicalPath, source: "worktree", branch: preferred.branch },
        { path: child.canonicalPath, source: "worktree", branch: child.branch },
      ],
      lineage,
    }))

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.find((row) => row.workshopId === child.workshopId)?.parentWorkshopId).toBe(preferred.workshopId)
    expect(result.sessions.find((row) => row.workshopId === preferred.workshopId)?.childWorkshopCount).toBe(1)
  })

  test("marks a live tmux session as a worktree deletion target from current Git evidence", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession()],
      directories: [{ path: "/tmp/work", source: "worktree", branch: "feature" }],
      gitMetaByPath: new Map([["/tmp/work", { branch: "feature", flags: "" }]]),
    }))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      path: "/tmp/work",
      directorySource: "worktree",
      target: { type: "tmux_session", session: "repo@work" },
    })
  })

  test("uses a managed Workshop's canonical path and does not duplicate it as a directory", () => {
    const record = workshop({ workshopId: "workshop-1", canonicalPath: "/tmp/canonical", parentWorkshopId: null })
    const lineage: LineageSnapshot = { byPath: new Map([[record.canonicalPath, record]]), byId: new Map([[record.workshopId, record]]) }
    const managed = { id: "mux-session-1", kind: "session" as const, workshopId: record.workshopId, parentId: null, displayName: "managed", createdAt: 1, updatedAt: 1, location: { kind: "tmux" as const, instanceId: tmuxServerKey, nativeSessionId: "$1", nativeWindowId: null, nativePaneId: null, observedAt: 1 } }
    const result = projectResources(inputs({
      sessions: [tmuxSession({ path: "/tmp/stale-legacy-path", workshopId: record.workshopId, resourceId: managed.id })],
      windows: [tmuxWindow()],
      directories: [{ path: record.canonicalPath, source: "worktree", branch: "canonical" }],
      lineage,
      managedResources: new Map([[managed.id, managed]]),
      gitMetaByPath: new Map([[record.canonicalPath, { branch: "canonical", flags: "" }]]),
    }))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ name: "managed", path: record.canonicalPath, branch: "canonical", workshopId: record.workshopId, target: { type: "tmux_session" } })
  })

  test("applies and sorts incidents using the prepared observation time", () => {
    const result = projectResources(inputs({
      directories: [{ path: "/tmp/lost", source: "worktree", branch: "" }],
      incidents: [incident()],
    }))
    expect(result.sessions[0]).toMatchObject({ name: "/tmp/lost", recency: 100 })
    expect(result.sessions[0]?.details.find((detail) => detail.kind === "incident")).toMatchObject({ age: "1h", state: "failed" })
  })

  test("separates owned display names from scoped tmux identity", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession({ resourceId: "mux-session-1", displayName: "Owned workshop" })],
      windows: [tmuxWindow({ terminalId: "terminal-1", terminalDisplayName: "Owned terminal" })],
      managedResources: new Map([
        ["mux-session-1", { id: "mux-session-1", kind: "session", workshopId: "workshop-1", parentId: null, displayName: "Owned workshop", createdAt: 1, updatedAt: 1, location: { kind: "tmux", instanceId: tmuxServerKey, nativeSessionId: "$1", nativeWindowId: null, nativePaneId: null, observedAt: 1 } }],
        ["terminal-1", { id: "terminal-1", kind: "terminal", workshopId: "workshop-1", parentId: "window-1", displayName: "Owned terminal", createdAt: 1, updatedAt: 1, location: { kind: "tmux", instanceId: tmuxServerKey, nativeSessionId: "$1", nativeWindowId: "@1", nativePaneId: "%1", observedAt: 1 } }],
      ]),
    }))

    expect(result.sessions[0]).toMatchObject({
      name: "Owned workshop",
      resourceId: "mux-session-1",
      management: "managed",
      target: {
        session: "repo@work",
        resourceId: "mux-session-1",
        location: { instanceId: tmuxServerKey, nativeSessionId: "$1" },
      },
    })
    expect(result.sessions[0]?.details[0]).toMatchObject({
      title: "Owned terminal",
      terminalId: "terminal-1",
      target: { resourceId: "terminal-1", location: { nativeWindowId: "@1", nativePaneId: "%1" } },
    })
  })

  test("treats unregistered identity claims as unmanaged and joins panes by session id", () => {
    const result = projectResources(inputs({
      sessions: [tmuxSession({ resourceId: "spoofed", displayName: "Ignored" })],
      windows: [tmuxWindow({ session: "stale-name", terminalId: "spoofed-terminal" })],
    }))

    expect(result.sessions[0]).toMatchObject({ name: "repo@work", management: "unmanaged" })
    expect(result.sessions[0]?.details).toHaveLength(1)
    expect(result.sessions[0]?.details[0]?.target).toMatchObject({ management: "unmanaged", session: "stale-name" })
  })
})

import { describe, expect, test } from "bun:test"
import type { ForegroundAgentDiscovery } from "./process-discovery"
import { openCodeSessionIdFromArgv, projectOpenCodeService } from "./opencode"
import type { TmuxWindow } from "./resources"

const window = (overrides: Partial<TmuxWindow> = {}): TmuxWindow => ({
  session: "repo@work",
  sessionId: "$1",
  id: "@1",
  index: "0",
  name: "main",
  pane: "%1",
  pid: "10",
  currentPath: "/tmp/work",
  command: "opencode2",
  title: "OC | Current task...",
  activity: 1,
  active: false,
  ...overrides,
})

const discovery = (argv: string[]): ForegroundAgentDiscovery => ({
  harness: "opencode",
  paneChildPid: 10,
  foregroundProcessGroupId: 11,
  matchedProcess: { pid: 11, ppid: 10, processGroupId: 11, terminalForegroundProcessGroupId: 11, name: "opencode2", argv },
  match: { kind: "executable", value: "opencode2" },
  processes: [],
  source: "linux-proc",
})

describe("OpenCode service projection", () => {
  test.each([
    [["opencode2", "-s", "ses_short"], "ses_short"],
    [["opencode2", "--session", "ses_long"], "ses_long"],
    [["opencode2", "--session=ses_equals"], "ses_equals"],
    [["opencode2"], undefined],
  ] as const)("extracts a selected session from %j", (argv, expected) => {
    expect(openCodeSessionIdFromArgv(argv)).toBe(expected)
  })

  test("projects an explicitly selected active session without relying on pane-local lifecycle reports", () => {
    const rows = projectOpenCodeService(
      [window()],
      new Map([["%1", discovery(["opencode2", "-s", "ses_active"])]]),
      { sessions: [], active: new Set(["ses_active"]), questions: new Set(), permissions: new Set() },
    )
    expect(rows).toEqual([expect.objectContaining({ stablePane: "%1", harnessSessionId: "ses_active", status: "generating", detail: "session running" })])
  })

  test("uniquely correlates an unpinned pane by current directory and OpenCode title", () => {
    const rows = projectOpenCodeService(
      [window()],
      new Map([["%1", discovery(["opencode2"])]]),
      {
        sessions: [
          { id: "ses_root", title: "Current task with details", location: { directory: "/tmp/work" }, time: { updated: 42 } },
          { id: "ses_child", parentID: "ses_root", title: "Current task child", location: { directory: "/tmp/work" } },
        ],
        active: new Set(),
        questions: new Set(),
        permissions: new Set(),
      },
    )
    expect(rows).toEqual([expect.objectContaining({ harnessSessionId: "ses_root", status: "idle", updatedAt: 42 })])
  })

  test("retains exact correlation when Linux marks a removed pane directory as deleted", () => {
    const rows = projectOpenCodeService(
      [window({ currentPath: "/tmp/work (deleted)" })],
      new Map([["%1", discovery(["opencode2"])]]),
      { sessions: [{ id: "ses_root", title: "Current task with details", location: { directory: "/tmp/work" } }], active: new Set(), questions: new Set(), permissions: new Set() },
    )
    expect(rows[0]?.harnessSessionId).toBe("ses_root")
  })

  test("fails closed when a pane title does not identify exactly one root session", () => {
    const sessions = ["one", "two"].map((id) => ({ id, title: `Current task ${id}`, location: { directory: "/tmp/work" } }))
    expect(projectOpenCodeService(
      [window()],
      new Map([["%1", discovery(["opencode2"])]]),
      { sessions, active: new Set(), questions: new Set(), permissions: new Set() },
    )).toEqual([])
  })

  test("projects pending permission as blocked service evidence", () => {
    const rows = projectOpenCodeService(
      [window()],
      new Map([["%1", discovery(["opencode2", "--session=ses_blocked"])]]),
      { sessions: [], active: new Set(["ses_blocked"]), questions: new Set(), permissions: new Set(["ses_blocked"]) },
    )
    expect(rows[0]).toMatchObject({ status: "waiting permission", detail: "permission" })
  })
})

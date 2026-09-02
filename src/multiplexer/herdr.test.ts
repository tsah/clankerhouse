import { describe, expect, test } from "bun:test"
import { HerdrAdapter, herdrSocketPath } from "./herdr"
import { paneLocation, sessionLocation, windowLocation } from "./interface"

interface Call { method: string; params: Record<string, unknown> }

const fakeHerdr = (calls: Call[]) => {
  const state = {
    workspaces: [{ workspace_id: "w1", number: 1, label: "repo@main", focused: true, pane_count: 2, tab_count: 2, active_tab_id: "w1:t1", agent_status: "working", tokens: { ch_workshop_id: "workshop-1", ch_session_id: "mux-session-1" } }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "unknown" },
      { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "pi", focused: false, pane_count: 1, agent_status: "working" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_a", workspace_id: "w1", tab_id: "w1:t1", focused: true, cwd: "/repo", foreground_cwd: "/repo", agent_status: "unknown", revision: 3 },
      { pane_id: "w1:p2", terminal_id: "term_b", workspace_id: "w1", tab_id: "w1:t2", focused: false, cwd: "/repo", foreground_cwd: "/repo/src", agent: "pi", agent_status: "working", revision: 9, label: "worker", tokens: { ch_clanker_id: "clanker-1", ch_harness: "pi", ch_harness_session: "session-1" }, agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/home/u/.pi/s.jsonl" } },
    ],
  }
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    switch (method) {
      case "ping": return { type: "pong", version: "0.8.2", protocol: 20 }
      case "session.snapshot": return { snapshot: { focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", ...state } }
      case "pane.process_info": return { process_info: params.pane_id === "w1:p2" ? { pane_id: "w1:p2", shell_pid: 200, foreground_process_group_id: 201, foreground_processes: [{ pid: 200, name: "zsh", argv: ["zsh"] }, { pid: 201, name: "pi", argv: ["pi", "--session", "x"], cwd: "/repo/src" }] } : { pane_id: "w1:p1", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "zsh", argv: ["zsh"] }] } }
      case "workspace.create": return { workspace: { workspace_id: "w2", label: params.label }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } }
      case "tab.create": return { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } }
      case "layout.apply": return { layout: { workspace_id: params.workspace_id, tab_id: `${params.workspace_id}:t9`, root: { type: "pane", pane_id: `${params.workspace_id}:p9` } } }
      case "pane.get": return { pane: state.panes.find((pane) => pane.pane_id === params.pane_id) }
      case "workspace.get": return { workspace: state.workspaces[0] }
      default: return { type: "ok" }
    }
  }
  return request
}

describe("herdr multiplexer adapter", () => {
  test("declares its capabilities and pane address", () => {
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr([]) })
    expect(adapter.kind).toBe("herdr")
    expect(adapter.paneAddressEnv()).toBe("HERDR_PANE_ID")
    expect(adapter.capabilities()).toMatchObject({ processInfo: true, agentStatus: true, agentPrompt: true, durableIds: true, clientRouting: false, argvLaunch: true, claimScopes: ["session", "pane"] })
  })

  test("maps workspaces, tabs, and panes onto the session topology with claims from tokens", async () => {
    const calls: Call[] = []
    const snapshot = await new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) }).observe()
    expect(snapshot.kind).toBe("herdr")
    expect(snapshot.instanceId).toBe("herdr:/tmp/x.sock")
    const session = snapshot.sessions[0]!
    expect(session).toMatchObject({ id: "w1", nativeName: "repo@main", path: "/repo", attached: true, workshopId: "workshop-1", resourceId: "mux-session-1" })
    expect(session.windows.map((window) => [window.id, window.nativeName, window.active])).toEqual([["w1:t1", "main", true], ["w1:t2", "pi", false]])
    const worker = session.windows[1]!.panes[0]!
    expect(worker).toMatchObject({ id: "w1:p2", pid: "200", command: "pi", currentPath: "/repo/src", displayName: "worker", clankerId: "clanker-1", harness: "pi", harnessSessionId: "session-1" })
    expect(worker.agentStatus).toEqual({ agent: "pi", status: "working" })
    expect(worker.sessionRef).toMatchObject({ agent: "pi", kind: "path" })
    expect(worker.processInfo?.foregroundProcesses.at(-1)?.argv).toEqual(["pi", "--session", "x"])
    expect(calls.filter((call) => call.method === "pane.process_info")).toHaveLength(2)
  })

  test("spawns sessions and windows with env, using layout.apply for argv launches", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    const shell = await adapter.spawn({ scope: "session", name: "repo@feature", cwd: "/repo", windowName: "main" })
    expect(shell).toEqual({ nativeSessionId: "w2", nativeWindowId: "w2:t1", nativePaneId: "w2:p1" })
    expect(calls.find((call) => call.method === "workspace.create")?.params).toMatchObject({ cwd: "/repo", label: "repo@feature", focus: false })
    expect(calls.find((call) => call.method === "tab.rename")?.params).toEqual({ tab_id: "w2:t1", label: "main" })

    const argv = await adapter.spawn({ scope: "window", nativeSessionId: "w1", name: "pi", cwd: "/repo", env: { CLANKER_ID: "clanker-2" }, launch: { kind: "argv", argv: ["pi", "hello"] } })
    expect(argv).toEqual({ nativeSessionId: "w1", nativeWindowId: "w1:t9", nativePaneId: "w1:p9" })
    expect(calls.find((call) => call.method === "layout.apply")?.params).toEqual({ workspace_id: "w1", tab_label: "pi", focus: false, root: { type: "pane", command: ["pi", "hello"], cwd: "/repo", env: { CLANKER_ID: "clanker-2" } } })

    const argvSession = await adapter.spawn({ scope: "session", name: "ws", cwd: "/repo", windowName: "main", launch: { kind: "argv", argv: ["sh"] } })
    expect(argvSession).toEqual({ nativeSessionId: "w2", nativeWindowId: "w2:t9", nativePaneId: "w2:p9" })
    expect(calls.filter((call) => call.method === "tab.close").map((call) => call.params)).toEqual([{ tab_id: "w2:t1" }])
  })

  test("writes claims as tokens, display names as labels, and skips window claims", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    await adapter.claim(paneLocation("w1", "w1:t2", "w1:p2"), "clankerId", "clanker-9")
    await adapter.claim(paneLocation("w1", "w1:t2", "w1:p2"), "clankerId", null)
    await adapter.claim(sessionLocation("w1"), "workshopId", "workshop-9")
    await adapter.claim(sessionLocation("w1"), "sessionDisplayName", "Renamed")
    await adapter.claim(paneLocation("w1", "w1:t2", "w1:p2"), "terminalDisplayName", "Worker")
    await adapter.claim(windowLocation("w1", "w1:t2"), "windowHarness", "pi")
    await adapter.claim(sessionLocation("w1"), "worktreePath", "/".padEnd(120, "x"))
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ["pane.report_metadata", { pane_id: "w1:p2", source: "clankerhouse", tokens: { ch_clanker_id: "clanker-9" } }],
      ["pane.report_metadata", { pane_id: "w1:p2", source: "clankerhouse", tokens: { ch_clanker_id: null } }],
      ["workspace.report_metadata", { workspace_id: "w1", source: "clankerhouse", tokens: { ch_workshop_id: "workshop-9" } }],
      ["workspace.rename", { workspace_id: "w1", label: "Renamed" }],
      ["pane.rename", { pane_id: "w1:p2", label: "Worker" }],
    ])
    await expect(adapter.claim(paneLocation("w1", null, "w1:p2"), "clankerId", "x".repeat(81))).rejects.toThrow(/80-character/)
    expect(await adapter.readClaim(paneLocation("w1", null, "w1:p2"), "harnessSessionId")).toBe("session-1")
    expect(await adapter.readClaim(sessionLocation("w1"), "workshopId")).toBe("workshop-1")
  })

  test("submits a semantic prompt to the exact recognized agent pane", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    await adapter.promptAgent(paneLocation("w1", "w1:t2", "w1:p2"), "review this exact change")
    expect(calls).toEqual([{ method: "agent.prompt", params: { target: "w1:p2", text: "review this exact change" } }])
    await expect(adapter.promptAgent(sessionLocation("w1"), "not a pane")).rejects.toThrow(/requires a pane location/)
  })

  test("focus walks workspace, tab, and pane; kill and rename map by scope", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    await adapter.focus(paneLocation("w1", "w1:t2", "w1:p2"))
    await adapter.kill(sessionLocation("w1"))
    await adapter.kill(windowLocation("w1", "w1:t2"))
    await adapter.kill(paneLocation("w1", "w1:t2", "w1:p2"))
    await adapter.rename(windowLocation("w1", "w1:t2"), "logs")
    expect(calls.map((call) => call.method)).toEqual(["workspace.focus", "tab.focus", "pane.focus", "workspace.close", "tab.close", "pane.close", "tab.rename"])
    expect(await adapter.currentLocation()).toEqual({ kind: "herdr", instanceId: "herdr:/tmp/x.sock", nativeSessionId: "w1", nativeWindowId: "w1:t1", nativePaneId: "w1:p1" })
  })

  test("resolves the socket path from the environment", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/x/herdr.sock" })).toBe("/x/herdr.sock")
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/herdr/herdr.sock")
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg", HERDR_SESSION: "work" })).toBe("/cfg/herdr/sessions/work/herdr.sock")
    expect(herdrSocketPath({ HOME: "/home/u" })).toBe("/home/u/.config/herdr/herdr.sock")
  })
})

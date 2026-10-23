import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { HERDR_MIN_PROTOCOL, HERDR_PROCESS_INFO_CONCURRENCY, HerdrAdapter, herdrLabelTokens, herdrRequest, herdrSocketPath } from "./herdr"
import { MultiplexerResourceExhaustedError, paneLocation, sessionLocation, windowLocation } from "./interface"

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
      case "ping": return { type: "pong", version: "0.9.5", protocol: 22, capabilities: { live_handoff: true } }
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
    expect(adapter.capabilities()).toMatchObject({ processInfo: true, agentStatus: true, agentPrompt: true, durableIds: true, argvLaunch: true, claimScopes: ["session", "pane"] })
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

  test("observes topology and claims without per-pane process requests when asked", async () => {
    const calls: Call[] = []
    const snapshot = await new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) }).observe({ processInfo: false })
    expect(calls.filter((call) => call.method === "pane.process_info")).toHaveLength(0)
    const worker = snapshot.sessions[0]!.windows[1]!.panes[0]!
    expect(worker).toMatchObject({ id: "w1:p2", pid: "", command: "", clankerId: "clanker-1", harness: "pi" })
    expect(worker.processInfo).toBeUndefined()
  })

  test("asks process facts of harness panes every time and of other panes at most once per TTL", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    const asked = () => calls.filter((call) => call.method === "pane.process_info").map((call) => call.params.pane_id)
    await adapter.observe()
    expect(asked()).toEqual(["w1:p1", "w1:p2"])
    calls.length = 0
    const again = await adapter.observe()
    expect(asked()).toEqual(["w1:p2"])
    expect(again.sessions[0]!.windows[0]!.panes[0]).toMatchObject({ id: "w1:p1", pid: "100", command: "zsh" })
    calls.length = 0
    const harnesses = await new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) }).observe({ processInfo: "harnesses" })
    expect(asked()).toEqual(["w1:p2"])
    expect(harnesses.sessions[0]!.windows[0]!.panes[0]!.processInfo).toBeUndefined()
    expect(harnesses.sessions[0]!.windows[1]!.panes[0]!.processInfo?.foregroundProcesses.at(-1)?.name).toBe("pi")
  })

  test("keeps at most a bounded number of per-pane requests in flight however many panes exist", async () => {
    const panes = Array.from({ length: 50 }, (_, index) => ({ pane_id: `w1:p${index + 1}`, terminal_id: `term_${index}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", revision: 0 }))
    let inFlight = 0
    let peak = 0
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "session.snapshot") return { snapshot: { workspaces: [{ workspace_id: "w1", number: 1, label: "big", focused: false, active_tab_id: "w1:t1", agent_status: "unknown" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: false, agent_status: "unknown" }], panes } }
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Bun.sleep(1)
      inFlight -= 1
      return { process_info: { pane_id: params.pane_id, shell_pid: 1 } }
    }
    const snapshot = await new HerdrAdapter({ socketPath: "/tmp/x.sock", request }).observe()
    expect(snapshot.sessions[0]!.windows[0]!.panes).toHaveLength(50)
    expect(snapshot.sessions[0]!.windows[0]!.panes.every((pane) => pane.pid === "1")).toBe(true)
    expect(peak).toBe(HERDR_PROCESS_INFO_CONCURRENCY)
  })

  test("callers during an observation share one later observation instead of running their own", async () => {
    const calls: Call[] = []
    const base = fakeHerdr(calls)
    let release: () => void = () => {}
    let gate: Promise<void> | undefined = new Promise((resolve) => { release = resolve })
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "session.snapshot" && gate) { const waiting = gate; gate = undefined; await waiting }
      return base(method, params)
    }
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request })
    const first = adapter.observe()
    await Bun.sleep(0)
    const joined = [adapter.observe(), adapter.observe(), adapter.observe()]
    release()
    const [firstSnapshot, ...joinedSnapshots] = await Promise.all([first, ...joined])
    // One observation for the first caller, one after it for everyone who arrived meanwhile.
    expect(calls.filter((call) => call.method === "session.snapshot")).toHaveLength(2)
    expect(joinedSnapshots.map((snapshot) => snapshot.sessions[0]!.id)).toEqual(["w1", "w1", "w1"])
    expect(joinedSnapshots[0]).not.toBe(joinedSnapshots[1])
    expect(firstSnapshot.sessions).toHaveLength(1)
    await adapter.observe()
    expect(calls.filter((call) => call.method === "session.snapshot")).toHaveLength(3)
  })

  test("reports herdr running out of file descriptors as resource exhaustion with the remedy", async () => {
    const path = `/tmp/clankerhouse-herdr-emfile-${process.pid}.sock`
    const server = Bun.listen({
      unix: path,
      socket: {
        data(socket) {
          socket.write(`${JSON.stringify({ id: "1", error: { code: "INVALID_REQUEST", message: "workspace.create: dup of fd 815 failed" } })}\n`)
        },
      },
    })
    try {
      const failure = await herdrRequest(path)("workspace.create", {}).catch((error) => error)
      expect(failure).toBeInstanceOf(MultiplexerResourceExhaustedError)
      expect(failure.code).toBe("RESOURCE_EXHAUSTED")
      expect(failure.message).toMatch(/ran out of file descriptors.*prlimit/)
    } finally { server.stop(true) }
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

  test("accepts any herdr protocol at or above the supported minimum and refuses older ones", async () => {
    const path = `/tmp/clankerhouse-herdr-protocol-${process.pid}.sock`
    let protocol = 22
    const server = Bun.listen({ unix: path, socket: { data(socket) { socket.write(`${JSON.stringify({ id: "1", result: { type: "pong", version: "x", protocol, capabilities: { future: true } } })}\n`) } } })
    try {
      const adapter = new HerdrAdapter({ socketPath: path })
      expect(await adapter.available()).toBe(true)
      protocol = HERDR_MIN_PROTOCOL + 40
      expect(await adapter.available()).toBe(true)
      protocol = HERDR_MIN_PROTOCOL - 1
      await expect(adapter.available()).rejects.toThrow(/older than the supported minimum/)
    } finally { server.stop(true) }
  })

  test("keeps the instance id across a server restart but changes the server epoch", async () => {
    const path = `/tmp/clankerhouse-herdr-epoch-${process.pid}.sock`
    const listen = () => Bun.listen({ unix: path, socket: { data(socket) { socket.write(`${JSON.stringify({ id: "1", result: { type: "pong", protocol: 22 } })}\n`) } } })
    const adapter = new HerdrAdapter({ socketPath: path })
    let server = listen()
    try {
      const instance = await adapter.instanceId()
      const first = await adapter.serverEpoch()
      expect(first).toBeString()
      expect(await adapter.serverEpoch()).toBe(first)
      server.stop(true)
      rmSync(path, { force: true })
      expect(await adapter.serverEpoch()).toBeUndefined()
      await Bun.sleep(5)
      server = listen()
      const second = await adapter.serverEpoch()
      expect(second).toBeString()
      expect(second).not.toBe(first)
      expect(await adapter.instanceId()).toBe(instance)
    } finally { server.stop(true); rmSync(path, { force: true }) }
  })

  test("streams agent status changes over a per-pane subscription that follows the agent panes", async () => {
    const path = `/tmp/clankerhouse-herdr-status-${process.pid}.sock`
    rmSync(path, { force: true })
    let panes = [{ pane_id: "w1:p1", agent: "codex" }, { pane_id: "w1:p2" }]
    const statusSubscriptions: Array<{ panes: string[]; socket: { write(data: string): unknown; end(): unknown } }> = []
    let rejectNext = false
    let topologySocket: { write(data: string): unknown } | undefined
    const line = (value: unknown) => `${JSON.stringify(value)}\n`
    const server = Bun.listen({
      unix: path,
      socket: {
        data(socket, chunk) {
          const request = JSON.parse(chunk.toString().trim()) as { id: string; method: string; params: { subscriptions?: Array<{ type: string; pane_id?: string }> } }
          if (request.method === "session.snapshot") return void socket.write(line({ id: request.id, result: { snapshot: { workspaces: [], tabs: [], panes } } }))
          const subscriptions = request.params.subscriptions ?? []
          if (!subscriptions.some((entry) => entry.type === "pane.agent_status_changed")) {
            topologySocket = socket
            return void socket.write(line({ id: request.id, result: { type: "subscription_started" } }))
          }
          if (rejectNext) { rejectNext = false; socket.write(line({ id: request.id, error: { code: "pane_not_found", message: "pane not found" } })); return void socket.end() }
          statusSubscriptions.push({ panes: subscriptions.map((entry) => entry.pane_id!), socket })
          socket.write(line({ id: request.id, result: { type: "subscription_started" } }))
        },
      },
    })
    const controller = new AbortController()
    const seen: string[] = []
    const adapter = new HerdrAdapter({ socketPath: path })
    const until = async (predicate: () => boolean) => { for (let index = 0; index < 400 && !predicate(); index++) await Bun.sleep(5); expect(predicate()).toBe(true) }
    const consuming = (async () => { for await (const change of adapter.changes(controller.signal)) seen.push(change.kind) })()
    try {
      await until(() => statusSubscriptions.length === 1)
      expect(statusSubscriptions[0]!.panes).toEqual(["w1:p1"])
      statusSubscriptions[0]!.socket.write(line({ event: "pane_agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" } }))
      await until(() => seen.includes("status"))

      // A detected agent widens the subscription; a pane that vanished first makes herdr reject it, and the adapter retries.
      panes = [...panes.slice(0, 1), { pane_id: "w1:p2", agent: "claude" }]
      rejectNext = true
      topologySocket!.write(line({ event: "pane_agent_detected", data: { pane_id: "w1:p2", workspace_id: "w1" } }))
      await until(() => statusSubscriptions.length === 2)
      expect(statusSubscriptions[1]!.panes).toEqual(["w1:p1", "w1:p2"])

      // Lost event history is reported as a reconnect and resubscribes.
      const before = seen.filter((kind) => kind === "reconnect").length
      statusSubscriptions[1]!.socket.write(line({ id: "status", error: { code: "events_lost", message: "lost" } }))
      await until(() => statusSubscriptions.length === 3 && seen.filter((kind) => kind === "reconnect").length > before)
    } finally {
      controller.abort()
      await consuming
      server.stop(true)
      rmSync(path, { force: true })
    }
  })

  test("shows Workshop Labels as workspace tokens, patching only what differs", async () => {
    const calls: Call[] = []
    const adapter = new HerdrAdapter({ socketPath: "/tmp/x.sock", request: fakeHerdr(calls) })
    const reports = () => calls.filter((call) => call.method === "workspace.report_metadata").map((call) => call.params)
    expect(await adapter.showLabels(sessionLocation("w1"), { stage: "retro", status: "done" }, {})).toBe(true)
    expect(reports()).toEqual([{ workspace_id: "w1", source: "clankerhouse", tokens: { lbl_stage: "retro", lbl_status: "done", labels: "retro done" } }])

    // What is already shown is left alone; a removed label is cleared, and other reporters' tokens are untouched.
    calls.length = 0
    const shown = { lbl_stage: "retro", lbl_status: "done", labels: "retro done", jj_status: "2 changes" }
    expect(await adapter.showLabels(sessionLocation("w1"), { stage: "retro", status: "done" }, shown)).toBe(false)
    expect(await adapter.showLabels(sessionLocation("w1"), { stage: "retro" }, shown)).toBe(true)
    expect(reports()).toEqual([{ workspace_id: "w1", source: "clankerhouse", tokens: { labels: "retro", lbl_status: null } }])

    // Observation hands back only the label tokens.
    const observed = await new HerdrAdapter({ socketPath: "/tmp/x.sock", request: async (method, params) => {
      const result = await fakeHerdr([])(method, params)
      if (method === "session.snapshot") (result.snapshot as { workspaces: Array<{ tokens: Record<string, string> }> }).workspaces[0]!.tokens = { ch_workshop_id: "workshop-1", lbl_stage: "retro", labels: "retro", jj_status: "x" }
      return result
    } }).observe({ processInfo: false })
    expect(observed.sessions[0]!.shownLabels).toEqual({ lbl_stage: "retro", labels: "retro" })
  })

  test("keeps label tokens within herdr's token-name and per-report limits", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${String(index).padStart(2, "0")}`, `v${index}`]))
    const tokens = herdrLabelTokens({ ...many, ["x".repeat(30)]: "long-key" })
    expect(Object.keys(tokens)).toHaveLength(16)
    expect(tokens.lbl_k14).toBe("v14")
    expect(tokens.lbl_k15).toBeUndefined()
    expect(tokens[`lbl_${"x".repeat(30)}`]).toBeUndefined()
    expect(tokens.labels!.length).toBeLessThanOrEqual(80)
    expect(herdrLabelTokens({})).toEqual({})
  })

  test("resolves the socket path from the environment", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/x/herdr.sock" })).toBe("/x/herdr.sock")
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/herdr/herdr.sock")
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg", HERDR_SESSION: "work" })).toBe("/cfg/herdr/sessions/work/herdr.sock")
    expect(herdrSocketPath({ HOME: "/home/u" })).toBe("/home/u/.config/herdr/herdr.sock")
  })
})

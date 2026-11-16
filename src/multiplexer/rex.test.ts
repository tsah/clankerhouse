/**
 * The unit half runs everywhere against a scripted `rex`. The real half runs against a scratch Rex server (its own
 * socket, state and config under a temporary directory, stopped afterwards) and skips when `rex` is not installed,
 * unless REX_REQUIRED is set.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paneLocation, sessionLocation, windowLocation } from "./interface"
import { psProcessGroups, REX_POPUP_LABEL_PREFIX, REX_STARTUP_SILENCE_MS, REX_UNSET_ON_SPAWN, RexAdapter, RexClaimStore, rexChangeKind, rexLabel, rexLaunchCommand, type RexRun } from "./rex"

const scratch = () => mkdtempSync(join(tmpdir(), "ch-rex-test-"))
const observeScript = join(import.meta.dir, "..", "..", "share", "rex", "observe.lua")

/** A `rex` that answers `do` with `observation` and records every `api call`. */
const scripted = (observation: () => unknown, answers: Record<string, unknown> = {}) => {
  const calls: Array<{ method: string; params: any }> = []
  const run: RexRun = async (args, options) => {
    if (args[0] === "do") return { exitCode: 0, stdout: JSON.stringify(observation()), stderr: "" }
    if (args[0] === "api" && args[1] === "call") {
      const params = JSON.parse(options?.stdin ?? "{}")
      calls.push({ method: args[2]!, params })
      const answer = answers[args[2]!]
      return { exitCode: 0, stdout: JSON.stringify(typeof answer === "function" ? answer(params) : answer ?? {}), stderr: "" }
    }
    return { exitCode: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` }
  }
  return { run, calls }
}

const terminalBlock = (id: string, extra: Record<string, unknown> = {}) => ({
  block_id: id, label: "shell", creator: "com.superlogical.terminal", layer: "tiled", title: "",
  process: { child: { pid: 10, name: "bash", cwd: "/work" }, foreground: { pid: 11, name: "Claude", cwd: "/work/sub", argv0: "claude" } },
  program_status: { records: {} },
  ...extra,
})

const oneSession = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  host_id: "host-1", instance_id: "inst-2", pid: 99,
  sessions: [{ session_id: "session:s1", label: "repo@main", active_window_id: "window:w1", windows: [{ window_id: "window:w1", label: "main", focused_block_id: "block:b1", blocks }] }],
  clients: [{ client_id: "client:app", kind: "app", session_ids: ["session:s1"] }],
  ...extra,
})

describe("Rex claim store", () => {
  test("keeps one file per object and key, removes empty values, and skips writes in flight", () => {
    const store = new RexClaimStore(scratch())
    store.write("block:b1", "clankerId", "c-1")
    store.write("block:b1", "harness", "claude")
    store.write("block:b1", "harness", "")
    writeFileSync(join(store.root, "block:b1", "clankerId.123.tmp"), "partial")
    expect(store.all("block:b1")).toEqual({ clankerId: "c-1" })
    expect(store.read("block:b1", "harness")).toBeUndefined()
    expect(() => store.write("block:../x", "k", "v")).toThrow()
    expect(() => store.write("block:b1", "../k", "v")).toThrow()
  })

  test("prunes objects the server no longer has once they are past the grace", () => {
    const store = new RexClaimStore(scratch())
    store.write("block:gone", "clankerId", "c-1")
    store.write("block:young", "clankerId", "c-2")
    store.write("block:live", "clankerId", "c-3")
    const old = (Date.now() - 3_600_000) / 1000
    utimesSync(join(store.root, "block:gone"), old, old)
    store.prune(new Set(["block:live"]), Date.now())
    expect(readdirSync(store.root).sort()).toEqual(["block:live", "block:young"])
  })
})

describe("Rex adapter, scripted", () => {
  test("maps sessions, windows and blocks with Claims, process facts, status and attachment", async () => {
    const claims = new RexClaimStore(scratch())
    claims.write("session:s1", "workshopId", "w-1")
    claims.write("session:s1", "worktreePath", "/work")
    claims.write("window:w1", "windowId", "mux-window-1")
    claims.write("block:b1", "clankerId", "c-1")
    claims.write("block:b1", "harness", "claude")
    const records = [{ state: "blocked", kind: "question", app: "claude-code", effective_app: "claude-code", msg: "Which one?", updated_at: "2026-11-16T10:00:00Z" }]
    const popup = { ...terminalBlock("block:popup"), label: `${REX_POPUP_LABEL_PREFIX} picker`, layer: "floating" }
    const { run } = scripted(() => oneSession([terminalBlock("block:b1", { program_status: { records } }), popup]))
    const adapter = new RexAdapter({ run, claims, observeScript, env: {} })
    const snapshot = await adapter.observe()
    expect(snapshot).toMatchObject({ kind: "rex", instanceId: "rex:host-1" })
    const [session] = snapshot.sessions
    expect(session).toMatchObject({ id: "session:s1", nativeName: "repo@main", workshopId: "w-1", worktreePath: "/work", path: "/work", attached: true })
    expect(session!.claims).toEqual({ workshopId: "w-1", worktreePath: "/work" })
    expect(session!.windows[0]).toMatchObject({ id: "window:w1", nativeName: "main", active: true, resourceId: "window:w1" })
    // The popup is Clankerhouse's own, never a pane.
    expect(session!.windows[0]!.panes.map((pane) => pane.id)).toEqual(["block:b1"])
    expect(session!.windows[0]!.panes[0]).toMatchObject({
      pid: "10", command: "claude", currentPath: "/work/sub", active: true, clankerId: "c-1", harness: "claude",
      agentStatus: { agent: "claude", status: "blocked", blockedKind: "question", message: "Which one?", reportedAt: Date.parse("2026-11-16T10:00:00Z") },
    })
    expect(session!.windows[0]!.panes[0]!.harnessGone).toBeUndefined()
  })

  test("a harness silent since its start is held at a startup dialog, and a block from an earlier server holds no harness", async () => {
    const claims = new RexClaimStore(scratch())
    const now = 1_000_000_000
    claims.write("block:b1", "harness", "claude")
    claims.write("block:b1", "_spawned", String(now - REX_STARTUP_SILENCE_MS - 1))
    claims.write("block:b1", "_epoch", "inst-2")
    const { run } = scripted(() => oneSession([terminalBlock("block:b1")]))
    const adapter = new RexAdapter({ run, claims, observeScript, env: {}, now: () => now })
    const pane = () => adapter.observe().then((snapshot) => snapshot.sessions[0]!.windows[0]!.panes[0]!)
    expect((await pane()).agentStatus).toMatchObject({ status: "blocked", blockedKind: "startup" })
    claims.write("block:b1", "_reported", String(now))
    expect((await pane()).agentStatus).toEqual({ status: "unknown" })
    claims.write("block:b1", "_epoch", "inst-1")
    expect((await pane()).harnessGone).toBe(true)
  })

  test("spawns a session and a window through env, and records the server instance on the block", async () => {
    const claims = new RexClaimStore(scratch())
    const { run, calls } = scripted(() => oneSession([]), {
      "server.status": { host_id: "host-1", instance_id: "inst-2" },
      "session.create": { session_id: "session:new", initial_windows: [{ window_id: "window:new", block_ids: ["block:new"], revision: 1 }] },
      "session.new_window": { window_id: "window:two", block_ids: ["block:two"], revision: 2 },
    })
    const adapter = new RexAdapter({ run, claims, observeScript, env: { PATH: "/bin", CLANKER_ID: "parent", CLANKERHOUSE_INSTANCE: "rex", HERDR_PANE_ID: "w1:p1" }, now: () => 42 })
    const created = await adapter.spawn({ scope: "session", name: "repo@main", cwd: "/work", windowName: "claude", env: { CLANKER_ID: "c-1" }, launch: { kind: "argv", argv: ["claude", "hi"] } })
    expect(created).toEqual({ nativeSessionId: "session:new", nativeWindowId: "window:new", nativePaneId: "block:new" })
    const create = calls.find((call) => call.method === "session.create")!.params
    expect(create.label).toBe("repo@main")
    expect(create.initial_windows[0].window_label).toBe("claude")
    const command: string[] = create.initial_windows[0].layout.block.options.command
    expect(create.initial_windows[0].layout.block.options).toMatchObject({ shell: "none", cwd: "/work" })
    expect(command.slice(-2)).toEqual(["claude", "hi"])
    expect(command).toContain("CLANKER_ID=c-1")
    expect(command).toContain("CLANKERHOUSE_MULTIPLEXER=rex")
    expect(command).toContain("CLANKERHOUSE_INSTANCE=rex")
    expect(command).not.toContain("CLANKER_ID=parent")
    // The spawner's pane address is removed; the identity the request sets is not.
    expect(command.join(" ")).toContain("-u HERDR_PANE_ID")
    // A mutation's own marker never reaches the terminal it starts, even when the spawner had it.
    expect(command.join(" ")).toContain("-u CLANKERHOUSE_DAEMON_INTERNAL")
    expect(command.join(" ")).not.toContain("-u CLANKER_ID")
    expect(claims.all("block:new")).toEqual({ _epoch: "inst-2", _spawned: "42" })

    await adapter.spawn({ scope: "window", nativeSessionId: "session:new", name: "tests", cwd: "/work" })
    const window = calls.find((call) => call.method === "session.new_window")!.params
    expect(window).toMatchObject({ session_id: "session:new", window_label: "tests", focus: false })
    expect(window.layout.block.options.command.slice(-3)).toEqual(["sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'])
  })

  test("claims by scope, kills by scope, renames, focuses and moves the app that opened the popup", async () => {
    const claims = new RexClaimStore(scratch())
    const { run, calls } = scripted(() => oneSession([]), { "client.list": { clients: [{ client_id: "client:app", info: { kind: "app" } }, { client_id: "client:other", info: { kind: "app" } }, { client_id: "client:cli", info: { kind: "cli" } }] } })
    const adapter = new RexAdapter({ run, claims, observeScript, env: { CLANKERHOUSE_REX_CLIENT: "client:app" } })
    const pane = paneLocation("session:s1", "window:w1", "block:b1")
    await adapter.claim(pane, "workshopId", "w-1")
    await adapter.claim(pane, "windowHarness", "claude")
    await adapter.claim(pane, "clankerId", "c-1")
    expect(claims.all("session:s1")).toEqual({ workshopId: "w-1" })
    expect(await adapter.readClaim(windowLocation("session:s1", "window:w1"), "windowHarness")).toBe("claude")
    expect(await adapter.readClaim(pane, "clankerId")).toBe("c-1")
    await adapter.claim(pane, "clankerId", null)
    expect(await adapter.readClaim(pane, "clankerId")).toBeUndefined()

    await adapter.rename(sessionLocation("session:s1"), `x${"y".repeat(200)}`)
    await adapter.focus(pane)
    await adapter.kill(pane)
    await adapter.kill(sessionLocation("session:s1"))
    expect(calls.map((call) => call.method)).toEqual(["session.set_label", "session.focus_block", "client.list", "client.perform", "block.close", "session.destroy"])
    expect(calls[0]!.params.label).toHaveLength(128)
    expect(calls[3]!.params).toMatchObject({ client_id: "client:app", action: "session.select", args: { session_id: "session:s1", window_id: "window:w1" } })
    expect(existsSync(join(claims.root, "session:s1"))).toBe(false)
  })

  test("a focus no app will show says why", async () => {
    const run: RexRun = async (args, options) => {
      const method = args[2]
      if (method === "client.list") return { exitCode: 0, stdout: JSON.stringify({ clients: [{ client_id: "client:app", info: { kind: "app" } }] }), stderr: "" }
      if (method === "client.perform") return { exitCode: 1, stdout: "", stderr: 'Error: stream response "control-1" failed: Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server. (status=403 code=refused)' }
      return { exitCode: 0, stdout: "{}", stderr: "" }
    }
    const adapter = new RexAdapter({ run, claims: new RexClaimStore(scratch()), observeScript, env: {} })
    await expect(adapter.focus(paneLocation("session:s1", "window:w1", "block:b1"))).rejects.toThrow("Turn on Remote Control in its Settings under Rex Server.")
  })

  test("prompts with a paste and a separate Enter, and interrupts by status", async () => {
    const claims = new RexClaimStore(scratch())
    let state = "working"
    const { run, calls } = scripted(() => oneSession([]), {
      "block.method": () => ({ records: state ? [{ state, updated_at: "2026-11-16T10:00:00Z" }] : {} }),
      "block.event": (params: any) => { if (params.event.payload.key === "escape") state = "idle"; return {} },
    })
    const adapter = new RexAdapter({ run, claims, observeScript, env: {}, sleep: async () => {} })
    const pane = paneLocation("session:s1", "window:w1", "block:b1")
    await adapter.promptAgent(pane, "Review this")
    expect(calls.map((call) => call.params.event)).toEqual([{ type: "paste", payload: { text: "Review this" } }, { type: "key", payload: { key: "enter" } }])
    expect(await adapter.interruptAgent(pane)).toBe("stopped")
    expect(await adapter.interruptAgent(pane)).toBe("not_working")
    state = ""
    expect(await adapter.interruptAgent(pane)).toBe("sent")
  })

  test("classifies event lines, ignoring the clients every CLI call brings", () => {
    const wrap = (event: unknown) => JSON.stringify({ type: "session_event", payload: { session_id: "session:s1", event } })
    const block = (name: string) => wrap({ type: "block_event", payload: { block_id: "block:b1", creator_name: "com.superlogical.terminal", name, payload: {} } })
    expect(rexChangeKind(JSON.stringify({ type: "session_created", payload: {} }))).toBe("topology")
    expect(rexChangeKind(wrap({ type: "window_closed", payload: {} }))).toBe("topology")
    expect(rexChangeKind(wrap({ type: "session_label_changed", payload: {} }))).toBe("metadata")
    expect(rexChangeKind(wrap({ type: "active_window_changed", payload: {} }))).toBe("focus")
    expect(rexChangeKind(block("program_status_changed"))).toBe("status")
    expect(rexChangeKind(block("process_changed"))).toBe("metadata")
    expect(rexChangeKind(block("bell"))).toBeUndefined()
    expect(rexChangeKind(wrap({ type: "client_connected", payload: {} }))).toBeUndefined()
    expect(rexChangeKind("not json")).toBeUndefined()
  })

  test("groups ps output by process group, as macOS observes foreground members", () => {
    const groups = psProcessGroups("  100   100 /bin/bash /opt/ch/bin/clankerhouse-harness-lifecycle -- claude\n  101   100 claude --session-id s\n  200   200 -zsh\nnoise\n")
    expect(groups.get(100)!.map((member) => member.name)).toEqual(["bash", "claude"])
    expect(groups.get(200)!.map((member) => member.argv)).toEqual([["-zsh"]])
  })

  test("labels and launch commands", () => {
    expect(rexLabel("  a\nb  ")).toBe("a b")
    expect(rexLaunchCommand(["x"], { A: "1" })).toEqual(["env", ...REX_UNSET_ON_SPAWN.flatMap((name) => ["-u", name]), "A=1", "x"])
  })
})

const rex = Bun.env.REX_BIN || Bun.which("rex")
if (Bun.env.REX_REQUIRED && !rex) throw new Error("REX_REQUIRED is set but rex is not installed")
const home = scratch()
const server = `unix://${home}/rex.sock`
const start = rex ? Bun.spawnSync([rex, "--server", server, "server", "start", "--state-dir", join(home, "state"), "--config", join(home, "init.lua")], { stdout: "ignore", stderr: "pipe" }) : undefined
const started = start?.exitCode === 0
if (Bun.env.REX_REQUIRED && !started) throw new Error(`REX_REQUIRED is set but no Rex server started: ${start?.stderr.toString()}`)

describe.skipIf(!started)("Rex adapter against a real server", () => {
  const claims = new RexClaimStore(join(home, "claims"))
  const adapter = new RexAdapter({ server, claims, observeScript, env: { PATH: Bun.env.PATH, HOME: Bun.env.HOME } })
  const stop = () => Bun.spawnSync([rex!, "--server", server, "server", "stop"], { stdout: "ignore", stderr: "ignore" })
  afterAll(stop)

  test("observes what it spawned, with Claims, process facts and self-reported status", async () => {
    expect(await adapter.available()).toBe(true)
    const report = "printf '\\033]7501;state=blocked:kind=permission:app=claude-code\\033\\\\'; exec sleep 600"
    const created = await adapter.spawn({ scope: "session", name: "repo@main", cwd: "/tmp", windowName: "claude", launch: { kind: "argv", argv: ["sh", "-c", report] } })
    await adapter.claim(sessionLocation(created.nativeSessionId), "workshopId", "w-1")
    const pane = paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId)
    await adapter.claim(pane, "harness", "claude")
    const second = await adapter.spawn({ scope: "window", nativeSessionId: created.nativeSessionId, name: "tests", cwd: "/tmp" })
    await Bun.sleep(700)
    const session = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!
    expect(session).toMatchObject({ nativeName: "repo@main", workshopId: "w-1" })
    expect(session.windows.map((window) => window.nativeName)).toEqual(["claude", "tests"])
    expect(session.windows[0]!.panes[0]).toMatchObject({ id: created.nativePaneId, harness: "claude", command: "sleep", currentPath: realpathSync("/tmp"), agentStatus: { agent: "claude", status: "blocked", blockedKind: "permission" } })
    expect(session.windows[1]!.panes[0]!.id).toBe(second.nativePaneId)

    await adapter.rename(windowLocation(created.nativeSessionId, second.nativeWindowId), "renamed")
    await adapter.kill(paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId))
    const after = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!
    expect(after.windows.map((window) => window.nativeName)).toEqual(["renamed"])
    await adapter.kill(sessionLocation(created.nativeSessionId))
    expect((await adapter.observe()).sessions.some((candidate) => candidate.id === created.nativeSessionId)).toBe(false)
  })

  test("submits a prompt to a terminal", async () => {
    const out = join(home, "prompt.out")
    const echo = await adapter.spawn({ scope: "session", name: "prompt2", cwd: home, launch: { kind: "argv", argv: ["sh", "-c", "read line; echo \"got:$line\" > prompt.out; exec sleep 600"] } })
    await Bun.sleep(300)
    await adapter.promptAgent(paneLocation(echo.nativeSessionId, echo.nativeWindowId, echo.nativePaneId), "hello rex")
    for (let tries = 0; tries < 40 && !existsSync(out); tries += 1) await Bun.sleep(50)
    expect(await Bun.file(out).text()).toBe("got:hello rex\n")
    await adapter.kill(sessionLocation(echo.nativeSessionId))
  })

  test("streams changes and keeps instanceId but not serverEpoch across a restart, which leaves a shell in place of the harness", async () => {
    const created = await adapter.spawn({ scope: "session", name: "restart", cwd: "/tmp", launch: { kind: "argv", argv: ["sleep", "600"] } })
    const pane = paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId)
    await adapter.claim(pane, "harness", "claude")
    const controller = new AbortController()
    const seen: string[] = []
    const reading = (async () => { for await (const change of adapter.changes(controller.signal)) seen.push(change.kind) })()
    await Bun.sleep(400)
    await adapter.rename(sessionLocation(created.nativeSessionId), "restarted")
    for (let tries = 0; tries < 40 && !seen.includes("metadata"); tries += 1) await Bun.sleep(50)
    controller.abort()
    await reading
    expect(seen[0]).toBe("reconnect")
    expect(seen).toContain("metadata")

    const [instance, epoch] = [await adapter.instanceId(), await adapter.serverEpoch()]
    stop()
    expect(await adapter.available()).toBe(false)
    mkdirSync(join(home, "state"), { recursive: true })
    Bun.spawnSync([rex!, "--server", server, "server", "start", "--state-dir", join(home, "state"), "--config", join(home, "init.lua")], { stdout: "ignore", stderr: "ignore" })
    expect(await adapter.instanceId()).toBe(instance)
    expect(await adapter.serverEpoch()).not.toBe(epoch)
    const restored = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!
    expect(restored.nativeName).toBe("restarted")
    expect(restored.windows[0]!.panes[0]).toMatchObject({ id: created.nativePaneId, harness: "claude", harnessGone: true })
    await adapter.kill(sessionLocation(created.nativeSessionId))
  })
})

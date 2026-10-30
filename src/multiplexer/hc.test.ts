/**
 * Runs against a real scratch core: its own HC_SESSION under scratch XDG directories, stopped afterwards. Skips when `hc`
 * is not installed unless HC_REQUIRED is set, which is how CI's hc lane proves it ran.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HC_INTERRUPT_STEP_MS, HC_STARTUP_SILENCE_MS, HC_UNSET_ON_SPAWN, HcAdapter, HcAttachError, hcRequest, hcSocketPath, type HcRequest } from "./hc"
import { hcCoreEnvironment } from "./hc-core"
import { paneLocation, sessionLocation } from "./interface"
import { ManagedMultiplexer } from "./managed"

const hc = Bun.env.HC_BIN || Bun.which("hc")
if (Bun.env.HC_REQUIRED && !hc) throw new Error("HC_REQUIRED is set but hc is not installed")
const home = mkdtempSync(join(tmpdir(), "ch-hc-test-"))
const session = `eval-unit-${process.pid}`
const env = { ...Bun.env, HC_SESSION: session, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") }
const socketPath = hcSocketPath(env)
const run = (...args: string[]) => Bun.spawnSync([hc!, ...args], { env })
const settle = (ms = 150) => Bun.sleep(ms)
// Started here rather than in beforeAll so a box that cannot run a core skips: scripts/qa-install fakes systemd-run.
if (hc) Bun.spawnSync([hc, "server", "start"], { env: { ...hcCoreEnvironment(env), CLANKER_ID: "polluted-core", HERDR_PANE_ID: "w9:p9" } })
if (Bun.env.HC_REQUIRED && !existsSync(socketPath)) throw new Error("HC_REQUIRED is set but no core started")

describe.skipIf(!hc || !existsSync(socketPath))("hc multiplexer adapter against a real core", () => {
  const adapter = new HcAdapter({ socketPath })
  afterAll(() => { run("server", "stop") })

  test("is reachable and keeps instanceId but not serverEpoch across a restart", async () => {
    expect(await adapter.available()).toBe(true)
    const [instance, epoch] = [await adapter.instanceId(), await adapter.serverEpoch()]
    run("server", "restart")
    expect(await adapter.instanceId()).toBe(instance)
    expect(await adapter.serverEpoch()).not.toBe(epoch)
  })

  test("groups terminals into sessions, carries Claims, and folds a Workshop down to nothing", async () => {
    const created = await adapter.spawn({ scope: "session", name: "repo@main", cwd: "/tmp", windowName: "main", env: { CLANKER_ID: "c-1" }, launch: { kind: "argv", argv: ["bash", "--norc"] } })
    const longPath = `/home/u/${"deep/".repeat(40)}worktree`
    await adapter.claim(sessionLocation(created.nativeSessionId), "workshopId", "workshop-1")
    await adapter.claim(sessionLocation(created.nativeSessionId), "worktreePath", longPath)
    const pane = paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId)
    await adapter.claim(pane, "clankerId", "c-1")
    await adapter.claim(pane, "harness", "claude")
    const second = await adapter.spawn({ scope: "window", nativeSessionId: created.nativeSessionId, name: "tests", cwd: "/tmp" })
    await settle(700)

    const found = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!
    expect(found).toMatchObject({ nativeName: "repo@main", workshopId: "workshop-1", worktreePath: longPath })
    expect(found.windows.map((window) => window.nativeName)).toEqual(["main", "tests"])
    expect(found.windows[0]!.panes[0]).toMatchObject({ id: created.nativePaneId, clankerId: "c-1", harness: "claude", command: "bash" })
    expect(found.windows[1]!.panes[0]!.clankerId).toBeUndefined()
    // The second window inherited session Claims, so a session keeps them after its first terminal goes.
    expect(await adapter.readClaim(sessionLocation(created.nativeSessionId), "workshopId")).toBe("workshop-1")

    await adapter.claim(pane, "harness", null)
    expect(await adapter.readClaim(pane, "harness")).toBeUndefined()
    await adapter.kill(pane)
    expect((await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)?.windows).toHaveLength(1)
    await adapter.kill(sessionLocation(created.nativeSessionId))
    expect((await adapter.observe()).sessions.some((candidate) => candidate.id === created.nativeSessionId)).toBe(false)
    expect(second.nativePaneId).not.toBe(created.nativePaneId)
  })

  test("spawn env reaches the program and survives as a terminal-scoped fact, and shells need no argv", async () => {
    const created = await adapter.spawn({ scope: "session", name: "env", cwd: "/tmp", env: { CLANKER_ID: "from-spawn" } })
    await settle(300)
    await adapter.promptAgent(paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId), "echo got=$CLANKER_ID")
    await settle(300)
    const read = await hcRequest(socketPath)("terminal.read", { terminal: created.nativePaneId })
    expect(read.text).toContain("got=from-spawn")
    await adapter.kill(sessionLocation(created.nativeSessionId))
  })

  test("status comes from OSC 7501 and changes() reports topology, status and metadata", async () => {
    const abort = new AbortController()
    const seen: string[] = []
    const consuming = (async () => { for await (const change of adapter.changes(abort.signal)) seen.push(change.kind) })()
    await settle()
    const created = await adapter.spawn({ scope: "session", name: "status", cwd: "/tmp", launch: { kind: "argv", argv: ["sh", "-c", String.raw`printf '\033]7501;state=blocked:app=claude-code\033\\'; sleep 60`] } })
    await settle(400)
    const pane = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!.windows[0]!.panes[0]!
    expect(pane.agentStatus).toEqual({ agent: "claude", status: "blocked" })
    await adapter.rename(paneLocation(created.nativeSessionId, created.nativeWindowId, created.nativePaneId), "worker")
    await settle()
    expect(seen).toEqual(expect.arrayContaining(["reconnect", "topology", "status", "metadata"]))
    await adapter.kill(sessionLocation(created.nativeSessionId))
    abort.abort()
    await consuming
  })

  test("a live terminal survives a core restart with address, Claims and status intact", async () => {
    const created = await adapter.spawn({ scope: "session", name: "durable", cwd: "/tmp", launch: { kind: "argv", argv: ["sh", "-c", String.raw`printf '\033]7501;state=idle:app=pi\033\\'; sleep 60`] } })
    await adapter.claim(sessionLocation(created.nativeSessionId), "workshopId", "workshop-durable")
    await settle(300)
    run("server", "restart")
    const found = (await adapter.observe()).sessions.find((candidate) => candidate.id === created.nativeSessionId)!
    expect(found.workshopId).toBe("workshop-durable")
    expect(found.windows[0]!.panes[0]).toMatchObject({ id: created.nativePaneId, agentStatus: { agent: "pi", status: "idle" } })
    await adapter.kill(sessionLocation(created.nativeSessionId))
  })

  test("terminals take identity from spawn, never from a core that carries someone else's", async () => {
    // beforeAll started this core with CLANKER_ID and HERDR_PANE_ID in its environment.
    const script = 'echo "id=${CLANKER_ID:-none} pane=${HERDR_PANE_ID:-none} lane=$CLANKERHOUSE_MULTIPLEXER"; sleep 60'
    const argv = ["sh", "-c", script]
    const first = await adapter.spawn({ scope: "session", name: "one", cwd: "/tmp", env: { CLANKER_ID: "clanker-1" }, launch: { kind: "argv", argv } })
    const second = await adapter.spawn({ scope: "session", name: "two", cwd: "/tmp", launch: { kind: "argv", argv } })
    await settle(300)
    const read = hcRequest(socketPath)
    expect((await read("terminal.read", { terminal: first.nativePaneId })).text).toContain("id=clanker-1 pane=none lane=hc")
    expect((await read("terminal.read", { terminal: second.nativePaneId })).text).toContain("id=none pane=none lane=hc")
    await adapter.kill(sessionLocation(first.nativeSessionId))
    await adapter.kill(sessionLocation(second.nativeSessionId))
  })

  test("interrupt returns at once for a program with no status and escalates for one in vim-style INSERT", async () => {
    const plain = await adapter.spawn({ scope: "session", name: "plain", cwd: "/tmp", launch: { kind: "argv", argv: ["bash", "--norc"] } })
    await settle(300)
    await adapter.promptAgent(paneLocation(plain.nativeSessionId, plain.nativeWindowId, plain.nativePaneId), "sleep 100")
    await settle(300)
    const started = Date.now()
    expect(await adapter.interruptAgent(paneLocation(plain.nativeSessionId, plain.nativeWindowId, plain.nativePaneId))).toBe("sent")
    expect(Date.now() - started).toBeLessThan(500)
    await adapter.kill(sessionLocation(plain.nativeSessionId))

    // Swallows the first ESC, as Claude does leaving INSERT, and settles on the second.
    const script = String.raw`
import os, sys, tty
tty.setraw(0)
def report(state):
    sys.stdout.write("\033]7501;state=%s:app=fake\033\\\\" % state); sys.stdout.flush()
report("working")
seen = 0
while seen < 2:
    seen += os.read(0, 16).count(b"\033")
report("idle")
os.read(0, 16)
`
    const vim = await adapter.spawn({ scope: "session", name: "vim", cwd: "/tmp", launch: { kind: "argv", argv: ["python3", "-c", script] } })
    await settle(500)
    expect(await adapter.interruptAgent(paneLocation(vim.nativeSessionId, vim.nativeWindowId, vim.nativePaneId))).toBe("stopped")
    await adapter.kill(sessionLocation(vim.nativeSessionId))
  })

  test("attach refuses a finished terminal with its reason and last output", async () => {
    const done = await adapter.spawn({ scope: "session", name: "done", cwd: "/tmp", launch: { kind: "argv", argv: ["sh", "-c", "echo last-words; exit 3"] } })
    await settle(300)
    const failure = await adapter.attachTarget(done.nativePaneId).catch((error) => error)
    expect(failure).toBeInstanceOf(HcAttachError)
    expect(failure.message).toContain("has finished")
    expect(failure.transcript).toContain("last-words")
    const live = await adapter.spawn({ scope: "session", name: "live", cwd: "/tmp", launch: { kind: "argv", argv: ["sleep", "60"] } })
    expect(await adapter.attachTarget(live.nativePaneId)).toBe(live.nativePaneId)
    await adapter.kill(sessionLocation(live.nativeSessionId))
  })

  test("ManagedMultiplexer drives the adapter unchanged", async () => {
    const managed = new ManagedMultiplexer(adapter, { registryPath: join(home, "registry.sqlite") })
    expect(typeof managed.observe).toBe("function")
    expect((await managed.observe()).kind).toBe("hc")
  })
})

const terminal = (overrides: Record<string, unknown> = {}) => ({ address: "t1", argv: ["claude"], cwd: "/repo", pid: 10, state: "live", created_ms: 0, reported: true, labels: { ch_session: "s1", ch_harness: "claude" }, status: null, ...overrides })
const stubbed = (terminals: unknown[], now = 1_000) => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const request: HcRequest = async (method, params = {}) => {
    calls.push([method, params])
    if (method === "terminal.list") return { terminals }
    if (method === "server.status") return { core: { id: "core-1" }, pid: 1 }
    if (method === "terminal.get") return terminals[0] as Record<string, unknown>
    return {}
  }
  return { adapter: new HcAdapter({ socketPath: "/tmp/none.sock", request, now: () => now, sleep: async () => {} }), calls }
}
const firstPane = async (adapter: HcAdapter) => (await adapter.observe()).sessions[0]!.windows[0]!.panes[0]!

describe("hc status mapping", () => {
  test.each([
    [{ state: "idle", app: "claude-code" }, { agent: "claude", status: "idle" }],
    [{ state: "working", app: "pi", msg: "reading" }, { agent: "pi", status: "working", message: "reading" }],
    [{ state: "done", app: "claude-code" }, { agent: "claude", status: "done" }],
    [{ state: "blocked", app: "claude-code", kind: "permission", msg: "approve Bash" }, { agent: "claude", status: "blocked", blockedKind: "permission", message: "approve Bash" }],
    [{ state: "blocked", app: "claude-code", kind: "question", msg: "red or blue" }, { agent: "claude", status: "blocked", blockedKind: "question", message: "red or blue" }],
    [{ state: "blocked", app: "pi" }, { agent: "pi", status: "blocked" }],
    [{ state: "error", app: "pi" }, { agent: "pi", status: "blocked", blockedKind: "error" }],
    [{ state: "something-new" }, { agent: undefined, status: "unknown" }],
    [null, { agent: undefined, status: "unknown" }],
  ])("%j", async (status, expected) => {
    expect((await firstPane(stubbed([terminal({ status })]).adapter)).agentStatus).toEqual(expected as never)
  })

  test("a self-reporting harness silent past the startup window reads as blocked; others and early ones do not", async () => {
    const silent = terminal({ reported: false })
    expect((await firstPane(stubbed([silent], HC_STARTUP_SILENCE_MS - 1).adapter)).agentStatus?.status).toBe("unknown")
    expect((await firstPane(stubbed([silent], HC_STARTUP_SILENCE_MS).adapter)).agentStatus).toMatchObject({ status: "blocked", blockedKind: "startup" })
    const opencode = terminal({ reported: false, labels: { ch_session: "s1", ch_harness: "opencode" } })
    expect((await firstPane(stubbed([opencode], HC_STARTUP_SILENCE_MS).adapter)).agentStatus?.status).toBe("unknown")
  })
})

describe("hc spawn identity", () => {
  test("unsets every identity variable the caller did not set, and keeps those it did", async () => {
    const { adapter, calls } = stubbed([])
    await adapter.spawn({ scope: "session", name: "w", cwd: "/repo", env: { CLANKER_ID: "c-1" }, launch: { kind: "argv", argv: ["claude"] } })
    const params = calls.find(([method]) => method === "terminal.run")![1] as { argv: string[]; env: Record<string, string>; no_parent: boolean; no_notify: boolean }
    expect(params).toMatchObject({ no_parent: true, no_notify: true, env: { CLANKER_ID: "c-1", CLANKERHOUSE_MULTIPLEXER: "hc" } })
    expect(params.argv.at(-1)).toBe("claude")
    expect(params.argv).not.toContain("CLANKER_ID")
    for (const name of HC_UNSET_ON_SPAWN.filter((candidate) => candidate !== "CLANKER_ID")) expect(params.argv).toContain(name)
  })
})

describe("hc interrupt steps", () => {
  test("does nothing to a harness that is not working", async () => {
    const { adapter, calls } = stubbed([terminal({ status: { state: "idle" } })])
    expect(await adapter.interruptAgent(paneLocation("s1", "t1", "t1"))).toBe("not_working")
    expect(calls.some(([method]) => method === "terminal.keys")).toBe(false)
  })

  test("gives up after two ESCs and says so", async () => {
    const { adapter, calls } = stubbed([terminal({ status: { state: "working" } })])
    expect(HC_INTERRUPT_STEP_MS).toBeLessThan(1_000)
    expect(await adapter.interruptAgent(paneLocation("s1", "t1", "t1"))).toBe("still_working")
    expect(calls.filter(([method]) => method === "terminal.keys").map(([, params]) => params.keys)).toEqual([["esc"], ["esc"]])
  })
})

describe("hc labels and notifications", () => {
  const original = Bun.env.CLANKERHOUSE_NOTIFY_COMMAND
  afterEach(() => { if (original === undefined) delete Bun.env.CLANKERHOUSE_NOTIFY_COMMAND; else Bun.env.CLANKERHOUSE_NOTIFY_COMMAND = original })

  test("showLabels writes only differences and clears what went away", async () => {
    const { adapter, calls } = stubbed([terminal()])
    expect(await adapter.showLabels(sessionLocation("s1"), { stage: "planning", title: "x" }, { lbl_title: "x", lbl_old: "y" })).toBe(true)
    expect(calls.find(([method]) => method === "terminal.label")![1].labels).toEqual({ lbl_old: "", lbl_stage: "planning" })
    expect(await adapter.showLabels(sessionLocation("s1"), { title: "x" }, { lbl_title: "x" })).toBe(false)
  })

  test("notify is the operator's command, with title and body as arguments, and false without one", async () => {
    const { adapter } = stubbed([])
    delete Bun.env.CLANKERHOUSE_NOTIFY_COMMAND
    expect(await adapter.notify({ title: "t" })).toBe(false)
    const out = join(home, "notice")
    Bun.env.CLANKERHOUSE_NOTIFY_COMMAND = `sh -c 'printf "%s|%s" "$1" "$2" > ${out}' _`
    expect(await adapter.notify({ title: "hello world", body: "b" })).toBe(true)
    expect(await Bun.file(out).text()).toBe("hello world|b")
    Bun.env.CLANKERHOUSE_NOTIFY_COMMAND = "false"
    expect(await adapter.notify({ title: "t" })).toBe(false)
  })
})

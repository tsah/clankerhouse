/**
 * SPIKE. Runs against a real scratch core and skips when `hc` is not installed. It starts its own HC_SESSION under
 * scratch XDG directories and stops it afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HcAdapter, hcRequest, hcSocketPath } from "./hc"
import { paneLocation, sessionLocation } from "./interface"
import { ManagedMultiplexer } from "./managed"

const hc = Bun.which("hc")
const home = mkdtempSync(join(tmpdir(), "ch-hc-spike-"))
const session = `eval-spike-${process.pid}`
const env = { ...Bun.env, HC_SESSION: session, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") }
const socketPath = hcSocketPath(env)
const run = (...args: string[]) => Bun.spawnSync([hc!, ...args], { env })
const settle = (ms = 150) => Bun.sleep(ms)

describe.skipIf(!hc)("hc multiplexer adapter spike", () => {
  const adapter = new HcAdapter({ socketPath })
  beforeAll(() => { run("server", "start") })
  afterAll(() => { run("server", "stop"); rmSync(home, { recursive: true, force: true }) })

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
    expect(pane.agentStatus).toEqual({ agent: "claude-code", status: "blocked" })
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

  test("ManagedMultiplexer drives the adapter unchanged", async () => {
    const managed = new ManagedMultiplexer(adapter, { registryPath: join(home, "registry.sqlite") })
    expect(typeof managed.observe).toBe("function")
    expect((await managed.observe()).kind).toBe("hc")
  })
})

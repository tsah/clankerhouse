import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaimKey, CurrentLocation, Multiplexer, MultiplexerCapabilities, MultiplexerChange, MultiplexerSnapshot, NativeLocation, SpawnRequest } from "./interface"
import { polledChanges } from "./interface"
import { ManagedMultiplexer } from "./managed"
import { openResourceRegistry } from "../resource-registry"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A minimal third Adapter: required core only, no Runtime Capabilities, no claims. */
class StubAdapter implements Multiplexer {
  readonly kind = "stub"
  readonly focused: unknown[] = []
  readonly claims: Array<[NativeLocation, ClaimKey, string | null]> = []
  snapshot: MultiplexerSnapshot = { kind: "stub", instanceId: "stub:1", sessions: [{ id: "s1", nativeName: "one", path: "/tmp", recency: 1, attached: true, worktreePath: "", directoryPath: "", windows: [{ id: "s1:w1", index: "0", nativeName: "main", active: true, panes: [{ id: "s1:w1:p1", index: "0", pid: "", command: "", title: "", currentPath: "/tmp", activity: 1, active: true }] }] }] }
  capabilities(): MultiplexerCapabilities { return { processInfo: false, agentStatus: false, agentPrompt: false, sessionRefs: false, persistentLabels: false, durableIds: true, popup: false, worktrees: false, nativeChanges: false, argvLaunch: false, claimScopes: [] } }
  async instanceId() { return "stub:1" }
  async observe() { return this.snapshot }
  changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> { return polledChanges(() => this.observe(), 5, signal) }
  async currentLocation(): Promise<CurrentLocation | undefined> { return { kind: "stub", instanceId: "stub:1", nativeSessionId: "s1", nativeWindowId: "s1:w1", nativePaneId: "s1:w1:p1" } }
  async spawn(request: SpawnRequest) { return { nativeSessionId: request.scope === "session" ? "s2" : request.nativeSessionId, nativeWindowId: "w9", nativePaneId: "p9" } }
  async kill() {}
  async rename() {}
  async focus(location: NativeLocation) { this.focused.push(location) }
  async claim(location: NativeLocation, key: ClaimKey, value: string | null) { this.claims.push([location, key, value]) }
  async readClaim() { return undefined }
  paneAddressEnv() { return "STUB_PANE" }
  insideRuntime() { return false }
  async available() { return true }
}

describe("multiplexer interface", () => {
  test("a capability-less adapter can be absorbed, resolved, and opened through the managed layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-stub-")); roots.push(root)
    const registryPath = join(root, "resources.sqlite3")
    const adapter = new StubAdapter()
    const managed = new ManagedMultiplexer(adapter, { registryPath })
    const absorbed = await managed.absorb({ kind: "stub", instanceId: "stub:1", nativeSessionId: "s1", nativeWindowId: "s1:w1", nativePaneId: "s1:w1:p1" })
    expect(absorbed.session.location).toMatchObject({ kind: "stub", nativeSessionId: "s1" })
    expect(adapter.claims).toEqual([])
    const again = await managed.absorb({ kind: "stub", instanceId: "stub:1", nativeSessionId: "s1", nativeWindowId: "s1:w1", nativePaneId: "s1:w1:p1" })
    expect(again.session.id).toBe(absorbed.session.id)
    expect(again.terminals[0]?.id).toBe(absorbed.terminals[0]?.id)

    const resolved = await managed.resolve({ management: "managed", resourceId: absorbed.terminals[0]!.id })
    expect(resolved).toMatchObject({ nativePaneId: "s1:w1:p1" })
    await managed.openTarget({ type: "window", session: "one", windowId: "s1:w1", pane: "s1:w1:p1", management: "managed", resourceId: absorbed.terminals[0]!.id })
    expect(adapter.focused).toEqual([{ kind: "stub", instanceId: "stub:1", nativeSessionId: "s1", nativeWindowId: "s1:w1", nativePaneId: "s1:w1:p1", observedAt: expect.any(Number) }])

    adapter.snapshot = { ...adapter.snapshot, sessions: [] }
    await expect(managed.resolve({ management: "managed", resourceId: absorbed.terminals[0]!.id })).rejects.toThrow(/stale/)
    const registry = openResourceRegistry({ dbPath: registryPath })
    expect(registry.list({ workshopId: absorbed.workshopId })).toHaveLength(3)
    registry.close()
  })

  test("rejects locations from another runtime kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-stub-")); roots.push(root)
    const managed = new ManagedMultiplexer(new StubAdapter(), { registryPath: join(root, "resources.sqlite3") })
    await expect(managed.absorb({ kind: "other", instanceId: "stub:1", nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null })).rejects.toThrow(/Unsupported multiplexer kind/)
  })

  test("polled change stream emits only when the topology fingerprint changes", async () => {
    const adapter = new StubAdapter()
    const controller = new AbortController()
    const seen: MultiplexerChange[] = []
    const consume = (async () => { for await (const change of adapter.changes(controller.signal)) { seen.push(change); if (seen.length === 2) controller.abort() } })()
    await Bun.sleep(30)
    adapter.snapshot = { ...adapter.snapshot, sessions: [] }
    await consume
    expect(seen.map((change) => change.kind)).toEqual(["topology", "topology"])
  })

})

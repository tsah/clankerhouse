import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedMultiplexer } from "./multiplexer"
import { polledChanges, type ClaimKey, type ClaimScope, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type SpawnRequest } from "./multiplexer/interface"
import { openResourceRegistry } from "./resource-registry"
import { registerWorkshop } from "./workshop"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-multiplexer-"))
  roots.push(root)
  return join(root, "resources.sqlite3")
}

const INSTANCE = "fake:/tmp/fake.sock"

const topology = (options: { sessionId?: string; sessionResourceId?: string } = {}): MultiplexerSession[] => [{
  id: options.sessionId || "s1",
  nativeName: "native-session",
  path: "/repo",
  recency: 20,
  attached: true,
  worktreePath: "",
  directoryPath: "/repo",
  workshopId: "workshop-1",
  resourceId: options.sessionResourceId,
  windows: [
    { id: "t1", index: "0", nativeName: "editor", active: true, panes: [
      { id: "p1", index: "0", pid: "101", command: "zsh", title: "shell", currentPath: "/repo", activity: 20, active: true },
      { id: "p2", index: "1", pid: "102", command: "pi", title: "worker", currentPath: "/other", activity: 19, active: false },
    ] },
    { id: "t2", index: "1", nativeName: "logs", active: false, panes: [
      { id: "p3", index: "0", pid: "103", command: "zsh", title: "logs", currentPath: "/repo", activity: 18, active: true },
    ] },
  ],
}]

/** In-memory Adapter that records claims; durable ids are off so claims carry identity. */
class FakeAdapter implements Multiplexer {
  readonly kind = "fake"
  readonly claims: Array<[NativeLocation, ClaimKey, string | null]> = []
  readonly focused: NativeLocation[] = []
  sessions: MultiplexerSession[]
  constructor(sessions: MultiplexerSession[], readonly claimScopes: readonly ClaimScope[] = ["session", "window", "pane"]) { this.sessions = sessions }
  capabilities(): MultiplexerCapabilities { return { processInfo: false, agentStatus: false, agentPrompt: false, sessionRefs: false, persistentLabels: false, durableIds: false, popup: false, worktrees: false, nativeChanges: false, argvLaunch: false, claimScopes: this.claimScopes } }
  async instanceId() { return INSTANCE }
  async observe(): Promise<MultiplexerSnapshot> { return { kind: this.kind, instanceId: INSTANCE, sessions: structuredClone(this.sessions) } }
  changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> { return polledChanges(() => this.observe(), 5, signal) }
  async currentLocation(): Promise<CurrentLocation | undefined> { return undefined }
  async spawn(request: SpawnRequest) { return { nativeSessionId: request.scope === "session" ? "s9" : request.nativeSessionId, nativeWindowId: "t9", nativePaneId: "p9" } }
  async kill() {}
  async rename() {}
  async focus(location: NativeLocation) { this.focused.push(location) }
  async claim(location: NativeLocation, key: ClaimKey, value: string | null) { this.claims.push([location, key, value]) }
  async readClaim() { return undefined }
  paneAddressEnv() { return "FAKE_PANE" }
  insideRuntime() { return false }
  async available() { return true }
}

describe("managed multiplexer", () => {
  test("absorbs an entire session idempotently and seeds names without interpreting them", async () => {
    const registryPath = fixture()
    const adapter = new FakeAdapter(topology())
    const managed = new ManagedMultiplexer(adapter, { registryPath })
    const location = { kind: "fake", instanceId: INSTANCE, nativeSessionId: "s1", nativeWindowId: "t1", nativePaneId: "p1" }

    const first = await managed.absorb(location)
    const second = await managed.absorb(location)

    expect(second.session.id).toBe(first.session.id)
    expect(first).toMatchObject({ workshopId: "workshop-1", session: { displayName: "native-session" } })
    expect(first.windows.map((window) => window.displayName)).toEqual(["editor", "logs"])
    expect(first.terminals.map((terminal) => terminal.displayName)).toEqual(["editor.0", "editor.1", "logs"])
    expect(adapter.claims.some(([, key]) => key === "sessionId")).toBe(true)
    expect(adapter.claims.filter(([, key]) => key === "terminalId")).toHaveLength(6)

    const registry = openResourceRegistry({ dbPath: registryPath })
    expect(registry.list({ workshopId: "workshop-1" })).toHaveLength(6)
    registry.close()
  })

  test("reconciles missing windows and panes in an already absorbed session", async () => {
    const adapter = new FakeAdapter(topology())
    const managed = new ManagedMultiplexer(adapter, { registryPath: fixture() })
    const snapshot = await managed.observe()
    const absorbed = await managed.absorb({ kind: "fake", instanceId: INSTANCE, nativeSessionId: "s1", nativeWindowId: "t2", nativePaneId: "p3" }, snapshot)
    const current = await managed.observe()
    const session = current.sessions[0]!
    session.workshopId = absorbed.workshopId
    session.resourceId = absorbed.session.id
    session.windows[0]!.resourceId = absorbed.windows[0]!.id
    session.windows[0]!.panes[0]!.terminalId = absorbed.terminals[0]!.id
    session.windows.push({ id: "t9", index: "9", nativeName: "new", active: false, panes: [{ id: "p9", index: "0", pid: "900", command: "zsh", title: "new", currentPath: session.path, activity: 1, active: false }] })
    adapter.claims.length = 0

    expect(await managed.reconcileAbsorbedTopology(current)).toBe(true)
    expect(adapter.claims.some(([at, key]) => key === "windowId" && at.nativeWindowId === "t9")).toBe(true)
    expect(adapter.claims.some(([at, key]) => key === "terminalId" && at.nativePaneId === "p9")).toBe(true)
    expect(adapter.claims.some(([, key]) => key === "sessionId")).toBe(false)
  })

  test("restores a registered session's claims after a durable runtime restart dropped them", async () => {
    const registryPath = fixture()
    const workshopStatePath = join(registryPath, "..", "workshops.sqlite3")
    const parentPath = realpathSync(mkdtempSync(join(tmpdir(), "clankerhouse-restart-parent-"))); roots.push(parentPath)
    const path = `${parentPath}-feature`; roots.push(path)
    for (const argv of [["init", "-q", "-b", "main"], ["-c", "user.email=qa@example.com", "-c", "user.name=qa", "commit", "-q", "--allow-empty", "-m", "init"], ["worktree", "add", "-q", "-b", "feature", path]]) Bun.spawnSync(["git", "-C", parentPath, ...argv])
    const parent = registerWorkshop({ path: parentPath, commonDir: join(parentPath, ".git"), branch: "main" }, { dbPath: workshopStatePath })
    const workshop = registerWorkshop({ path, commonDir: join(parentPath, ".git"), branch: "feature" }, { parentWorkshopId: parent.workshopId, dbPath: workshopStatePath })
    class DurableAdapter extends FakeAdapter { override capabilities() { return { ...super.capabilities(), durableIds: true } } }
    const sessions = topology().map((session) => ({ ...session, path, worktreePath: path, directoryPath: "", workshopId: workshop.workshopId }))
    const adapter = new DurableAdapter(sessions, ["session", "pane"])
    const managed = new ManagedMultiplexer(adapter, { registryPath, workshopStatePath })
    const absorbed = await managed.absorb({ kind: "fake", instanceId: INSTANCE, nativeSessionId: "s1", nativeWindowId: "t1", nativePaneId: "p1" })

    // A cold restart keeps native ids, names, and cwd, but every claim is gone.
    const restarted = (path: string) => ({ kind: "fake", instanceId: INSTANCE, sessions: sessions.map((session) => ({ ...session, path, worktreePath: "", workshopId: undefined, resourceId: undefined, claims: {} })) })
    adapter.claims.length = 0
    expect(await managed.reconcileAbsorbedTopology(restarted(path))).toBe(true)
    const claimed = (key: ClaimKey) => adapter.claims.filter(([, claim]) => claim === key).map(([at, , value]) => [at.nativePaneId ?? at.nativeSessionId, value])
    expect(claimed("workshopId")).toEqual([["s1", workshop.workshopId]])
    expect(claimed("sessionId")).toEqual([["s1", absorbed.session.id]])
    expect(claimed("workshopParentId")).toEqual([["s1", parent.workshopId]])
    expect(claimed("terminalId")).toEqual(absorbed.terminals.map((terminal) => [terminal.location!.nativePaneId, terminal.id]))

    // A workspace whose path no longer is its Workshop's is left unmanaged.
    adapter.claims.length = 0
    expect(await managed.reconcileAbsorbedTopology(restarted("/elsewhere"))).toBe(false)
    expect(adapter.claims).toEqual([])
  })

  test("resolves managed resources from the registry rather than stale target hints", async () => {
    const registryPath = fixture()
    const registry = openResourceRegistry({ dbPath: registryPath })
    const session = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "owned", location: { kind: "fake", instanceId: INSTANCE, nativeSessionId: "s9" } })
    registry.close()

    const managed = new ManagedMultiplexer(new FakeAdapter(topology({ sessionId: "s9", sessionResourceId: session.id })), { registryPath })
    const resolved = await managed.resolve({
      management: "managed",
      resourceId: session.id,
      location: { kind: "fake", instanceId: "stale", nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null },
    })
    expect(resolved?.nativeSessionId).toBe("s9")
  })

  test("opens a session target by native name through the Adapter", async () => {
    const adapter = new FakeAdapter(topology())
    const managed = new ManagedMultiplexer(adapter, { registryPath: fixture() })
    await managed.openTarget({ type: "session", session: "native-session" })
    await managed.openTarget({ type: "window", session: "native-session", windowId: "t2", pane: "p3" })
    expect(adapter.focused).toEqual([
      { nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null },
      { nativeSessionId: "s1", nativeWindowId: "t2", nativePaneId: null },
    ])
  })

  test("does not let unknown claims mint Clankerhouse identity", async () => {
    const managed = new ManagedMultiplexer(new FakeAdapter(topology({ sessionResourceId: "mux-session-spoofed" })), { registryPath: fixture() })
    const absorbed = await managed.absorb({ kind: "fake", instanceId: INSTANCE, nativeSessionId: "s1", nativeWindowId: "t1", nativePaneId: "p1" })

    expect(absorbed.session.id).toMatch(/^mux-session-/)
    expect(absorbed.session.id).not.toBe("mux-session-spoofed")
  })

  test("rejects a registry location whose identity claim is stale", async () => {
    const registryPath = fixture()
    const registry = openResourceRegistry({ dbPath: registryPath })
    const session = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "owned", location: { kind: "fake", instanceId: INSTANCE, nativeSessionId: "s9" } })
    registry.close()

    const managed = new ManagedMultiplexer(new FakeAdapter(topology({ sessionId: "s9" })), { registryPath })
    await expect(managed.resolve({ management: "managed", resourceId: session.id })).rejects.toThrow("location is stale")
  })
})

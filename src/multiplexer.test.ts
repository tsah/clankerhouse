import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedMultiplexer, managedResourcesOf } from "./multiplexer"
import { polledChanges, type ClaimKey, type ClaimScope, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type SpawnRequest } from "./multiplexer/interface"
import { changeWorkshopLabel, registerWorkshop } from "./workshop"

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
  test("derives a Workshop's sessions, windows and terminals from its claim, identified by native id", async () => {
    const snapshot = await new FakeAdapter([...topology(), ...topology({ sessionId: "s2" }).map((session) => ({ ...session, workshopId: undefined }))]).observe()
    const resources = managedResourcesOf(snapshot, 7)
    expect([...resources.keys()]).toEqual(["s1", "t1", "p1", "p2", "t2", "p3"])
    expect(resources.get("p3")).toEqual({ id: "p3", kind: "terminal", workshopId: "workshop-1", parentId: "t2", displayName: "", location: { kind: "fake", instanceId: INSTANCE, nativeSessionId: "s1", nativeWindowId: "t2", nativePaneId: "p3", observedAt: 7 } })
    expect(resources.get("s1")).toMatchObject({ kind: "session", displayName: "native-session", parentId: null })
  })

  test("shows each session's visible Workshop Labels and leaves sessions outside Workshops alone", async () => {
    const registryPath = fixture()
    const workshopStatePath = join(registryPath, "..", "workshops.sqlite3")
    const path = realpathSync(mkdtempSync(join(tmpdir(), "clankerhouse-labels-"))); roots.push(path)
    Bun.spawnSync(["git", "-C", path, "init", "-q", "-b", "main"])
    const workshop = registerWorkshop({ path, commonDir: join(path, ".git"), branch: "main" }, { dbPath: workshopStatePath })
    changeWorkshopLabel(workshop.workshopId, "stage", "retro", workshopStatePath)
    changeWorkshopLabel(workshop.workshopId, "title", "A title", workshopStatePath)
    changeWorkshopLabel(workshop.workshopId, "_bookkeeping", "x", workshopStatePath)
    const shown: Array<[string, Record<string, string>, Record<string, string> | undefined]> = []
    class LabelAdapter extends FakeAdapter {
      async showLabels(location: NativeLocation, labels: Readonly<Record<string, string>>, current: Readonly<Record<string, string>> | undefined) {
        shown.push([location.nativeSessionId, { ...labels }, current ? { ...current } : undefined])
        return true
      }
    }
    const sessions = [
      ...topology({ sessionResourceId: "mux-session-1" }).map((session) => ({ ...session, workshopId: workshop.workshopId, shownLabels: { lbl_old: "x" } })),
      ...topology({ sessionId: "s2" }).map((session) => ({ ...session, workshopId: undefined })),
      // A session without claims belongs to the Workshop at its path, as its row does.
      ...topology({ sessionId: "s3" }).map((session) => ({ ...session, path, workshopId: undefined })),
    ]
    const managed = new ManagedMultiplexer(new LabelAdapter(sessions), { workshopStatePath })
    expect(await managed.mirrorWorkshopLabels(await managed.observe())).toBe(2)
    expect(shown).toEqual([["s1", { stage: "retro" }, { lbl_old: "x" }], ["s3", { stage: "retro" }, undefined]])
    // An Adapter that cannot show labels is skipped.
    expect(await new ManagedMultiplexer(new FakeAdapter(sessions), { workshopStatePath }).mirrorWorkshopLabels(await managed.observe())).toBe(0)
  })

  test("resolves a managed resource by its native id, wherever its target hint points", async () => {
    const managed = new ManagedMultiplexer(new FakeAdapter(topology({ sessionId: "s9" })))
    const resolved = await managed.resolve({
      management: "managed",
      resourceId: "s9",
      location: { kind: "fake", instanceId: "stale", nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null },
    })
    expect(resolved?.nativeSessionId).toBe("s9")
  })

  test("refuses a managed resource that no longer exists", async () => {
    const managed = new ManagedMultiplexer(new FakeAdapter(topology({ sessionId: "s9" })))
    await expect(managed.resolve({ management: "managed", resourceId: "s1" })).rejects.toThrow("no longer exists")
  })

  test("opens a session target by native name through the Adapter", async () => {
    const adapter = new FakeAdapter(topology())
    const managed = new ManagedMultiplexer(adapter)
    await managed.openTarget({ type: "session", session: "native-session" })
    await managed.openTarget({ type: "window", session: "native-session", windowId: "t2", pane: "p3" })
    expect(adapter.focused).toEqual([
      { nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null },
      { nativeSessionId: "s1", nativeWindowId: "t2", nativePaneId: null },
    ])
  })

  test("a session without a Workshop claim is not managed, and ensuring it claims the Workshop at its path", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clankerhouse-ensure-"))); roots.push(root)
    Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"])
    const workshopStatePath = join(root, "workshops.sqlite3")
    const workshop = registerWorkshop({ path: root, commonDir: join(root, ".git"), branch: "main" }, { dbPath: workshopStatePath })
    // A spoofed resource id claim mints nothing: the session's identity is its native id, its Workshop the one at its path.
    const sessions = topology().map((session) => ({ ...session, path: root, workshopId: undefined, resourceId: "mux-session-spoofed", windows: session.windows.map((window) => ({ ...window, panes: window.panes.map((pane) => ({ ...pane, currentPath: root })) })) }))
    const adapter = new FakeAdapter(sessions)
    expect(managedResourcesOf(await adapter.observe()).size).toBe(0)
    const managed = new ManagedMultiplexer(adapter, { workshopStatePath })
    const ensured = await managed.ensureManagedSession("native-session")
    expect(ensured.sessionId).toBe("s1")
    expect(adapter.claims).toEqual([[{ nativeSessionId: "s1", nativeWindowId: null, nativePaneId: null }, "workshopId", ensured.workshopId]])
    expect(ensured.workshopId).toBe(workshop.workshopId)
  })
})

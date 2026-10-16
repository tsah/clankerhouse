import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openResourceRegistry, resourceRegistryStatePath, type NativeLocationInput } from "./resource-registry"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-resources-"))
  roots.push(root)
  return { root, dbPath: join(root, "state", "clankerhouse", "resources.sqlite3") }
}

const sessionLocation = (nativeSessionId = "$1"): NativeLocationInput => ({
  kind: "herdr", instanceId: "server-a", nativeSessionId,
})

describe("resource registry", () => {
  test("uses a separate versioned state database", () => {
    const { root, dbPath } = fixture()
    expect(resourceRegistryStatePath(root, {})).toBe(join(root, "clankerhouse-herdr", "resources.sqlite3"))
    expect(resourceRegistryStatePath(root, {})).not.toContain("workshops.sqlite3")
    const registry = openResourceRegistry({ dbPath })
    registry.close()
  })

  test("idempotently inserts by native identity and keeps mutable names out of identity", () => {
    const { dbPath } = fixture()
    const registry = openResourceRegistry({ dbPath })
    const first = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "old", location: sessionLocation() }, { now: 10 })
    const second = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "new", location: sessionLocation() }, { now: 20 })

    expect(first.id).toMatch(/^mux-session-/)
    expect(second).toMatchObject({ id: first.id, displayName: "new", createdAt: 10, updatedAt: 20 })
    expect(registry.list()).toHaveLength(1)
    registry.close()
  })

  test("validates parent kind and workshop ownership", () => {
    const { dbPath } = fixture()
    const registry = openResourceRegistry({ dbPath })
    const session = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "session" }, { now: 1 })
    expect(() => registry.upsert({ kind: "window", workshopId: "workshop-2", parentId: session.id, displayName: "window" })).toThrow(/different workshop/)
    expect(() => registry.upsert({ kind: "terminal", workshopId: "workshop-1", parentId: session.id, displayName: "pane" })).toThrow(/window parent/)
    expect(registry.list()).toHaveLength(1)
    registry.close()
  })

  test("replaces locations and looks them up using the complete scoped native identity", () => {
    const { dbPath } = fixture()
    const registry = openResourceRegistry({ dbPath })
    const session = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "session", location: sessionLocation("$1") }, { now: 1 })
    const moved = registry.updateLocation(session.id, { ...sessionLocation("$2"), observedAt: 15 }, { now: 20 })

    expect(registry.findByNativeLocation(sessionLocation("$1"))).toBeUndefined()
    expect(registry.findByNativeLocation(sessionLocation("$2"))?.id).toBe(session.id)
    expect(registry.findByNativeLocation({ ...sessionLocation("$2"), instanceId: "server-b" })).toBeUndefined()
    expect(registry.findByNativeLocation({ ...sessionLocation("$2"), kind: "zellij" })).toBeUndefined()
    expect(moved.location?.observedAt).toBe(15)
    registry.close()
  })

  test("rejects duplicate native location claims", () => {
    const { dbPath } = fixture()
    const registry = openResourceRegistry({ dbPath })
    const first = registry.upsert({ id: "mux-session-first", kind: "session", workshopId: "workshop-1", displayName: "first", location: sessionLocation() })
    registry.upsert({ id: "mux-session-second", kind: "session", workshopId: "workshop-1", displayName: "second" })

    expect(() => registry.updateLocation("mux-session-second", sessionLocation())).toThrow(/already claimed/)
    expect(registry.findByNativeLocation(sessionLocation())?.id).toBe(first.id)
    registry.close()
  })

  test("persists resources, hierarchy, and locations across reopen", () => {
    const { dbPath } = fixture()
    const first = openResourceRegistry({ dbPath })
    const session = first.upsert({ kind: "session", workshopId: "workshop-1", displayName: "session", location: sessionLocation() }, { now: 1 })
    const window = first.upsert({
      kind: "window", workshopId: "workshop-1", parentId: session.id, displayName: "editor",
      location: { ...sessionLocation(), nativeWindowId: "@1" },
    }, { now: 2 })
    const terminal = first.upsert({
      kind: "terminal", workshopId: "workshop-1", parentId: window.id, displayName: "shell",
      location: { ...sessionLocation(), nativeWindowId: "@1", nativePaneId: "%1" },
    }, { now: 3 })
    first.close()

    const reopened = openResourceRegistry({ dbPath })
    expect(window.id).toMatch(/^mux-window-/)
    expect(terminal.id).toMatch(/^terminal-/)
    expect(reopened.get(terminal.id)).toMatchObject({ parentId: window.id, workshopId: "workshop-1", displayName: "shell" })
    expect(reopened.findByNativeLocation({ ...sessionLocation(), nativeWindowId: "@1", nativePaneId: "%1" })?.id).toBe(terminal.id)
    expect(reopened.list({ workshopId: "workshop-1" })).toHaveLength(3)
    reopened.close()
  })

  test("renames display metadata without changing resource identity or location", () => {
    const { dbPath } = fixture()
    const registry = openResourceRegistry({ dbPath })
    const session = registry.upsert({ kind: "session", workshopId: "workshop-1", displayName: "old", location: sessionLocation() }, { now: 1 })
    const renamed = registry.updateDisplayName(session.id, "new", { now: 2 })
    expect(renamed).toMatchObject({ id: session.id, displayName: "new", location: session.location, updatedAt: 2 })
    registry.close()
  })
})

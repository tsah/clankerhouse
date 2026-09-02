import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TmuxMultiplexer, type MultiplexerCommand } from "./multiplexer"
import { openResourceRegistry } from "./resource-registry"
import { tmuxFields } from "./tmux-fields"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-multiplexer-"))
  roots.push(root)
  return join(root, "resources.sqlite3")
}

const topologyCommand = (calls: string[][], options: { sessionId?: string; sessionResourceId?: string } = {}): MultiplexerCommand => async (argv) => {
  calls.push(argv)
  if (argv[0] === "display-message" && argv.at(-1) === "#{socket_path}") return { stdout: "/tmp/tmux.sock", stderr: "", code: 0 }
  if (argv[0] === "show-options") return { stdout: "epoch-1", stderr: "", code: 0 }
  if (argv[0] === "list-sessions") return {
    stdout: tmuxFields(options.sessionId || "$1", "native-session", "10", "20", "5", "/repo", "", "/repo", "1", "", "workshop-1", "", options.sessionResourceId || "", ""),
    stderr: "",
    code: 0,
  }
  if (argv[0] === "list-panes") return {
    stdout: [
      tmuxFields(options.sessionId || "$1", "@1", "0", "editor", "1", "%1", "0", "101", "zsh", "shell", "/repo", "20", "1", "", "", "", "", "", ""),
      tmuxFields(options.sessionId || "$1", "@1", "0", "editor", "1", "%2", "1", "102", "pi", "worker", "/other", "19", "0", "", "", "", "", "", ""),
      tmuxFields(options.sessionId || "$1", "@2", "1", "logs", "0", "%3", "0", "103", "zsh", "logs", "/repo", "18", "1", "", "", "", "", "", ""),
    ].join("\n"),
    stderr: "",
    code: 0,
  }
  if (argv[0] === "set-option") return { stdout: "", stderr: "", code: 0 }
  throw new Error(`Unexpected tmux command: ${argv.join(" ")}`)
}

describe("tmux multiplexer adapter", () => {
  test("observes complete topology using opaque native ids", async () => {
    const calls: string[][] = []
    const snapshot = await new TmuxMultiplexer({ command: topologyCommand(calls) }).observe()

    expect(snapshot).toMatchObject({ kind: "tmux", instanceId: "tmux:/tmp/tmux.sock:epoch-1" })
    expect(snapshot.sessions[0]).toMatchObject({ id: "$1", nativeName: "native-session", workshopId: "workshop-1" })
    expect(snapshot.sessions[0]?.windows.map((window) => [window.id, window.panes.map((pane) => pane.id)])).toEqual([
      ["@1", ["%1", "%2"]],
      ["@2", ["%3"]],
    ])
    expect(calls.some((argv) => argv[0] === "list-panes" && argv.includes("-a"))).toBe(true)
  })

  test("absorbs an entire session idempotently and seeds names without interpreting them", async () => {
    const calls: string[][] = []
    const registryPath = fixture()
    const adapter = new TmuxMultiplexer({ command: topologyCommand(calls), registryPath })
    const location = { kind: "tmux", instanceId: "tmux:/tmp/tmux.sock:epoch-1", nativeSessionId: "$1", nativeWindowId: "@1", nativePaneId: "%1" }

    const first = await adapter.absorb(location)
    const second = await adapter.absorb(location)

    expect(second.session.id).toBe(first.session.id)
    expect(first).toMatchObject({ workshopId: "workshop-1", session: { displayName: "native-session" } })
    expect(first.windows.map((window) => window.displayName)).toEqual(["editor", "logs"])
    expect(first.terminals.map((terminal) => terminal.displayName)).toEqual(["editor.0", "editor.1", "logs"])
    expect(first.terminals).toHaveLength(3)
    expect(calls.some((argv) => argv.includes("@clankerhouse_session_id"))).toBe(true)
    expect(calls.filter((argv) => argv.includes("@clankerhouse_terminal_id"))).toHaveLength(6)

    const registry = openResourceRegistry({ dbPath: registryPath })
    expect(registry.list({ workshopId: "workshop-1" })).toHaveLength(6)
    registry.close()
  })

  test("reconciles missing windows and panes in an already absorbed session", async () => {
    const calls: string[][] = []
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-multiplexer-"))
    roots.push(root)
    const registryPath = join(root, "resources.sqlite3")
    const command = topologyCommand(calls)
    const multiplexer = new TmuxMultiplexer({ command, registryPath })
    const snapshot = await multiplexer.observe()
    const absorbed = await multiplexer.absorb({ kind: "tmux", instanceId: snapshot.instanceId, nativeSessionId: "$1", nativeWindowId: "@2", nativePaneId: "%3" }, snapshot)
    const current = await multiplexer.observe()
    const session = current.sessions[0]!
    session.workshopId = absorbed.workshopId
    session.resourceId = absorbed.session.id
    session.windows[0]!.resourceId = absorbed.windows[0]!.id
    session.windows[0]!.panes[0]!.terminalId = absorbed.terminals[0]!.id
    session.windows.push({ id: "@9", index: "9", nativeName: "new", active: false, panes: [{ id: "%9", index: "0", pid: "900", command: "zsh", title: "new", currentPath: session.path, activity: 1, active: false }] })
    calls.length = 0

    expect(await multiplexer.reconcileAbsorbedTopology(current)).toBe(true)
    expect(calls.some((argv) => argv.includes("@clankerhouse_window_id") && argv.includes("@9"))).toBe(true)
    expect(calls.some((argv) => argv.includes("@clankerhouse_terminal_id") && argv.includes("%9"))).toBe(true)
    expect(calls.some((argv) => argv.includes("@clankerhouse_session_id"))).toBe(false)
  })

  test("resolves managed resources from the registry rather than stale target hints", async () => {
    const registryPath = fixture()
    const registry = openResourceRegistry({ dbPath: registryPath })
    const session = registry.upsert({
      kind: "session",
      workshopId: "workshop-1",
      displayName: "owned",
      location: { kind: "tmux", instanceId: "tmux:/tmp/tmux.sock:epoch-1", nativeSessionId: "$9" },
    })
    registry.close()

    const adapter = new TmuxMultiplexer({ command: topologyCommand([], { sessionId: "$9", sessionResourceId: session.id }), registryPath })
    const resolved = await adapter.resolve({
      management: "managed",
      resourceId: session.id,
      location: { kind: "tmux", instanceId: "stale", nativeSessionId: "$1", nativeWindowId: null, nativePaneId: null },
    })
    expect(resolved?.nativeSessionId).toBe("$9")
  })

  test("opens and observes against the explicit requesting client", async () => {
    const calls: string[][] = []
    const command: MultiplexerCommand = async (argv) => {
      calls.push(argv)
      if (argv[0] === "list-clients") return { stdout: tmuxFields("/dev/pts/9", "$2", "@2", "%2"), stderr: "", code: 0 }
      if (argv[0] === "display-message") return { stdout: "/tmp/tmux.sock", stderr: "", code: 0 }
      return { stdout: "", stderr: "", code: 0 }
    }
    const adapter = new TmuxMultiplexer({ command })

    expect(await adapter.currentLocation("/dev/pts/9")).toMatchObject({ nativeSessionId: "$2" })
    await adapter.open({ nativeSessionId: "$3", nativeWindowId: null, nativePaneId: null }, "/dev/pts/9")

    expect(calls[0]).toEqual(["list-clients", "-F", expect.any(String)])
    expect(calls).toContainEqual(["switch-client", "-c", "/dev/pts/9", "-t", "$3"])
  })

  test("does not let unknown tmux claims mint Clankerhouse identity", async () => {
    const registryPath = fixture()
    const adapter = new TmuxMultiplexer({ command: topologyCommand([], { sessionResourceId: "mux-session-spoofed" }), registryPath })
    const absorbed = await adapter.absorb({
      kind: "tmux",
      instanceId: "tmux:/tmp/tmux.sock:epoch-1",
      nativeSessionId: "$1",
      nativeWindowId: "@1",
      nativePaneId: "%1",
    })

    expect(absorbed.session.id).toMatch(/^mux-session-/)
    expect(absorbed.session.id).not.toBe("mux-session-spoofed")
  })

  test("rejects a registry location whose tmux identity claim is stale", async () => {
    const registryPath = fixture()
    const registry = openResourceRegistry({ dbPath: registryPath })
    const session = registry.upsert({
      kind: "session",
      workshopId: "workshop-1",
      displayName: "owned",
      location: { kind: "tmux", instanceId: "tmux:/tmp/tmux.sock:epoch-1", nativeSessionId: "$9" },
    })
    registry.close()

    const adapter = new TmuxMultiplexer({ command: topologyCommand([], { sessionId: "$9" }), registryPath })
    await expect(adapter.resolve({ management: "managed", resourceId: session.id })).rejects.toThrow("location is stale")
  })
})

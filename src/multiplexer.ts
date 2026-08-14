import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { openResourceRegistry, type MultiplexerLocation, type ResourceRecord } from "./resource-registry"
import { parseTmuxFields, tmuxFields } from "./tmux-fields"
import { identifyWorkshopSync, persistWorkshopLineage, workshopForPath } from "./workshop"

export interface MultiplexerPane {
  id: string
  index: string
  pid: string
  command: string
  title: string
  currentPath: string
  activity: number
  active: boolean
  terminalId?: string
  displayName?: string
  clankerId?: string
  harness?: string
  harnessSessionId?: string
}

export interface MultiplexerWindow {
  id: string
  index: string
  nativeName: string
  active: boolean
  resourceId?: string
  displayName?: string
  panes: MultiplexerPane[]
}

export interface MultiplexerSession {
  id: string
  nativeName: string
  path: string
  recency: number
  attached: boolean
  worktreePath: string
  directoryPath: string
  workshopId?: string
  parentWorkshopId?: string | null
  resourceId?: string
  displayName?: string
  windows: MultiplexerWindow[]
}

export interface MultiplexerSnapshot {
  kind: "tmux"
  instanceId: string
  sessions: MultiplexerSession[]
}

export interface MultiplexerTarget {
  management?: "managed" | "unmanaged"
  resourceId?: string
  location?: Omit<MultiplexerLocation, "observedAt">
}

export type OpenMultiplexerTarget =
  | ({ type: "tmux_session"; session: string } & MultiplexerTarget)
  | ({ type: "tmux_window"; session: string; windowId: string; pane: string } & MultiplexerTarget)

export interface AbsorbedSession {
  workshopId: string
  session: ResourceRecord
  windows: ResourceRecord[]
  terminals: ResourceRecord[]
}

export type MultiplexerCommand = (argv: string[], options?: { allowFailure?: boolean; interactive?: boolean }) => Promise<{ stdout: string; stderr: string; code: number }>

const tmux = async (argv: string[], options: { allowFailure?: boolean; interactive?: boolean } = {}) => {
  if (options.interactive) {
    const proc = Bun.spawn(["tmux", ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    if (code !== 0 && !options.allowFailure) throw new Error(`tmux ${argv.join(" ")} exited ${code}`)
    return { stdout: "", stderr: "", code }
  }
  const proc = Bun.spawn(["tmux", ...argv], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0 && !options.allowFailure) throw new Error(stderr.trim() || `tmux ${argv.join(" ")} exited ${code}`)
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

const canonicalPath = (path: string) => {
  try { return realpathSync(path) }
  catch { return resolve(path) }
}

const sessionFormat = tmuxFields(
  "#{session_id}", "#{session_name}", "#{session_last_attached}", "#{session_activity}", "#{session_created}",
  "#{@dotfiles_worktree_path}", "#{@dotfiles_directory_path}", "#{session_path}", "#{session_attached}",
  "#{@clankerhouse_workshop_id}", "#{@dotfiles_workshop_id}", "#{@dotfiles_workshop_parent_id}",
  "#{@clankerhouse_session_id}", "#{@clankerhouse_display_name}",
)

const paneFormat = tmuxFields(
  "#{session_id}", "#{window_id}", "#{window_index}", "#{window_name}", "#{window_active}",
  "#{pane_id}", "#{pane_index}", "#{pane_pid}", "#{pane_current_command}", "#{pane_title}",
  "#{pane_current_path}", "#{window_activity}", "#{pane_active}",
  "#{@clankerhouse_window_id}", "#{@clankerhouse_window_display_name}",
  "#{@clankerhouse_terminal_id}", "#{@clankerhouse_terminal_display_name}",
  "#{@clankerhouse_clanker_id}", "#{@dotfiles_harness}", "#{@clankerhouse_harness_session_id}",
)

export class TmuxMultiplexer {
  readonly kind = "tmux" as const
  private readonly command: MultiplexerCommand
  private readonly registryPath?: string

  constructor(options: { command?: MultiplexerCommand; registryPath?: string } = {}) {
    this.command = options.command ?? tmux
    this.registryPath = options.registryPath
  }

  async instanceId() {
    const [socket, initialEpoch] = await Promise.all([
      this.command(["display-message", "-p", "#{socket_path}"], { allowFailure: true }),
      this.command(["show-options", "-gqv", "@clankerhouse_server_epoch"], { allowFailure: true }),
    ])
    let epoch = initialEpoch.stdout
    if (!epoch) {
      await this.command(["set-option", "-goq", "@clankerhouse_server_epoch", randomUUID()], { allowFailure: true })
      epoch = (await this.command(["show-options", "-gqv", "@clankerhouse_server_epoch"], { allowFailure: true })).stdout
    }
    return `tmux:${socket.stdout || "default"}:${epoch || "legacy"}`
  }

  async observe(): Promise<MultiplexerSnapshot> {
    const [instanceId, listedSessions, listedPanes] = await Promise.all([
      this.instanceId(),
      this.command(["list-sessions", "-F", sessionFormat], { allowFailure: true }),
      this.command(["list-panes", "-a", "-F", paneFormat], { allowFailure: true }),
    ])
    if (listedSessions.code !== 0) return { kind: "tmux", instanceId, sessions: [] }
    const bySession = new Map<string, MultiplexerSession>()
    for (const line of listedSessions.stdout.split("\n").filter(Boolean)) {
      const parts = parseTmuxFields(line)
      const id = parts[0] ?? ""
      const nativeName = parts[1] ?? ""
      if (!id || !nativeName) continue
      const worktreePath = parts[5] ?? ""
      const directoryPath = parts[6] ?? ""
      const sessionPath = parts[7] ?? ""
      bySession.set(id, {
        id,
        nativeName,
        recency: Math.max(Number(parts[2] ?? 0) || 0, Number(parts[3] ?? 0) || 0, Number(parts[4] ?? 0) || 0),
        path: canonicalPath(worktreePath || directoryPath || sessionPath),
        attached: Number(parts[8] ?? 0) > 0,
        worktreePath,
        directoryPath,
        workshopId: parts[9] || parts[10] || undefined,
        parentWorkshopId: parts[11] || undefined,
        resourceId: parts[12] || undefined,
        displayName: parts[13] || undefined,
        windows: [],
      })
    }
    const windows = new Map<string, MultiplexerWindow>()
    if (listedPanes.code === 0) for (const line of listedPanes.stdout.split("\n").filter(Boolean)) {
      const parts = parseTmuxFields(line)
      const session = bySession.get(parts[0] ?? "")
      const windowId = parts[1] ?? ""
      const paneId = parts[5] ?? ""
      if (!session || !windowId || !paneId) continue
      const key = `${session.id}:${windowId}`
      let window = windows.get(key)
      if (!window) {
        window = {
          id: windowId,
          index: parts[2] ?? "",
          nativeName: parts[3] ?? "",
          active: parts[4] === "1",
          resourceId: parts[13] || undefined,
          displayName: parts[14] || undefined,
          panes: [],
        }
        windows.set(key, window)
        session.windows.push(window)
      }
      window.panes.push({
        id: paneId,
        index: parts[6] ?? "",
        pid: parts[7] ?? "",
        command: (parts[8] ?? "").toLowerCase(),
        title: parts[9] ?? "",
        currentPath: canonicalPath(parts[10] || session.path),
        activity: Number(parts[11] ?? 0) || 0,
        active: parts[12] === "1",
        terminalId: parts[15] || undefined,
        displayName: parts[16] || undefined,
        clankerId: parts[17] || undefined,
        harness: parts[18] || undefined,
        harnessSessionId: parts[19] || undefined,
      })
    }
    return { kind: "tmux", instanceId, sessions: [...bySession.values()] }
  }

  async currentLocation(): Promise<Omit<MultiplexerLocation, "observedAt"> | undefined> {
    const result = await this.command(["display-message", "-p", tmuxFields("#{session_id}", "#{window_id}", "#{pane_id}")], { allowFailure: true })
    if (result.code !== 0) return undefined
    const [nativeSessionId = "", nativeWindowId = "", nativePaneId = ""] = parseTmuxFields(result.stdout)
    if (!nativeSessionId) return undefined
    return { kind: "tmux", instanceId: await this.instanceId(), nativeSessionId, nativeWindowId: nativeWindowId || null, nativePaneId: nativePaneId || null }
  }

  private workshopFor(session: MultiplexerSession, pane: MultiplexerPane) {
    if (session.workshopId) return session.workshopId
    const path = canonicalPath(pane.currentPath || session.path)
    const existing = workshopForPath(path)
    if (existing) return existing.workshopId
    try {
      const identity = identifyWorkshopSync(path)
      return persistWorkshopLineage(identity)?.workshopId ?? `path-${createHash("sha256").update(identity.path).digest("hex").slice(0, 24)}`
    } catch {
      return `directory-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`
    }
  }

  async absorb(location: Omit<MultiplexerLocation, "observedAt">): Promise<AbsorbedSession> {
    if (location.kind !== "tmux") throw new Error(`Unsupported multiplexer kind: ${location.kind}`)
    const snapshot = await this.observe()
    if (snapshot.instanceId !== location.instanceId) throw new Error("Multiplexer instance changed before absorption")
    const session = snapshot.sessions.find((candidate) => candidate.id === location.nativeSessionId)
    if (!session) throw new Error("Tmux session disappeared before absorption")
    const selectedPane = session.windows.flatMap((window) => window.panes).find((pane) => pane.id === location.nativePaneId)
      ?? session.windows.find((window) => window.active)?.panes.find((pane) => pane.active)
      ?? session.windows.flatMap((window) => window.panes)[0]
    if (!selectedPane) throw new Error("Tmux session has no terminal panes")
    const workshopId = this.workshopFor(session, selectedPane)
    const now = Date.now()
    const registry = openResourceRegistry({ dbPath: this.registryPath })
    try {
      const claimed = registry.transaction(() => {
        const registeredId = (id: string | undefined, kind: ResourceRecord["kind"], parentId: string | null) => {
          if (!id) return undefined
          const resource = registry.get(id)
          return resource?.kind === kind && resource.workshopId === workshopId && resource.parentId === parentId ? id : undefined
        }
        const sessionRecord = registry.upsert({
          id: registeredId(session.resourceId, "session", null),
          kind: "session",
          workshopId,
          displayName: session.displayName || session.nativeName,
          location: { kind: "tmux", instanceId: snapshot.instanceId, nativeSessionId: session.id, observedAt: now },
        }, { now })
        const windowRecords: ResourceRecord[] = []
        const terminalRecords: ResourceRecord[] = []
        for (const window of session.windows) {
          const windowRecord = registry.upsert({
            id: registeredId(window.resourceId, "window", sessionRecord.id),
            kind: "window",
            workshopId,
            parentId: sessionRecord.id,
            displayName: window.displayName || window.nativeName || `window ${window.index}`,
            location: { kind: "tmux", instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, observedAt: now },
          }, { now })
          windowRecords.push(windowRecord)
          for (const pane of window.panes) {
            const displayName = pane.displayName || (window.panes.length > 1 ? `${windowRecord.displayName}.${pane.index}` : windowRecord.displayName)
            terminalRecords.push(registry.upsert({
              id: registeredId(pane.terminalId, "terminal", windowRecord.id),
              kind: "terminal",
              workshopId,
              parentId: windowRecord.id,
              displayName,
              location: { kind: "tmux", instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: pane.id, observedAt: now },
            }, { now }))
          }
        }
        return { workshopId, session: sessionRecord, windows: windowRecords, terminals: terminalRecords }
      })
      await this.command(["set-option", "-t", session.id, "@clankerhouse_workshop_id", workshopId])
      await this.command(["set-option", "-t", session.id, "@clankerhouse_session_id", claimed.session.id])
      await this.command(["set-option", "-t", session.id, "@clankerhouse_display_name", claimed.session.displayName])
      for (let index = 0; index < session.windows.length; index += 1) {
        const window = session.windows[index]!
        const record = claimed.windows[index]!
        await this.command(["set-option", "-w", "-t", window.id, "@clankerhouse_window_id", record.id])
        await this.command(["set-option", "-w", "-t", window.id, "@clankerhouse_window_display_name", record.displayName])
        for (const pane of window.panes) {
          const terminal = claimed.terminals.find((candidate) => candidate.location?.nativePaneId === pane.id)!
          await this.command(["set-option", "-p", "-t", pane.id, "@clankerhouse_terminal_id", terminal.id])
          await this.command(["set-option", "-p", "-t", pane.id, "@clankerhouse_terminal_display_name", terminal.displayName])
        }
      }
      return claimed
    } finally { registry.close() }
  }

  async resolve(target: MultiplexerTarget) {
    if (target.management === "managed" && target.resourceId) {
      const registry = openResourceRegistry({ dbPath: this.registryPath })
      try {
        const resource = registry.get(target.resourceId)
        if (!resource?.location) throw new Error(`Managed resource has no current location: ${target.resourceId}`)
        const snapshot = await this.observe()
        const session = snapshot.sessions.find((candidate) => candidate.id === resource.location?.nativeSessionId)
        const window = session?.windows.find((candidate) => candidate.id === resource.location?.nativeWindowId)
        const pane = window?.panes.find((candidate) => candidate.id === resource.location?.nativePaneId)
        const claimed = resource.kind === "session" ? session?.resourceId : resource.kind === "window" ? window?.resourceId : pane?.terminalId
        if (snapshot.instanceId !== resource.location.instanceId || claimed !== resource.id) throw new Error(`Managed resource location is stale: ${target.resourceId}`)
        return resource.location
      } finally { registry.close() }
    }
    if (!target.location) return undefined
    if (target.management === "unmanaged") await this.absorb(target.location)
    return { ...target.location, observedAt: Date.now() }
  }

  async open(location: Pick<MultiplexerLocation, "nativeSessionId" | "nativeWindowId" | "nativePaneId">) {
    if (!Bun.env.TMUX) {
      const argv = ["attach-session", "-t", location.nativeSessionId]
      if (location.nativeWindowId) argv.push(";", "select-window", "-t", location.nativeWindowId)
      if (location.nativePaneId) argv.push(";", "select-pane", "-t", location.nativePaneId)
      await this.command(argv, { interactive: true })
      return
    }
    await this.command(["switch-client", "-t", location.nativeSessionId])
    if (location.nativeWindowId) await this.command(["select-window", "-t", location.nativeWindowId])
    if (location.nativePaneId) await this.command(["select-pane", "-t", location.nativePaneId])
  }

  async openTarget(target: OpenMultiplexerTarget) {
    const resolved = await this.resolve(target)
    if (resolved) {
      await this.open(resolved)
      return
    }
    if (target.type === "tmux_session") {
      await this.command([Bun.env.TMUX ? "switch-client" : "attach-session", "-t", `=${target.session}`], { interactive: !Bun.env.TMUX })
      return
    }
    if (Bun.env.TMUX) {
      await this.command(["switch-client", "-t", `=${target.session}`])
      await this.command(["select-window", "-t", target.windowId])
      return
    }
    await this.command(["attach-session", "-t", `=${target.session}`, ";", "select-window", "-t", target.windowId], { interactive: true })
  }
}

export const newManagedResourceId = (kind: "session" | "window" | "terminal") =>
  `${kind === "session" ? "mux-session" : kind === "window" ? "mux-window" : "terminal"}-${randomUUID()}`

export const ensureManagedTmuxSession = async (selector: string) => {
  const multiplexer = new TmuxMultiplexer()
  const snapshot = await multiplexer.observe()
  const session = snapshot.sessions.find((candidate) => candidate.id === selector || candidate.nativeName === selector)
  if (!session) throw new Error(`Unknown tmux session: ${selector}`)
  const pane = session.windows.find((window) => window.active)?.panes.find((candidate) => candidate.active)
    ?? session.windows.flatMap((window) => window.panes)[0]
  if (!pane) throw new Error(`Tmux session has no panes: ${selector}`)
  const window = session.windows.find((candidate) => candidate.panes.some((entry) => entry.id === pane.id))!
  return multiplexer.absorb({
    kind: "tmux",
    instanceId: snapshot.instanceId,
    nativeSessionId: session.id,
    nativeWindowId: window.id,
    nativePaneId: pane.id,
  })
}

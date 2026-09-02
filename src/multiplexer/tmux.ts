/**
 * tmux Multiplexer Adapter. All tmux command syntax and `@option` names live here.
 */
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { parseTmuxFields, tmuxFields } from "../tmux-fields"
import {
  claimScopeOf, locationScope, polledChanges,
  type AttachedClient, type ClaimKey, type ClaimMap, type CurrentLocation, type Multiplexer, type MultiplexerCapabilities, type MultiplexerChange,
  type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type MultiplexerWindow, type NativeLocation, type SpawnRequest, type SpawnResult,
} from "./interface"

export type MultiplexerCommand = (argv: string[], options?: { allowFailure?: boolean; interactive?: boolean }) => Promise<{ stdout: string; stderr: string; code: number }>

export const tmuxCommand: MultiplexerCommand = async (argv, options = {}) => {
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

/** Semantic claim key → tmux user options. The first option is read; every option is written. */
export const tmuxClaimOptions: Record<ClaimKey, readonly string[]> = {
  workshopId: ["@clankerhouse_workshop_id", "@dotfiles_workshop_id"],
  workshopParentId: ["@dotfiles_workshop_parent_id"],
  worktreePath: ["@dotfiles_worktree_path"],
  directoryPath: ["@dotfiles_directory_path"],
  gitCommonDir: ["@dotfiles_git_common_dir"],
  sessionId: ["@clankerhouse_session_id"],
  sessionDisplayName: ["@clankerhouse_display_name"],
  windowId: ["@clankerhouse_window_id"],
  windowDisplayName: ["@clankerhouse_window_display_name"],
  windowHarness: ["@dotfiles_harness"],
  terminalId: ["@clankerhouse_terminal_id"],
  terminalDisplayName: ["@clankerhouse_terminal_display_name"],
  clankerId: ["@clankerhouse_clanker_id"],
  harness: ["@dotfiles_harness"],
  harnessSessionId: ["@clankerhouse_harness_session_id"],
  recoveryAttemptId: ["@clankerhouse_recovery_attempt"],
  clankerSocket: ["@clankerhouse_clanker_socket"],
  clankerPid: ["@clankerhouse_clanker_pid"],
  clankerCapabilities: ["@clankerhouse_clanker_capabilities"],
}

const sessionFormat = tmuxFields(
  "#{session_id}", "#{session_name}", "#{session_last_attached}", "#{session_activity}", "#{session_created}",
  "#{@dotfiles_worktree_path}", "#{@dotfiles_directory_path}", "#{session_path}", "#{session_attached}",
  "#{@clankerhouse_workshop_id}", "#{@dotfiles_workshop_id}", "#{@dotfiles_workshop_parent_id}",
  "#{@clankerhouse_session_id}", "#{@clankerhouse_display_name}", "#{@dotfiles_git_common_dir}",
)

const paneFormat = tmuxFields(
  "#{session_id}", "#{window_id}", "#{window_index}", "#{window_name}", "#{window_active}",
  "#{pane_id}", "#{pane_index}", "#{pane_pid}", "#{pane_current_command}", "#{pane_title}",
  "#{pane_current_path}", "#{window_activity}", "#{pane_active}",
  "#{@clankerhouse_window_id}", "#{@clankerhouse_window_display_name}",
  "#{@clankerhouse_terminal_id}", "#{@clankerhouse_terminal_display_name}",
  "#{@clankerhouse_clanker_id}", "#{@dotfiles_harness}", "#{@clankerhouse_harness_session_id}", "#{@clankerhouse_recovery_attempt}",
  "#{@clankerhouse_clanker_socket}", "#{@clankerhouse_clanker_pid}", "#{@clankerhouse_clanker_capabilities}",
)

const withClaims = <T extends Record<string, string | undefined>>(entries: T): ClaimMap => {
  const claims: ClaimMap = {}
  for (const [key, value] of Object.entries(entries)) if (value) claims[key as ClaimKey] = value
  return claims
}

const sessionSelector = (nativeSessionId: string) => nativeSessionId.startsWith("$") ? nativeSessionId : `=${nativeSessionId}`

const scopeFlag = (location: NativeLocation) => {
  const scope = locationScope(location)
  return scope === "pane" ? ["-p", "-t", location.nativePaneId!] : scope === "window" ? ["-w", "-t", location.nativeWindowId!] : ["-t", location.nativeSessionId]
}

export class TmuxAdapter implements Multiplexer {
  readonly kind = "tmux" as const
  private readonly command: MultiplexerCommand
  private readonly pollIntervalMs: number

  constructor(options: { command?: MultiplexerCommand; pollIntervalMs?: number } = {}) {
    this.command = options.command ?? tmuxCommand
    this.pollIntervalMs = options.pollIntervalMs ?? Number(Bun.env.CLANKERHOUSE_REFRESH_MS || 15_000)
  }

  capabilities(): MultiplexerCapabilities {
    return { processInfo: false, agentStatus: false, agentPrompt: false, sessionRefs: false, persistentLabels: false, durableIds: false, popup: true, worktrees: false, clientRouting: true, nativeChanges: false, argvLaunch: true, claimScopes: ["session", "window", "pane"] }
  }

  paneAddressEnv() { return "TMUX_PANE" }
  insideRuntime() { return Boolean(Bun.env.TMUX) }

  async available() {
    return (await this.command(["display-message", "-p", "#{socket_path}"], { allowFailure: true })).code === 0
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
      const workshopId = parts[9] || parts[10] || undefined
      bySession.set(id, {
        id,
        nativeName,
        recency: Math.max(Number(parts[2] ?? 0) || 0, Number(parts[3] ?? 0) || 0, Number(parts[4] ?? 0) || 0),
        path: canonicalPath(worktreePath || directoryPath || sessionPath),
        attached: Number(parts[8] ?? 0) > 0,
        worktreePath,
        directoryPath,
        claims: withClaims({ workshopId, workshopParentId: parts[11], worktreePath, directoryPath, gitCommonDir: parts[14], sessionId: parts[12], sessionDisplayName: parts[13] }),
        workshopId,
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
          claims: withClaims({ windowId: parts[13], windowDisplayName: parts[14] }),
          resourceId: parts[13] || undefined,
          displayName: parts[14] || undefined,
          panes: [],
        }
        windows.set(key, window)
        session.windows.push(window)
      }
      const pane: MultiplexerPane = {
        id: paneId,
        index: parts[6] ?? "",
        pid: parts[7] ?? "",
        command: (parts[8] ?? "").toLowerCase(),
        title: parts[9] ?? "",
        currentPath: canonicalPath(parts[10] || session.path),
        activity: Number(parts[11] ?? 0) || 0,
        active: parts[12] === "1",
        claims: withClaims({ terminalId: parts[15], terminalDisplayName: parts[16], clankerId: parts[17], harness: parts[18], harnessSessionId: parts[19], recoveryAttemptId: parts[20], clankerSocket: parts[21], clankerPid: parts[22], clankerCapabilities: parts[23] }),
        terminalId: parts[15] || undefined,
        displayName: parts[16] || undefined,
        clankerId: parts[17] || undefined,
        harness: parts[18] || undefined,
        harnessSessionId: parts[19] || undefined,
        recoveryAttemptId: parts[20] || undefined,
      }
      window.panes.push(pane)
    }
    return { kind: "tmux", instanceId, sessions: [...bySession.values()] }
  }

  changes(signal: AbortSignal): AsyncIterable<MultiplexerChange> {
    return polledChanges(() => this.observe(), this.pollIntervalMs, signal)
  }

  async currentLocation(client?: string): Promise<CurrentLocation | undefined> {
    const result = client
      ? await this.command(["list-clients", "-F", tmuxFields("#{client_name}", "#{session_id}", "#{window_id}", "#{pane_id}")], { allowFailure: true })
      : await this.command(["display-message", "-p", tmuxFields("#{session_id}", "#{window_id}", "#{pane_id}")], { allowFailure: true })
    if (result.code !== 0) return undefined
    const fields = client
      ? result.stdout.split("\n").map(parseTmuxFields).find((parts) => parts[0] === client)?.slice(1)
      : parseTmuxFields(result.stdout)
    const [nativeSessionId = "", nativeWindowId = "", nativePaneId = ""] = fields ?? []
    if (!nativeSessionId) return undefined
    return { kind: "tmux", instanceId: await this.instanceId(), nativeSessionId, nativeWindowId: nativeWindowId || null, nativePaneId: nativePaneId || null }
  }

  async listClients(): Promise<AttachedClient[]> {
    const result = await this.command(["list-clients", "-F", tmuxFields("#{client_name}", "#{session_id}", "#{window_id}", "#{pane_id}")], { allowFailure: true })
    if (result.code !== 0) return []
    return result.stdout.split("\n").filter(Boolean).map(parseTmuxFields).flatMap(([id = "", nativeSessionId = "", nativeWindowId = "", nativePaneId = ""]) =>
      id && nativeSessionId ? [{ id, location: { nativeSessionId, nativeWindowId: nativeWindowId || null, nativePaneId: nativePaneId || null } }] : [])
  }

  private launchArgv(request: SpawnRequest) {
    const argv = request.launch?.kind === "argv" ? request.launch.argv : []
    if (!request.env || Object.keys(request.env).length === 0) return argv
    const base = argv.length > 0 ? argv : [Bun.env.SHELL || "/bin/sh"]
    return ["env", ...Object.entries(request.env).map(([key, value]) => `${key}=${value}`), ...base]
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const format = tmuxFields("#{session_id}", "#{window_id}", "#{pane_id}")
    const argv = this.launchArgv(request)
    const result = request.scope === "session"
      ? await this.command(["new-session", "-d", "-P", "-F", format, "-s", request.name, "-n", request.windowName ?? "main", "-c", request.cwd, ...argv])
      : await this.command(["new-window", "-d", "-P", "-F", format, "-t", sessionSelector(request.nativeSessionId), "-n", request.name, "-c", request.cwd, ...argv])
    const [nativeSessionId = "", nativeWindowId = "", nativePaneId = ""] = parseTmuxFields(result.stdout)
    if (!nativePaneId) throw new Error("tmux did not return a pane id")
    return { nativeSessionId, nativeWindowId, nativePaneId }
  }

  async kill(location: NativeLocation) {
    const scope = locationScope(location)
    if (scope === "pane") await this.command(["kill-pane", "-t", location.nativePaneId!])
    else if (scope === "window") await this.command(["kill-window", "-t", location.nativeWindowId!])
    else await this.command(["kill-session", "-t", location.nativeSessionId])
  }

  async rename(location: NativeLocation, name: string) {
    const scope = locationScope(location)
    if (scope === "pane") await this.command(["select-pane", "-t", location.nativePaneId!, "-T", name])
    else if (scope === "window") await this.command(["rename-window", "-t", location.nativeWindowId!, name])
    else await this.command(["rename-session", "-t", location.nativeSessionId, name])
  }

  async focus(location: NativeLocation, client?: string) {
    if (!Bun.env.TMUX && !client) {
      const argv = ["attach-session", "-t", location.nativeSessionId]
      if (location.nativeWindowId) argv.push(";", "select-window", "-t", location.nativeWindowId)
      if (location.nativePaneId) argv.push(";", "select-pane", "-t", location.nativePaneId)
      await this.command(argv, { interactive: true })
      return
    }
    await this.command(["switch-client", ...(client ? ["-c", client] : []), "-t", location.nativeSessionId])
    if (location.nativeWindowId) await this.command(["select-window", "-t", location.nativeWindowId])
    if (location.nativePaneId) await this.command(["select-pane", "-t", location.nativePaneId])
  }

  async claim(location: NativeLocation, key: ClaimKey, value: string | null) {
    const scope = claimScopeOf(key)
    const target = scope === "pane" ? ["-p", "-t", location.nativePaneId ?? ""] : scope === "window" ? ["-w", "-t", location.nativeWindowId ?? ""] : ["-t", location.nativeSessionId]
    if (!target.at(-1)) throw new Error(`Claim ${key} requires a ${scope} location`)
    for (const option of tmuxClaimOptions[key]) {
      if (value === null) await this.command(["set-option", ...(scope === "session" ? [] : [target[0]!]), "-u", "-t", target.at(-1)!, option], { allowFailure: true })
      else await this.command(["set-option", ...target, option, value])
    }
  }

  async readClaim(location: NativeLocation, key: ClaimKey) {
    const scope = claimScopeOf(key)
    const flags = scope === "pane" ? ["-p", "-t", location.nativePaneId ?? ""] : scope === "window" ? ["-w", "-t", location.nativeWindowId ?? ""] : ["-t", location.nativeSessionId]
    const result = await this.command(["show-option", ...flags, "-qv", tmuxClaimOptions[key][0]!], { allowFailure: true })
    return result.code === 0 && result.stdout ? result.stdout : undefined
  }

  /** Flags for `set-option`/`show-option` against a location, exposed for script-facing helpers. */
  static scopeFlags(location: NativeLocation) { return scopeFlag(location) }
}

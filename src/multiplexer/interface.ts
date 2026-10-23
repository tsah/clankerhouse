/**
 * The Multiplexer Interface (ADR-0007).
 *
 * A Multiplexer Adapter hosts terminal topology for Clankerhouse. The Interface is
 * expressed in Clankerhouse domain operations: every Adapter implements the required
 * core, and declares which optional Runtime Capabilities it provides. Callers gate on
 * the declaration instead of assuming a runtime. Native vocabulary (herdr workspaces,
 * tabs and tokens) never leaves the Adapter module that owns it.
 */
import type { MultiplexerLocation } from "../resource-registry"

export type MultiplexerKind = string

export interface MultiplexerCapabilities {
  /** Foreground process group, pids, argv and cwd per pane come from the runtime. */
  processInfo: boolean
  /** Runtime-derived harness status with source and confidence. */
  agentStatus: boolean
  /** Semantic prompt submission to a runtime-recognized interactive harness pane. */
  agentPrompt: boolean
  /** Harness session identity observed by the runtime. */
  sessionRefs: boolean
  /** Native labels survive a runtime restart. */
  persistentLabels: boolean
  /** Native ids survive a runtime restart. */
  durableIds: boolean
  /** Key-bound modal popup with current-location environment. */
  popup: boolean
  /** Runtime-managed worktree checkouts grouped by repository. */
  worktrees: boolean
  /** `changes()` is fed by runtime events rather than synthesized by polling. */
  nativeChanges: boolean
  /** `spawn` accepts an argv launch, not only a shell. */
  argvLaunch: boolean
  /** Scopes whose identity claims the runtime can carry on the native object. */
  claimScopes: readonly ClaimScope[]
}

export type ClaimScope = "session" | "window" | "pane"

/**
 * Identity-claim keys written on native objects. A claim is a correlation hint that a
 * child process can read from its own environment-addressed pane; the registry stays
 * authoritative (ADR-0004).
 */
export type SessionClaimKey = "workshopId" | "workshopParentId" | "worktreePath" | "directoryPath" | "gitCommonDir" | "sessionId" | "sessionDisplayName"
export type WindowClaimKey = "windowId" | "windowDisplayName" | "windowHarness"
export type PaneClaimKey = "terminalId" | "terminalDisplayName" | "clankerId" | "harness" | "harnessSessionId" | "recoveryAttemptId" | "clankerSocket" | "clankerPid" | "clankerCapabilities"
export type ClaimKey = SessionClaimKey | WindowClaimKey | PaneClaimKey

export const claimScopeOf = (key: ClaimKey): ClaimScope => {
  switch (key) {
    case "workshopId": case "workshopParentId": case "worktreePath": case "directoryPath": case "gitCommonDir": case "sessionId": case "sessionDisplayName": return "session"
    case "windowId": case "windowDisplayName": case "windowHarness": return "window"
    default: return "pane"
  }
}

export type ClaimMap = Partial<Record<ClaimKey, string>>

export interface RuntimeProcessInfo {
  shellPid?: number
  foregroundProcessGroupId?: number
  foregroundProcesses: Array<{ pid: number; name?: string; argv?: string[]; cmdline?: string; cwd?: string }>
}

export type RuntimeAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown"

export interface MultiplexerPane {
  id: string
  index: string
  /** Pid of the pane's root process, empty when unknown. */
  pid: string
  /** Lower-cased foreground command name, empty when unknown. */
  command: string
  title: string
  currentPath: string
  /** Last activity, seconds since the epoch; 0 when the runtime does not report it. */
  activity: number
  active: boolean
  /** The runtime's input focus is on this pane; present only when the runtime reports it. */
  focused?: boolean
  claims?: ClaimMap
  terminalId?: string
  displayName?: string
  clankerId?: string
  harness?: string
  harnessSessionId?: string
  recoveryAttemptId?: string
  /** Present only when the Adapter declares `processInfo`. */
  processInfo?: RuntimeProcessInfo
  /** Present only when the Adapter declares `agentStatus`. */
  agentStatus?: { agent?: string; status: RuntimeAgentStatus }
  /** Present only when the Adapter declares `sessionRefs`. */
  sessionRef?: { agent: string; kind: "id" | "path"; value: string; source: string }
}

export interface MultiplexerWindow {
  id: string
  index: string
  nativeName: string
  active: boolean
  claims?: ClaimMap
  resourceId?: string
  displayName?: string
  panes: MultiplexerPane[]
}

export interface MultiplexerSession {
  id: string
  nativeName: string
  path: string
  /** Seconds since the epoch; 0 when the runtime does not report activity. */
  recency: number
  attached: boolean
  worktreePath: string
  directoryPath: string
  claims?: ClaimMap
  workshopId?: string
  parentWorkshopId?: string | null
  resourceId?: string
  displayName?: string
  windows: MultiplexerWindow[]
}

export interface MultiplexerSnapshot {
  kind: MultiplexerKind
  instanceId: string
  sessions: MultiplexerSession[]
}

export interface ObserveOptions {
  /** Defaults to true. */
  processInfo?: boolean
}

export type NativeLocation = Pick<MultiplexerLocation, "nativeSessionId" | "nativeWindowId" | "nativePaneId">
export type CurrentLocation = Omit<MultiplexerLocation, "observedAt">

export type SpawnLaunch = { kind: "shell" } | { kind: "argv"; argv: string[] }

export type SpawnRequest =
  | { scope: "session"; name: string; cwd: string; windowName?: string; env?: Record<string, string>; launch?: SpawnLaunch }
  | { scope: "window"; nativeSessionId: string; name: string; cwd: string; env?: Record<string, string>; launch?: SpawnLaunch }

export interface SpawnResult { nativeSessionId: string; nativeWindowId: string; nativePaneId: string }

export interface MultiplexerChange {
  /** Coarse change class; consumers re-observe rather than trusting event payloads. */
  kind: "topology" | "focus" | "metadata" | "status" | "reconnect"
  at: number
}

/** Required core every Adapter implements. */
export interface Multiplexer {
  readonly kind: MultiplexerKind
  capabilities(): MultiplexerCapabilities
  /** Identity of the runtime instance that scopes Multiplexer Locations; with `durableIds` it survives a restart. */
  instanceId(): Promise<string>
  /** Identity of the running server process, which changes on every runtime restart; undefined when the runtime is unreachable. Defaults to `instanceId()`. */
  serverEpoch?(): Promise<string | undefined>
  /** `processInfo: false` lets a runtime that pays per pane for process facts skip them; pane `processInfo`, `pid`, and `command` may then be empty. */
  observe(options?: ObserveOptions): Promise<MultiplexerSnapshot>
  /** Change Stream. May be synthesized by polling. Ends when the signal aborts. */
  changes(signal: AbortSignal): AsyncIterable<MultiplexerChange>
  /** Location the runtime is currently focused on. */
  currentLocation(): Promise<CurrentLocation | undefined>
  spawn(request: SpawnRequest): Promise<SpawnResult>
  kill(location: NativeLocation): Promise<void>
  /** Change the native label of a session, window, or pane. */
  rename(location: NativeLocation, name: string): Promise<void>
  focus(location: NativeLocation): Promise<void>
  /** Submit text through the runtime's validated interactive-harness prompt operation when `agentPrompt` is declared. */
  promptAgent?(location: NativeLocation, text: string): Promise<void>
  /** Write (or clear with null) an identity claim on the native object at `location`. */
  claim(location: NativeLocation, key: ClaimKey, value: string | null): Promise<void>
  readClaim(location: NativeLocation, key: ClaimKey): Promise<string | undefined>
  /** Name of the environment variable a child process reads to learn its own pane address. */
  paneAddressEnv(): string
  /** Whether the current process is running inside this runtime. */
  insideRuntime(): boolean
  /** Reachability probe; false when the runtime server is not running. */
  available(): Promise<boolean>
}

export const sessionLocation = (nativeSessionId: string): NativeLocation => ({ nativeSessionId, nativeWindowId: null, nativePaneId: null })
export const windowLocation = (nativeSessionId: string, nativeWindowId: string): NativeLocation => ({ nativeSessionId, nativeWindowId, nativePaneId: null })
export const paneLocation = (nativeSessionId: string, nativeWindowId: string | null, nativePaneId: string): NativeLocation => ({ nativeSessionId, nativeWindowId, nativePaneId })

export const locationScope = (location: NativeLocation): ClaimScope => location.nativePaneId ? "pane" : location.nativeWindowId ? "window" : "session"

export class MultiplexerUnavailableError extends Error {
  constructor(kind: MultiplexerKind, detail: string) {
    super(`${kind} runtime is unavailable: ${detail}`)
    this.name = "MultiplexerUnavailableError"
  }
}

/** The Multiplexer server refused work because it ran out of a host resource, such as file descriptors. */
export class MultiplexerResourceExhaustedError extends Error {
  readonly code = "RESOURCE_EXHAUSTED"
  constructor(message: string) {
    super(message)
    this.name = "MultiplexerResourceExhaustedError"
  }
}

export class UnsupportedMultiplexerOperation extends Error {
  constructor(kind: MultiplexerKind, operation: string) {
    super(`${kind} adapter does not support ${operation}`)
    this.name = "UnsupportedMultiplexerOperation"
  }
}

/** Polling-based Change Stream helper for Adapters without native events. */
export async function* polledChanges(observe: () => Promise<MultiplexerSnapshot>, intervalMs: number, signal: AbortSignal): AsyncIterable<MultiplexerChange> {
  let previous = ""
  while (!signal.aborted) {
    let fingerprint = previous
    try {
      const snapshot = await observe()
      fingerprint = JSON.stringify(snapshot.sessions.map((session) => [session.id, session.nativeName, session.attached, session.claims, session.windows.map((window) => [window.id, window.nativeName, window.active, window.claims, window.panes.map((pane) => [pane.id, pane.command, pane.currentPath, pane.active, pane.claims])])]))
    } catch { fingerprint = previous }
    if (fingerprint !== previous) {
      previous = fingerprint
      yield { kind: "topology", at: Date.now() }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, intervalMs)
      const onAbort = () => { clearTimeout(timer); resolve() }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
}

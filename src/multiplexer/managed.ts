/**
 * Clankerhouse's layer over the Rex Adapter: which sessions belong to Workshops, presenting Workshop Labels, resolving
 * and opening targets. Rex ids are durable, so a native id is a resource's identity; a session is managed when it
 * carries a `workshopId` claim. Nothing here keeps its own copy of topology.
 */
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { visibleLabels } from "../labels"
import { allWorkshopLabels, identifyWorkshopSync, listWorkshopRecords, persistWorkshopLineage, workshopForPath } from "../workshop"
import {
  sessionLocation, UnsupportedMultiplexerOperation, windowLocation,
  type ClaimKey, type CurrentLocation, type ManagedResource, type Multiplexer, type MultiplexerLocation, type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type ObserveOptions, type SpawnRequest,
} from "./interface"

export interface MultiplexerTarget {
  management?: "managed" | "unmanaged"
  resourceId?: string
  location?: Omit<MultiplexerLocation, "observedAt">
}

/** The runtime kind lives on the location, not the target type. */
export type OpenMultiplexerTarget =
  | ({ type: "session"; session: string } & MultiplexerTarget)
  | ({ type: "window"; session: string; windowId: string; pane: string } & MultiplexerTarget)

export interface ManagedSession { workshopId: string; sessionId: string }

const canonicalPath = (path: string) => {
  try { return realpathSync(path) }
  catch { return resolve(path) }
}

/** Every session, window and terminal of a Workshop in one observation, keyed by native id. */
export const managedResourcesOf = (snapshot: MultiplexerSnapshot, observedAt = Date.now()): Map<string, ManagedResource> => {
  const resources = new Map<string, ManagedResource>()
  const at = (nativeSessionId: string, nativeWindowId: string | null, nativePaneId: string | null): MultiplexerLocation => ({ kind: snapshot.kind, instanceId: snapshot.instanceId, nativeSessionId, nativeWindowId, nativePaneId, observedAt })
  for (const session of snapshot.sessions) {
    if (!session.workshopId) continue
    const workshopId = session.workshopId
    resources.set(session.id, { id: session.id, kind: "session", workshopId, parentId: null, displayName: session.displayName ?? session.nativeName, location: at(session.id, null, null) })
    for (const window of session.windows) {
      resources.set(window.id, { id: window.id, kind: "window", workshopId, parentId: session.id, displayName: window.displayName ?? window.nativeName, location: at(session.id, window.id, null) })
      for (const pane of window.panes) resources.set(pane.id, { id: pane.id, kind: "terminal", workshopId, parentId: window.id, displayName: pane.displayName ?? "", location: at(session.id, window.id, pane.id) })
    }
  }
  return resources
}

export class ManagedMultiplexer {
  readonly kind: string
  readonly adapter: Multiplexer
  private readonly workshopStatePath?: string
  /** Last label-mirroring failure per session, so a repeating one is logged once. */
  private readonly labelFailures = new Map<string, string>()

  constructor(adapter: Multiplexer, options: { workshopStatePath?: string } = {}) {
    this.adapter = adapter
    this.kind = adapter.kind
    this.workshopStatePath = options.workshopStatePath
  }

  capabilities() { return this.adapter.capabilities() }
  instanceId() { return this.adapter.instanceId() }
  async serverEpoch() {
    if (this.adapter.serverEpoch) return this.adapter.serverEpoch()
    return await this.adapter.available() ? this.adapter.instanceId() : undefined
  }
  observe(options?: ObserveOptions) { return this.adapter.observe(options) }
  currentLocation() { return this.adapter.currentLocation() }
  spawn(request: SpawnRequest) { return this.adapter.spawn(request) }
  kill(location: NativeLocation) { return this.adapter.kill(location) }
  rename(location: NativeLocation, name: string) { return this.adapter.rename(location, name) }
  focus(location: NativeLocation) { return this.adapter.focus(location) }
  promptAgent(location: NativeLocation, text: string) {
    if (!this.capabilities().agentPrompt || !this.adapter.promptAgent) throw new UnsupportedMultiplexerOperation(this.kind, "agent prompt")
    return this.adapter.promptAgent(location, text)
  }
  /** Whether the runtime can stop a harness's turn and say whether it stopped. */
  supportsInterrupt() { return typeof this.adapter.interruptAgent === "function" }
  interruptAgent(location: NativeLocation) {
    if (!this.adapter.interruptAgent) throw new UnsupportedMultiplexerOperation(this.kind, "agent interrupt")
    return this.adapter.interruptAgent(location)
  }
  claim(location: NativeLocation, key: ClaimKey, value: string | null) { return this.adapter.claim(location, key, value) }
  readClaim(location: NativeLocation, key: ClaimKey) { return this.adapter.readClaim(location, key) }
  paneAddressEnv() { return this.adapter.paneAddressEnv() }
  /** Resolves false when the runtime cannot notify. */
  async notify(notice: { title: string; body?: string }) { return this.adapter.notify ? this.adapter.notify(notice) : false }
  changes(signal: AbortSignal) { return this.adapter.changes(signal) }
  available() { return this.adapter.available() }

  /** The Workshop a session belongs to: its claim, else the Workshop at its path, registered if new. */
  private workshopFor(session: MultiplexerSession, pane: MultiplexerPane | undefined) {
    if (session.workshopId) return session.workshopId
    const path = canonicalPath(pane?.currentPath || session.path)
    const existing = workshopForPath(path, this.workshopStatePath)
    if (existing) return existing.workshopId
    try {
      const identity = identifyWorkshopSync(path)
      return persistWorkshopLineage(identity, { dbPath: this.workshopStatePath })?.workshopId ?? `path-${createHash("sha256").update(identity.path).digest("hex").slice(0, 24)}`
    } catch {
      return `directory-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`
    }
  }

  /**
   * Shows each session's Workshop Labels in the runtime, so its own UI can render them. A session belongs to the
   * Workshop its claim names, else to the Workshop at its path, as the session's row does. Idempotent: only
   * differences are written. Presentation only; a session that fails is left for the next pass.
   */
  async mirrorWorkshopLabels(snapshot: MultiplexerSnapshot): Promise<number> {
    if (!this.adapter.showLabels || !snapshot.sessions.length) return 0
    const labels = allWorkshopLabels(this.workshopStatePath)
    const byPath = new Map(listWorkshopRecords(this.workshopStatePath).map((workshop) => [workshop.canonicalPath, workshop.workshopId]))
    let written = 0
    for (const session of snapshot.sessions) {
      const workshopId = session.workshopId ?? (session.path ? byPath.get(canonicalPath(session.path)) : undefined)
      const wanted = visibleLabels(workshopId ? labels.get(workshopId) : undefined)
      // A session that never showed labels and has none to show costs nothing.
      if (!Object.keys(wanted).length && !Object.keys(session.shownLabels ?? {}).length) continue
      try {
        if (await this.adapter.showLabels(sessionLocation(session.id), wanted, session.shownLabels)) written += 1
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (this.labelFailures.get(session.id) !== detail) console.error(`Unable to show Workshop labels on ${this.kind} session ${session.id}: ${detail}`)
        this.labelFailures.set(session.id, detail)
        continue
      }
      this.labelFailures.delete(session.id)
    }
    return written
  }

  /** A managed target names a native id that must still exist; an unmanaged one carries its location. */
  async resolve(target: MultiplexerTarget): Promise<MultiplexerLocation | undefined> {
    if (target.management === "managed" && target.resourceId) {
      const snapshot = await this.observe({ processInfo: false })
      const resource = managedResourcesOf(snapshot).get(target.resourceId)
      if (!resource) throw new Error(`Managed resource no longer exists: ${target.resourceId}`)
      return resource.location
    }
    if (!target.location) return undefined
    return { ...target.location, observedAt: Date.now() }
  }

  async open(location: NativeLocation) {
    await this.adapter.focus(location)
  }

  async openTarget(target: OpenMultiplexerTarget) {
    const resolved = await this.resolve(target)
    if (resolved) {
      await this.open(resolved)
      return
    }
    const snapshot = await this.observe({ processInfo: false })
    const session = snapshot.sessions.find((candidate) => candidate.nativeName === target.session || candidate.id === target.session)
    if (!session) throw new Error(`Unknown ${this.kind} session: ${target.session}`)
    if (target.type === "session") {
      await this.open(sessionLocation(session.id))
      return
    }
    await this.open(windowLocation(session.id, target.windowId))
  }

  /** Make the session that `selector` (native id or label) names a Workshop's: claim its Workshop when it has none. */
  async ensureManagedSession(selector: string): Promise<ManagedSession> {
    const snapshot = await this.observe({ processInfo: false })
    const session = snapshot.sessions.find((candidate) => candidate.id === selector || candidate.nativeName === selector)
    if (!session) throw new Error(`Unknown ${this.kind} session: ${selector}`)
    const pane = session.windows.find((window) => window.active)?.panes.find((candidate) => candidate.active)
      ?? session.windows.flatMap((window) => window.panes)[0]
    const workshopId = this.workshopFor(session, pane)
    if (session.workshopId !== workshopId) await this.adapter.claim(sessionLocation(session.id), "workshopId", workshopId)
    return { workshopId, sessionId: session.id }
  }
}

export const currentLocationOf = (location: CurrentLocation | undefined) => location

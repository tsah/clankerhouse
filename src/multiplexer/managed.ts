/**
 * Registry-backed operations layered over any Multiplexer Adapter: Absorption, Herd
 * Reconciliation of claims, managed-location resolution, and opening targets.
 * Runtime-neutral by construction: it only speaks the Multiplexer Interface.
 */
import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { openResourceRegistry, type MultiplexerLocation, type ResourceRecord } from "../resource-registry"
import { identifyWorkshopSync, persistWorkshopLineage, workshopForPath } from "../workshop"
import {
  paneLocation, sessionLocation, UnsupportedMultiplexerOperation, windowLocation,
  type ClaimKey, type CurrentLocation, type Multiplexer, type MultiplexerPane, type MultiplexerSession, type MultiplexerSnapshot, type NativeLocation, type SpawnRequest,
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

export interface AbsorbedSession {
  workshopId: string
  session: ResourceRecord
  windows: ResourceRecord[]
  terminals: ResourceRecord[]
}

const canonicalPath = (path: string) => {
  try { return realpathSync(path) }
  catch { return resolve(path) }
}

export const newManagedResourceId = (kind: "session" | "window" | "terminal") =>
  `${kind === "session" ? "mux-session" : kind === "window" ? "mux-window" : "terminal"}-${randomUUID()}`

export class ManagedMultiplexer {
  readonly kind: string
  readonly adapter: Multiplexer
  private readonly registryPath?: string

  constructor(adapter: Multiplexer, options: { registryPath?: string } = {}) {
    this.adapter = adapter
    this.kind = adapter.kind
    this.registryPath = options.registryPath
  }

  capabilities() { return this.adapter.capabilities() }
  instanceId() { return this.adapter.instanceId() }
  observe() { return this.adapter.observe() }
  currentLocation() { return this.adapter.currentLocation() }
  spawn(request: SpawnRequest) { return this.adapter.spawn(request) }
  kill(location: NativeLocation) { return this.adapter.kill(location) }
  rename(location: NativeLocation, name: string) { return this.adapter.rename(location, name) }
  focus(location: NativeLocation) { return this.adapter.focus(location) }
  promptAgent(location: NativeLocation, text: string) {
    if (!this.capabilities().agentPrompt || !this.adapter.promptAgent) throw new UnsupportedMultiplexerOperation(this.kind, "agent prompt")
    return this.adapter.promptAgent(location, text)
  }
  claim(location: NativeLocation, key: ClaimKey, value: string | null) { return this.adapter.claim(location, key, value) }
  readClaim(location: NativeLocation, key: ClaimKey) { return this.adapter.readClaim(location, key) }
  paneAddressEnv() { return this.adapter.paneAddressEnv() }
  changes(signal: AbortSignal) { return this.adapter.changes(signal) }
  available() { return this.adapter.available() }

  private supportsClaims(scope: "session" | "window" | "pane") { return this.adapter.capabilities().claimScopes.includes(scope) }

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

  async absorb(location: Omit<MultiplexerLocation, "observedAt">, observedSnapshot?: MultiplexerSnapshot): Promise<AbsorbedSession> {
    if (location.kind !== this.kind) throw new Error(`Unsupported multiplexer kind: ${location.kind}`)
    const snapshot = observedSnapshot ?? await this.observe()
    if (snapshot.instanceId !== location.instanceId) throw new Error("Multiplexer instance changed before absorption")
    const session = snapshot.sessions.find((candidate) => candidate.id === location.nativeSessionId)
    if (!session) throw new Error("Multiplexer session disappeared before absorption")
    const selectedPane = session.windows.flatMap((window) => window.panes).find((pane) => pane.id === location.nativePaneId)
      ?? session.windows.find((window) => window.active)?.panes.find((pane) => pane.active)
      ?? session.windows.flatMap((window) => window.panes)[0]
    if (!selectedPane) throw new Error("Multiplexer session has no terminal panes")
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
        const durable = this.adapter.capabilities().durableIds
        const byLocation = (input: { nativeSessionId: string; nativeWindowId?: string | null; nativePaneId?: string | null }, kind: ResourceRecord["kind"], parentId: string | null) => {
          if (!durable) return undefined
          const found = registry.findByNativeLocation({ kind: this.kind, instanceId: snapshot.instanceId, ...input })
          return found?.kind === kind && found.workshopId === workshopId && found.parentId === parentId ? found.id : undefined
        }
        const sessionRecord = registry.upsert({
          id: registeredId(session.resourceId, "session", null) ?? byLocation({ nativeSessionId: session.id }, "session", null),
          kind: "session",
          workshopId,
          displayName: session.displayName || session.nativeName,
          location: { kind: this.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, observedAt: now },
        }, { now })
        const windowRecords: ResourceRecord[] = []
        const terminalRecords: ResourceRecord[] = []
        for (const window of session.windows) {
          const windowRecord = registry.upsert({
            id: registeredId(window.resourceId, "window", sessionRecord.id) ?? byLocation({ nativeSessionId: session.id, nativeWindowId: window.id }, "window", sessionRecord.id),
            kind: "window",
            workshopId,
            parentId: sessionRecord.id,
            displayName: window.displayName || window.nativeName || `window ${window.index}`,
            location: { kind: this.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, observedAt: now },
          }, { now })
          windowRecords.push(windowRecord)
          for (const pane of window.panes) {
            const displayName = pane.displayName || (window.panes.length > 1 ? `${windowRecord.displayName}.${pane.index}` : windowRecord.displayName)
            terminalRecords.push(registry.upsert({
              id: registeredId(pane.terminalId, "terminal", windowRecord.id) ?? byLocation({ nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: pane.id }, "terminal", windowRecord.id),
              kind: "terminal",
              workshopId,
              parentId: windowRecord.id,
              displayName,
              location: { kind: this.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: pane.id, observedAt: now },
            }, { now }))
          }
        }
        return { workshopId, session: sessionRecord, windows: windowRecords, terminals: terminalRecords }
      })
      const at = sessionLocation(session.id)
      if (this.supportsClaims("session")) {
        if (session.workshopId !== workshopId) await this.adapter.claim(at, "workshopId", workshopId)
        if (session.resourceId !== claimed.session.id) await this.adapter.claim(at, "sessionId", claimed.session.id)
        if (session.displayName !== claimed.session.displayName) await this.adapter.claim(at, "sessionDisplayName", claimed.session.displayName)
      }
      for (let index = 0; index < session.windows.length; index += 1) {
        const window = session.windows[index]!
        const record = claimed.windows[index]!
        if (this.supportsClaims("window")) {
          const where = windowLocation(session.id, window.id)
          if (window.resourceId !== record.id) await this.adapter.claim(where, "windowId", record.id)
          if (window.displayName !== record.displayName) await this.adapter.claim(where, "windowDisplayName", record.displayName)
        }
        if (!this.supportsClaims("pane")) continue
        for (const pane of window.panes) {
          const terminal = claimed.terminals.find((candidate) => candidate.location?.nativePaneId === pane.id)!
          const where = paneLocation(session.id, window.id, pane.id)
          if (pane.terminalId !== terminal.id) await this.adapter.claim(where, "terminalId", terminal.id)
          if (pane.displayName !== terminal.displayName) await this.adapter.claim(where, "terminalDisplayName", terminal.displayName)
        }
      }
      return claimed
    } finally { registry.close() }
  }

  async reconcileAbsorbedTopology(snapshot: MultiplexerSnapshot): Promise<boolean> {
    let changed = false
    const durable = this.adapter.capabilities().durableIds
    for (const session of snapshot.sessions) {
      if (!session.workshopId || !session.resourceId) continue
      const incomplete = session.windows.some((window) => (this.supportsClaims("window") && !window.resourceId) || window.panes.some((pane) => !pane.terminalId))
      if (!incomplete && !durable) continue
      if (!incomplete) continue
      const pane = session.windows.find((window) => window.active)?.panes.find((candidate) => candidate.active)
        ?? session.windows.flatMap((window) => window.panes)[0]
      if (!pane) continue
      const window = session.windows.find((candidate) => candidate.panes.some((entry) => entry.id === pane.id))!
      await this.absorb({ kind: this.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: pane.id }, snapshot)
      changed = true
    }
    return changed
  }

  async resolve(target: MultiplexerTarget): Promise<MultiplexerLocation | undefined> {
    if (target.management === "managed" && target.resourceId) {
      const registry = openResourceRegistry({ dbPath: this.registryPath })
      try {
        const resource = registry.get(target.resourceId)
        if (!resource?.location) throw new Error(`Managed resource has no current location: ${target.resourceId}`)
        const snapshot = await this.observe()
        const session = snapshot.sessions.find((candidate) => candidate.id === resource.location?.nativeSessionId)
        const window = session?.windows.find((candidate) => candidate.id === resource.location?.nativeWindowId)
        const pane = window?.panes.find((candidate) => candidate.id === resource.location?.nativePaneId)
        const live = resource.kind === "session" ? session : resource.kind === "window" ? window : pane
        const scope = resource.kind === "session" ? "session" : resource.kind === "window" ? "window" : "pane"
        const claimed = resource.kind === "session" ? session?.resourceId : resource.kind === "window" ? window?.resourceId : pane?.terminalId
        const claimMatches = this.supportsClaims(scope) ? claimed === resource.id : Boolean(live)
        if (snapshot.instanceId !== resource.location.instanceId || resource.location.kind !== this.kind || !claimMatches) throw new Error(`Managed resource location is stale: ${target.resourceId}`)
        return resource.location
      } finally { registry.close() }
    }
    if (!target.location) return undefined
    if (target.management === "unmanaged") await this.absorb(target.location)
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
    const snapshot = await this.observe()
    const session = snapshot.sessions.find((candidate) => candidate.nativeName === target.session || candidate.id === target.session)
    if (!session) throw new Error(`Unknown ${this.kind} session: ${target.session}`)
    if (target.type === "session") {
      await this.open(sessionLocation(session.id))
      return
    }
    await this.open(windowLocation(session.id, target.windowId))
  }

  /** Absorb the whole session that `selector` (native id or native name) identifies. */
  async ensureManagedSession(selector: string) {
    const snapshot = await this.observe()
    const session = snapshot.sessions.find((candidate) => candidate.id === selector || candidate.nativeName === selector)
    if (!session) throw new Error(`Unknown ${this.kind} session: ${selector}`)
    const pane = session.windows.find((window) => window.active)?.panes.find((candidate) => candidate.active)
      ?? session.windows.flatMap((window) => window.panes)[0]
    if (!pane) throw new Error(`${this.kind} session has no panes: ${selector}`)
    const window = session.windows.find((candidate) => candidate.panes.some((entry) => entry.id === pane.id))!
    return this.absorb({ kind: this.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: pane.id })
  }
}

export const currentLocationOf = (location: CurrentLocation | undefined) => location

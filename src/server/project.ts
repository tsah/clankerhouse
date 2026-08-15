import type { ActivitySource } from "../activity"
import { applyResourceIncidents, type ResourceIncident } from "../incidents"
import { sessionSortRank, stateWithSeen } from "../model"
import type { ClankerState, DetailRow, SessionRow } from "../model"
import type { ResourceRecord } from "../resource-registry"
import type { LineageSnapshot } from "../workshop"
import type { ClankerReport, DirectoryRow, OpencodeStatus, TmuxSession, TmuxWindow } from "./resources"

export interface GitMeta {
  branch: string
  flags: string
}

export type ProjectEffect =
  | { type: "markDirectoryActivity"; path: string; source: ActivitySource; updatedAt: number; minIntervalMs: number }
  | { type: "markSeen"; key: string; seenAt: number }

export interface ProjectInputs {
  sessions: readonly TmuxSession[]
  windows: readonly TmuxWindow[]
  opencodes: readonly OpencodeStatus[]
  directories: readonly DirectoryRow[]
  clankerReports: readonly ClankerReport[]
  seen: ReadonlyMap<string, number>
  lineage: LineageSnapshot
  incidents: readonly ResourceIncident[]
  gitMetaByPath: ReadonlyMap<string, GitMeta>
  detectedHarnessByPane: ReadonlyMap<string, "pi" | "claude" | "codex" | "opencode">
  codexPanes: ReadonlySet<string>
  managedResources: ReadonlyMap<string, ResourceRecord>
  observedAt: number
  tmuxServerKey: string
  home?: string
}

export interface ProjectResult {
  sessions: SessionRow[]
  effects: ProjectEffect[]
}

const expandHome = (path: string, home = "") => path === "~" ? home || path : path.startsWith("~/") && home ? `${home}${path.slice(1)}` : path
const ageFromTimestamp = (timestamp: number, observedAt: number) => {
  if (timestamp <= 0) return ""
  const diff = Math.max(0, Math.floor((observedAt - timestamp) / 1000))
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

const paneCompletionKey = (tmuxServerKey: string, pane: string) => `${tmuxServerKey}:pane:${pane}`
const windowCompletionKey = (tmuxServerKey: string, window: string) => `${tmuxServerKey}:window:${window}`

export const isPiWindow = (window: TmuxWindow) => window.command === "pi" || window.name.toLowerCase() === "pi" || window.name.toLowerCase().startsWith("p:") || window.title.startsWith("π")
export const isClaudeWindow = (window: TmuxWindow) => window.command === "claude" || window.name.toLowerCase() === "claude" || window.title.toLowerCase().includes("claude code")
export const isCodexWindow = (window: TmuxWindow) => window.command === "codex" || window.name.toLowerCase() === "codex" || window.title.toLowerCase().includes("codex")

const clankerStateFromStatus = (status: string, detail = ""): ClankerState => {
  const normalized = status.trim().toLowerCase()
  const normalizedDetail = detail.trim().toLowerCase()
  if (!normalized) return "unknown"
  if (["done", "complete", "completed", "success", "succeeded"].includes(normalized)) return "done"
  if (normalized === "idle") return "idle"
  if (normalized === "waiting question") return "blocked"
  if (normalized.includes("tool running") && ["question", "permission", "approval"].some((word) => normalizedDetail.includes(word))) return "blocked"
  if (["error", "failed", "failure", "blocked", "input", "attention", "confirm", "review", "question", "permission", "approval"].some((word) => normalized.includes(word))) return "blocked"
  if (["running", "generating", "streaming", "working"].some((word) => normalized.includes(word))) return "working"
  return "unknown"
}

const opencodeState = (opencode: OpencodeStatus) => {
  const state = clankerStateFromStatus(opencode.status, opencode.detail)
  return !opencode.updatedAt && state === "done" ? "idle" : state
}

const codexStateFromTitle = (title: string): ClankerState => {
  const normalized = title.trim().toLowerCase()
  if (!normalized) return "unknown"
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(normalized)) return "working"
  if (/^[✓✔]/.test(normalized) || normalized.includes("done") || normalized.includes("complete")) return "done"
  if (/^[!✗×]/.test(normalized) || ["error", "failed", "blocked", "attention"].some((word) => normalized.includes(word))) return "blocked"
  return "unknown"
}

const claudeStateFromTitle = (title: string): ClankerState => {
  const normalized = title.trim().toLowerCase()
  if (!normalized) return "unknown"
  if (/^[⠁⠂⠄⡀⢀⠠⠐⠈]/.test(normalized)) return "working"
  if (/^[✳✓✔]/.test(normalized) || normalized.includes("done") || normalized.includes("complete")) return "done"
  if (/^[!✗×]/.test(normalized) || ["error", "failed", "blocked", "attention"].some((word) => normalized.includes(word))) return "blocked"
  return "unknown"
}

const buildLineageFields = (workshopId?: string, parentWorkshopId?: string | null, childWorkshopCount = 0) => {
  const label = [parentWorkshopId ? "↖" : "", childWorkshopCount > 0 ? `⇣${childWorkshopCount}` : ""].filter(Boolean).join(" ")
  const searchText = [workshopId, parentWorkshopId || "", childWorkshopCount > 0 ? `child-count-${childWorkshopCount}` : "root"].filter(Boolean).join(" ")
  return { lineageLabel: label, lineageSearchText: searchText }
}

export const projectResources = (inputs: ProjectInputs): ProjectResult => {
  const { sessions, windows, opencodes, directories, clankerReports, lineage, incidents, gitMetaByPath, detectedHarnessByPane, codexPanes, observedAt, tmuxServerKey, home } = inputs
  const seen = new Map(inputs.seen)
  const effects: ProjectEffect[] = []
  const windowsBySession = Map.groupBy(windows, (window) => window.sessionId)
  const reportsByPane = new Map(clankerReports.map((report) => [report.pane, report]))
  const rows: SessionRow[] = []
  const managedAt = (resourceId: string | undefined, kind: ResourceRecord["kind"], sessionId: string, windowId?: string, paneId?: string) => {
    if (!resourceId) return undefined
    const resource = inputs.managedResources.get(resourceId)
    const location = resource?.location
    return resource?.kind === kind && location?.kind === "tmux" && location.instanceId === tmuxServerKey
      && location.nativeSessionId === sessionId && (location.nativeWindowId ?? undefined) === windowId && (location.nativePaneId ?? undefined) === paneId
      ? resource
      : undefined
  }

  for (const session of sessions) {
    const sessionWindows = windowsBySession.get(session.id) ?? []
    const sessionPaneIds = new Set(sessionWindows.map((window) => window.pane))
    const sessionOpencodes = opencodes.filter((row) => row.stablePane ? sessionPaneIds.has(row.stablePane) : row.session === session.name)
    const managedSession = managedAt(session.resourceId, "session", session.id)
    const sessionManaged = Boolean(managedSession)
    const workshop = managedSession?.workshopId
      ? lineage.byId.get(managedSession.workshopId)
      : session.workshopId ? lineage.byId.get(session.workshopId) : lineage.byPath.get(session.path)
    const sessionPath = workshop?.canonicalPath ?? session.path
    const sessionLocation = { kind: "tmux", instanceId: tmuxServerKey, nativeSessionId: session.id, nativeWindowId: null, nativePaneId: null }
    if (session.attached && sessionWindows.some((window) => window.active)) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "active", updatedAt: observedAt, minIntervalMs: 60_000 })
    const meta = gitMetaByPath.get(sessionPath) ?? { branch: "", flags: "" }
    const details: DetailRow[] = []

    const opencodesByWindow = Map.groupBy(sessionOpencodes, (opencode) => {
      if (opencode.stablePane) return sessionWindows.find((window) => window.pane === opencode.stablePane)?.id ?? ""
      const prefix = `${opencode.session}:`
      const windowIndex = opencode.pane.startsWith(prefix) ? opencode.pane.slice(prefix.length).split(".")[0] : ""
      return sessionWindows.find((window) => window.index === windowIndex)?.id ?? ""
    })

    for (const window of sessionWindows) {
      const focused = session.attached && window.active
      const windowOpencodes = opencodesByWindow.get(window.id) ?? []
      const managedTerminal = managedAt(window.terminalId, "terminal", session.id, window.id, window.pane)
      const terminalManaged = Boolean(managedTerminal)
      const location = { kind: "tmux", instanceId: tmuxServerKey, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: window.pane }
      for (const opencode of windowOpencodes) {
        if (opencode.updatedAt) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "clanker", updatedAt: opencode.updatedAt, minIntervalMs: 0 })
        const completionKey = paneCompletionKey(tmuxServerKey, opencode.stablePane || window.pane || opencode.pane)
        const sourceState = opencodeState(opencode)
        const state = stateWithSeen(sourceState, opencode.updatedAt, seen.get(completionKey), focused)
        if (sourceState === "done" && focused) {
          effects.push({ type: "markSeen", key: completionKey, seenAt: observedAt })
          seen.set(completionKey, observedAt)
        }
        const clankerId = opencode.harnessSessionId && opencode.harnessSessionId === window.harnessSessionId ? window.clankerId : undefined
        details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || window.name || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || window.pane || opencode.pane, management: terminalManaged ? "managed" : "unmanaged", resourceId: managedTerminal?.id, location }, completionKey, updatedAt: opencode.updatedAt, terminalId: managedTerminal?.id, clankerId })
      }
      if (windowOpencodes.length > 0) continue

      const report = reportsByPane.get(window.pane)
      const registeredHarness = window.clankerId && ["pi", "claude", "codex", "opencode"].includes(window.explicitHarness || "")
        ? window.explicitHarness
        : report?.harness
      // Titles, command names, and process resemblance can enrich a registered Clanker,
      // but never create Clanker identity.
      const projectedKind = registeredHarness ?? "window"
      if (report?.updatedAt) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "clanker", updatedAt: report.updatedAt, minIntervalMs: 0 })
      const sourceState = report?.harness === projectedKind ? report.state : projectedKind === "codex" ? codexStateFromTitle(window.title || window.name) : projectedKind === "claude" ? claudeStateFromTitle(window.title || window.name) : "unknown"
      const updatedAt = report?.harness === projectedKind ? report.updatedAt : window.activity * 1000
      const completionKey = projectedKind === "window" ? windowCompletionKey(tmuxServerKey, window.id) : paneCompletionKey(tmuxServerKey, window.pane)
      const state = stateWithSeen(sourceState, updatedAt, seen.get(completionKey), focused)
      if (sourceState === "done" && focused) {
        effects.push({ type: "markSeen", key: completionKey, seenAt: observedAt })
        seen.set(completionKey, observedAt)
      }
      details.push({ kind: projectedKind === "window" ? "window" : "clanker", harness: projectedKind === "window" ? undefined : projectedKind, status: projectedKind === "window" ? window.command : "", detail: "", title: managedTerminal?.displayName || window.name || window.title, age: ageFromTimestamp(window.activity * 1000, observedAt), state, target: { type: "tmux_window", session: window.session, windowId: window.id, pane: window.pane, management: terminalManaged ? "managed" : "unmanaged", resourceId: managedTerminal?.id, location }, completionKey, updatedAt, terminalId: managedTerminal?.id, clankerId: window.clankerId })
    }

    for (const opencode of opencodesByWindow.get("") ?? []) {
      if (opencode.updatedAt) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "clanker", updatedAt: opencode.updatedAt, minIntervalMs: 0 })
      const completionKey = paneCompletionKey(tmuxServerKey, opencode.stablePane || opencode.pane)
      const sourceState = opencodeState(opencode)
      const state = stateWithSeen(sourceState, opencode.updatedAt, seen.get(completionKey))
      details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || opencode.pane }, completionKey, updatedAt: opencode.updatedAt })
    }

    if (details.length === 0) details.push({ kind: "session", status: meta.flags, detail: "", title: sessionPath, age: ageFromTimestamp(session.recency * 1000, observedAt), state: "unknown", target: { type: "tmux_session", session: session.name, management: sessionManaged ? "managed" : "unmanaged", resourceId: sessionManaged ? session.resourceId : undefined, location: sessionLocation }, updatedAt: 0 })

    const markers = [
      sessionOpencodes.length > 0 || sessionWindows.some((window) => detectedHarnessByPane.get(window.pane) === "opencode") ? "oc" : "",
      sessionWindows.some((window) => isPiWindow(window) || detectedHarnessByPane.get(window.pane) === "pi") ? "pi" : "",
      sessionWindows.some((window) => isClaudeWindow(window) || detectedHarnessByPane.get(window.pane) === "claude") ? "C" : "",
      sessionWindows.some((window) => codexPanes.has(window.pane) || detectedHarnessByPane.get(window.pane) === "codex") ? "codex" : "",
    ].filter(Boolean)
    const parentWorkshopId = workshop ? workshop.parentWorkshopId : session.parentWorkshopId
    const lineageFields = buildLineageFields(workshop?.workshopId || session.workshopId, parentWorkshopId, workshop?.childWorkshopCount ?? 0)
    const displayName = managedSession?.displayName || session.name
    const workshopId = workshop?.workshopId || managedSession?.workshopId || session.workshopId
    const availableActions = ["open", "rename", ...(workshopId ? ["attach"] : []), ...(parentWorkshopId ? ["detach"] : []), "delete"] as SessionRow["availableActions"]
    const row: SessionRow = { name: displayName, path: sessionPath, branch: meta.branch, flags: meta.flags, markers, age: ageFromTimestamp(session.recency * 1000, observedAt), recency: session.recency, target: { type: "tmux_session", session: session.name, management: sessionManaged ? "managed" : "unmanaged", resourceId: managedSession?.id, location: sessionLocation }, details, searchText: "", availableActions, workshopId, resourceId: managedSession?.id, management: sessionManaged ? "managed" : "unmanaged", parentWorkshopId, childWorkshopCount: workshop?.childWorkshopCount ?? 0, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText }
    row.searchText = [row.name, row.path, row.branch, row.flags, row.markers.join(" "), row.lineageLabel, row.lineageSearchText, ...row.details.flatMap((detail) => [detail.kind, detail.harness, detail.status, detail.detail, detail.title, detail.age])].join(" ").toLowerCase()
    rows.push(row)
  }

  const occupiedDirs = new Set([
    ...rows.map((row) => expandHome(row.path, home)),
    ...opencodes.map((row) => expandHome(row.directory.replace(/ \([0-9]+\)$/, ""), home)),
  ])
  const occupiedWorkshopIds = new Set(rows.flatMap((row) => row.workshopId ? [row.workshopId] : []))
  for (const directory of directories) {
    const path = expandHome(directory.path, home)
    const workshop = lineage.byPath.get(path)
    if (occupiedDirs.has(path) || (workshop && occupiedWorkshopIds.has(workshop.workshopId))) continue
    occupiedDirs.add(path)
    const details: DetailRow[] = [{ kind: "directory", status: "", detail: directory.source, title: path, age: "", state: "unknown", target: { type: "directory", path }, updatedAt: 0 }]
    const age = directory.activityAt ? ageFromTimestamp(directory.activityAt, observedAt) : ""
    const lineageFields = buildLineageFields(workshop?.workshopId, workshop?.parentWorkshopId, workshop?.childWorkshopCount ?? 0)
    const row: SessionRow = { name: path, path, branch: directory.branch, flags: "", markers: [], age, recency: Math.floor((directory.activityAt ?? 0) / 1000), target: { type: "directory", path }, details, searchText: "", availableActions: ["open", "create"], directorySource: directory.source, activitySource: directory.activitySource, frecency: directory.frecency, workshopId: workshop?.workshopId, parentWorkshopId: workshop?.parentWorkshopId, childWorkshopCount: workshop?.childWorkshopCount ?? 0, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText }
    row.searchText = [row.name, row.path, row.branch, `${directory.source} directory`, row.activitySource, row.age, row.lineageLabel, row.lineageSearchText].join(" ").toLowerCase()
    rows.push(row)
  }

  const projectedSessions = applyResourceIncidents(rows, [...incidents], observedAt)
  projectedSessions.sort((a, b) => sessionSortRank(a) - sessionSortRank(b) || b.recency - a.recency || (b.frecency ?? 0) - (a.frecency ?? 0) || a.name.localeCompare(b.name))
  return { sessions: projectedSessions, effects }
}

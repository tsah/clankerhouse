import type { ActivitySource } from "../activity"
import { applyResourceIncidents, type ResourceIncident } from "../incidents"
import { labelTags, projectName } from "../labels"
import { compareProjectedSessions, stateWithSeen } from "../model"
import type { ClankerState, DetailRow, RuntimeObservation, SessionRow } from "../model"
import type { ResourceRecord } from "../resource-registry"
import { attachmentCandidatesFromWorkshops, type LineageSnapshot } from "../workshop"
import type { ClankerReport, DirectoryRow, OpencodeStatus, TmuxSession, TmuxWindow } from "./resources"
import { reconcileClankerObservations, type LifecycleObservation, type OwnedClankerIdentity } from "./observations"

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
  clankerReports: readonly LifecycleObservation[]
  seen: ReadonlyMap<string, number>
  lineage: LineageSnapshot
  incidents: readonly ResourceIncident[]
  gitMetaByPath: ReadonlyMap<string, GitMeta>
  detectedHarnessByPane: ReadonlyMap<string, "pi" | "claude" | "codex" | "opencode">
  activeOpenCodeSessions?: ReadonlySet<string>
  codexPanes: ReadonlySet<string>
  managedResources: ReadonlyMap<string, ResourceRecord>
  observedAt: number
  tmuxServerKey: string
  /** Multiplexer kind that produced `sessions`/`windows`; defaults to tmux. */
  multiplexerKind?: string
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
const supportedHarnesses = new Set(["pi", "claude", "codex", "opencode"])
const ownedClankerIdentity = (window: TmuxWindow): OwnedClankerIdentity | undefined => window.clankerId && supportedHarnesses.has(window.explicitHarness || "")
  ? { pane: window.pane, clankerId: window.clankerId, harness: window.explicitHarness!, harnessSessionId: window.harnessSessionId, recoveryAttemptId: window.recoveryAttemptId }
  : undefined

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
  const multiplexerKind = inputs.multiplexerKind ?? "tmux"
  const activeOpenCodeSessions = inputs.activeOpenCodeSessions ?? new Set<string>()
  const seen = new Map(inputs.seen)
  const effects: ProjectEffect[] = []
  const windowsBySession = Map.groupBy(windows, (window) => window.sessionId)
  const worktreePaths = new Set(directories.filter((directory) => directory.source === "worktree").map((directory) => expandHome(directory.path, home)))
  const observationReconciliation = reconcileClankerObservations(windows.flatMap((window) => {
    const identity = ownedClankerIdentity(window)
    return identity ? [identity] : []
  }), clankerReports)
  const rows: SessionRow[] = []
  const preferredWorkshopId = (workshopId: string | null | undefined) => {
    if (!workshopId) return workshopId
    const workshop = lineage.byId.get(workshopId)
    return workshop ? lineage.byPath.get(workshop.canonicalPath)?.workshopId ?? workshopId : workshopId
  }
  const projectedChildCounts = new Map<string, number>()
  for (const workshop of lineage.byId.values()) {
    if (lineage.byPath.get(workshop.canonicalPath)?.workshopId !== workshop.workshopId) continue
    const parentWorkshopId = preferredWorkshopId(workshop.parentWorkshopId)
    if (parentWorkshopId) projectedChildCounts.set(parentWorkshopId, (projectedChildCounts.get(parentWorkshopId) ?? 0) + 1)
  }
  const projectedChildCount = (workshop: { workshopId: string; childWorkshopCount: number }) => Math.max(workshop.childWorkshopCount, projectedChildCounts.get(workshop.workshopId) ?? 0)
  const managedAt = (resourceId: string | undefined, kind: ResourceRecord["kind"], sessionId: string, windowId?: string, paneId?: string) => {
    if (!resourceId) return undefined
    const resource = inputs.managedResources.get(resourceId)
    const location = resource?.location
    return resource?.kind === kind && location?.kind === multiplexerKind && location.instanceId === tmuxServerKey
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
    const sessionLocation = { kind: multiplexerKind, instanceId: tmuxServerKey, nativeSessionId: session.id, nativeWindowId: null, nativePaneId: null }
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
      const location = { kind: multiplexerKind, instanceId: tmuxServerKey, nativeSessionId: session.id, nativeWindowId: window.id, nativePaneId: window.pane }
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
        details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || window.name || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || window.pane || opencode.pane, management: terminalManaged ? "managed" : "unmanaged", resourceId: managedTerminal?.id, location }, completionKey, updatedAt: opencode.updatedAt, terminalId: managedTerminal?.id, clankerId, observation: { source: "lifecycle", confidence: clankerId ? "attested" : "observed", state: sourceState, observedAt: opencode.updatedAt } })
      }
      if (windowOpencodes.length > 0) continue

      const registeredIdentity = ownedClankerIdentity(window)
      const registeredHarness = registeredIdentity?.harness
      const runtimeHarness = window.agentStatus?.agent && supportedHarnesses.has(window.agentStatus.agent) ? window.agentStatus.agent : undefined
      const detectedHarness = detectedHarnessByPane.get(window.pane)
      const observedHarness = runtimeHarness ?? detectedHarness
      const matchingReport = registeredHarness ? observationReconciliation.matchedByPane.get(window.pane) : undefined
      const observedReportCandidate = !registeredHarness && observedHarness ? observationReconciliation.observedByPane.get(window.pane) : undefined
      const observedReport = observedReportCandidate && observedReportCandidate.harness === observedHarness
        && (observedHarness !== "opencode" || window.harnessSessionId === observedReportCandidate.harnessSessionId)
        ? observedReportCandidate
        : undefined
      // Runtime and process evidence remain visible without manufacturing Clanker identity.
      const projectedKind = registeredHarness ? "clanker" : observedHarness ? "observation" : "window"
      const projectedHarness = registeredHarness ?? observedHarness
      if (matchingReport?.updatedAt) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "clanker", updatedAt: matchingReport.updatedAt, minIntervalMs: 0 })
      const runtimeState = runtimeHarness ? window.agentStatus?.status : undefined
      const registeredFallback = registeredHarness === "opencode" && window.harnessSessionId && activeOpenCodeSessions.has(window.harnessSessionId)
        ? "working"
        : registeredHarness === "codex"
          ? codexStateFromTitle(window.title || window.name)
          : registeredHarness === "claude"
            ? claudeStateFromTitle(window.title || window.name)
            : "unknown"
      const sourceState = matchingReport?.state ?? observedReport?.state ?? runtimeState ?? registeredFallback
      const updatedAt = matchingReport?.updatedAt ?? observedReport?.updatedAt ?? window.activity * 1000
      const completionKey = projectedKind === "window" ? windowCompletionKey(tmuxServerKey, window.id) : paneCompletionKey(tmuxServerKey, window.pane)
      const state = stateWithSeen(sourceState, updatedAt, seen.get(completionKey), focused)
      if (sourceState === "done" && focused) {
        effects.push({ type: "markSeen", key: completionKey, seenAt: observedAt })
        seen.set(completionKey, observedAt)
      }
      const observation: RuntimeObservation = matchingReport
        ? { source: "lifecycle", confidence: "attested", state: sourceState, observedAt: matchingReport.updatedAt }
        : observedReport
          ? { source: "lifecycle", confidence: "observed", state: sourceState, observedAt: observedReport.updatedAt }
          : runtimeState !== undefined
            ? { source: "runtime", confidence: "observed", state: sourceState, observedAt }
            : detectedHarness
              ? { source: "process", confidence: "observed", state: "present", observedAt }
              : { source: multiplexerKind === "tmux" ? "tmux" : "runtime", confidence: "observed", state: "present", observedAt }
      const status = projectedKind === "window" ? window.command : observedReport ? `reported ${sourceState}` : runtimeState !== undefined ? `runtime ${sourceState}` : projectedKind === "observation" ? "process observed" : ""
      details.push({ kind: projectedKind, harness: projectedHarness, status, detail: "", title: managedTerminal?.displayName || window.name || window.title, age: ageFromTimestamp(window.activity * 1000, observedAt), state, target: { type: "tmux_window", session: window.session, windowId: window.id, pane: window.pane, management: terminalManaged ? "managed" : "unmanaged", resourceId: managedTerminal?.id, location }, completionKey, updatedAt, terminalId: managedTerminal?.id, clankerId: registeredHarness ? window.clankerId : undefined, observation })
      for (const unmatched of observationReconciliation.unmatchedByPane.get(window.pane) ?? []) {
        const report = unmatched.observation
        if (report === observedReport) continue
        details.push({
          kind: "observation",
          harness: report.harness,
          status: report.state ? `reported ${report.state}` : report.reportedState ? `reported ${report.reportedState}` : "state unreported",
          detail: `rejected lifecycle identity: ${unmatched.reason}`,
          title: `${report.harness || "lifecycle"} report ${report.clankerId || "without identity"}`,
          age: ageFromTimestamp(report.updatedAt, observedAt),
          state: "unknown",
          target: { type: "tmux_window", session: window.session, windowId: window.id, pane: window.pane, management: terminalManaged ? "managed" : "unmanaged", resourceId: managedTerminal?.id, location },
          updatedAt: report.updatedAt,
          terminalId: managedTerminal?.id,
          observation: { source: "lifecycle", confidence: "rejected", state: report.state ?? "unreported", observedAt: report.updatedAt, reason: unmatched.reason },
        })
      }
    }

    for (const opencode of opencodesByWindow.get("") ?? []) {
      if (opencode.updatedAt) effects.push({ type: "markDirectoryActivity", path: sessionPath, source: "clanker", updatedAt: opencode.updatedAt, minIntervalMs: 0 })
      const completionKey = paneCompletionKey(tmuxServerKey, opencode.stablePane || opencode.pane)
      const sourceState = opencodeState(opencode)
      const state = stateWithSeen(sourceState, opencode.updatedAt, seen.get(completionKey))
      details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || opencode.pane }, completionKey, updatedAt: opencode.updatedAt, observation: { source: "lifecycle", confidence: "observed", state: sourceState, observedAt: opencode.updatedAt } })
    }

    if (details.length === 0) details.push({ kind: "session", status: meta.flags, detail: "", title: sessionPath, age: ageFromTimestamp(session.recency * 1000, observedAt), state: "unknown", target: { type: "tmux_session", session: session.name, management: sessionManaged ? "managed" : "unmanaged", resourceId: sessionManaged ? session.resourceId : undefined, location: sessionLocation }, updatedAt: 0 })

    const markers = [
      sessionOpencodes.length > 0 || sessionWindows.some((window) => window.agentStatus?.agent === "opencode" || detectedHarnessByPane.get(window.pane) === "opencode") ? "oc" : "",
      sessionWindows.some((window) => isPiWindow(window) || window.agentStatus?.agent === "pi" || detectedHarnessByPane.get(window.pane) === "pi") ? "pi" : "",
      sessionWindows.some((window) => isClaudeWindow(window) || window.agentStatus?.agent === "claude" || detectedHarnessByPane.get(window.pane) === "claude") ? "C" : "",
      sessionWindows.some((window) => codexPanes.has(window.pane) || window.agentStatus?.agent === "codex" || detectedHarnessByPane.get(window.pane) === "codex") ? "codex" : "",
    ].filter(Boolean)
    const parentWorkshopId = preferredWorkshopId(workshop ? workshop.parentWorkshopId : session.parentWorkshopId)
    const childWorkshopCount = workshop ? projectedChildCount(workshop) : 0
    const lineageFields = buildLineageFields(workshop?.workshopId || session.workshopId, parentWorkshopId, childWorkshopCount)
    const displayName = managedSession?.displayName || session.name
    const workshopId = workshop?.workshopId || managedSession?.workshopId || session.workshopId
    const availableActions = ["open", "rename", ...(workshopId ? ["attach"] : []), ...(parentWorkshopId ? ["detach"] : []), "delete"] as SessionRow["availableActions"]
    const row: SessionRow = { name: displayName, path: sessionPath, branch: meta.branch, flags: meta.flags, markers, age: ageFromTimestamp(session.recency * 1000, observedAt), recency: session.recency, target: { type: "tmux_session", session: session.name, management: sessionManaged ? "managed" : "unmanaged", resourceId: managedSession?.id, location: sessionLocation }, details, searchText: "", availableActions, directorySource: worktreePaths.has(expandHome(sessionPath, home)) ? "worktree" : undefined, workshopId, resourceId: managedSession?.id, management: sessionManaged ? "managed" : "unmanaged", parentWorkshopId, childWorkshopCount, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText, labels: labelTags(workshop?.labels), title: workshop?.labels?.title, project: projectName(workshop?.commonDir) }
    row.searchText = [row.name, row.path, row.branch, row.flags, row.markers.join(" "), ...(row.labels ?? []), row.title, row.lineageLabel, row.lineageSearchText, ...row.details.flatMap((detail) => [detail.kind, detail.harness, detail.status, detail.detail, detail.title])].join(" ").toLowerCase()
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
    if (workshop) occupiedWorkshopIds.add(workshop.workshopId)
    const details: DetailRow[] = [{ kind: "directory", status: "", detail: directory.source, title: path, age: "", state: "unknown", target: { type: "directory", path }, updatedAt: 0 }]
    const age = directory.activityAt ? ageFromTimestamp(directory.activityAt, observedAt) : ""
    const parentWorkshopId = preferredWorkshopId(workshop?.parentWorkshopId)
    const childWorkshopCount = workshop ? projectedChildCount(workshop) : 0
    const lineageFields = buildLineageFields(workshop?.workshopId, parentWorkshopId, childWorkshopCount)
    // A sessionless Workshop can still be given a title.
    const availableActions = ["open", "create", ...(workshop ? ["rename", "attach"] : []), ...(parentWorkshopId ? ["detach"] : [])] as SessionRow["availableActions"]
    const row: SessionRow = { name: path, path, branch: directory.branch, flags: "", markers: [], age, recency: Math.floor((directory.activityAt ?? 0) / 1000), target: { type: "directory", path }, details, searchText: "", availableActions, directorySource: directory.source, activitySource: directory.activitySource, frecency: directory.frecency, workshopId: workshop?.workshopId, parentWorkshopId, childWorkshopCount, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText, labels: labelTags(workshop?.labels), title: workshop?.labels?.title, project: projectName(workshop?.commonDir) }
    row.searchText = [row.name, row.path, row.branch, `${directory.source} directory`, row.activitySource, ...(row.labels ?? []), row.title, row.lineageLabel, row.lineageSearchText].join(" ").toLowerCase()
    rows.push(row)
  }

  const preferredWorkshops = [...lineage.byId.values()]
    .filter((record) => lineage.byPath.get(record.canonicalPath)?.workshopId === record.workshopId)
    .map((record) => ({ ...record, parentWorkshopId: preferredWorkshopId(record.parentWorkshopId) ?? null }))
  const projectedWorkshopIds = new Set(rows.flatMap((row) => row.workshopId ? [row.workshopId] : []))
  const preferredWorkshopIds = new Set(preferredWorkshops.map((record) => record.workshopId))
  for (const row of rows) {
    if (!row.workshopId || !row.availableActions?.includes("attach")) continue
    const candidates = new Set(preferredWorkshopIds.has(row.workshopId) ? attachmentCandidatesFromWorkshops(row.workshopId, preferredWorkshops).map((candidate) => candidate.workshopId) : [])
    row.attachmentCandidateWorkshopIds = rows.flatMap((candidate) => candidate.workshopId && projectedWorkshopIds.has(candidate.workshopId) && candidates.has(candidate.workshopId) ? [candidate.workshopId] : [])
    if (row.attachmentCandidateWorkshopIds.length === 0) row.availableActions = row.availableActions.filter((action) => action !== "attach")
  }

  const projectedSessions = applyResourceIncidents(rows, [...incidents], observedAt)
  projectedSessions.sort(compareProjectedSessions)
  return { sessions: projectedSessions, effects }
}

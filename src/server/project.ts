import type { ActivitySource } from "../activity"
import { applyResourceIncidents, type ResourceIncident } from "../incidents"
import { sessionSortRank, stateWithSeen } from "../model"
import type { ClankerState, DetailRow, SessionRow } from "../model"
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
  const windowsBySession = Map.groupBy(windows, (window) => window.session)
  const opencodesBySession = Map.groupBy(opencodes, (row) => row.session)
  const reportsByPane = new Map(clankerReports.map((report) => [report.pane, report]))
  const rows: SessionRow[] = []

  for (const session of sessions) {
    const sessionWindows = windowsBySession.get(session.name) ?? []
    const sessionOpencodes = opencodesBySession.get(session.name) ?? []
    if (session.attached && sessionWindows.some((window) => window.active)) effects.push({ type: "markDirectoryActivity", path: session.path, source: "active", updatedAt: observedAt, minIntervalMs: 60_000 })
    const meta = gitMetaByPath.get(session.path) ?? { branch: "", flags: "" }
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
      for (const opencode of windowOpencodes) {
        if (opencode.updatedAt) effects.push({ type: "markDirectoryActivity", path: session.path, source: "clanker", updatedAt: opencode.updatedAt, minIntervalMs: 0 })
        const completionKey = paneCompletionKey(tmuxServerKey, opencode.stablePane || window.pane || opencode.pane)
        const sourceState = opencodeState(opencode)
        const state = stateWithSeen(sourceState, opencode.updatedAt, seen.get(completionKey), focused)
        if (sourceState === "done" && focused) {
          effects.push({ type: "markSeen", key: completionKey, seenAt: observedAt })
          seen.set(completionKey, observedAt)
        }
        details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || window.name || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || window.pane || opencode.pane }, completionKey, updatedAt: opencode.updatedAt })
      }
      if (windowOpencodes.length > 0) continue

      const kind = isPiWindow(window)
        ? "pi"
        : isClaudeWindow(window)
          ? "claude"
          : codexPanes.has(window.pane)
            ? "codex"
            : detectedHarnessByPane.get(window.pane) ?? "window"
      const report = reportsByPane.get(window.pane)
      if (report?.updatedAt) effects.push({ type: "markDirectoryActivity", path: session.path, source: "clanker", updatedAt: report.updatedAt, minIntervalMs: 0 })
      const sourceState = report?.harness === kind ? report.state : kind === "codex" ? codexStateFromTitle(window.title || window.name) : kind === "claude" ? claudeStateFromTitle(window.title || window.name) : "unknown"
      const updatedAt = report?.harness === kind ? report.updatedAt : window.activity * 1000
      const completionKey = kind === "window" ? windowCompletionKey(tmuxServerKey, window.id) : paneCompletionKey(tmuxServerKey, window.pane)
      const state = stateWithSeen(sourceState, updatedAt, seen.get(completionKey), focused)
      if (sourceState === "done" && focused) {
        effects.push({ type: "markSeen", key: completionKey, seenAt: observedAt })
        seen.set(completionKey, observedAt)
      }
      details.push({ kind: kind === "window" ? "window" : "clanker", harness: kind === "window" ? undefined : kind, status: kind === "window" ? window.command : "", detail: "", title: kind === "window" ? window.name || window.title : window.title || window.name, age: ageFromTimestamp(window.activity * 1000, observedAt), state, target: { type: "tmux_window", session: window.session, windowId: window.id, pane: window.pane }, completionKey, updatedAt })
    }

    for (const opencode of opencodesByWindow.get("") ?? []) {
      if (opencode.updatedAt) effects.push({ type: "markDirectoryActivity", path: session.path, source: "clanker", updatedAt: opencode.updatedAt, minIntervalMs: 0 })
      const completionKey = paneCompletionKey(tmuxServerKey, opencode.stablePane || opencode.pane)
      const sourceState = opencodeState(opencode)
      const state = stateWithSeen(sourceState, opencode.updatedAt, seen.get(completionKey))
      details.push({ kind: "clanker", harness: "opencode", status: opencode.status, detail: opencode.detail, title: opencode.title || opencode.directory, age: opencode.age, state, target: { type: "opencode", session: opencode.session, pane: opencode.stablePane || opencode.pane }, completionKey, updatedAt: opencode.updatedAt })
    }

    if (details.length === 0) details.push({ kind: "session", status: meta.flags, detail: "", title: session.path, age: ageFromTimestamp(session.recency * 1000, observedAt), state: "unknown", target: { type: "tmux_session", session: session.name }, updatedAt: 0 })

    const markers = [
      sessionOpencodes.length > 0 || sessionWindows.some((window) => detectedHarnessByPane.get(window.pane) === "opencode") ? "oc" : "",
      sessionWindows.some((window) => isPiWindow(window) || detectedHarnessByPane.get(window.pane) === "pi") ? "pi" : "",
      sessionWindows.some((window) => isClaudeWindow(window) || detectedHarnessByPane.get(window.pane) === "claude") ? "C" : "",
      sessionWindows.some((window) => codexPanes.has(window.pane) || detectedHarnessByPane.get(window.pane) === "codex") ? "codex" : "",
    ].filter(Boolean)
    const workshop = session.workshopId ? lineage.byId.get(session.workshopId) : lineage.byPath.get(session.path)
    const parentWorkshopId = workshop ? workshop.parentWorkshopId : session.parentWorkshopId
    const lineageFields = buildLineageFields(workshop?.workshopId || session.workshopId, parentWorkshopId, workshop?.childWorkshopCount ?? 0)
    const row: SessionRow = { name: session.name, path: session.path, branch: meta.branch, flags: meta.flags, markers, age: ageFromTimestamp(session.recency * 1000, observedAt), recency: session.recency, target: { type: "tmux_session", session: session.name }, details, searchText: "", workshopId: workshop?.workshopId || session.workshopId, parentWorkshopId, childWorkshopCount: workshop?.childWorkshopCount ?? 0, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText }
    row.searchText = [row.name, row.path, row.branch, row.flags, row.markers.join(" "), row.lineageLabel, row.lineageSearchText, ...row.details.flatMap((detail) => [detail.kind, detail.harness, detail.status, detail.detail, detail.title, detail.age])].join(" ").toLowerCase()
    rows.push(row)
  }

  const occupiedDirs = new Set([
    ...sessions.map((session) => expandHome(session.path, home)),
    ...opencodes.map((row) => expandHome(row.directory.replace(/ \([0-9]+\)$/, ""), home)),
  ])
  for (const directory of directories) {
    const path = expandHome(directory.path, home)
    if (occupiedDirs.has(path)) continue
    occupiedDirs.add(path)
    const details: DetailRow[] = [{ kind: "directory", status: "", detail: directory.source, title: path, age: "", state: "unknown", target: { type: "directory", path }, updatedAt: 0 }]
    const age = directory.activityAt ? ageFromTimestamp(directory.activityAt, observedAt) : ""
    const workshop = lineage.byPath.get(path)
    const lineageFields = buildLineageFields(workshop?.workshopId, workshop?.parentWorkshopId, workshop?.childWorkshopCount ?? 0)
    const row: SessionRow = { name: path, path, branch: directory.branch, flags: "", markers: [], age, recency: Math.floor((directory.activityAt ?? 0) / 1000), target: { type: "directory", path }, details, searchText: "", directorySource: directory.source, activitySource: directory.activitySource, frecency: directory.frecency, workshopId: workshop?.workshopId, parentWorkshopId: workshop?.parentWorkshopId, childWorkshopCount: workshop?.childWorkshopCount ?? 0, lineageLabel: lineageFields.lineageLabel, lineageSearchText: lineageFields.lineageSearchText }
    row.searchText = [row.name, row.path, row.branch, `${directory.source} directory`, row.activitySource, row.age, row.lineageLabel, row.lineageSearchText].join(" ").toLowerCase()
    rows.push(row)
  }

  const projectedSessions = applyResourceIncidents(rows, [...incidents], observedAt)
  projectedSessions.sort((a, b) => sessionSortRank(a) - sessionSortRank(b) || b.recency - a.recency || (b.frecency ?? 0) - (a.frecency ?? 0) || a.name.localeCompare(b.name))
  return { sessions: projectedSessions, effects }
}

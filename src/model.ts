import type { MultiplexerLocation } from "./resource-registry"
import type { AvailableAction } from "./transport/protocol"

export interface TargetIdentity {
  management?: "managed" | "unmanaged"
  resourceId?: string
  location?: Omit<MultiplexerLocation, "observedAt">
}

export type Target =
  | ({ type: "tmux_session"; session: string } & TargetIdentity)
  | ({ type: "tmux_window"; session: string; windowId: string; pane: string } & TargetIdentity)
  | ({ type: "opencode"; session: string; pane: string } & TargetIdentity)
  | { type: "directory"; path: string }

export type ClankerState = "failed" | "blocked" | "working" | "done" | "idle" | "unknown"
export type ReportedClankerState = ClankerState

export interface RuntimeObservation {
  source: "tmux" | "runtime" | "process" | "lifecycle"
  confidence: "observed" | "attested" | "rejected"
  state: ClankerState | "present" | "unreported"
  observedAt: number
  reason?: string
}

export interface DetailRow { kind: string; harness?: string; status: string; detail: string; title: string; age: string; state: ClankerState; target: Target; completionKey?: string; updatedAt: number; terminalId?: string; clankerId?: string; observation?: RuntimeObservation }
export type DirectorySource = "worktree" | "zoxide" | "activity"
export interface SessionRow { name: string; path: string; branch: string; flags: string; markers: string[]; age: string; recency: number; target: Target; details: DetailRow[]; searchText: string; availableActions?: AvailableAction[]; directorySource?: DirectorySource; activitySource?: string; frecency?: number; workshopId?: string; resourceId?: string; management?: "managed" | "unmanaged"; parentWorkshopId?: string | null; childWorkshopCount?: number; attachmentCandidateWorkshopIds?: string[]; lineageLabel?: string; lineageSearchText?: string; labels?: string[]; title?: string; project?: string }
export interface TreeRow {
  key: string
  depth: number
  session: SessionRow
  detail?: DetailRow
  target: Target
  state: ClankerState
  containsClanker: boolean
  searchText: string
  matchScore?: number
  expanded: boolean
  expandable: boolean
  detailsExpanded: boolean
  detailsExpandable: boolean
  visibleDetailCount: number
  visibleChildCount: number
  hiddenDetailCount: number
  hiddenChildCount: number
  ownerSessionKey: string
  parentSessionKey?: string
  guideColumns: boolean[]
  isLastSibling: boolean
}
export interface FuzzyResult { score: number; positions: number[] }
export interface SearchField { text: string; weight?: number }
export interface StructuredSearchResult { score: number }

interface SessionNode {
  key: string
  session: SessionRow
  children: SessionNode[]
  index: number
}

interface VisibleDetail {
  detail: DetailRow
  matchScore?: number
}

interface VisibleTreeNode {
  session: SessionRow
  key: string
  parentSessionKey?: string
  searchText: string
  matchScore?: number
  details: VisibleDetail[]
  children: VisibleTreeNode[]
  expanded: boolean
  expandable: boolean
  detailsExpanded: boolean
  detailsExpandable: boolean
  hiddenDetailCount: number
  hiddenChildCount: number
  state: ClankerState
  containsClanker: boolean
  recency: number
  score: number
}

export const normalizeReportedState = (state: ReportedClankerState, hookEvent?: string): ClankerState =>
  state === "done" && hookEvent === "session_start" ? "idle" : state

export const stateWithSeen = (state: ClankerState, updatedAt: number, seenAt = 0, focused = false): ClankerState => {
  if (state !== "done") return state
  if (focused || (seenAt > 0 && (!updatedAt || seenAt >= updatedAt))) return "idle"
  return "done"
}

const aggregateStates = (states: ClankerState[]): ClankerState => {
  if (states.includes("failed")) return "failed"
  if (states.includes("blocked")) return "blocked"
  if (states.includes("working")) return "working"
  if (states.includes("done")) return "done"
  if (states.includes("idle")) return "idle"
  return "unknown"
}

export const sessionState = (session: SessionRow): ClankerState => {
  const hasLiveClanker = session.details.some((detail) => detail.kind === "clanker" && detail.state !== "unknown")
  const currentDetails = hasLiveClanker
    ? session.details.filter((detail) => detail.kind !== "incident" || detail.status !== "lost on reboot")
    : session.details
  return aggregateStates(currentDetails.map((detail) => detail.state))
}

const neutralDetailKinds = new Set(["directory", "repository", "session", "window"])
export const isNeutralDetail = (detail: DetailRow) => neutralDetailKinds.has(detail.kind)
  || (detail.kind === "observation" && detail.observation?.source === "process" && detail.observation.confidence === "observed" && detail.observation.state === "present")

export const isNeutralSession = (
  session: SessionRow,
  state = sessionState(session),
  containsClanker = session.details.some((detail) => detail.kind === "clanker"),
): boolean => state === "unknown" && !containsClanker
  && (session.target.type === "directory" || session.details.every(isNeutralDetail))

/** Status-bearing rows precede grey-orb rows; each group remains newest-first. */
export const compareProjectedSessions = (a: SessionRow, b: SessionRow) =>
  Number(isNeutralSession(a)) - Number(isNeutralSession(b))
  || b.recency - a.recency
  || a.name.localeCompare(b.name)

export const fuzzyResult = (text: string, query: string): FuzzyResult | undefined => {
  const chars = Array.from(text.toLowerCase())
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) return { score: 0, positions: [] }
  const positions: number[] = []
  let searchFrom = 0
  for (const char of Array.from(normalizedQuery)) {
    const index = chars.indexOf(char, searchFrom)
    if (index < 0) return undefined
    positions.push(index)
    searchFrom = index + 1
  }
  const span = positions[positions.length - 1]! - positions[0]! + 1
  let score = normalizedQuery.length * 100 - span * 8 - positions[0]! * 2
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i]!
    const previousPosition = positions[i - 1]
    const previousChar = position > 0 ? chars[position - 1] ?? "" : ""
    if (position === 0) score += 35
    if (["/", "@", "-", "_", " ", "."].includes(previousChar)) score += 30
    if (previousPosition !== undefined && position === previousPosition + 1) score += 45
  }
  return { score, positions }
}

const normalizeTerms = (query: string) => query.toLowerCase().trim().split(/\s+/).filter(Boolean)

export const structuredSearch = (fields: Array<string | SearchField>, query: string): StructuredSearchResult | undefined => {
  const terms = normalizeTerms(query)
  if (terms.length === 0) return { score: 0 }
  const normalizedFields = fields
    .map((field) => typeof field === "string" ? { text: field, weight: 0 } : { text: field.text, weight: field.weight ?? 0 })
    .map((field) => ({ ...field, text: field.text.toLowerCase().trim() }))
    .filter((field) => field.text.length > 0)
  if (normalizedFields.length === 0) return undefined

  let score = 0
  for (const term of terms) {
    let bestTermScore = Number.NEGATIVE_INFINITY
    for (const field of normalizedFields) {
      const match = fuzzyResult(field.text, term)
      if (!match) continue
      bestTermScore = Math.max(bestTermScore, match.score + field.weight)
    }
    if (!Number.isFinite(bestTermScore)) return undefined
    score += bestTermScore
  }
  return { score }
}

export const targetKey = (target: Target) => {
  if ("resourceId" in target && target.resourceId) return `${target.type}:${target.resourceId}`
  switch (target.type) {
    case "tmux_session": return `session:${target.session}`
    case "tmux_window": return `window:${target.session}:${target.windowId}`
    case "opencode": return `opencode:${target.session}:${target.pane}`
    case "directory": return `directory:${target.path}`
  }
}

const sessionSearchFields = (session: SessionRow): SearchField[] => [
  { text: session.name, weight: 180 },
  { text: session.branch, weight: 140 },
  { text: session.path, weight: 80 },
  { text: session.flags, weight: 40 },
  { text: session.markers.join(" "), weight: 50 },
  { text: (session.labels ?? []).join(" "), weight: 50 },
  { text: session.title ?? "", weight: 180 },
  { text: session.lineageLabel || "", weight: 30 },
  { text: session.lineageSearchText || "", weight: 70 },
]
const sessionSearchText = (session: SessionRow) => [session.name, session.path, session.branch, session.flags, session.markers.join(" "), (session.labels ?? []).join(" "), session.title ?? "", session.lineageLabel, session.lineageSearchText].join(" ").toLowerCase()
const detailSearchFields = (detail: DetailRow): SearchField[] => [
  { text: detail.title, weight: 160 },
  { text: detail.kind, weight: 140 },
  { text: detail.harness ?? "", weight: 140 },
  { text: detail.status, weight: 80 },
  { text: detail.detail, weight: 70 },
  { text: detail.state, weight: 30 },
  { text: detail.age, weight: 10 },
]
const detailSearchText = (_session: SessionRow, detail: DetailRow) => [detail.kind, detail.harness, detail.status, detail.detail, detail.title, detail.age, detail.state].join(" ").toLowerCase()
const selectableDetails = (session: SessionRow) => session.details.filter((detail) => !["directory", "repository", "session"].includes(detail.kind))
const sessionNodeContainsClanker = (node: SessionNode): boolean => node.session.details.some((detail) => detail.kind === "clanker") || node.children.some(sessionNodeContainsClanker)
const subtreeRecency = (node: SessionNode): number => Math.max(node.session.recency, ...node.children.map(subtreeRecency))
const containsPrioritySession = (node: SessionNode | VisibleTreeNode, prioritySessionKeys: ReadonlySet<string> | undefined): boolean =>
  Boolean(prioritySessionKeys?.has(node.key) || node.children.some((child) => containsPrioritySession(child, prioritySessionKeys)))
const neutralNode = (node: VisibleTreeNode) => Number(isNeutralSession(node.session, node.state, node.containsClanker))
const visibleTreeTieBreak = (a: VisibleTreeNode, b: VisibleTreeNode, prioritySessionKeys?: ReadonlySet<string>) =>
  Number(containsPrioritySession(b, prioritySessionKeys)) - Number(containsPrioritySession(a, prioritySessionKeys))
  || neutralNode(a) - neutralNode(b)
  || b.recency - a.recency
  || a.session.name.localeCompare(b.session.name)
// Root groups are reversed as units by the bottom-up picker. Descendants retain
// their order, so put neutral children first, then oldest-first, and keep the current child last.
const visibleChildTieBreak = (a: VisibleTreeNode, b: VisibleTreeNode, prioritySessionKeys?: ReadonlySet<string>) =>
  Number(containsPrioritySession(a, prioritySessionKeys)) - Number(containsPrioritySession(b, prioritySessionKeys))
  || neutralNode(b) - neutralNode(a)
  || a.recency - b.recency
  || a.session.name.localeCompare(b.session.name)
const maxScore = (...scores: number[]) => {
  const score = Math.max(...scores)
  return Number.isFinite(score) ? score : 0
}

const sessionForest = (sessions: SessionRow[]) => {
  const idCounts = new Map<string, number>()
  for (const session of sessions) {
    if (!session.workshopId) continue
    idCounts.set(session.workshopId, (idCounts.get(session.workshopId) ?? 0) + 1)
  }

  const nodes = sessions.map((session, index): SessionNode => ({ key: targetKey(session.target), session, children: [], index }))
  const byWorkshopId = new Map<string, SessionNode>()
  for (const node of nodes) {
    const workshopId = node.session.workshopId
    if (!workshopId || idCounts.get(workshopId) !== 1) continue
    byWorkshopId.set(workshopId, node)
  }

  const wouldCycle = (child: SessionNode, parent: SessionNode) => {
    const seen = new Set<string>([child.key])
    let cursor: SessionNode | undefined = parent
    while (cursor) {
      if (seen.has(cursor.key)) return true
      seen.add(cursor.key)
      const nextId: string | null | undefined = cursor.session.parentWorkshopId
      cursor = nextId ? byWorkshopId.get(nextId) : undefined
    }
    return false
  }

  const roots: SessionNode[] = []
  for (const node of nodes) {
    const parentId = node.session.parentWorkshopId
    const parent = parentId ? byWorkshopId.get(parentId) : undefined
    if (!parent || parent === node || wouldCycle(node, parent)) {
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }

  return { roots, nodes }
}

const subtreeState = (node: SessionNode): ClankerState => aggregateStates([sessionState(node.session), ...node.children.map(subtreeState)])

const visibleNode = (
  node: SessionNode,
  normalizedQuery: string,
  expandedDetailSessions: ReadonlySet<string> | undefined,
  ancestors: SessionNode[] = [],
  includeLineage = false,
  prioritySessionKeys?: ReadonlySet<string>,
): VisibleTreeNode | undefined => {
  const searchText = sessionSearchText(node.session)
  const sessionMatch = structuredSearch(sessionSearchFields(node.session), normalizedQuery)
  const exposeLineage = includeLineage || Boolean(sessionMatch)
  const details = selectableDetails(node.session)
  const detailMatches = details.flatMap((detail) => {
    const match = structuredSearch(detailSearchFields(detail), normalizedQuery)
    return match ? [{ detail, match }] : []
  })
  const children = node.children.flatMap((child) => {
    const visible = visibleNode(child, normalizedQuery, expandedDetailSessions, [...ancestors, node], exposeLineage, prioritySessionKeys)
    return visible ? [visible] : []
  // Lineage siblings keep structural (recency) order under search too; a descendant's
  // incidental fuzzy match against ancestor-derived text must not reorder the subtree.
  }).sort((a, b) => visibleChildTieBreak(a, b, prioritySessionKeys))
  if (!exposeLineage && detailMatches.length === 0 && children.length === 0) return undefined

  const detailsExpanded = Boolean(expandedDetailSessions?.has(node.session.name))
  const visibleDetails = detailMatches.map(({ detail, match }) => ({ detail, matchScore: match.score }))
  const score = maxScore(sessionMatch?.score ?? Number.NEGATIVE_INFINITY, ...detailMatches.map(({ match }) => match.score), ...children.map((child) => child.score))
  return {
    session: node.session,
    key: node.key,
    parentSessionKey: ancestors.at(-1)?.key,
    searchText,
    matchScore: sessionMatch?.score,
    details: visibleDetails,
    children,
    expanded: children.length > 0,
    expandable: node.children.length > 0,
    detailsExpanded,
    detailsExpandable: details.length > 0,
    hiddenDetailCount: Math.max(0, details.length - visibleDetails.length),
    hiddenChildCount: Math.max(0, node.children.length - children.length),
    state: subtreeState(node),
    containsClanker: sessionNodeContainsClanker(node),
    recency: subtreeRecency(node),
    score,
  }
}

const expandedNode = (
  node: SessionNode,
  expandedLineageSessions: ReadonlySet<string> | undefined,
  expandedDetailSessions: ReadonlySet<string> | undefined,
  parentSessionKey?: string,
  prioritySessionKeys?: ReadonlySet<string>,
): VisibleTreeNode => {
  const details = selectableDetails(node.session)
  // The current Workshop must never disappear behind a collapsed ancestor.
  const lineageExpanded = node.children.length > 0 && (
    containsPrioritySession(node, prioritySessionKeys)
    || !expandedLineageSessions || expandedLineageSessions.has(node.session.name)
  )
  const detailsExpanded = Boolean(details.length > 0 && expandedDetailSessions?.has(node.session.name))
  const children = node.children
    .map((child) => expandedNode(child, expandedLineageSessions, expandedDetailSessions, node.key, prioritySessionKeys))
    .sort((a, b) => visibleChildTieBreak(a, b, prioritySessionKeys))
  const visibleChildren = lineageExpanded ? children : []
  const visibleDetails = detailsExpanded ? details.map((detail) => ({ detail })) : []
  return {
    session: node.session,
    key: node.key,
    parentSessionKey,
    searchText: sessionSearchText(node.session),
    details: visibleDetails,
    children: visibleChildren,
    expanded: lineageExpanded,
    expandable: node.children.length > 0,
    detailsExpanded,
    detailsExpandable: details.length > 0,
    hiddenDetailCount: Math.max(0, details.length - visibleDetails.length),
    hiddenChildCount: Math.max(0, node.children.length - visibleChildren.length),
    state: aggregateStates([sessionState(node.session), ...children.map((child) => child.state)]),
    containsClanker: node.session.details.some((detail) => detail.kind === "clanker") || children.some((child) => child.containsClanker),
    recency: Math.max(node.session.recency, ...children.map((child) => child.recency)),
    score: 0,
  }
}

const detailTreeKey = (detail: DetailRow) => {
  const evidence = detail.kind === "observation" && detail.observation
    ? `:${detail.observation.source}:${detail.observation.confidence}:${detail.observation.reason ?? ""}`
    : ""
  return `${targetKey(detail.target)}:${detail.kind}${evidence}`
}

const flattenTreeRows = (node: VisibleTreeNode, depth: number, guideColumns: boolean[], isLastSibling: boolean): TreeRow[] => {
  const sessionRow: TreeRow = {
    key: node.key,
    depth,
    session: node.session,
    target: node.session.target,
    state: node.state,
    containsClanker: node.containsClanker,
    searchText: node.searchText,
    matchScore: node.matchScore,
    expanded: node.expanded,
    expandable: node.expandable,
    detailsExpanded: node.detailsExpanded,
    detailsExpandable: node.detailsExpandable,
    visibleDetailCount: node.details.length,
    visibleChildCount: node.children.length,
    hiddenDetailCount: node.hiddenDetailCount,
    hiddenChildCount: node.hiddenChildCount,
    ownerSessionKey: node.key,
    parentSessionKey: node.parentSessionKey,
    guideColumns,
    isLastSibling,
  }
  const childrenGuides = depth === 0 ? [] : [...guideColumns, !isLastSibling]
  const entries: Array<{ detail: VisibleDetail } | { child: VisibleTreeNode }> = [...node.details.map((detail) => ({ detail })), ...node.children.map((child) => ({ child }))]
  const childRows = entries.flatMap((entry, index) => {
    const childIsLast = index === entries.length - 1
    if ("detail" in entry) {
      return [{
        key: detailTreeKey(entry.detail.detail),
        depth: depth + 1,
        session: node.session,
        detail: entry.detail.detail,
        target: entry.detail.detail.target,
        state: entry.detail.detail.state,
        containsClanker: entry.detail.detail.kind === "clanker",
        searchText: detailSearchText(node.session, entry.detail.detail),
        matchScore: entry.detail.matchScore,
        expanded: false,
        expandable: false,
        detailsExpanded: false,
        detailsExpandable: false,
        visibleDetailCount: 0,
        visibleChildCount: 0,
        hiddenDetailCount: 0,
        hiddenChildCount: 0,
        ownerSessionKey: node.key,
        parentSessionKey: node.key,
        guideColumns: childrenGuides,
        isLastSibling: childIsLast,
      } satisfies TreeRow]
    }
    return flattenTreeRows(entry.child, depth + 1, childrenGuides, childIsLast)
  })
  return [sessionRow, ...childRows]
}

const expandedLineageRowCount = (node: SessionNode): number => 1 + node.children.reduce((count, child) => count + expandedLineageRowCount(child), 0)

export const defaultExpandedLineageSessions = (sessions: SessionRow[], maxExpandedRows = 10) => {
  const { nodes } = sessionForest(sessions)
  return new Set(
    nodes
      .filter((node) => {
        if (node.children.length === 0) return false
        const state = subtreeState(node)
        return expandedLineageRowCount(node) < maxExpandedRows || state === "working" || state === "done"
      })
      .map((node) => node.session.name),
  )
}

export const buildTreeRows = (
  sessions: SessionRow[],
  query: string,
  options: { expandedLineageSessions?: ReadonlySet<string>; expandedDetailSessions?: ReadonlySet<string>; prioritySessionKeys?: ReadonlySet<string>; bottomUp?: boolean } = {},
): TreeRow[] => {
  const normalized = query.trim().toLowerCase()
  const { roots } = sessionForest(sessions)
  const visibleRoots = normalized
    ? roots
        .flatMap((node) => {
          const visible = visibleNode(node, normalized, options.expandedDetailSessions, [], false, options.prioritySessionKeys)
          return visible ? [visible] : []
        })
        .sort((a, b) => b.score - a.score || visibleTreeTieBreak(a, b, options.prioritySessionKeys))
    : roots
        .map((node) => expandedNode(node, options.expandedLineageSessions, options.expandedDetailSessions, undefined, options.prioritySessionKeys))
        .sort((a, b) => visibleTreeTieBreak(a, b, options.prioritySessionKeys))

  const groups = visibleRoots.map((node, index) => flattenTreeRows(node, 0, [], index === visibleRoots.length - 1))
  return options.bottomUp ? groups.flatMap((rows) => [...rows].reverse()) : groups.flat()
}

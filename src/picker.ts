import type { SessionRow, Target, TreeRow } from "./model"

export interface TreeRowAnchor {
  key: string
  target: Target
  workshopId?: string
  sessionPath: string
  sessionName: string
  detailKind?: string
  detailTitle?: string
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

const sameTarget = (left: Target | undefined, right: Target | undefined) => {
  if (!left || !right || left.type !== right.type) return false
  switch (left.type) {
    case "directory": {
      const other = right as Extract<Target, { type: "directory" }>
      return left.path === other.path
    }
    case "tmux_session": {
      const other = right as Extract<Target, { type: "tmux_session" }>
      return left.session === other.session
    }
    case "opencode": {
      const other = right as Extract<Target, { type: "opencode" }>
      return left.pane === other.pane
    }
    case "tmux_window": {
      const other = right as Extract<Target, { type: "tmux_window" }>
      return left.windowId === other.windowId || left.pane === other.pane
    }
  }
}

export const treeRowAnchor = (row: TreeRow | undefined): TreeRowAnchor | undefined => row
  ? {
      key: row.key,
      target: row.target,
      workshopId: row.session.workshopId,
      sessionPath: row.session.path,
      sessionName: row.session.name,
      detailKind: row.detail?.kind,
      detailTitle: row.detail?.title,
    }
  : undefined

const matchesTreeRowAnchor = (row: TreeRow, anchor: TreeRowAnchor | undefined) => {
  if (!anchor) return false
  if (row.key === anchor.key) return true
  if (sameTarget(row.target, anchor.target)) return true
  if (anchor.workshopId && row.session.workshopId === anchor.workshopId) {
    return row.detail ? row.detail.kind === anchor.detailKind && row.detail.title === anchor.detailTitle : !anchor.detailKind
  }
  if (row.session.path === anchor.sessionPath) {
    return row.detail ? row.detail.kind === anchor.detailKind && row.detail.title === anchor.detailTitle : !anchor.detailKind
  }
  if (row.session.name === anchor.sessionName) {
    return row.detail ? row.detail.kind === anchor.detailKind && row.detail.title === anchor.detailTitle : !anchor.detailKind
  }
  return false
}

export const bestMatchIndex = <T extends { matchScore?: number }>(rows: T[]) => {
  let bestIndex = -1
  let bestScore = Number.NEGATIVE_INFINITY
  rows.forEach((row, index) => {
    const score = row.matchScore
    if (score === undefined || !Number.isFinite(score)) return
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return bestIndex
}

export const selectedItem = <T,>(rows: T[], index: number) => rows[index]

export const pickSelection = (rows: TreeRow[], index: number, query: string, anchor?: TreeRowAnchor) => {
  if (rows.length === 0) return undefined
  const preservedIndex = anchor ? rows.findIndex((row) => matchesTreeRowAnchor(row, anchor)) : -1
  const searching = Boolean(query.trim())
  if (preservedIndex >= 0 && (!searching || Number.isFinite(rows[preservedIndex]?.matchScore))) return rows[preservedIndex]
  if (searching) {
    const bestIndex = bestMatchIndex(rows)
    if (bestIndex >= 0) return rows[bestIndex]
  }
  return rows[clamp(index, 0, rows.length - 1)]
}

export const refreshSessionsAuthoritatively = (_current: SessionRow[], refreshed: SessionRow[]) => refreshed

export const visibleSlice = <T,>(rows: T[], index: number, count: number) => {
  const windowSize = Math.max(1, count)
  const maxStart = Math.max(0, rows.length - windowSize)
  const start = clamp(index - Math.floor((windowSize - 1) / 2), 0, maxStart)
  return rows.slice(start, start + windowSize).reverse()
}

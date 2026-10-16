import { buildTreeRows, compareProjectedSessions, sessionState, targetKey, type SessionRow } from "./model"

export type DiagnosticSeverity = "error" | "warning" | "info"

export interface DiagnosticIssue {
  code: string
  severity: DiagnosticSeverity
  summary: string
  targets: string[]
  evidence?: Record<string, unknown>
  suggestion: string
}

export interface ProjectionDiagnosticReport {
  version: 1
  healthy: boolean
  counts: {
    resources: number
    sessions: number
    directories: number
    managed: number
    unknownClankers: number
    observations: number
    rejectedObservations: number
    expectedUnknownResources: number
    renderedSessionRows: number
  }
  issues: DiagnosticIssue[]
}

const duplicates = <T>(values: Iterable<T>) => {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 1)
}

const issue = (code: string, severity: DiagnosticSeverity, summary: string, targets: string[], suggestion: string, evidence?: Record<string, unknown>): DiagnosticIssue =>
  ({ code, severity, summary, targets, suggestion, ...(evidence ? { evidence } : {}) })

const lineageCycles = (sessions: SessionRow[]) => {
  const unique = new Map<string, SessionRow>()
  const counts = new Map<string, number>()
  for (const row of sessions) if (row.workshopId) counts.set(row.workshopId, (counts.get(row.workshopId) ?? 0) + 1)
  for (const row of sessions) if (row.workshopId && counts.get(row.workshopId) === 1) unique.set(row.workshopId, row)
  const cycles = new Set<string>()
  for (const start of unique.keys()) {
    const path: string[] = []
    const positions = new Map<string, number>()
    let current: string | undefined = start
    while (current && unique.has(current)) {
      const position = positions.get(current)
      if (position !== undefined) {
        for (const id of path.slice(position)) cycles.add(id)
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = unique.get(current)?.parentWorkshopId ?? undefined
    }
  }
  return [...cycles].sort()
}

export const diagnoseProjection = (sessions: readonly SessionRow[]): ProjectionDiagnosticReport => {
  const rows = [...sessions]
  const issues: DiagnosticIssue[] = []
  const keys = rows.map((row) => targetKey(row.target))
  for (const [key, count] of duplicates(keys)) issues.push(issue(
    "duplicate-target",
    "error",
    `Target ${key} is projected ${count} times`,
    [String(key)],
    "Trace projection ownership and retain exactly one row for each exact target identity.",
    { count },
  ))

  for (const [workshopId, count] of duplicates(rows.flatMap((row) => row.workshopId ? [row.workshopId] : []))) issues.push(issue(
    "ambiguous-workshop",
    "error",
    `Workshop ${workshopId} is represented by ${count} rows`,
    rows.filter((row) => row.workshopId === workshopId).map((row) => targetKey(row.target)),
    "Prefer the validated managed session and suppress compatibility directory aliases.",
    { workshopId, count },
  ))

  const workshopIds = new Set(rows.flatMap((row) => row.workshopId ? [row.workshopId] : []))
  for (const row of rows) if (row.parentWorkshopId && !workshopIds.has(row.parentWorkshopId)) issues.push(issue(
    "orphan-lineage",
    "warning",
    `${row.name} references a parent Workshop that is not projected`,
    [targetKey(row.target)],
    "Verify the lineage store and whether the parent should be represented as a session or directory.",
    { workshopId: row.workshopId, parentWorkshopId: row.parentWorkshopId },
  ))

  const cycles = lineageCycles(rows)
  if (cycles.length) issues.push(issue(
    "lineage-cycle",
    "error",
    `Workshop lineage contains a cycle involving ${cycles.join(", ")}`,
    cycles,
    "Repair durable parentage before rendering the tree.",
  ))

  for (const row of rows) {
    const key = targetKey(row.target)
    const location = row.target.type === "directory" ? undefined : row.target.location
    if (row.management === "managed" && (!row.resourceId || !location)) issues.push(issue(
      "incomplete-managed-identity",
      "error",
      `${row.name} is marked managed without a complete resource identity and Multiplexer Location`,
      [key],
      "Reconcile registry ownership and validate the current Multiplexer Location.",
      { resourceId: row.resourceId ?? null, location: location ?? null },
    ))
    if (!row.name.trim() || row.name !== row.name.trim() || /[\u0000-\u001f\u007f]/.test(row.name) || row.name.length > 160) issues.push(issue(
      "suspicious-name",
      "warning",
      `Resource has a suspicious Display Name: ${JSON.stringify(row.name)}`,
      [key],
      "Compare the durable Display Name with the native session label and rename only the owned metadata.",
    ))
    if (row.target.type === "directory" && row.target.path !== row.path) issues.push(issue(
      "directory-path-mismatch",
      "error",
      `${row.name} displays a different path than its target`,
      [key],
      "Canonicalize the directory once in the projection core.",
      { displayedPath: row.path, targetPath: row.target.path },
    ))
    for (const detail of row.details) if (detail.kind === "clanker" && detail.state === "unknown") issues.push(issue(
      "unknown-clanker-state",
      "warning",
      `${detail.harness || "Clanker"} in ${row.name} renders as unknown (?)`,
      [targetKey(detail.target)],
      "Inspect the explicit Clanker report, socket ownership, generation, and harness session identity.",
      { clankerId: detail.clankerId ?? null, status: detail.status, title: detail.title },
    ))
    for (const detail of row.details) if (detail.observation?.confidence === "rejected") issues.push(issue(
      "rejected-runtime-observation",
      "info",
      `${detail.harness || "Runtime"} evidence in ${row.name} did not match owned identity`,
      [targetKey(detail.target)],
      "Inspect the reported and owned Clanker, harness-session, and recovery-attempt identities without suppressing the observed fact.",
      { source: detail.observation.source, state: detail.observation.state, reason: detail.observation.reason ?? null, observedAt: detail.observation.observedAt },
    ))
  }

  const expectedOrder = [...rows].sort(compareProjectedSessions).map((row) => targetKey(row.target))
  const actualOrder = rows.map((row) => targetKey(row.target))
  const mismatch = actualOrder.findIndex((key, index) => key !== expectedOrder[index])
  if (mismatch >= 0) issues.push(issue(
    "projection-sort-drift",
    "warning",
    `Projection order diverges from the functional-core comparator at index ${mismatch}`,
    [actualOrder[mismatch]!, expectedOrder[mismatch]!],
    "Ensure every producer sorts with compareProjectedSessions before publishing.",
    { index: mismatch, actual: actualOrder[mismatch], expected: expectedOrder[mismatch] },
  ))

  const expanded = new Set(rows.map((row) => row.name))
  const rendered = buildTreeRows(rows, "", { expandedLineageSessions: expanded })
  const renderedSessions = rendered.filter((row) => !row.detail)
  for (const [key, count] of duplicates(renderedSessions.map((row) => row.key))) issues.push(issue(
    "duplicate-rendered-session",
    "error",
    `Tree rendering emits ${key} ${count} times`,
    [String(key)],
    "Reject ambiguous lineage parents and cycles in the functional core.",
    { count },
  ))

  const unknownClankers = rows.flatMap((row) => row.details).filter((detail) => detail.kind === "clanker" && detail.state === "unknown").length
  const observations = rows.flatMap((row) => row.details).filter((detail) => detail.kind === "observation").length
  const rejectedObservations = rows.flatMap((row) => row.details).filter((detail) => detail.observation?.confidence === "rejected").length
  const expectedUnknownResources = rows.filter((row) => sessionState(row) === "unknown" && !row.details.some((detail) => detail.kind === "clanker")).length
  return {
    version: 1,
    healthy: !issues.some((entry) => entry.severity === "error"),
    counts: {
      resources: rows.length,
      sessions: rows.filter((row) => row.target.type === "session").length,
      directories: rows.filter((row) => row.target.type === "directory").length,
      managed: rows.filter((row) => row.management === "managed").length,
      unknownClankers,
      observations,
      rejectedObservations,
      expectedUnknownResources,
      renderedSessionRows: renderedSessions.length,
    },
    issues,
  }
}

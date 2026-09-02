import { randomUUID } from "node:crypto"
import { instanceSlug } from "./paths"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { canonicalActivityPath } from "./activity"
import type { DetailRow, SessionRow, Target } from "./model"

export type IncidentKind = "resource_pressure_termination" | "resource_pressure_workload_stop" | "resource_pressure_clanker_stop" | "unclean_boot_clanker_loss" | "recovery_quarantined" | "recovery_pressure_suspension" | "recovery_descendant_cleanup_failed" | "aggregate_io_saturation" | "interrupted_tool_requires_confirmation"

export interface ResourceIncident {
  version: 1
  id: string
  kind: IncidentKind
  occurredAt: number
  status: "open"
  clanker: {
    clankerId: string
    harness: "pi" | "claude" | "opencode" | "codex"
    pane?: string
    sessionName?: string
    worktreePath?: string
    cwd?: string
  }
  evidence?: {
    reason?: string
    forced?: boolean
    previousBootId?: string
    ownerUnit?: string
    attemptId?: number
    attemptNumber?: number
    bootId?: string
    memoryPsiSome?: number
    ioPsiSome?: number
    ioPsiFull?: number
    rootReadBytesPerSecond?: number
    process?: { pid: number; command: string; rssBytes?: number; ioBytesPerSecond?: number }
    steering?: { attempted: boolean; delivered: boolean }
  }
}

export const incidentStateDirectory = `${Bun.env.XDG_STATE_HOME || `${Bun.env.HOME || ""}/.local/state`}/clankerhouse${instanceSlug()}/incidents`
const incidentKinds = new Set<IncidentKind>(["resource_pressure_termination", "resource_pressure_workload_stop", "resource_pressure_clanker_stop", "unclean_boot_clanker_loss", "recovery_quarantined", "recovery_pressure_suspension", "recovery_descendant_cleanup_failed", "aggregate_io_saturation", "interrupted_tool_requires_confirmation"])
const harnesses = new Set(["pi", "claude", "opencode", "codex"])

export const recordRecoveryIncident = (kind: IncidentKind, clanker: ResourceIncident["clanker"], evidence: NonNullable<ResourceIncident["evidence"]> = {}, directory = incidentStateDirectory) => {
  if (!incidentKinds.has(kind)) throw new Error(`Unsupported incident kind ${kind}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const occurredAt = Date.now()
  const incident: ResourceIncident = { version: 1, id: randomUUID(), kind, occurredAt, status: "open", clanker, evidence }
  const path = resolve(directory, `${new Date(occurredAt).toISOString().replace(/[:]/g, "")}-${kind}-${incident.id}.json`)
  writeFileSync(path, `${JSON.stringify(incident, null, 2)}\n`, { mode: 0o400, flag: "wx" })
  const descriptor = openSync(path, "r")
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  const directoryDescriptor = openSync(directory, "r")
  try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
  return path
}

const validIncident = (value: unknown): value is ResourceIncident => {
  if (!value || typeof value !== "object") return false
  const incident = value as Partial<ResourceIncident>
  return incident.version === 1
    && typeof incident.id === "string" && incident.id.length > 0
    && incidentKinds.has(incident.kind as IncidentKind)
    && Number.isFinite(incident.occurredAt) && Number(incident.occurredAt) > 0
    && incident.status === "open"
    && Boolean(incident.clanker && typeof incident.clanker.clankerId === "string" && harnesses.has(incident.clanker.harness || ""))
}

export const readResourceIncidents = (directory = incidentStateDirectory): ResourceIncident[] => {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (!entry.endsWith(".json")) return []
    try {
      const incident = JSON.parse(readFileSync(resolve(directory, entry), "utf8"))
      return validIncident(incident) ? [incident] : []
    } catch {
      return []
    }
  }).sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id))
}

export const resolveRecoveredClankerIncidents = (clankerId: string, directory = incidentStateDirectory, resolvedAt = Date.now()) => {
  if (!clankerId) throw new Error("clankerId is required")
  if (!existsSync(directory)) return []
  const resolved: string[] = []
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue
    const path = resolve(directory, entry)
    let incident: Record<string, unknown>
    try {
      incident = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    const clanker = incident.clanker as Record<string, unknown> | undefined
    if (incident.kind !== "unclean_boot_clanker_loss" || incident.status !== "open" || clanker?.clankerId !== clankerId) continue
    const next = { ...incident, status: "resolved", resolvedAt }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    resolved.push(String(incident.id))
  }
  return resolved
}

const incidentPath = (incident: ResourceIncident) => incident.clanker.worktreePath || incident.clanker.cwd || ""
const incidentStatus = (incident: ResourceIncident) => incident.kind === "resource_pressure_workload_stop"
  ? "workload stopped"
  : incident.kind === "resource_pressure_clanker_stop"
    ? "clanker stopped"
    : incident.kind === "resource_pressure_termination" || incident.kind === "recovery_pressure_suspension"
      ? "terminated"
      : incident.kind === "unclean_boot_clanker_loss" ? "lost on reboot" : "recovery blocked"
const ageFromTimestamp = (timestamp: number, observedAt: number) => {
  const seconds = Math.max(0, Math.floor((observedAt - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

const incidentDetail = (incident: ResourceIncident, target: Target, observedAt: number): DetailRow => ({
  kind: "incident",
  status: incidentStatus(incident),
  detail: incident.evidence?.reason || incident.kind,
  title: `${incident.clanker.harness} ${incident.clanker.clankerId}`,
  age: ageFromTimestamp(incident.occurredAt, observedAt),
  state: "failed",
  target,
  updatedAt: incident.occurredAt,
})

const rowMatches = (row: SessionRow, incident: ResourceIncident) => {
  if (incident.clanker.sessionName && row.target.type === "tmux_session" && row.name === incident.clanker.sessionName) return true
  const path = incidentPath(incident)
  return Boolean(path && row.path && canonicalActivityPath(row.path) === canonicalActivityPath(path))
}

export const applyResourceIncidents = (rows: SessionRow[], incidents: ResourceIncident[], observedAt = Date.now()) => {
  const result = rows.map((row) => ({ ...row, details: [...row.details] }))
  for (const incident of incidents) {
    let row = result.find((candidate) => rowMatches(candidate, incident))
    // Any later Workshop activity acknowledges the incident in the actionable
    // projection while preserving its durable record for diagnostics.
    if (row && row.recency > Math.floor(incident.occurredAt / 1000)) continue
    if (!row) continue
    row.details.push(incidentDetail(incident, row.target, observedAt))
    row.recency = Math.max(row.recency, Math.floor(incident.occurredAt / 1000))
    row.searchText = [row.searchText, incident.id, incident.kind, incidentStatus(incident), incident.clanker.harness, incident.clanker.clankerId, incident.evidence?.reason].filter(Boolean).join(" ").toLowerCase()
  }
  return result
}

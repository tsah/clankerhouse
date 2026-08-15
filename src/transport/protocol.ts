import type { Target } from "../model"
import type { ProjectionSnapshot } from "../projection"

export const SNAPSHOT_PROTOCOL_VERSION = 1 as const

export type AvailableAction = "open" | "absorb" | "rename" | "attach" | "reparent" | "detach" | "delete" | "create" | "start" | "stop" | "recovery"

export type MutationIntent =
  | { type: "open"; target: Target; client?: string }
  | { type: "absorb"; target: Target }
  | { type: "rename"; session: string; resourceId?: string; displayName: string }
  | { type: "attach" | "reparent"; workshopId: string; parentWorkshopId: string; session?: string }
  | { type: "detach"; workshopId: string; session?: string }
  | { type: "delete"; kind: "pane" | "session" | "worktree"; session: string; confirmed: true; pane?: string; path?: string }
  | { type: "create"; repository: string; branch: string; create: boolean; base?: string }
  | { type: "start"; clankerId: string; force?: boolean }
  | { type: "stop"; clankerId: string; confirmed: true; reason?: string }
  | { type: "recovery"; clankerId: string; action: "reconcile" | "resume" | "suspend" | "tombstone"; force?: boolean; reason?: string }
  | { type: "repository.refresh" }

export type SnapshotMethod = "server.status" | "server.health" | "snapshot.get" | "snapshots.subscribe" | "projection.refresh" | "mutation.submit" | "operation.status"

interface RequestBase { version: typeof SNAPSHOT_PROTOCOL_VERSION; id: string }
export type SnapshotRequest =
  | (RequestBase & { method: "server.status" | "server.health" | "snapshot.get" | "snapshots.subscribe" | "projection.refresh" })
  | (RequestBase & { method: "mutation.submit"; params: { idempotencyKey: string; intent: MutationIntent } })
  | (RequestBase & { method: "operation.status"; params: { operationId: string } })

export interface ServerStatus {
  protocolVersion: typeof SNAPSHOT_PROTOCOL_VERSION
  startedAt: number
  subscribers: number
  healthy: true
  epoch: string
  owner: string
  revision: ProjectionSnapshot<unknown>["revision"]
}

export interface SubscriptionResult { subscribed: true; epoch: string }
export interface ProjectionRefreshResult { revision: ProjectionSnapshot<unknown>["revision"] }

export type OperationState = "queued" | "running" | "succeeded" | "failed"
export interface OperationRecord {
  operationId: string
  idempotencyKey: string
  intent: MutationIntent
  state: OperationState
  stage: string
  attempts: number
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
}

export interface MutationSubmitResult { operation: OperationRecord; replayed: boolean }
export type SnapshotResult<T> = ServerStatus | ProjectionSnapshot<T> | SubscriptionResult | ProjectionRefreshResult | MutationSubmitResult | OperationRecord

export interface SuccessResponse<T = unknown> { version: typeof SNAPSHOT_PROTOCOL_VERSION; id: string; ok: true; result: T }
export interface ErrorResponse {
  version: typeof SNAPSHOT_PROTOCOL_VERSION
  id: string | null
  ok: false
  error: { code: "bad_request" | "unsupported_version" | "method_not_found" | "request_too_large" | "server_busy" | "not_found" | "stale_producer"; message: string }
}
export interface SnapshotEvent<T> { version: typeof SNAPSHOT_PROTOCOL_VERSION; event: "snapshot"; epoch: string; snapshot: ProjectionSnapshot<T> }
export type ServerMessage<T> = SuccessResponse<SnapshotResult<T>> | ErrorResponse | SnapshotEvent<T>
export const encodeMessage = (message: object): string => `${JSON.stringify(message)}\n`

const validText = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const validTarget = (value: unknown): value is Target => {
  if (!value || typeof value !== "object") return false
  const target = value as Record<string, unknown>
  if (target.type === "directory") return validText(target.path)
  if (target.type === "tmux_session") return validText(target.session)
  if (target.type === "tmux_window") return validText(target.session) && validText(target.windowId) && validText(target.pane)
  return target.type === "opencode" && validText(target.session) && validText(target.pane)
}

const parseIntent = (value: unknown): MutationIntent | undefined => {
  if (!value || typeof value !== "object") return undefined
  const intent = value as Record<string, unknown>
  switch (intent.type) {
    case "open": {
      if (!validTarget(intent.target) || (intent.client !== undefined && !validText(intent.client, 512))) return undefined
      return { type: "open", target: intent.target, ...(typeof intent.client === "string" ? { client: intent.client } : {}) }
    }
    case "absorb": return validTarget(intent.target) ? { type: "absorb", target: intent.target } : undefined
    case "rename": return validText(intent.session) && validText(intent.displayName, 256) ? { type: "rename", session: intent.session, resourceId: validText(intent.resourceId) ? intent.resourceId : undefined, displayName: intent.displayName } : undefined
    case "attach":
    case "reparent": return validText(intent.workshopId) && validText(intent.parentWorkshopId) ? { type: intent.type, workshopId: intent.workshopId, parentWorkshopId: intent.parentWorkshopId, session: validText(intent.session) ? intent.session : undefined } : undefined
    case "detach": return validText(intent.workshopId) ? { type: "detach", workshopId: intent.workshopId, session: validText(intent.session) ? intent.session : undefined } : undefined
    case "delete": return ["pane", "session", "worktree"].includes(String(intent.kind)) && validText(intent.session) && intent.confirmed === true ? { type: "delete", kind: intent.kind as "pane" | "session" | "worktree", session: intent.session, confirmed: true, pane: validText(intent.pane) ? intent.pane : undefined, path: validText(intent.path) ? intent.path : undefined } : undefined
    case "create": return validText(intent.repository) && validText(intent.branch) && typeof intent.create === "boolean" ? { type: "create", repository: intent.repository, branch: intent.branch, create: intent.create, base: validText(intent.base) ? intent.base : undefined } : undefined
    case "start": return validText(intent.clankerId) ? { type: "start", clankerId: intent.clankerId, force: intent.force === true || undefined } : undefined
    case "stop": return validText(intent.clankerId) && intent.confirmed === true ? { type: "stop", clankerId: intent.clankerId, confirmed: true, reason: validText(intent.reason) ? intent.reason : undefined } : undefined
    case "recovery": return validText(intent.clankerId) && ["reconcile", "resume", "suspend", "tombstone"].includes(String(intent.action)) ? { type: "recovery", clankerId: intent.clankerId, action: intent.action as "reconcile" | "resume" | "suspend" | "tombstone", force: intent.force === true || undefined, reason: validText(intent.reason) ? intent.reason : undefined } : undefined
    case "repository.refresh": return { type: "repository.refresh" }
    default: return undefined
  }
}

export const parseRequest = (value: unknown): SnapshotRequest | ErrorResponse => {
  if (!value || typeof value !== "object") return protocolError(null, "bad_request", "request must be an object")
  const request = value as Record<string, unknown>
  const id = validText(request.id, 128) ? request.id : null
  if (!id) return protocolError(null, "bad_request", "request id must be a non-empty string of at most 128 characters")
  if (request.version !== SNAPSHOT_PROTOCOL_VERSION) return protocolError(id, "unsupported_version", `protocol version ${SNAPSHOT_PROTOCOL_VERSION} is required`)
  const simple = ["server.status", "server.health", "snapshot.get", "snapshots.subscribe", "projection.refresh"] as const
  if (simple.includes(request.method as typeof simple[number])) return { version: SNAPSHOT_PROTOCOL_VERSION, id, method: request.method as typeof simple[number] }
  if (request.method === "mutation.submit") {
    const params = request.params as Record<string, unknown> | undefined
    const intent = parseIntent(params?.intent)
    if (!validText(params?.idempotencyKey, 256) || !intent) return protocolError(id, "bad_request", "mutation.submit requires a valid idempotencyKey and typed intent")
    return { version: SNAPSHOT_PROTOCOL_VERSION, id, method: "mutation.submit", params: { idempotencyKey: params.idempotencyKey, intent } }
  }
  if (request.method === "operation.status") {
    const operationId = (request.params as Record<string, unknown> | undefined)?.operationId
    if (!validText(operationId, 128)) return protocolError(id, "bad_request", "operation.status requires operationId")
    return { version: SNAPSHOT_PROTOCOL_VERSION, id, method: "operation.status", params: { operationId } }
  }
  return protocolError(id, "method_not_found", "unknown or unavailable method")
}

export const protocolError = (id: string | null, code: ErrorResponse["error"]["code"], message: string): ErrorResponse => ({ version: SNAPSHOT_PROTOCOL_VERSION, id, ok: false, error: { code, message } })
export const isErrorResponse = (value: SnapshotRequest | ErrorResponse): value is ErrorResponse => "ok" in value

import type { ProjectionSnapshot } from "../projection"

export const SNAPSHOT_PROTOCOL_VERSION = 1 as const

export type SnapshotMethod = "server.status" | "snapshot.get" | "snapshots.subscribe" | "projection.refresh"

export interface SnapshotRequest {
  version: typeof SNAPSHOT_PROTOCOL_VERSION
  id: string
  method: SnapshotMethod
}

export interface ServerStatus {
  protocolVersion: typeof SNAPSHOT_PROTOCOL_VERSION
  startedAt: number
  subscribers: number
}

export interface SubscriptionResult {
  subscribed: true
}

export interface ProjectionRefreshResult {
  revision: ProjectionSnapshot<unknown>["revision"]
}

export type SnapshotResult<T> = ServerStatus | ProjectionSnapshot<T> | SubscriptionResult | ProjectionRefreshResult

export interface SuccessResponse<T = unknown> {
  version: typeof SNAPSHOT_PROTOCOL_VERSION
  id: string
  ok: true
  result: T
}

export interface ErrorResponse {
  version: typeof SNAPSHOT_PROTOCOL_VERSION
  id: string | null
  ok: false
  error: {
    code: "bad_request" | "unsupported_version" | "method_not_found" | "request_too_large" | "server_busy"
    message: string
  }
}

export interface SnapshotEvent<T> {
  version: typeof SNAPSHOT_PROTOCOL_VERSION
  event: "snapshot"
  snapshot: ProjectionSnapshot<T>
}

export type ServerMessage<T> = SuccessResponse<SnapshotResult<T>> | ErrorResponse | SnapshotEvent<T>

export const encodeMessage = (message: object): string => `${JSON.stringify(message)}\n`

export const parseRequest = (value: unknown): SnapshotRequest | ErrorResponse => {
  if (!value || typeof value !== "object") return protocolError(null, "bad_request", "request must be an object")
  const request = value as Record<string, unknown>
  const id = typeof request.id === "string" && request.id.length > 0 && request.id.length <= 128 ? request.id : null
  if (!id) return protocolError(null, "bad_request", "request id must be a non-empty string of at most 128 characters")
  if (request.version !== SNAPSHOT_PROTOCOL_VERSION) return protocolError(id, "unsupported_version", `protocol version ${SNAPSHOT_PROTOCOL_VERSION} is required`)
  if (request.method !== "server.status" && request.method !== "snapshot.get" && request.method !== "snapshots.subscribe" && request.method !== "projection.refresh") {
    return protocolError(id, "method_not_found", "unknown or unavailable method")
  }
  return { version: SNAPSHOT_PROTOCOL_VERSION, id, method: request.method }
}

export const protocolError = (id: string | null, code: ErrorResponse["error"]["code"], message: string): ErrorResponse => ({
  version: SNAPSHOT_PROTOCOL_VERSION,
  id,
  ok: false,
  error: { code, message },
})

export const isErrorResponse = (value: SnapshotRequest | ErrorResponse): value is ErrorResponse => "ok" in value

import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { parseProjectionSnapshot, type ProjectionSnapshot } from "../projection"
import { encodeMessage, SNAPSHOT_PROTOCOL_VERSION, type MutationIntent, type MutationSubmitResult, type OperationRecord, type ProjectionRefreshResult, type ServerStatus } from "./protocol"

export interface SnapshotSubscription {
  close(): void
}

export interface SubscribeCallbacks<T> {
  onSnapshot(snapshot: ProjectionSnapshot<T>): void
  onDisconnect(error?: Error): void
}

export interface SnapshotClientOptions {
  maxMessageBytes?: number
}

const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value))

const connect = (socketPath: string) => new Promise<Socket>((resolve, reject) => {
  const socket = createConnection(socketPath)
  const onError = (error: Error) => reject(error)
  socket.once("error", onError)
  socket.once("connect", () => {
    socket.off("error", onError)
    resolve(socket)
  })
})

const parseSnapshot = <T>(value: unknown): ProjectionSnapshot<T> | undefined => {
  if (!value || typeof value !== "object") return undefined
  const version = Number((value as { version?: unknown }).version)
  if (!Number.isSafeInteger(version) || version < 0) return undefined
  return parseProjectionSnapshot<T>(value, version)
}

const request = async <T>(socketPath: string, method: "server.status" | "server.health" | "snapshot.get" | "projection.refresh" | "mutation.submit" | "operation.status", options: SnapshotClientOptions = {}, params?: object): Promise<T> => {
  const socket = await connect(socketPath)
  const id = randomUUID()
  const maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024
  return await new Promise<T>((resolve, reject) => {
    let input = Buffer.alloc(0)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(asError(error))
    }
    socket.on("error", fail)
    socket.on("close", () => fail(new Error("snapshot transport disconnected before responding")))
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk])
      if (input.byteLength > maxMessageBytes) return fail(new Error("snapshot transport response exceeds byte limit"))
      const newline = input.indexOf(10)
      if (newline < 0) return
      let message: any
      try {
        message = JSON.parse(input.subarray(0, newline).toString("utf8"))
      } catch {
        return fail(new Error("snapshot transport returned malformed JSON"))
      }
      if (message?.version !== SNAPSHOT_PROTOCOL_VERSION || message?.id !== id || typeof message?.ok !== "boolean") return fail(new Error("snapshot transport returned an invalid response"))
      if (!message.ok) return fail(new Error(`${message.error?.code ?? "error"}: ${message.error?.message ?? "request failed"}`))
      settled = true
      socket.end()
      resolve(message.result as T)
    })
    socket.write(encodeMessage({ version: SNAPSHOT_PROTOCOL_VERSION, id, method, ...(params ? { params } : {}) }))
  })
}

export const getServerStatus = (socketPath: string, options?: SnapshotClientOptions) => request<ServerStatus>(socketPath, "server.status", options)
export const getServerHealth = (socketPath: string, options?: SnapshotClientOptions) => request<ServerStatus>(socketPath, "server.health", options)
export const refreshProjection = (socketPath: string, options?: SnapshotClientOptions) => request<ProjectionRefreshResult>(socketPath, "projection.refresh", options)
export const submitMutation = (socketPath: string, idempotencyKey: string, intent: MutationIntent, options?: SnapshotClientOptions) => request<MutationSubmitResult>(socketPath, "mutation.submit", options, { idempotencyKey, intent })
export const getOperationStatus = (socketPath: string, operationId: string, options?: SnapshotClientOptions) => request<OperationRecord>(socketPath, "operation.status", options, { operationId })

export const waitForOperation = async (socketPath: string, operationId: string, options: SnapshotClientOptions & { timeoutMs?: number; retryMs?: number; onStatus?: (operation: OperationRecord) => void } = {}) => {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let lastError: Error | undefined
  while (true) {
    let operation: OperationRecord | undefined
    try {
      operation = await getOperationStatus(socketPath, operationId, options)
      options.onStatus?.(operation)
      lastError = undefined
    }
    catch (error) { lastError = asError(error) }
    if (operation?.state === "succeeded") return operation
    if (operation?.state === "failed") throw new Error(operation.error || "daemon operation failed")
    if (Date.now() >= deadline) throw lastError ?? new Error(`operation ${operationId} did not complete before timeout`)
    await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 25))
  }
}

export const getSnapshot = async <T>(socketPath: string, options?: SnapshotClientOptions): Promise<ProjectionSnapshot<T>> => {
  const value = await request<unknown>(socketPath, "snapshot.get", options)
  const snapshot = parseSnapshot<T>(value)
  if (!snapshot) throw new Error("snapshot transport returned an invalid snapshot")
  return snapshot
}

export const subscribeSnapshots = async <T>(
  socketPath: string,
  callbacks: SubscribeCallbacks<T>,
  options: SnapshotClientOptions = {},
): Promise<SnapshotSubscription> => {
  const socket = await connect(socketPath)
  const id = randomUUID()
  const maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024
  let input = Buffer.alloc(0)
  let acknowledged = false
  let intentionalClose = false
  let disconnectError: Error | undefined
  let resolveReady!: (subscription: SnapshotSubscription) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<SnapshotSubscription>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const subscription: SnapshotSubscription = {
    close() {
      intentionalClose = true
      socket.end()
    },
  }
  const fail = (error: unknown) => {
    disconnectError = asError(error)
    socket.destroy()
  }
  socket.on("error", (error) => { disconnectError = error })
  socket.on("close", () => {
    if (!acknowledged) rejectReady(disconnectError ?? new Error("snapshot transport disconnected before subscribing"))
    if (!intentionalClose) callbacks.onDisconnect(disconnectError)
  })
  socket.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk])
    if (input.byteLength > maxMessageBytes) return fail(new Error("snapshot transport message exceeds byte limit"))
    while (true) {
      const newline = input.indexOf(10)
      if (newline < 0) return
      const line = input.subarray(0, newline)
      input = input.subarray(newline + 1)
      if (line.byteLength > maxMessageBytes) return fail(new Error("snapshot transport message exceeds byte limit"))
      let message: any
      try {
        message = JSON.parse(line.toString("utf8"))
      } catch {
        return fail(new Error("snapshot transport returned malformed JSON"))
      }
      if (message?.version !== SNAPSHOT_PROTOCOL_VERSION) return fail(new Error("snapshot transport protocol version mismatch"))
      if (message.id === id) {
        if (message.ok !== true || message.result?.subscribed !== true) return fail(new Error(`${message.error?.code ?? "error"}: ${message.error?.message ?? "subscription failed"}`))
        if (!acknowledged) {
          acknowledged = true
          resolveReady(subscription)
        }
      } else if (message.event === "snapshot") {
        const snapshot = parseSnapshot<T>(message.snapshot)
        if (!snapshot) return fail(new Error("snapshot transport returned an invalid snapshot event"))
        callbacks.onSnapshot(snapshot)
      } else {
        return fail(new Error("snapshot transport returned an unexpected message"))
      }
    }
  })
  socket.write(encodeMessage({ version: SNAPSHOT_PROTOCOL_VERSION, id, method: "snapshots.subscribe" }))
  return await ready
}

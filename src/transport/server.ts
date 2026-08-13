import { chmod, lstat, unlink } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import type { ProjectionSnapshot } from "../projection"
import { encodeMessage, isErrorResponse, parseRequest, protocolError, SNAPSHOT_PROTOCOL_VERSION } from "./protocol"

export interface SnapshotServerOptions<T> {
  socketPath: string
  initialSnapshot: ProjectionSnapshot<T>
  maxRequestBytes?: number
  maxOutboundBytes?: number
  maxClients?: number
  refresh?: () => Promise<ProjectionSnapshot<T>>
}

export interface SnapshotServer<T> {
  readonly socketPath: string
  publish(snapshot: ProjectionSnapshot<T>): void
  close(): Promise<void>
  subscriberCount(): number
}

interface PathIdentity { dev: number; ino: number; uid: number }

const pathIdentity = async (path: string): Promise<PathIdentity | undefined> => {
  try {
    const stat = await lstat(path)
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${path}`)
    const currentUid = process.getuid?.()
    if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Refusing socket not owned by current user: ${path}`)
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const socketIsListening = (path: string) => new Promise<boolean>((resolve, reject) => {
  const probe = createConnection(path)
  const timer = setTimeout(() => {
    probe.destroy()
    reject(new Error(`Timed out probing Unix socket: ${path}`))
  }, 500)
  probe.once("connect", () => {
    clearTimeout(timer)
    probe.destroy()
    resolve(true)
  })
  probe.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer)
    if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false)
    else reject(error)
  })
})

const prepareSocketPath = async (path: string) => {
  const identity = await pathIdentity(path)
  if (!identity) return
  if (await socketIsListening(path)) throw new Error(`Unix socket is already in use: ${path}`)
  const current = await pathIdentity(path)
  if (!current) return
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid) throw new Error(`Unix socket changed while checking staleness: ${path}`)
  await unlink(path)
}

const listen = (server: Server, path: string) => new Promise<void>((resolve, reject) => {
  const onError = (error: Error) => reject(error)
  server.once("error", onError)
  server.listen(path, () => {
    server.off("error", onError)
    resolve()
  })
})

export const startSnapshotServer = async <T>(options: SnapshotServerOptions<T>): Promise<SnapshotServer<T>> => {
  const maxRequestBytes = options.maxRequestBytes ?? 64 * 1024
  const maxOutboundBytes = options.maxOutboundBytes ?? 4 * 1024 * 1024
  const maxClients = options.maxClients ?? 32
  if (maxRequestBytes < 128 || maxOutboundBytes < 128 || maxClients < 1) throw new Error("Invalid snapshot server limits")

  await prepareSocketPath(options.socketPath)

  let latest = options.initialSnapshot
  let closed = false
  const startedAt = Date.now()
  const clients = new Set<Socket>()
  const subscribers = new Set<Socket>()

  const send = (socket: Socket, message: object): boolean => {
    const encoded = encodeMessage(message)
    const bytes = Buffer.byteLength(encoded)
    if (bytes > maxOutboundBytes || socket.writableLength + bytes > maxOutboundBytes) {
      socket.destroy(new Error("snapshot transport outbound limit exceeded"))
      return false
    }
    socket.write(encoded)
    return true
  }

  const publish = (snapshot: ProjectionSnapshot<T>) => {
    if (latest.revision.source === snapshot.revision.source && latest.revision.sequence === snapshot.revision.sequence) return
    latest = snapshot
    for (const subscriber of subscribers) send(subscriber, { version: SNAPSHOT_PROTOCOL_VERSION, event: "snapshot", snapshot })
  }

  const server = createServer((socket) => {
    if (clients.size >= maxClients) {
      send(socket, protocolError(null, "server_busy", "too many clients"))
      socket.end()
      return
    }
    clients.add(socket)
    let input = Buffer.alloc(0)
    const remove = () => {
      clients.delete(socket)
      subscribers.delete(socket)
    }
    socket.on("close", remove)
    socket.on("error", () => {})
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk])
      while (true) {
        const newline = input.indexOf(10)
        if (newline < 0) break
        const line = input.subarray(0, newline)
        input = input.subarray(newline + 1)
        if (line.byteLength > maxRequestBytes) {
          send(socket, protocolError(null, "request_too_large", "request exceeds byte limit"))
          socket.end()
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(line.toString("utf8"))
        } catch {
          send(socket, protocolError(null, "bad_request", "request is not valid JSON"))
          continue
        }
        const request = parseRequest(raw)
        if (isErrorResponse(request)) {
          send(socket, request)
          continue
        }
        if (request.method === "server.status") {
          send(socket, { version: SNAPSHOT_PROTOCOL_VERSION, id: request.id, ok: true, result: { protocolVersion: SNAPSHOT_PROTOCOL_VERSION, startedAt, subscribers: subscribers.size } })
        } else if (request.method === "snapshot.get") {
          send(socket, { version: SNAPSHOT_PROTOCOL_VERSION, id: request.id, ok: true, result: latest })
        } else if (request.method === "projection.refresh") {
          if (!options.refresh) {
            send(socket, protocolError(request.id, "method_not_found", "projection refresh is unavailable"))
            continue
          }
          void options.refresh().then((snapshot) => {
            publish(snapshot)
            send(socket, { version: SNAPSHOT_PROTOCOL_VERSION, id: request.id, ok: true, result: { revision: snapshot.revision } })
          }).catch(() => {
            send(socket, protocolError(request.id, "server_busy", "projection refresh failed"))
          })
        } else {
          subscribers.add(socket)
          if (send(socket, { version: SNAPSHOT_PROTOCOL_VERSION, id: request.id, ok: true, result: { subscribed: true } })) {
            send(socket, { version: SNAPSHOT_PROTOCOL_VERSION, event: "snapshot", snapshot: latest })
          }
        }
      }
      if (input.byteLength > maxRequestBytes) {
        send(socket, protocolError(null, "request_too_large", "request exceeds byte limit"))
        socket.end()
      }
    })
  })

  try {
    await listen(server, options.socketPath)
    await chmod(options.socketPath, 0o600)
  } catch (error) {
    server.close()
    throw error
  }
  const ownedIdentity = await pathIdentity(options.socketPath)

  return {
    socketPath: options.socketPath,
    publish(snapshot) {
      if (!closed) publish(snapshot)
    },
    subscriberCount: () => subscribers.size,
    async close() {
      if (closed) return
      closed = true
      for (const socket of clients) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      const current = await pathIdentity(options.socketPath)
      if (current && ownedIdentity && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino && current.uid === ownedIdentity.uid) await unlink(options.socketPath)
    },
  }
}

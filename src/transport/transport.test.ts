import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, createServer } from "node:net"
import { advanceProjection, type ProjectionSnapshot } from "../projection"
import { openDurableRegistry } from "../registry"
import { acquireProducerLease, getOperationStatus, getServerStatus, getSnapshot, refreshProjection, replaceProducerLeaseRecord, SNAPSHOT_PROTOCOL_VERSION, startSnapshotServer, submitMutation, subscribeSnapshots, type SnapshotServer } from "./index"

interface Row { name: string }

const directories: string[] = []
const servers: SnapshotServer<Row>[] = []

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankerhouse-transport-"))
  directories.push(directory)
  return { directory, socketPath: join(directory, "snapshots.sock") }
}

const snapshot = (name: string, previous?: ProjectionSnapshot<Row>) => advanceProjection(previous, [{ name }], 3, "test", Date.now())

const start = async (socketPath: string, initialSnapshot = snapshot("initial"), options: object = {}) => {
  const server = await startSnapshotServer({ socketPath, initialSnapshot, ...options })
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const rawRequest = async (socketPath: string, payload: string): Promise<any> => {
  const socket = createConnection(socketPath)
  return await new Promise((resolve, reject) => {
    let data = ""
    socket.on("error", reject)
    socket.on("data", (chunk) => {
      data += chunk.toString()
      const newline = data.indexOf("\n")
      if (newline >= 0) {
        socket.destroy()
        resolve(JSON.parse(data.slice(0, newline)))
      }
    })
    socket.write(payload)
  })
}

const listen = (server: ReturnType<typeof createServer>, path: string) => new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(path, resolve)
})

const closeNetServer = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

describe("Unix snapshot transport", () => {
  test("serves status and the latest typed snapshot over a mode-0600 socket", async () => {
    const { socketPath } = await fixture()
    const initial = snapshot("first")
    const server = await start(socketPath, initial)

    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)
    expect(await getSnapshot<Row>(socketPath)).toEqual(initial)
    const status = await getServerStatus(socketPath)
    expect(status.protocolVersion).toBe(SNAPSHOT_PROTOCOL_VERSION)
    expect(status).toMatchObject({ healthy: true, epoch: initial.revision.source, revision: initial.revision })
    expect(status.subscribers).toBe(0)

    const next = snapshot("second", initial)
    server.publish(next)
    expect(await getSnapshot<Row>(socketPath)).toEqual(next)
  })

  test("subscribes with the current snapshot immediately and receives future publishes", async () => {
    const { socketPath } = await fixture()
    const initial = snapshot("initial")
    const server = await start(socketPath, initial)
    const received: ProjectionSnapshot<Row>[] = []
    let disconnected: Error | undefined
    const firstEvent = Promise.withResolvers<void>()
    const secondEvent = Promise.withResolvers<void>()

    const subscription = await subscribeSnapshots<Row>(socketPath, {
      onSnapshot(value) {
        received.push(value)
        if (received.length === 1) firstEvent.resolve()
        if (received.length === 2) secondEvent.resolve()
      },
      onDisconnect(error) { disconnected = error ?? new Error("disconnected") },
    })
    await firstEvent.promise
    expect(received).toEqual([initial])
    expect(server.subscriberCount()).toBe(1)

    const next = snapshot("future", initial)
    server.publish(next)
    await secondEvent.promise
    expect(received).toEqual([initial, next])
    subscription.close()
    await Bun.sleep(10)
    expect(disconnected).toBeUndefined()
  })

  test("coalesces through a typed non-destructive projection refresh action", async () => {
    const { socketPath } = await fixture()
    const initial = snapshot("initial")
    const next = snapshot("refreshed", initial)
    let refreshes = 0
    const server = await startSnapshotServer({
      socketPath,
      initialSnapshot: initial,
      refresh: async () => {
        refreshes += 1
        return next
      },
    })
    servers.push(server)

    expect(await refreshProjection(socketPath)).toEqual({ revision: next.revision })
    expect(refreshes).toBe(1)
    expect(await getSnapshot<Row>(socketPath)).toEqual(next)
  })

  test("delivers typed lifecycle observations to the authoritative producer", async () => {
    const { socketPath } = await fixture()
    const reports: unknown[] = []
    await start(socketPath, snapshot("initial"), { reportObservation: (report: unknown) => { reports.push(report); return true } })
    const response = await rawRequest(socketPath, JSON.stringify({
      version: 1,
      id: "observation",
      method: "observation.report",
      params: { source: "opencode:42", seq: 1, pane: "%4", harness: "opencode", state: "working", updatedAt: 123, harnessSessionId: "session-1" },
    }) + "\n")
    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(reports).toEqual([expect.objectContaining({ pane: "%4", state: "working", seq: 1 })])
  })

  test("reports unexpected disconnects so callers can retain polling fallback", async () => {
    const { socketPath } = await fixture()
    const server = await start(socketPath)
    const disconnected = Promise.withResolvers<Error | undefined>()
    await subscribeSnapshots<Row>(socketPath, {
      onSnapshot() {},
      onDisconnect: disconnected.resolve,
    })
    await server.close()
    expect(await disconnected.promise).toBeUndefined()
  })

  test("executes typed mutations idempotently and resumes a failed retry", async () => {
    const { directory, socketPath } = await fixture()
    let attempts = 0
    const operationRegistry = openDurableRegistry({ dbPath: join(directory, "registry.sqlite3") })
    const server = await startSnapshotServer({
      socketPath,
      initialSnapshot: snapshot("initial"),
      operationRegistry,
      executeMutation: async (intent) => {
        attempts += 1
        if (attempts === 1) throw new Error("injected fault")
        return { accepted: intent.type }
      },
    })
    servers.push(server)
    const intent = { type: "open" as const, target: { type: "directory" as const, path: "/tmp/work" } }
    const first = await submitMutation(socketPath, "same-key", intent)
    let operation = await getOperationStatus(socketPath, first.operation.operationId)
    while (operation.state === "queued" || operation.state === "running") {
      await Bun.sleep(5)
      operation = await getOperationStatus(socketPath, operation.operationId)
    }
    expect(operation.state).toBe("failed")

    const retry = await submitMutation(socketPath, "same-key", intent)
    expect(retry.replayed).toBe(true)
    expect(retry.operation.operationId).toBe(first.operation.operationId)
    do {
      await Bun.sleep(5)
      operation = await getOperationStatus(socketPath, operation.operationId)
    } while (operation.state === "queued" || operation.state === "running")
    expect(operation).toMatchObject({ state: "succeeded", attempts: 2, result: { accepted: "open" } })
    expect(operationRegistry.operation(operation.operationId)).toMatchObject({ status: "succeeded", attempts: 2 })
    expect(attempts).toBe(2)
    operationRegistry.close()
  })

  test("preserves explicitly injected in-memory mutation mode without a registry", async () => {
    const { socketPath } = await fixture()
    const server = await startSnapshotServer({
      socketPath,
      initialSnapshot: snapshot("initial"),
      executeMutation: async (intent) => ({ accepted: intent.type }),
    })
    servers.push(server)
    const submitted = await submitMutation(socketPath, "memory-key", { type: "repository.refresh" })
    let operation = await getOperationStatus(socketPath, submitted.operation.operationId)
    while (operation.state === "queued" || operation.state === "running") {
      await Bun.sleep(2)
      operation = await getOperationStatus(socketPath, operation.operationId)
    }
    expect(operation).toMatchObject({ state: "succeeded", attempts: 1, result: { accepted: "repository.refresh" } })
  })

  test("rejects a stale producer after its epoch lease is replaced", async () => {
    const { directory, socketPath } = await fixture()
    const leasePath = join(directory, "producer.lease")
    const lease = await acquireProducerLease(leasePath, "herdr:test")
    const initial = advanceProjection(undefined, [{ name: "initial" }], 3, lease.epoch)
    const server = await startSnapshotServer({ socketPath, initialSnapshot: initial, epoch: lease.epoch, owner: lease.owner, assertAuthoritative: lease.assertCurrentSync })
    servers.push(server)
    await replaceProducerLeaseRecord(leasePath, lease.owner, "replacement-epoch")
    const next = advanceProjection(initial, [{ name: "rejected" }], 3, lease.epoch)
    expect(() => server.publish(next)).toThrow("stale producer")
    await lease.release()
  })

  test("rejects malformed, unsupported, unknown, and oversized requests", async () => {
    const { socketPath } = await fixture()
    await start(socketPath, snapshot("initial"), { maxRequestBytes: 128 })

    expect((await rawRequest(socketPath, "not-json\n")).error.code).toBe("bad_request")
    expect((await rawRequest(socketPath, JSON.stringify({ version: 99, id: "v", method: "snapshot.get" }) + "\n")).error.code).toBe("unsupported_version")
    expect((await rawRequest(socketPath, JSON.stringify({ version: 1, id: "x", method: "snapshot.delete" }) + "\n")).error.code).toBe("method_not_found")
    expect((await rawRequest(socketPath, `${"x".repeat(129)}\n`)).error.code).toBe("request_too_large")
  })

  test("bounds clients and refuses non-socket paths", async () => {
    const first = await fixture()
    await writeFile(first.socketPath, "do not delete")
    await expect(startSnapshotServer({ socketPath: first.socketPath, initialSnapshot: snapshot("initial") })).rejects.toThrow("non-socket")
    expect(await Bun.file(first.socketPath).text()).toBe("do not delete")

    const second = await fixture()
    await start(second.socketPath, snapshot("initial"), { maxClients: 1 })
    const held = createConnection(second.socketPath)
    await new Promise<void>((resolve, reject) => { held.once("connect", resolve); held.once("error", reject) })
    const busy = await rawRequest(second.socketPath, JSON.stringify({ version: 1, id: "status", method: "server.status" }) + "\n")
    expect(busy.error.code).toBe("server_busy")
    held.destroy()
  })

  test("replaces only a confirmed stale socket and removes its own socket on shutdown", async () => {
    const { directory, socketPath } = await fixture()
    const originalPath = join(directory, "original.sock")
    const staleServer = createServer()
    await listen(staleServer, originalPath)
    await Bun.write(socketPath, "placeholder")
    await rm(socketPath)
    await import("node:fs/promises").then(({ rename }) => rename(originalPath, socketPath))
    await closeNetServer(staleServer)
    expect((await lstat(socketPath)).isSocket()).toBe(true)

    const server = await start(socketPath)
    expect((await getSnapshot<Row>(socketPath)).sessions[0]?.name).toBe("initial")
    await server.close()
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

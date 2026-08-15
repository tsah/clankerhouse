import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { MutationIntent, MutationSubmitResult, OperationRecord } from "./protocol"

export type MutationExecutor = (intent: MutationIntent, operation: OperationRecord) => Promise<unknown>

interface StoredOperations { version: 1; operations: OperationRecord[] }

export class OperationJournal {
  readonly #byId = new Map<string, OperationRecord>()
  readonly #byKey = new Map<string, OperationRecord>()
  readonly #path?: string
  readonly #execute: MutationExecutor
  #writeQueue = Promise.resolve()

  private constructor(execute: MutationExecutor, path?: string) {
    this.#execute = execute
    this.#path = path
  }

  static async open(execute: MutationExecutor, path?: string) {
    const journal = new OperationJournal(execute, path)
    if (path) {
      try {
        const stored = JSON.parse(await readFile(path, "utf8")) as StoredOperations
        if (stored.version === 1 && Array.isArray(stored.operations)) {
          for (const record of stored.operations) {
            const resumed = record.state === "running" || record.state === "queued" ? { ...record, state: "failed" as const, stage: "interrupted", error: "daemon stopped before the operation completed", updatedAt: Date.now() } : record
            journal.#byId.set(resumed.operationId, resumed)
            journal.#byKey.set(resumed.idempotencyKey, resumed)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    await journal.#persist()
    return journal
  }

  get(operationId: string) { return this.#byId.get(operationId) }

  async submit(idempotencyKey: string, intent: MutationIntent): Promise<MutationSubmitResult> {
    const existing = this.#byKey.get(idempotencyKey)
    if (existing) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new Error("idempotency key was already used for a different intent")
      if (existing.state === "failed") void this.#run(existing)
      return { operation: existing, replayed: true }
    }
    const now = Date.now()
    const operation: OperationRecord = { operationId: randomUUID(), idempotencyKey, intent, state: "queued", stage: "accepted", attempts: 0, createdAt: now, updatedAt: now }
    this.#byId.set(operation.operationId, operation)
    this.#byKey.set(idempotencyKey, operation)
    await this.#persist()
    void this.#run(operation)
    return { operation, replayed: false }
  }

  async #run(operation: OperationRecord) {
    operation.state = "running"
    operation.stage = "executing"
    operation.attempts += 1
    operation.updatedAt = Date.now()
    await this.#persist()
    try {
      operation.result = await this.#execute(operation.intent, operation)
      operation.state = "succeeded"
      operation.stage = "completed"
      operation.error = undefined
    } catch (error) {
      operation.state = "failed"
      operation.stage = "failed"
      operation.error = error instanceof Error ? error.message : String(error)
    }
    operation.updatedAt = Date.now()
    await this.#persist()
  }

  #persist() {
    if (!this.#path) return Promise.resolve()
    this.#writeQueue = this.#writeQueue.then(async () => {
      const path = this.#path!
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      const operations = [...this.#byId.values()].slice(-1000)
      await writeFile(temporary, JSON.stringify({ version: 1, operations } satisfies StoredOperations), { mode: 0o600 })
      await rename(temporary, path)
    })
    return this.#writeQueue
  }
}

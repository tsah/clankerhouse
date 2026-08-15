import { randomUUID } from "node:crypto"
import type { DurableOperationRecord, DurableRegistry } from "../registry"
import type { MutationIntent, MutationSubmitResult, OperationRecord } from "./protocol"

export interface MutationExecution {
  readonly operation: OperationRecord
  checkpoint(stage: string, result?: unknown): Promise<void>
}

export type MutationExecutor = (intent: MutationIntent, execution: MutationExecution) => Promise<unknown>

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const mutationKind = (intent: MutationIntent) => `mutation.${intent.type}`

const protocolRecord = (record: DurableOperationRecord): OperationRecord => ({
  operationId: record.id,
  idempotencyKey: record.idempotencyKey,
  intent: record.input as MutationIntent,
  state: record.status === "pending" ? "queued" : record.status,
  stage: record.stage,
  attempts: record.attempts,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.result === null ? {} : { result: record.result }),
  ...(record.error === null ? {} : { error: record.error }),
})

/** Durable registry-backed in production; intentionally in-memory when no registry is injected by tests. */
export class OperationJournal {
  readonly #byId = new Map<string, OperationRecord>()
  readonly #byKey = new Map<string, OperationRecord>()
  readonly #running = new Set<string>()
  readonly #registry?: DurableRegistry
  readonly #execute: MutationExecutor

  private constructor(execute: MutationExecutor, registry?: DurableRegistry) {
    this.#execute = execute
    this.#registry = registry
  }

  static async open(execute: MutationExecutor, registry?: DurableRegistry) {
    const journal = new OperationJournal(execute, registry)
    if (registry) {
      for (const durable of registry.resumableOperations()) {
        const operation = protocolRecord(durable)
        journal.#remember(operation)
      }
      for (const operation of journal.#byId.values()) void journal.#run(operation)
    }
    return journal
  }

  #remember(operation: OperationRecord) {
    this.#byId.set(operation.operationId, operation)
    this.#byKey.set(operation.idempotencyKey, operation)
  }

  #refresh(operation: OperationRecord) {
    if (!this.#registry) return operation
    const durable = this.#registry.operation(operation.operationId)
    if (!durable) throw new Error(`Unknown operation ${operation.operationId}`)
    const refreshed = protocolRecord(durable)
    Object.assign(operation, refreshed)
    for (const key of ["result", "error"] as const) if (!(key in refreshed)) delete operation[key]
    return operation
  }

  get(operationId: string) {
    let operation = this.#byId.get(operationId)
    if (!operation && this.#registry) {
      const durable = this.#registry.operation(operationId)
      if (durable?.kind.startsWith("mutation.")) {
        operation = protocolRecord(durable)
        this.#remember(operation)
      }
    }
    return operation ? this.#refresh(operation) : undefined
  }

  async submit(idempotencyKey: string, intent: MutationIntent): Promise<MutationSubmitResult> {
    const existing = this.#byKey.get(idempotencyKey)
    if (existing) {
      if (!sameJson(existing.intent, intent)) throw new Error("idempotency key was already used for a different intent")
      this.#refresh(existing)
      if (existing.state === "failed") void this.#run(existing)
      return { operation: existing, replayed: true }
    }

    let operation: OperationRecord
    let replayed = false
    if (this.#registry) {
      const durable = this.#registry.beginOperation(idempotencyKey, mutationKind(intent), intent)
      operation = protocolRecord(durable)
      replayed = durable.attempts > 0 || durable.status !== "pending"
    } else {
      const now = Date.now()
      operation = { operationId: randomUUID(), idempotencyKey, intent, state: "queued", stage: "registered", attempts: 0, createdAt: now, updatedAt: now }
    }
    this.#remember(operation)
    if (operation.state !== "succeeded") void this.#run(operation)
    return { operation, replayed }
  }

  async #checkpoint(operation: OperationRecord, stage: string, result?: unknown) {
    if (this.#registry) {
      this.#registry.advanceOperation(operation.operationId, stage, "running", { result })
      this.#refresh(operation)
      return
    }
    operation.stage = stage
    operation.state = "running"
    operation.updatedAt = Date.now()
    if (result !== undefined) operation.result = result
  }

  async #run(operation: OperationRecord) {
    if (this.#running.has(operation.operationId)) return
    this.#running.add(operation.operationId)
    try {
      if (this.#registry) {
        this.#registry.startOperation(operation.operationId)
        this.#refresh(operation)
      } else {
        operation.state = "running"
        operation.attempts += 1
        operation.updatedAt = Date.now()
        delete operation.error
      }
      const execution: MutationExecution = {
        operation,
        checkpoint: (stage, result) => this.#checkpoint(operation, stage, result),
      }
      const result = await this.#execute(operation.intent, execution)
      if (this.#registry) {
        this.#registry.advanceOperation(operation.operationId, "completed", "succeeded", { result })
        this.#refresh(operation)
      } else {
        operation.result = result
        operation.state = "succeeded"
        operation.stage = "completed"
        operation.error = undefined
        operation.updatedAt = Date.now()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.#registry) {
        const current = this.#registry.operation(operation.operationId)
        this.#registry.advanceOperation(operation.operationId, current?.stage ?? operation.stage, "failed", { error: message })
        this.#refresh(operation)
      } else {
        operation.state = "failed"
        operation.error = message
        operation.updatedAt = Date.now()
      }
    } finally {
      this.#running.delete(operation.operationId)
    }
  }
}

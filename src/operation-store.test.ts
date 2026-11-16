import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openOperationStore } from "./operation-store"

const store = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ch-operations-")), "operations.sqlite3")
  return { dbPath, store: openOperationStore({ dbPath }) }
}

describe("operation store", () => {
  test("an idempotency key returns the same operation, and refuses a different intent", () => {
    const { store: operations } = store()
    const first = operations.beginOperation("key-1", "mutation.delete", { path: "/a" })
    expect(operations.beginOperation("key-1", "mutation.delete", { path: "/a" }).id).toBe(first.id)
    expect(() => operations.beginOperation("key-1", "mutation.delete", { path: "/b" })).toThrow("different operation")
  })

  test("resumes an unfinished operation only once the process running it is gone", () => {
    const { dbPath, store: operations } = store()
    const mine = operations.beginOperation("key-mine", "mutation.delete", {})
    operations.startOperation(mine.id)
    const theirs = operations.beginOperation("key-theirs", "mutation.delete", {})
    const dead = operations.beginOperation("key-dead", "mutation.delete", {})
    const raw = new Database(dbPath)
    // pid 1 is always alive; a pid this large is not.
    raw.query("UPDATE operations SET status = 'running', owner_pid = 1 WHERE id = ?1").run(theirs.id)
    raw.query("UPDATE operations SET status = 'running', owner_pid = 4194303 WHERE id = ?1").run(dead.id)
    raw.close()
    expect(operations.resumableOperations().map((operation) => operation.id).sort()).toEqual([mine.id, dead.id].sort())
    operations.advanceOperation(mine.id, "completed", "succeeded", { result: { ok: true } })
    expect(operations.resumableOperations().map((operation) => operation.id)).toEqual([dead.id])
    expect(operations.operation(mine.id)).toMatchObject({ status: "succeeded", result: { ok: true }, attempts: 1 })
  })
})

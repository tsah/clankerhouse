import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStagedMutationExecutor, mutationStages } from "./daemon-mutations"
import { openDurableRegistry } from "./registry"
import { OperationJournal } from "./transport/operations"
import type { OperationRecord } from "./transport/protocol"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-mutations-"))
  roots.push(root)
  return { root, dbPath: join(root, "registry.sqlite3") }
}
const settled = async (journal: OperationJournal, id: string) => {
  let operation: OperationRecord | undefined
  for (let count = 0; count < 100; count += 1) {
    operation = journal.get(id)
    if (operation && operation.state !== "queued" && operation.state !== "running") return operation
    await Bun.sleep(2)
  }
  throw new Error(`operation ${id} did not settle`)
}

describe("staged daemon mutation durability", () => {
  test("a label change is persisted before its hook is dispatched, and the done key refreshes the projection it may have labelled", () => {
    expect(mutationStages({ type: "create", repository: "/repo", branch: "feature", create: true })).toEqual(["identity.validated", "worktree.ready", "multiplexer.ready", "hook.dispatched", "projection.refreshed"])
    expect(mutationStages({ type: "label", path: "/repo/feature", key: "stage", value: "retro" })).toEqual(["identity.validated", "labels.updated", "title.mirrored", "hook.dispatched", "projection.refreshed"])
    expect(mutationStages({ type: "done", path: "/repo/feature" })).toEqual(["identity.validated", "hook.completed", "projection.refreshed"])
  })

  test("splices deleted Workshop lineage before closing its multiplexer session", () => {
    expect(mutationStages({ type: "delete", kind: "worktree", session: "middle", path: "/repo/middle", confirmed: true })).toEqual([
      "identity.validated",
      "multiplexer.marked",
      "worktree.deleted",
      "lineage.spliced",
      "multiplexer-children.updated",
      "multiplexer.deleted",
      "projection.refreshed",
    ])
  })

  test("replays inserted lineage stages for legacy deletes already past them", async () => {
    for (const legacyStage of ["multiplexer.deleted", "projection.refreshed"]) {
      const { dbPath } = fixture()
      const registry = openDurableRegistry({ dbPath })
      const intent = { type: "delete" as const, kind: "worktree" as const, session: "middle", path: "/repo/middle", confirmed: true as const }
      const operation = registry.beginOperation(`legacy-${legacyStage}`, "mutation.delete", intent)
      registry.startOperation(operation.id)
      registry.advanceOperation(operation.id, legacyStage, "running", { result: { path: "/repo/middle" } })
      const reconciled: string[] = []
      const executor = createStagedMutationExecutor(async (_intent, stage, execution) => {
        reconciled.push(stage)
        const checkpoint = execution.operation.result as Record<string, unknown>
        return { checkpoint: stage === "lineage.spliced" ? { ...checkpoint, lineageSpliceVersion: 1 } : checkpoint }
      })
      const journal = await OperationJournal.open(executor, registry)

      expect(await settled(journal, operation.id)).toMatchObject({ state: "succeeded", stage: "completed" })
      expect(reconciled).toEqual(["lineage.spliced", "multiplexer-children.updated", "multiplexer.deleted", "projection.refreshed"])
      registry.close()
    }
  })

  test("reconciles a partial multiplexer rename and metadata write instead of repeating either effect", async () => {
    const { dbPath } = fixture()
    const registry = openDurableRegistry({ dbPath })
    let muxName = "before"
    let displayName = "before"
    let muxApplies = 0
    let metadataApplies = 0
    let failMuxAfterEffect = true
    let failMetadataAfterEffect = true
    const executor = createStagedMutationExecutor(async (intent, stage, execution) => {
      expect(intent.type).toBe("rename")
      const checkpoint = execution.operation.result && typeof execution.operation.result === "object" ? execution.operation.result as Record<string, unknown> : {}
      if (stage === "identity.validated") return { checkpoint: { nativeSessionId: "$exact" } }
      if (stage === "multiplexer.renamed") {
        if (muxName !== "after") { muxApplies += 1; muxName = "after" }
        if (failMuxAfterEffect) { failMuxAfterEffect = false; throw new Error("crash after multiplexer effect") }
        return { checkpoint }
      }
      if (stage === "display-name.persisted") {
        if (displayName !== "after") { metadataApplies += 1; displayName = "after" }
        if (failMetadataAfterEffect) { failMetadataAfterEffect = false; throw new Error("crash after metadata effect") }
        return { checkpoint: { ...checkpoint, outcome: { session: "after" } } }
      }
      return { checkpoint, result: checkpoint.outcome }
    })
    const journal = await OperationJournal.open(executor, registry)
    const intent = { type: "rename" as const, session: "before", resourceId: "mux-session-exact", displayName: "after" }
    const submitted = await journal.submit("rename-faults", intent)
    expect((await settled(journal, submitted.operation.operationId)).stage).toBe("identity.validated")

    await journal.submit("rename-faults", intent)
    expect((await settled(journal, submitted.operation.operationId)).stage).toBe("multiplexer.renamed")
    await journal.submit("rename-faults", intent)
    const complete = await settled(journal, submitted.operation.operationId)
    expect(complete).toMatchObject({ state: "succeeded", stage: "completed", attempts: 3, result: { session: "after" } })
    expect({ muxApplies, metadataApplies }).toEqual({ muxApplies: 1, metadataApplies: 1 })
    expect(registry.operation(submitted.operation.operationId)).toMatchObject({ status: "succeeded", stage: "completed", attempts: 3 })
    registry.close()
  })

  test("finishes multiplexer cleanup after worktree removal was interrupted", async () => {
    const { dbPath } = fixture()
    const registry = openDurableRegistry({ dbPath })
    const external = { worktree: true, mux: true }
    let removals = 0
    let muxKills = 0
    let interrupt = true
    const executor = createStagedMutationExecutor(async (_intent, stage, execution) => {
      const checkpoint = execution.operation.result && typeof execution.operation.result === "object" ? execution.operation.result as Record<string, unknown> : {}
      if (stage === "identity.validated") return { checkpoint: { path: "/repo.feature", nativeSessionId: "$1" } }
      if (stage === "worktree.deleted") {
        if (external.worktree) { external.worktree = false; removals += 1 }
        if (interrupt) { interrupt = false; throw new Error("crash after worktree removal") }
      }
      if (stage === "multiplexer.deleted" && external.mux) { external.mux = false; muxKills += 1 }
      return stage === "projection.refreshed"
        ? { checkpoint, result: { deleted: true } }
        : { checkpoint }
    })
    const journal = await OperationJournal.open(executor, registry)
    const intent = { type: "delete" as const, kind: "worktree" as const, session: "repo", path: "/repo.feature", confirmed: true as const }
    const submitted = await journal.submit("delete-partial", intent)
    expect((await settled(journal, submitted.operation.operationId)).stage).toBe("multiplexer.marked")
    await journal.submit("delete-partial", intent)
    expect(await settled(journal, submitted.operation.operationId)).toMatchObject({ state: "succeeded", result: { deleted: true } })
    expect({ removals, muxKills, external }).toEqual({ removals: 1, muxKills: 1, external: { worktree: false, mux: false } })
    registry.close()
  })

  test("automatically resumes an interrupted create from its durable stage after daemon restart", async () => {
    const { dbPath } = fixture()
    let registry = openDurableRegistry({ dbPath })
    const intent = { type: "create" as const, repository: "/repo", branch: "feature", create: true }
    const interrupted = registry.beginOperation("create-interrupted", "mutation.create", intent)
    registry.startOperation(interrupted.id)
    registry.advanceOperation(interrupted.id, "identity.validated", "running", { result: { repository: "/repo" } })
    // The external worktree effect happened, but the daemon stopped before advancing worktree.ready.
    registry.close()

    let worktreeCreates = 0
    let sessionCreates = 0
    const external = { worktree: "/repo.feature", session: "repo@feature" }
    registry = openDurableRegistry({ dbPath })
    const executor = createStagedMutationExecutor(async (_intent, stage, execution) => {
      const checkpoint = execution.operation.result as Record<string, unknown>
      if (stage === "worktree.ready") {
        if (!external.worktree) { worktreeCreates += 1; external.worktree = "/repo.feature" }
        return { checkpoint: { ...checkpoint, path: external.worktree } }
      }
      if (stage === "multiplexer.ready") {
        if (!external.session) { sessionCreates += 1; external.session = "repo@feature" }
        return { checkpoint: { ...checkpoint, session: external.session, outcome: { target: external.session } } }
      }
      return { checkpoint, result: checkpoint.outcome }
    })
    const resumed = await OperationJournal.open(executor, registry)
    const complete = await settled(resumed, interrupted.id)
    expect(complete).toMatchObject({ state: "succeeded", attempts: 2, result: { target: "repo@feature" } })
    expect({ worktreeCreates, sessionCreates }).toEqual({ worktreeCreates: 0, sessionCreates: 0 })
    registry.close()

    registry = openDurableRegistry({ dbPath })
    const restarted = await OperationJournal.open(async () => { throw new Error("a completed operation must not execute again") }, registry)
    const replay = await restarted.submit("create-interrupted", intent)
    expect(replay).toMatchObject({ replayed: true, operation: { state: "succeeded", attempts: 2 } })
    expect(restarted.get(interrupted.id)?.state).toBe("succeeded")
    registry.close()
  })
})

import type { MutationExecution, MutationExecutor } from "./transport/operations"
import type { MutationIntent } from "./transport/protocol"

export const mutationStages = (intent: MutationIntent): readonly string[] => {
  switch (intent.type) {
    case "open": return ["identity.validated", "target.opened"]
    case "absorb": return ["identity.validated", "topology.absorbed", "projection.refreshed"]
    case "rename": return ["identity.validated", "tmux.renamed", "display-name.persisted", "projection.refreshed"]
    case "attach":
    case "reparent": return ["identity.validated", "lineage.updated", "tmux-parent.updated", "projection.refreshed"]
    case "detach": return ["identity.validated", "lineage.updated", "tmux-parent.updated", "projection.refreshed"]
    case "delete": return intent.kind === "worktree"
      ? ["identity.validated", "tmux.marked", "worktree.deleted", "lineage.spliced", "tmux-children.updated", "tmux.deleted", "projection.refreshed"]
      : ["identity.validated", "target.deleted", "projection.refreshed"]
    case "create": return ["identity.validated", "worktree.ready", "tmux.ready", "projection.refreshed"]
    case "start": return ["identity.validated", "desired-state.updated", "recovery.reconciled", "projection.refreshed"]
    case "stop": return ["identity.validated", "desired-state.updated", "harness.stopped", "projection.refreshed"]
    case "recovery": return ["identity.validated", "desired-state.updated", "recovery.reconciled", "projection.refreshed"]
    case "label": return ["identity.validated", "labels.updated", "hook.dispatched", "projection.refreshed"]
    case "done": return ["identity.validated", "hook.completed", "projection.refreshed"]
    case "repository.refresh": return ["repository-cache.checked", "repository-cache.updated"]
  }
}

export interface MutationStageResult {
  /** Full durable checkpoint data to carry to the next stage. */
  checkpoint?: unknown
  /** Public operation result, normally supplied by the final semantic stage. */
  result?: unknown
}

export type MutationStageReconciler = (intent: MutationIntent, stage: string, execution: MutationExecution) => Promise<MutationStageResult | void>

/**
 * Executes only stages not already durably completed. Every stage reconciler must inspect
 * its external effect first and apply it only when absent. The checkpoint is committed
 * immediately after the reconciler returns, so a crash resumes at the first unproven stage.
 */
export const createStagedMutationExecutor = (reconcile: MutationStageReconciler): MutationExecutor => async (intent, execution) => {
  const stages = mutationStages(intent)
  const persistedCheckpoint = execution.operation.result && typeof execution.operation.result === "object" ? execution.operation.result as Record<string, unknown> : undefined
  const persistedIndex = stages.indexOf(execution.operation.stage)
  const lineageStageIndex = stages.indexOf("lineage.spliced")
  const legacyDeleteNeedsLineage = intent.type === "delete" && intent.kind === "worktree"
    && lineageStageIndex >= 0 && persistedIndex >= lineageStageIndex
    && persistedCheckpoint?.lineageSpliceVersion !== 1
  const completedIndex = legacyDeleteNeedsLineage ? stages.indexOf("worktree.deleted") : persistedIndex
  const initial = execution.operation.result
  let publicResult = initial && typeof initial === "object" && "outcome" in initial ? (initial as { outcome: unknown }).outcome : initial
  for (let index = completedIndex + 1; index < stages.length; index += 1) {
    const stage = stages[index]!
    const reconciled = await reconcile(intent, stage, execution)
    let checkpoint = reconciled?.checkpoint ?? execution.operation.result
    if (reconciled && "result" in reconciled) {
      publicResult = reconciled.result
      checkpoint = checkpoint && typeof checkpoint === "object" ? { ...checkpoint, outcome: publicResult } : { checkpoint, outcome: publicResult }
    }
    await execution.checkpoint(stage, checkpoint)
  }
  return publicResult
}

/**
 * Clankerhouse mutations: open, create, rename, attach/detach, delete, label, done, stop and repository refresh, run as
 * staged, checkpointed operations (src/mutation-stages.ts) journaled in operations.sqlite3. `clankers mutate` and the
 * other CLI commands run them in-process; an operation interrupted mid-way resumes on the next run.
 */
import { Effect, Exit } from "effect"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { canonicalActivityPath, gitStatusPaths, markDirectoryActivity, newestActivity, readDirectoryActivities } from "./activity"
import type { ActivityRecord } from "./activity"
import { selectIndependentRepositoryWorktrees } from "./directory-discovery"
import { claimSpareWorktree, isSpareWorktreePath, refillSpareWorktree, worktreePoolEnabled } from "./worktree-pool"
import { fireRoutinesThroughSend } from "./routine-api"
import { deliverQueuedMessages, harnessExited, listClankers, paneMetadataFromSnapshot, type PaneMetadata } from "./clanker-api"
import { withOrchestrationStore, type ClankerReportRecord } from "./orchestration"
import { workshopBase } from "./workshop-base"
import { applicationRoot, binPath, libexecPath } from "./installation"
import { allWorkshopLabels, attachWorkshopToParent, attachmentCandidatesForWorkshop, changeWorkshopLabel, detachWorkshopFromParent, isLinkedWorktreeSync, readLineageSnapshot, spliceDeletedWorkshopFromLineage, workshopDetails, workshopForId, workshopForPath, workshopStatePath, workshopsWithLabel } from "./workshop"
import { workshopStopPlan } from "./workshop-stop"
import { sessionState } from "./model"
import type { DetailRow, SessionRow } from "./model"
import { advanceProjection, parseProjectionSnapshot } from "./projection"
import type { ProjectionSnapshot } from "./projection"
import { planRepositoryIdentities, readRepositoryIdentityCache, writeRepositoryIdentityCache } from "./repository-cache"
import { managedResourcesOf, openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import { instanceSlug, runtimeDirFor, stateHomeDefault } from "./paths"
import { paneLocation, sessionLocation } from "./multiplexer/interface"
import { openOperationStore, type OperationStore as DurableRegistry } from "./operation-store"
import { openClankerLedger, pathWorkshopId, type ObservedClanker } from "./clanker-ledger"
import { watchHookStateRequests, type HookStateRequest } from "./hook-events"
import { StatusHookRuntime, liveStatusView } from "./status-hooks"
import { stopOwnedHarness } from "./harness-launch"
import { createStagedMutationExecutor } from "./mutation-stages"
import { completeDone, dispatchLabelsChangedHook, dispatchPostCreateHook, ensureWorkshopForLabels, workshopForLabelTarget } from "./workshop-hooks"
import { DONE_LABEL, TITLE_KEY, doneTtlMs, reapDecision } from "./labels"
import type { MutationExecution, MutationExecutor } from "./operation-journal"
import { parseClankerObservation, selectCurrentLifecycleObservations } from "./server/observations"
import type { LifecycleObservation } from "./server/observations"
import { projectResources } from "./server/project"
import { READY_AFTER_MS, SNOOZE_KEY, WAITS_ON_KEY, needsMe, parseSnooze, yourMoveLabels } from "./needs-me"
import { lastClaudeTranscriptText } from "./clanker-list"
import type { ProjectEffect } from "./server/project"
import type { DirectoryRow, MuxSession, MuxWindow } from "./server/resources"
import type { HerdResult, MutationIntent } from "./mutation-intent"

import { OperationJournal } from "./operation-journal"
import { cachedRepositoryRows, daemonMultiplexer, ensurePrivateRuntimeDirectory, expandHome, forgetMissingDirectories, invalidateProjectionEnrichment, latestSnapshotRows, readCache, refreshProjectionAfterMutation, refreshProjectionSnapshot, refreshRepositoryRows, rememberDirectory, repositoryCachePath, runCommand, runtimeDir } from "./snapshot"
import { rmSync } from "node:fs"
const repoRoot = applicationRoot
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
interface DeleteCommandResult { exitCode: number; stdout: string; stderr: string }
type DeleteProgressReporter = (step: string) => void
const deleteProgressPrefix = "CLANKERHOUSE_PROGRESS\t"

const consumeDeleteOutput = async (stream: ReadableStream<Uint8Array>, reportProgress?: DeleteProgressReporter) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let output = ""
  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split("\n")
    pending = done ? "" : lines.pop() ?? ""
    for (const line of lines) {
      if (line.startsWith(deleteProgressPrefix)) reportProgress?.(line.slice(deleteProgressPrefix.length))
      else output += `${line}\n`
    }
    if (done) {
      if (pending.startsWith(deleteProgressPrefix)) reportProgress?.(pending.slice(deleteProgressPrefix.length))
      else output += pending
      return output
    }
  }
}

const runDeleteCommand = async (argv: string[], reportProgress?: DeleteProgressReporter): Promise<DeleteCommandResult> => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...Bun.env, CLANKERHOUSE_PROGRESS: "1", CLANKERHOUSE_DAEMON_INTERNAL: "1" } })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    consumeDeleteOutput(proc.stdout, reportProgress),
    consumeDeleteOutput(proc.stderr, reportProgress),
  ])
  return { exitCode, stdout, stderr }
}

type MutationCheckpoint = Record<string, unknown>
const mutationCheckpoint = (execution: MutationExecution): MutationCheckpoint => execution.operation.result && typeof execution.operation.result === "object"
  ? execution.operation.result as MutationCheckpoint
  : {}

/** Session rows in the legacy positional shape: [id, name, workshopId, worktreePath, directoryPath, path, parentWorkshopId, displayName, resourceId]. */
const multiplexerSessionRows = async () => {
  try {
    const snapshot = await daemonMultiplexer().observe()
    return { rows: snapshot.sessions.map((session) => [session.id, session.nativeName, session.workshopId ?? "", session.worktreePath, session.directoryPath, session.path, session.parentWorkshopId ?? "", session.displayName ?? "", session.resourceId ?? ""]), error: "" }
  } catch (error) {
    return { rows: [] as string[][], error: error instanceof Error ? error.message : String(error) }
  }
}

const exactSession = async (identity: { session?: string; nativeSessionId?: string }) => {
  const listed = await multiplexerSessionRows()
  const matches = listed.rows.filter(([id, name]) => identity.nativeSessionId ? id === identity.nativeSessionId : name === identity.session)
  if (matches.length > 1) throw new Error("Selected multiplexer session identity is ambiguous")
  return matches[0]
}

const exactPaneExists = async (nativeSessionId: string, paneId: string) => {
  try {
    const snapshot = await daemonMultiplexer().observe()
    return snapshot.sessions.some((session) => session.id === nativeSessionId && session.windows.some((window) => window.panes.some((pane) => pane.id === paneId)))
  } catch { return false }
}

const sessionClankerIds = async (nativeSessionId: string) => {
  try {
    const snapshot = await daemonMultiplexer().observe()
    const session = snapshot.sessions.find((candidate) => candidate.id === nativeSessionId)
    return [...new Set((session?.windows ?? []).flatMap((window) => window.panes.flatMap((pane) => pane.clankerId ? [pane.clankerId] : [])))]
  } catch { return [] }
}

const applyExactWorkshopParent = async (nativeSessionId: string, workshopId: string, parentWorkshopId: string | null) => {
  const row = await exactSession({ nativeSessionId })
  if (!row) throw new Error("Selected session no longer exists")
  if (row[2] && row[2] !== workshopId) throw new Error(`Multiplexer session ${nativeSessionId} belongs to a different Workshop`)
  if ((row[6] || null) === parentWorkshopId) return
  await daemonMultiplexer().claim(sessionLocation(nativeSessionId), "workshopParentId", parentWorkshopId)
}

const workshopSessionIds = async (workshopId: string) => {
  const listed = await multiplexerSessionRows()
  if (listed.error) throw new Error(listed.error)
  return listed.rows.filter((row) => row[2] === workshopId).map((row) => row[0]!)
}

const worktreeForBranch = (repository: string, branch: string) => {
  const listed = Bun.spawnSync(["git", "-C", repository, "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" })
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString().trim() || `Unable to inspect worktrees for ${repository}`)
  let path = ""
  for (const line of listed.stdout.toString().split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return realpathSync(path)
  }
  return undefined
}

const createWorktreeSync = (repository: string, branch: string, create: boolean, base?: string, switchRef = branch) => {
  const existing = worktreeForBranch(repository, branch)
  if (existing) return existing
  // Resolve the fresh base first so a claimed spare never starts from a stale local default.
  const start = create ? workshopBase(repository, base) : undefined
  if (create && worktreePoolEnabled()) {
    // Replace the spare (or seed the first one) once the caller has its reply.
    setTimeout(() => { void refillSpareWorktree(repository).catch((error) => console.error(`Warm worktree refill failed: ${error instanceof Error ? error.message : String(error)}`)) }, 0)
    const claimed = switchRef === branch ? claimSpareWorktree(repository, branch, start) : undefined
    if (claimed) return claimed
  }
  const args = ["wt", "-C", repository, "switch", ...(create ? ["--create"] : []), switchRef, "--no-cd", "--format", "json", ...(start ? ["--base", start] : [])]
  const switched = Bun.spawnSync(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
  if (switched.exitCode !== 0) throw new Error(switched.stderr.toString().trim() || `wt exited ${switched.exitCode}`)
  const parsed = JSON.parse(switched.stdout.toString()) as { path?: string }
  if (!parsed.path) throw new Error("Worktrunk did not return a worktree path")
  return realpathSync(parsed.path)
}

const ensureWorktreeSession = async (path: string) => {
  const existing = (await multiplexerSessionRows()).rows.find((row) => {
    const candidate = row[3] || row[4] || row[5]
    try { return candidate && realpathSync(candidate) === path } catch { return false }
  })
  if (existing) return existing[1]!
  const created = Bun.spawnSync([binPath("clankers"), "workshop", "ensure", "--cwd", path], { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, CLANKERHOUSE_DAEMON_INTERNAL: "1" } })
  if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || `session creation exited ${created.exitCode}`)
  const session = created.stdout.toString().trim()
  if (!session) throw new Error("Session creation did not return a session name")
  return session
}

const reconcileMutationStage = async (intent: MutationIntent, stage: string, execution: MutationExecution) => {
  const checkpoint = mutationCheckpoint(execution)
  // Nothing serves a projection any more: whoever shows one recomputes it when Rex or the stores change.
  if (stage === "projection.refreshed") return { checkpoint, result: checkpoint.outcome ?? checkpoint }
  if (intent.type === "repository.refresh") {
    const rows = latestSnapshotRows() ?? readCache() ?? (await refreshProjectionSnapshot()).sessions
    if (stage === "repository-cache.checked") {
      const current = existsSync(repositoryCachePath) && statSync(repositoryCachePath).mtimeMs >= execution.operation.createdAt
      return { checkpoint: { ...checkpoint, cacheCurrent: current } }
    }
    const repositories = checkpoint.cacheCurrent ? cachedRepositoryRows(rows) : await Effect.runPromise(refreshRepositoryRows(rows))
    return { checkpoint: { ...checkpoint, cacheCurrent: true }, result: { repositories } }
  }

  if (intent.type === "open" || intent.type === "absorb") {
    const multiplexer = daemonMultiplexer()
    if (stage === "identity.validated") {
      if (intent.target.type === "directory") {
        const path = realpathSync(expandHome(intent.target.path))
        return { checkpoint: { ...checkpoint, path } }
      }
      if (intent.type === "absorb" && !intent.target.location) throw new Error("Absorption requires an exact Multiplexer Location")
      const target = intent.target
      const snapshot = await multiplexer.observe()
      const session = target.location
        ? snapshot.sessions.find((candidate) => candidate.id === target.location!.nativeSessionId && snapshot.instanceId === target.location!.instanceId)
        : snapshot.sessions.find((candidate) => candidate.nativeName === target.session)
      if (!session) throw new Error("Selected Multiplexer target no longer exists")
      const location = target.location ?? { kind: snapshot.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: target.type === "window" ? target.windowId : null, nativePaneId: target.type === "window" || target.type === "opencode" ? target.pane : null }
      return { checkpoint: { ...checkpoint, location } }
    }
    if (stage === "topology.absorbed") {
      const location = checkpoint.location as NonNullable<Exclude<typeof intent.target, { type: "directory" }>["location"]>
      // A session joins its Workshop by claim; Rex ids are already the identity of its windows and panes.
      await multiplexer.ensureManagedSession(location.nativeSessionId)
      return { checkpoint: { ...checkpoint, outcome: { absorbed: true } } }
    }
    if (stage === "target.opened") {
      const location = checkpoint.location as { nativeSessionId?: string; nativeWindowId?: string | null; nativePaneId?: string | null } | undefined
      // Rex keeps no focus outside its apps, and a mutation runs in none of its terminals, so it always opens.
      const current = multiplexer.kind === "rex" ? undefined : await multiplexer.currentLocation()
      const alreadyOpen = location && current?.nativeSessionId === location.nativeSessionId
        && (!location.nativeWindowId || current?.nativeWindowId === location.nativeWindowId)
        && (!location.nativePaneId || current?.nativePaneId === location.nativePaneId)
      if (!alreadyOpen && (intent.target.type === "session" || intent.target.type === "window")) {
        await multiplexer.openTarget(intent.target)
      } else if (!alreadyOpen) {
        const command = await runDeleteCommand([binPath("clankers"), "target", "open", "--json", JSON.stringify(intent.target)])
        if (command.exitCode !== 0) throw new Error(command.stderr.trim() || command.stdout.trim() || "Unable to open target")
      }
      return { checkpoint: { ...checkpoint, outcome: { opened: true } }, result: { opened: true } }
    }
  }

  if (intent.type === "rename") {
    if (stage === "identity.validated") {
      let row = await exactSession({ session: intent.session }) ?? await exactSession({ session: intent.displayName })
      if (!row) throw new Error("Selected session no longer exists")
      // A managed session's resource id is its Rex id, so it must name the session found.
      if (intent.resourceId && intent.resourceId !== row[0]) throw new Error("Managed session identity no longer matches its exact Multiplexer Location")
      return { checkpoint: { ...checkpoint, nativeSessionId: row[0] } }
    }
    const nativeSessionId = String(checkpoint.nativeSessionId)
    if (stage === "multiplexer.renamed") {
      const row = await exactSession({ nativeSessionId })
      if (!row) throw new Error("Selected session disappeared before rename reconciliation")
      if (row[1] !== intent.displayName) {
        if (row[1] !== intent.session) throw new Error("Selected session name changed outside this operation")
        await daemonMultiplexer().rename(sessionLocation(nativeSessionId), intent.displayName)
      }
      return { checkpoint }
    }
    if (stage === "display-name.persisted") {
      if (intent.resourceId) {
        if (intent.resourceId !== nativeSessionId) throw new Error("Managed session identity changed before Display Name persistence")
        const current = await exactSession({ nativeSessionId })
        if (!current) throw new Error("Managed session disappeared before Display Name claim persistence")
        if (current[7] !== intent.displayName) await daemonMultiplexer().claim(sessionLocation(nativeSessionId), "sessionDisplayName", intent.displayName)
      }
      return { checkpoint: { ...checkpoint, outcome: { session: intent.displayName } } }
    }
  }

  if (intent.type === "attach" || intent.type === "reparent" || intent.type === "detach") {
    const parentWorkshopId = intent.type === "detach" ? null : intent.parentWorkshopId
    if (stage === "identity.validated") {
      const workshop = workshopForId(intent.workshopId)
      if (!workshop) throw new Error(`Workshop ${intent.workshopId} does not exist`)
      if (parentWorkshopId) {
        const parent = workshopForId(parentWorkshopId)
        if (!parent || parent.repoId !== workshop.repoId) throw new Error("Workshop parent must exist in the same repository")
        if (!attachmentCandidatesForWorkshop(intent.workshopId).some((candidate) => candidate.workshopId === parentWorkshopId) && workshop.parentWorkshopId !== parentWorkshopId) throw new Error("Workshop reparent would create an unsafe lineage")
      }
      const row = intent.session ? await exactSession({ session: intent.session }) : undefined
      if (intent.session && !row) throw new Error("Selected Workshop session no longer exists")
      if (row?.[2] && row[2] !== intent.workshopId) throw new Error("Selected multiplexer session belongs to a different Workshop")
      return { checkpoint: { ...checkpoint, nativeSessionId: row?.[0] } }
    }
    if (stage === "lineage.updated") {
      const current = workshopForId(intent.workshopId)
      if (!current) throw new Error(`Workshop ${intent.workshopId} disappeared`)
      if (current.parentWorkshopId !== parentWorkshopId) {
        if (parentWorkshopId) attachWorkshopToParent(intent.workshopId, parentWorkshopId)
        else detachWorkshopFromParent(intent.workshopId)
      }
      return { checkpoint }
    }
    if (stage === "multiplexer-parent.updated") {
      // A caller that names no session, as the CLI does, means every session of the Workshop.
      const nativeSessionIds = checkpoint.nativeSessionId ? [String(checkpoint.nativeSessionId)] : intent.session ? [] : await workshopSessionIds(intent.workshopId)
      for (const nativeSessionId of nativeSessionIds) await applyExactWorkshopParent(nativeSessionId, intent.workshopId, parentWorkshopId)
      const outcome = parentWorkshopId ? { attached: true } : { detached: true }
      return { checkpoint: { ...checkpoint, outcome } }
    }
  }

  if (intent.type === "delete") {
    if (stage === "identity.validated") {
      if (intent.kind === "worktree") {
        if (!intent.path || !isLinkedWorktreeSync(expandHome(intent.path))) throw new Error("Selected path is not a linked worktree")
        const path = realpathSync(expandHome(intent.path))
        const session = await exactSession({ session: intent.session })
        const sessionPath = session?.[3] || session?.[4] || session?.[5]
        if (sessionPath && realpathSync(sessionPath) !== path) throw new Error("Selected session does not own the exact worktree path")
        const identity = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" })
        if (identity.exitCode !== 0) throw new Error(identity.stderr.toString().trim() || "Unable to capture exact worktree identity")
        const [commonDir, branch] = identity.stdout.toString().trim().split("\n")
        if (!commonDir || !branch || branch === "HEAD") throw new Error("Refusing worktree deletion without an exact branch identity")
        const lineage = workshopDetails(path)
        return { checkpoint: {
          ...checkpoint,
          nativeSessionId: session?.[0] || "",
          path,
          commonDir: realpathSync(commonDir),
          branch,
          deletedWorkshopId: lineage?.workshopId,
          deletedWorkshopRevision: lineage?.revision,
          deletedParentWorkshopId: lineage?.parentWorkshopId,
          deletedChildren: lineage?.children.map((child) => ({ workshopId: child.workshopId, revision: child.revision })) ?? [],
        } }
      }
      const session = await exactSession({ session: intent.session })
      if (!session) throw new Error("Selected session no longer exists")
      if (intent.kind === "pane") {
        if (!intent.pane || !await exactPaneExists(session[0]!, intent.pane)) throw new Error("Selected pane is not in the exact session")
        return { checkpoint: { ...checkpoint, nativeSessionId: session[0], pane: intent.pane } }
      }
      return { checkpoint: { ...checkpoint, nativeSessionId: session[0] } }
    }
    if (stage === "multiplexer.marked") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (await exactSession({ nativeSessionId })) {
        const ids = await sessionClankerIds(nativeSessionId)
        const ledger = openClankerLedger()
        let allStopped = false
        try { allStopped = ids.every((id) => ledger.get(id)?.state === "closed") } finally { ledger.close() }
        if (!allStopped) {
          const marked = await runDeleteCommand([binPath("clankerhouse-mux-stop"), "mark-session", nativeSessionId])
          if (marked.exitCode !== 0) throw new Error(marked.stderr.trim() || "Unable to mark worktree session for deletion")
        }
      }
      return { checkpoint }
    }
    if (stage === "worktree.deleted") {
      const path = String(checkpoint.path)
      if (existsSync(path)) {
        const identity = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" })
        const [commonDir, branch] = identity.stdout.toString().trim().split("\n")
        if (identity.exitCode !== 0 || !commonDir || realpathSync(commonDir) !== checkpoint.commonDir || branch !== checkpoint.branch) throw new Error("Worktree identity changed before deletion")
        const removed = await runDeleteCommand([libexecPath("worktree-delete"), "--yes", path])
        if (removed.exitCode !== 0 && existsSync(path)) throw new Error(removed.stderr.trim() || removed.stdout.trim() || "Worktree deletion failed")
      }
      return { checkpoint }
    }
    if (stage === "lineage.spliced") {
      const recovered = typeof checkpoint.deletedWorkshopId !== "string" && typeof checkpoint.path === "string" ? workshopDetails(String(checkpoint.path)) : undefined
      const workshopId = typeof checkpoint.deletedWorkshopId === "string" ? checkpoint.deletedWorkshopId : recovered?.workshopId
      const workshopRevision = typeof checkpoint.deletedWorkshopRevision === "number" ? checkpoint.deletedWorkshopRevision : recovered?.revision
      const parentWorkshopId = Object.prototype.hasOwnProperty.call(checkpoint, "deletedParentWorkshopId")
        ? typeof checkpoint.deletedParentWorkshopId === "string" ? checkpoint.deletedParentWorkshopId : null
        : recovered?.parentWorkshopId ?? null
      let deletedChildren = Array.isArray(checkpoint.deletedChildren) ? checkpoint.deletedChildren.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const child = value as { workshopId?: unknown; revision?: unknown }
        return typeof child.workshopId === "string" && typeof child.revision === "number" ? [{ workshopId: child.workshopId, revision: child.revision }] : []
      }) : []
      if (deletedChildren.length === 0 && Array.isArray(checkpoint.deletedChildWorkshopIds)) deletedChildren = checkpoint.deletedChildWorkshopIds.flatMap((id) => {
        if (typeof id !== "string") return []
        const child = workshopForId(id)
        return child ? [{ workshopId: child.workshopId, revision: child.revision }] : []
      })
      if (deletedChildren.length === 0 && recovered) deletedChildren = recovered.children.map((child) => ({ workshopId: child.workshopId, revision: child.revision }))
      if (workshopId) {
        const spliced = spliceDeletedWorkshopFromLineage(workshopId, workshopStatePath, { parentWorkshopId, revision: workshopRevision, children: deletedChildren })
        if (!spliced) for (const expectedChild of deletedChildren) {
          const child = workshopForId(expectedChild.workshopId)
          if (child && child.parentWorkshopId !== parentWorkshopId) throw new Error(`Workshop ${expectedChild.workshopId} changed after deleted lineage was spliced`)
        }
      }
      return { checkpoint: { ...checkpoint, lineageSpliceVersion: 1, deletedWorkshopId: workshopId, deletedWorkshopRevision: workshopRevision, deletedParentWorkshopId: parentWorkshopId, deletedChildren } }
    }
    if (stage === "multiplexer-children.updated") {
      const parentWorkshopId = typeof checkpoint.deletedParentWorkshopId === "string" ? checkpoint.deletedParentWorkshopId : null
      const childWorkshopIds = Array.isArray(checkpoint.deletedChildren) ? checkpoint.deletedChildren.flatMap((value) => value && typeof value === "object" && typeof (value as { workshopId?: unknown }).workshopId === "string" ? [(value as { workshopId: string }).workshopId] : []) : []
      const rows = (await multiplexerSessionRows()).rows
      for (const childWorkshopId of childWorkshopIds) {
        for (const row of rows.filter((candidate) => candidate[2] === childWorkshopId)) await applyExactWorkshopParent(row[0]!, childWorkshopId, parentWorkshopId)
      }
      return { checkpoint }
    }
    if (stage === "multiplexer.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (await exactSession({ nativeSessionId })) await daemonMultiplexer().kill(sessionLocation(nativeSessionId))
      return { checkpoint: { ...checkpoint, outcome: { deleted: true } } }
    }
    if (stage === "target.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      const exists = intent.kind === "pane" ? await exactPaneExists(nativeSessionId, String(checkpoint.pane)) : Boolean(await exactSession({ nativeSessionId }))
      if (exists) {
        const command = intent.kind === "pane"
          ? await runDeleteCommand([binPath("clankerhouse-mux-stop"), "pane", String(checkpoint.pane)])
          : await runDeleteCommand([binPath("clankerhouse-mux-stop"), "session", nativeSessionId])
        if (command.exitCode !== 0) throw new Error(command.stderr.trim() || command.stdout.trim() || "Deletion failed")
      }
      return { checkpoint: { ...checkpoint, outcome: { deleted: true } } }
    }
  }

  if (intent.type === "label") {
    if (stage === "identity.validated") {
      const workshop = workshopForLabelTarget(intent.path !== undefined ? { path: expandHome(intent.path) } : { workshopId: intent.workshopId! })
      return { checkpoint: { ...checkpoint, workshopId: workshop.workshopId } }
    }
    const workshop = workshopForId(String(checkpoint.workshopId))
    if (!workshop) throw new Error("Labelled Workshop disappeared")
    if (stage === "labels.updated") {
      const change = changeWorkshopLabel(workshop.workshopId, intent.key, intent.value)
      return { checkpoint: { ...checkpoint, ...change, outcome: { workshopId: workshop.workshopId, labels: change.labels, changed: change.changed } } }
    }
    if (stage === "title.mirrored") {
      if (intent.key === TITLE_KEY && intent.value) await mirrorWorkshopTitle(workshop.canonicalPath, intent.value)
      return { checkpoint }
    }
    if (stage === "hook.dispatched") {
      if (checkpoint.changed === true) dispatchLabelsChangedHook(workshop, checkpoint.previous as Record<string, string>, checkpoint.labels as Record<string, string>)
      return { checkpoint }
    }
  }

  if (intent.type === "done") {
    if (stage === "identity.validated") return { checkpoint: { ...checkpoint, path: realpathSync(expandHome(intent.path)) } }
    if (stage === "hook.completed") {
      const outcome = await completeDone(String(checkpoint.path))
      return { checkpoint: { ...checkpoint, outcome } }
    }
  }

  if (intent.type === "workshop.stop") {
    if (stage === "identity.validated") {
      const path = realpathSync(expandHome(intent.path))
      return { checkpoint: { ...checkpoint, path, workshopId: workshopForPath(path)?.workshopId } }
    }
    const path = String(checkpoint.path)
    const clankerIds = Array.isArray(checkpoint.clankerIds) ? checkpoint.clankerIds.map(String) : []
    if (stage === "desired-state.updated") {
      const canonical = (candidate: string) => { try { return realpathSync(candidate) } catch { return candidate } }
      const snapshot = await daemonMultiplexer().observe()
      const ledger = openClankerLedger()
      try {
        const plan = workshopStopPlan({
          path,
          workshopId: typeof checkpoint.workshopId === "string" ? checkpoint.workshopId : undefined,
          sessions: snapshot.sessions.map((session) => ({
            id: session.id,
            workshopId: session.workshopId,
            paths: [session.worktreePath, session.directoryPath, session.path].filter(Boolean).map(canonical),
            clankerIds: session.windows.flatMap((window) => window.panes.flatMap((pane) => pane.clankerId ? [pane.clankerId] : [])),
          })),
          clankers: ledger.list().map((row) => ({ clankerId: row.clankerId, workshopId: row.workshopId, workshopPath: canonical(row.workshopPath), state: row.state })),
        })
        for (const clankerId of plan.stop) ledger.end(clankerId, "workshop-stopped")
        return { checkpoint: { ...checkpoint, clankerIds: plan.clankerIds, sessionIds: plan.sessionIds } }
      } finally { ledger.close() }
    }
    if (stage === "messages.orphaned") {
      withOrchestrationStore((store) => store.orphanMessagesFor(clankerIds))
      return { checkpoint }
    }
    if (stage === "harness.stopped") {
      const ledger = openClankerLedger()
      try {
        for (const clankerId of clankerIds) {
          const ownerUnit = ledger.get(clankerId)?.ownerUnit
          if (!ownerUnit) continue
          const active = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", ownerUnit], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
          if (active) stopOwnedHarness(ownerUnit)
        }
      } finally { ledger.close() }
      return { checkpoint }
    }
    if (stage === "sessions.closed") {
      const sessionIds = Array.isArray(checkpoint.sessionIds) ? checkpoint.sessionIds.map(String) : []
      for (const nativeSessionId of sessionIds) {
        if (await exactSession({ nativeSessionId })) await daemonMultiplexer().kill(sessionLocation(nativeSessionId))
      }
      // The Workshop stays listed without its session, as a row that opens a fresh one.
      if (existsSync(path)) {
        const branch = Bun.spawnSync(["git", "-C", path, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
        rememberDirectory({ path, source: isLinkedWorktreeSync(path) ? "worktree" : "activity", branch, activityAt: Date.now(), activitySource: "opened" })
      }
      return { checkpoint: { ...checkpoint, outcome: { path, workshopId: checkpoint.workshopId ?? null, stopped: true, clankerIds, sessionIds } } }
    }
  }

  if (intent.type === "create") {
    if (stage === "identity.validated") {
      const repository = realpathSync(expandHome(intent.repository))
      const verified = Bun.spawnSync(["git", "-C", repository, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
      if (verified.exitCode !== 0) throw new Error(verified.stderr.toString().trim() || "Selected repository is invalid")
      return { checkpoint: { ...checkpoint, repository } }
    }
    if (stage === "worktree.ready") {
      const repository = String(checkpoint.repository)
      const existing = worktreeForBranch(repository, intent.branch)
      if (existing) return { checkpoint: { ...checkpoint, path: existing } }
      if (intent.remoteRef) {
        const remoteBranch = intent.remoteRef.split("/").slice(1).join("/")
        if (!remoteBranch || remoteBranch !== intent.branch) throw new Error("Selected remote ref does not match its branch")
        const fetched = Bun.spawnSync(["git", "-C", repository, "fetch", "--all", "--prune", "--quiet"], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } })
        // An unreachable remote does not stop the open: the branch as last fetched is checked below.
        if (fetched.exitCode !== 0) console.error(`Unable to refresh remote branches; opening ${intent.remoteRef} as last fetched: ${fetched.stderr.toString().trim() || `git fetch exited ${fetched.exitCode}`}`)
        const verified = Bun.spawnSync(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/remotes/${intent.remoteRef}`], { stdout: "ignore", stderr: "ignore" })
        if (verified.exitCode !== 0) throw new Error(`Remote branch ${intent.remoteRef} no longer exists`)
        const local = Bun.spawnSync(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${intent.branch}`], { stdout: "ignore", stderr: "ignore" })
        if (local.exitCode === 0) throw new Error(`Local branch ${intent.branch} appeared after remote selection`)
      }
      const path = createWorktreeSync(repository, intent.branch, intent.create, intent.base, intent.remoteRef)
      return { checkpoint: { ...checkpoint, path, created: true } }
    }
    if (stage === "multiplexer.ready") {
      const path = realpathSync(String(checkpoint.path))
      // Titled before its session exists, so the session is born with the human name.
      if (intent.title) changeWorkshopLabel(ensureWorkshopForLabels(path).workshopId, TITLE_KEY, intent.title)
      rememberDirectory({ path, source: "worktree", branch: intent.branch, activityAt: Date.now(), activitySource: "opened" })
      if (intent.deferSession) return { checkpoint: { ...checkpoint, outcome: { path } } }
      const session = await ensureWorktreeSession(path)
      return { checkpoint: { ...checkpoint, session, outcome: { target: { type: "session", session } } } }
    }
    if (stage === "hook.dispatched") {
      if (checkpoint.created) dispatchPostCreateHook(ensureWorkshopForLabels(realpathSync(String(checkpoint.path))))
      return { checkpoint }
    }
  }

  throw new Error(`Unsupported mutation stage ${intent.type}/${stage}`)
}

/** The multiplexer shows the Workshop under its title too; a failed rename never fails the title change. */
const mirrorWorkshopTitle = async (path: string, title: string) => {
  for (const row of (await multiplexerSessionRows()).rows) {
    const candidate = row[3] || row[4] || row[5]
    let matches = false
    try { matches = Boolean(candidate) && realpathSync(candidate!) === path } catch {}
    if (!matches || row[1] === title) continue
    try { await daemonMultiplexer().rename(sessionLocation(row[0]!), title) }
    catch (error) { console.error(`Unable to rename ${daemonMultiplexer().kind} session for ${path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

const reapIntervalMs = 10 * 60_000
let lastReapAt = 0
/**
 * Removes Workshops that were marked done and then left alone for the retention period. It only
 * decides; the deletion itself is an ordinary durable delete mutation.
 */
export const reapDoneWorkshops = async (rows: readonly SessionRow[], now = Date.now()) => {
  const ttlMs = doneTtlMs()
  if (ttlMs === undefined || now - lastReapAt < Math.min(reapIntervalMs, ttlMs)) return
  lastReapAt = now
  for (const workshop of workshopsWithLabel(DONE_LABEL.key, DONE_LABEL.value)) {
    // A Workshop the projection cannot see has no observed activity to judge, so it is left alone.
    const row = rows.find((candidate) => candidate.workshopId === workshop.workshopId) ?? rows.find((candidate) => expandHome(candidate.path) === workshop.canonicalPath)
    if (!row || !existsSync(workshop.canonicalPath)) continue
    if (now - Math.max(workshop.labelledAt, row.recency * 1000) < ttlMs) continue
    const status = Bun.spawnSync(["git", "-C", workshop.canonicalPath, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" })
    const decision = reapDecision({
      markedAt: workshop.labelledAt,
      lastActivityAt: row.recency * 1000,
      linkedWorktree: isLinkedWorktreeSync(workshop.canonicalPath),
      dirty: status.exitCode !== 0 || status.stdout.toString().trim().length > 0,
      busyClanker: row.details.some((detail) => detail.kind === "clanker" && (detail.state === "working" || detail.state === "blocked" || detail.state === "done")),
    }, now, ttlMs)
    if (!decision.reap) {
      if (decision.reason !== "not-expired") console.error(`Keeping done Workshop ${workshop.canonicalPath}: ${decision.reason}`)
      continue
    }
    console.error(`Reaping done Workshop ${workshop.canonicalPath}`)
    const session = row.target.type === "session" ? row.target.session : row.name
    await runMutation({ type: "delete", kind: "worktree", session, path: workshop.canonicalPath, confirmed: true }, { idempotencyKey: `reap:${workshop.workshopId}:${workshop.labelledAt}` })
  }
}

const stagedDaemonMutation = createStagedMutationExecutor(reconcileMutationStage)
const executeDaemonMutation: MutationExecutor = async (intent, execution) => {
  const result = await stagedDaemonMutation(intent, execution)
  invalidateProjectionEnrichment()
  forgetMissingDirectories()
  return result
}


/** Finishes every mutation whose process died mid-way (the runner calls this on each pass). */
export const resumeUnfinishedMutations = async () => {
  ensurePrivateRuntimeDirectory()
  const store = openOperationStore()
  try {
    const journal = await OperationJournal.open(executeDaemonMutation, store)
    await journal.idle()
  } finally {
    store.close()
  }
}

export interface MutationOutcome { operationId: string; state: string; stage: string; result?: unknown; error?: string }

/**
 * Runs one mutation in this process, after resuming any unfinished one whose process died mid-way. Mutations from
 * several processes run concurrently, as they did in the daemon: a repository hook run by one may start another. Idempotent by key: the same key and intent returns the recorded outcome.
 */
export const runMutation = async (intent: MutationIntent, options: { idempotencyKey?: string; onStage?: (stage: string) => void } = {}): Promise<MutationOutcome> => {
  ensurePrivateRuntimeDirectory()
  const store = openOperationStore()
  try {
    const journal = await OperationJournal.open(executeDaemonMutation, store)
    // Unfinished operations from an earlier process (a crash mid worktree delete) finish first.
    await journal.idle()
    const submitted = await journal.submit(options.idempotencyKey ?? `cli-${randomUUID()}`, intent)
    let stage = ""
    const poll = options.onStage ? setInterval(() => {
      const current = journal.get(submitted.operation.operationId)
      if (current && current.stage !== stage) { stage = current.stage; options.onStage!(stage) }
    }, 25) : undefined
    const settled = await journal.settled(submitted.operation.operationId)
    if (poll) clearInterval(poll)
    if (!settled) throw new Error(`Mutation ${submitted.operation.operationId} disappeared`)
    return { operationId: settled.operationId, state: settled.state, stage: settled.stage, ...(settled.result === undefined ? {} : { result: settled.result }), ...(settled.error ? { error: settled.error } : {}) }
  } finally {
    store.close()
  }
}

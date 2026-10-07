import { accessSync, constants, statSync } from "node:fs"
import { dirname } from "node:path"
import { binPath } from "./installation"
import { DONE_LABEL, doneHookHandled, hookEnvironment, isDone, type HookContext, type WorkshopHookEvent, type WorkshopLabels } from "./labels"
import { changeWorkshopLabel, identifyWorkshopSync, registerWorkshop, workshopForPath, workshopLabels, workshopStatePath, type WorkshopRecord } from "./workshop"

const doneHookTimeoutMs = 30_000

/** Repository hooks are tracked executables at .clankerhouse/hooks/<event> in the workshop itself. */
export const workshopHookPath = (workshopPath: string, event: WorkshopHookEvent) => `${workshopPath}/.clankerhouse/hooks/${event}`

const executableHook = (workshopPath: string, event: WorkshopHookEvent) => {
  const path = workshopHookPath(workshopPath, event)
  try {
    if (!statSync(path).isFile()) return undefined
    accessSync(path, constants.X_OK)
    return path
  } catch { return undefined }
}

const processEnvironment = (context: HookContext) => {
  const inherited: Record<string, string | undefined> = { ...Bun.env }
  // The hook's own `clankers` calls must reach the daemon like any other client.
  for (const key of ["CLANKERHOUSE_DAEMON_INTERNAL", "CLANKERHOUSE_PROGRESS", "CLANKERHOUSE_LEGACY_MUTATIONS"]) delete inherited[key]
  return { ...inherited, ...hookEnvironment(context), PATH: `${dirname(binPath("clankers"))}:${inherited.PATH ?? ""}` }
}

/** Labels need durable Workshop identity, so an unregistered Git worktree is registered on first use. */
export const ensureWorkshopForLabels = (path: string, dbPath = workshopStatePath): WorkshopRecord => {
  const identity = identifyWorkshopSync(path)
  return workshopForPath(identity.path, dbPath) ?? registerWorkshop(identity, { dbPath })
}

const contextFor = (workshop: WorkshopRecord, event: WorkshopHookEvent, labels: WorkshopLabels, previousLabels?: WorkshopLabels): HookContext => ({
  event, workshopId: workshop.workshopId, path: workshop.canonicalPath, branch: workshop.branch, labels, previousLabels,
})

/** Fire-and-forget: the hook outlives the caller and can never fail the label change that triggered it. */
export const dispatchLabelsChangedHook = (workshop: WorkshopRecord, previousLabels: WorkshopLabels, labels: WorkshopLabels) => {
  const hook = executableHook(workshop.canonicalPath, "labels-changed")
  if (!hook) return false
  try {
    Bun.spawn([hook], { cwd: workshop.canonicalPath, env: processEnvironment(contextFor(workshop, "labels-changed", labels, previousLabels)), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
    return true
  } catch { return false }
}

export const applyWorkshopLabel = (path: string, key: string, value: string | null, dbPath = workshopStatePath) => {
  const workshop = ensureWorkshopForLabels(path, dbPath)
  const change = changeWorkshopLabel(workshop.workshopId, key, value, dbPath)
  return { workshop, ...change }
}

export interface DoneHookResult {
  handled: boolean
  hook: boolean
  exitCode?: number
  /** Whether the path is a linked worktree, so the caller can offer worktree rather than session destruction. */
  worktree?: boolean
}

const isLinkedWorktree = (path: string) => {
  const result = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" })
  if (result.exitCode !== 0) return false
  const [gitDir, commonDir] = result.stdout.toString().trim().split("\n")
  return Boolean(gitDir && commonDir && gitDir !== commonDir)
}

/** Runs the repository's done hook to completion. Without a hook the default action stays with the caller. */
export const runDoneHook = async (path: string, dbPath = workshopStatePath): Promise<DoneHookResult> => {
  let worktreePath: string
  try { worktreePath = identifyWorkshopSync(path).path }
  catch { return { handled: false, hook: false } }
  // Checked before touching the store, so a repository without a hook gains no Workshop record from a key press.
  const hook = executableHook(worktreePath, "done")
  if (!hook) return { handled: false, hook: false }
  const workshop = ensureWorkshopForLabels(worktreePath, dbPath)
  const proc = Bun.spawn([hook], { cwd: workshop.canonicalPath, env: processEnvironment(contextFor(workshop, "done", workshopLabels(workshop.workshopId, dbPath))), stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, doneHookTimeoutMs)
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]).finally(() => clearTimeout(timer))
  if (timedOut) throw new Error(`Workshop done hook timed out after ${doneHookTimeoutMs / 1000}s`)
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`Workshop done hook failed with exit ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`)
  return { handled: doneHookHandled(exitCode), hook: true, exitCode }
}

/**
 * The done key. A repository done hook owns it outright; without one the built-in rule applies:
 * the first press marks a linked-worktree Workshop done, and a press on a done Workshop is left unhandled so
 * the caller offers the destroy confirmation.
 */
export const completeDone = async (path: string, dbPath = workshopStatePath): Promise<DoneHookResult> => {
  const worktree = isLinkedWorktree(path)
  const hooked = { ...await runDoneHook(path, dbPath), worktree }
  // Only a linked worktree can be reaped or destroyed as one, so only it takes the built-in mark.
  if (hooked.hook || !worktree) return hooked
  let workshop: WorkshopRecord
  try { workshop = ensureWorkshopForLabels(path, dbPath) }
  catch { return hooked }
  if (isDone(workshopLabels(workshop.workshopId, dbPath))) return hooked
  const change = changeWorkshopLabel(workshop.workshopId, DONE_LABEL.key, DONE_LABEL.value, dbPath)
  if (change.changed) dispatchLabelsChangedHook(workshop, change.previous, change.labels)
  return { handled: true, hook: false, worktree }
}

import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { binPath } from "./installation"
import { ownedScopeCommand } from "./recovery/process-owner"
import { DONE_LABEL, doneHookHandled, hookEnvironment, isDone, projectName, type HookContext, type WorkshopHookEvent, type WorkshopLabels } from "./labels"
import { changeWorkshopLabel, identifyWorkshopSync, registerWorkshop, workshopForId, workshopForPath, workshopLabels, workshopStatePath, type WorkshopRecord } from "./workshop"

const doneHookTimeoutMs = 30_000

/** Repository hooks are tracked executables at .clankerhouse/hooks/<event> in the workshop itself. */
export const workshopHookPath = (workshopPath: string, event: WorkshopHookEvent) => `${workshopPath}/.clankerhouse/hooks/${event}`

/**
 * The operator's own hooks for a project, outside the repository: they apply to every Workshop
 * of that project at once, including branches cut before the hook existed, and add nothing to a
 * shared repository.
 */
export const userHookPath = (project: string, event: WorkshopHookEvent, env: Record<string, string | undefined> = Bun.env) =>
  `${env.XDG_CONFIG_HOME || `${env.HOME ?? ""}/.config`}/clankerhouse/hooks/${project}/${event}`

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return undefined
    accessSync(path, constants.X_OK)
    return path
  } catch { return undefined }
}

/** A hook in the Workshop wins; otherwise the operator's hook for the Workshop's project. */
const executableHook = (workshopPath: string, commonDir: string, event: WorkshopHookEvent) => {
  const project = projectName(commonDir)
  return executable(workshopHookPath(workshopPath, event)) ?? (project ? executable(userHookPath(project, event)) : undefined)
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

/** A Workshop to label: by path, registering it on first use, or by durable ID, which outlives its worktree. */
export type LabelTarget = { path: string; workshopId?: undefined } | { workshopId: string; path?: undefined }

export const workshopForLabelTarget = (target: LabelTarget, dbPath = workshopStatePath): WorkshopRecord => {
  if (target.path !== undefined) return ensureWorkshopForLabels(target.path, dbPath)
  const workshop = workshopForId(target.workshopId, dbPath)
  if (!workshop) throw new Error(`Unknown workshop: ${target.workshopId}`)
  return workshop
}

/** Hooks run in the worktree; once it is deleted, in its repository, so a merged Workshop still reaches them. */
const hookDirectory = (workshop: WorkshopRecord) => {
  if (existsSync(workshop.canonicalPath)) return workshop.canonicalPath
  const repository = dirname(workshop.commonDir)
  return existsSync(repository) ? repository : workshop.commonDir
}

const contextFor = (workshop: WorkshopRecord, event: WorkshopHookEvent, labels: WorkshopLabels, previousLabels?: WorkshopLabels): HookContext => ({
  event, workshopId: workshop.workshopId, path: workshop.canonicalPath, branch: workshop.branch, project: projectName(workshop.commonDir), labels, previousLabels,
})

/** Fire-and-forget: the hook outlives the caller and can never fail the label change that triggered it. */
export const dispatchLabelsChangedHook = (workshop: WorkshopRecord, previousLabels: WorkshopLabels, labels: WorkshopLabels) => {
  const hook = executableHook(workshop.canonicalPath, workshop.commonDir, "labels-changed")
  if (!hook) return false
  try {
    Bun.spawn([hook], { cwd: hookDirectory(workshop), env: processEnvironment(contextFor(workshop, "labels-changed", labels, previousLabels)), stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
    return true
  } catch { return false }
}

/** Where a Workshop's post-create hook writes its output, ending with the hook's exit status. */
export const postCreateLogPath = (workshop: Pick<WorkshopRecord, "commonDir" | "workshopId">) => `${workshop.commonDir}/clankerhouse/hooks/post-create/${workshop.workshopId}.log`

/**
 * Fire-and-forget after a new worktree exists: the repository prepares it (installs, cache seeding)
 * while its first Clanker starts. The hook runs in its own scope under the clanker budget, so a heavy
 * install never lands in the caller's cgroup, and outlives the caller.
 */
export const dispatchPostCreateHook = (workshop: WorkshopRecord, dbPath = workshopStatePath) => {
  const hook = executableHook(workshop.canonicalPath, workshop.commonDir, "post-create")
  if (!hook) return false
  const log = postCreateLogPath(workshop)
  try {
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, "a")
    try {
      const report = `"$0"; status=$?; printf '%s post-create exited %s\\n' "$(date -u +%FT%TZ)" "$status"; exit "$status"`
      const unit = `clankerhouse-hook-${workshop.workshopId.replace(/[^A-Za-z0-9_.-]+/g, "-")}-${Date.now().toString(36)}.scope`
      Bun.spawn(ownedScopeCommand(["sh", "-c", report, hook], unit), { cwd: workshop.canonicalPath, env: processEnvironment(contextFor(workshop, "post-create", workshopLabels(workshop.workshopId, dbPath))), stdin: "ignore", stdout: fd, stderr: fd }).unref()
    } finally { closeSync(fd) }
    return true
  } catch { return false }
}

export const applyWorkshopLabel = (target: string | LabelTarget, key: string, value: string | null, dbPath = workshopStatePath) => {
  const workshop = workshopForLabelTarget(typeof target === "string" ? { path: target } : target, dbPath)
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
  let commonDir: string
  try { ({ path: worktreePath, commonDir } = identifyWorkshopSync(path)) }
  catch { return { handled: false, hook: false } }
  // Checked before touching the store, so a repository without a hook gains no Workshop record from a key press.
  const hook = executableHook(worktreePath, commonDir, "done")
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

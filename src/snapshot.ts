/**
 * A snapshot of what the picker shows: Rex's live topology and agent status joined with the Workshop, clanker and
 * orchestration stores, git facts and discovered directories (src/server/project.ts does the joining). Computed on
 * demand by `clankers snapshot` and the runner; Rex stays the truth for what runs, so nothing here is authoritative.
 * In-memory caches serve a long-lived process; directory discovery is also cached on disk for the next one.
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
import { createStagedMutationExecutor } from "./daemon-mutations"
import { completeDone, dispatchLabelsChangedHook, dispatchPostCreateHook, ensureWorkshopForLabels, workshopForLabelTarget } from "./workshop-hooks"
import { DONE_LABEL, TITLE_KEY, doneTtlMs, reapDecision } from "./labels"
import type { MutationExecution, MutationExecutor } from "./transport/operations"
import { parseClankerObservation, selectCurrentLifecycleObservations } from "./server/observations"
import type { LifecycleObservation } from "./server/observations"
import { projectResources } from "./server/project"
import { READY_AFTER_MS, SNOOZE_KEY, WAITS_ON_KEY, needsMe, parseSnooze, yourMoveLabels } from "./needs-me"
import { lastClaudeTranscriptText } from "./clanker-list"
import type { ProjectEffect } from "./server/project"
import type { DirectoryRow, MuxSession, MuxWindow } from "./server/resources"
import type { HerdResult, MutationIntent } from "./transport"

const repoRoot = applicationRoot
const runtimeDir = runtimeDirFor()
const cachePath = `${runtimeDir}/state.json`
const pidPath = `${runtimeDir}/server.pid`
const versionPath = `${runtimeDir}/server.version`
const daemonSocketPath = `${runtimeDir}/daemon.sock`
const repositoryCachePath = `${runtimeDir}/repositories.json`
const clankerStateDir = `${runtimeDir}/clanker-state`
// Read reports from clankers that were already running before the rename.
const previousClankerStateDir = `${Bun.env.XDG_RUNTIME_DIR ?? "/tmp"}/alt-k-tui-${process.getuid?.() ?? Bun.env.USER ?? "user"}/agent-state`
const refreshMs = Number(Bun.env.CLANKERHOUSE_REFRESH_MS ?? 15_000) || 15_000
const coldRefreshMs = Number(Bun.env.CLANKERHOUSE_COLD_REFRESH_MS ?? 60_000) || 60_000
const directoryRefreshMs = Number(Bun.env.CLANKERHOUSE_DIRECTORY_REFRESH_MS ?? 10 * 60_000) || 10 * 60_000
const cacheVersion = 11
const projectionSource: string = randomUUID()
let latestWrittenProjection: ProjectionSnapshot<SessionRow> | undefined
let latestProjectionSemanticKey = ""
let projectionRefreshInFlight: Promise<ProjectionSnapshot<SessionRow>> | undefined
/** Read-only snapshots write nothing: no ledger sync, activity marks, Workshop Label presentation or cache file. */
let readOnly = false
export const setSnapshotReadOnly = (value: boolean) => { readOnly = value }
const snapshotListeners = new Set<(sessions: SessionRow[]) => void>()
/** Called with every computed snapshot. */
export const onSnapshot = (listener: (sessions: SessionRow[]) => void) => { snapshotListeners.add(listener); return () => snapshotListeners.delete(listener) }
const directoryCachePath = `${runtimeDir}/directories.json`
const liveLifecycleReports = new Map<string, LifecycleObservation>()
// The herd as of the newest observation, served to clanker API callers so they need not observe.
let latestHerd: HerdResult<PaneMetadata> | undefined
const lifecycleSequences = new Map<string, number>()
let projectionRefreshScheduled = false
/** Each clanker's current turn start and transcript, from its hook's report file. */
const turnFacts = new Map<string, { turnStartedAt?: number; transcriptPath?: string }>()
/** Interrupted Clankers per Workshop, as of the last ledger sync. */
let interruptedByWorkshop = new Map<string, Array<{ clankerId: string; at: number }>>()
const lastTextCache = new Map<string, { key: string; text: string | null }>()
let projectionEnrichmentCache: { refreshedAt: number; version: string; lineage: ReturnType<typeof readLineageSnapshot> } | undefined
export const invalidateProjectionEnrichment = () => { projectionEnrichmentCache = undefined }
export const ensurePrivateRuntimeDirectory = () => {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(runtimeDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe Clankerhouse runtime directory: ${runtimeDir}`)
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Clankerhouse runtime directory is not owned by the current user: ${runtimeDir}`)
  chmodSync(runtimeDir, 0o700)
}
export const runCommand = (cmd: string[], options: { cwd?: string; allowFailure?: boolean } = {}) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, { cwd: options.cwd ?? repoRoot, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0 && !options.allowFailure) throw new Error(stderr.trim() || `${cmd.join(" ")} exited ${exitCode}`)
      return stdout
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const expandHome = (path: string) => path === "~" ? Bun.env.HOME ?? path : path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path
let daemonMultiplexerInstance: ManagedMultiplexer | undefined
/** The process's Multiplexer Adapter, created once. */
export const daemonMultiplexer = () => (daemonMultiplexerInstance ??= openManagedMultiplexer())

const collectMultiplexerResources = Effect.tryPromise({
  try: async () => {
    const multiplexer = daemonMultiplexer()
    // Read before observing, so a server restart in between is never stamped on the old server's panes.
    const serverEpoch = await multiplexer.serverEpoch().catch(() => undefined)
    const observedAt = Date.now()
    const snapshot = await multiplexer.observe()
    // Presentation only: Workshop Labels shown beside the session; failures are logged by the managed layer.
    if (!readOnly) await multiplexer.mirrorWorkshopLabels(snapshot).catch(() => 0)
    latestHerd = { instanceId: snapshot.instanceId, observedAt, panes: paneMetadataFromSnapshot(snapshot) }
    const sessions: MuxSession[] = snapshot.sessions.map((session) => ({
      id: session.id,
      name: session.nativeName,
      recency: session.recency,
      path: session.path ? canonicalActivityPath(session.path) : "",
      attached: session.attached,
      worktreePath: session.worktreePath,
      directoryPath: session.directoryPath,
      workshopId: session.workshopId,
      parentWorkshopId: session.parentWorkshopId,
      resourceId: session.resourceId,
      displayName: session.displayName,
    }))
    const windows: MuxWindow[] = snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.map((pane) => ({
      session: session.nativeName,
      sessionId: session.id,
      id: window.id,
      index: window.index,
      name: window.nativeName,
      pane: pane.id,
      pid: pane.pid,
      currentPath: pane.currentPath,
      command: pane.command,
      title: pane.title,
      activity: pane.activity,
      active: window.active && pane.active,
      windowResourceId: window.resourceId,
      windowDisplayName: window.displayName,
      terminalId: pane.terminalId,
      terminalDisplayName: pane.displayName,
      clankerId: pane.clankerId,
      explicitHarness: pane.harness,
      harnessSessionId: pane.harnessSessionId,
      agentStatus: pane.agentStatus,
      harnessGone: pane.harnessGone,
    }))))
    return { kind: snapshot.kind, instanceId: snapshot.instanceId, serverEpoch, sessions, windows, managedResources: managedResourcesOf(snapshot, observedAt) }
  },
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
})

/** A ledger clanker missing this long, in the server it was last seen in, ended rather than flickered. */
const LEDGER_MISSING_MS = 60_000
const ledgerMissingSince = new Map<string, number>()
let ledgerSyncFailure = ""
let ledgerSkipped = ""

/** Record which clankers are alive, and their current sessions, in the clanker ledger. */
const syncClankerLedger = (serverEpoch: string, sessions: readonly SessionRow[], windows: readonly MuxWindow[]) => {
  const now = Date.now()
  const panes = new Map(windows.map((window) => [window.pane, window]))
  const observed: ObservedClanker[] = sessions.flatMap((session) => session.details.flatMap((detail) => {
    const window = detail.target.type === "window" ? panes.get(detail.target.pane) : undefined
    // A pane outliving its harness (an exit mark, or hc keep's shell after a loss) holds no live clanker.
    if (detail.kind !== "clanker" || !detail.clankerId || !window || window.harnessGone || harnessExited(window.pane, detail.clankerId)) return []
    const workshopPath = session.path || window.currentPath || ""
    if (!workshopPath.startsWith("/")) return []
    return [{
      clankerId: detail.clankerId,
      harness: window.explicitHarness ?? detail.harness ?? "",
      harnessSessionId: window.harnessSessionId,
      workshopId: session.workshopId || pathWorkshopId(workshopPath),
      workshopPath,
      cwd: window.currentPath?.startsWith("/") ? window.currentPath : workshopPath,
      sessionLabel: window.session,
      windowLabel: window.name,
    }]
  }))
  const alive = new Set(observed.map((clanker) => clanker.clankerId))
  for (const clankerId of ledgerMissingSince.keys()) if (alive.has(clankerId)) ledgerMissingSince.delete(clankerId)
  const missing = (clankerId: string) => {
    const since = ledgerMissingSince.get(clankerId)
    if (since === undefined) ledgerMissingSince.set(clankerId, now)
    return since !== undefined && now - since >= LEDGER_MISSING_MS
  }
  try {
    const ledger = openClankerLedger()
    let skipped: { clankerId: string; error: string }[] = []
    try {
      if (!readOnly) skipped = ledger.sync(observed, serverEpoch, missing)
      // Open but last seen in an earlier server: running when the host or the Multiplexer went down.
      interruptedByWorkshop = Map.groupBy(
        ledger.list({ state: "open" }).filter((row) => !alive.has(row.clankerId) && row.serverEpoch !== serverEpoch).map((row) => ({ clankerId: row.clankerId, at: row.updatedAt, workshopId: row.workshopId })),
        (row) => row.workshopId,
      ) as Map<string, Array<{ clankerId: string; at: number }>>
    } finally { ledger.close() }
    ledgerSyncFailure = ""
    const skippedReport = skipped.map(({ clankerId, error }) => `${clankerId}: ${error}`).join("; ")
    if (skippedReport && skippedReport !== ledgerSkipped) console.error(`Clanker ledger skipped ${skipped.length} clanker(s): ${skippedReport}`)
    ledgerSkipped = skippedReport
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A read-only snapshot only reads the ledger; the runner owns it and reports its failures.
    if (message !== ledgerSyncFailure && !readOnly) console.error(`Clanker ledger update failed: ${message}`)
    ledgerSyncFailure = message
  }
}

/** The Workshop store's files as they are now: any process's label or lineage write changes this. */
const workshopStoreVersion = () => [workshopStatePath, `${workshopStatePath}-wal`].map((path) => {
  try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}` } catch { return "-" }
}).join("|")

const collectProjectionEnrichment = Effect.sync(() => {
  const version = workshopStoreVersion()
  if (projectionEnrichmentCache && projectionEnrichmentCache.version === version && Date.now() - projectionEnrichmentCache.refreshedAt < coldRefreshMs) return projectionEnrichmentCache
  projectionEnrichmentCache = {
    refreshedAt: Date.now(),
    version,
    lineage: readLineageSnapshot(),
  }
  return projectionEnrichmentCache
})

const collectZoxideDirectories = runCommand(["zoxide", "query", "-ls"], { allowFailure: true }).pipe(
  Effect.map((output) => output.split("\n").flatMap((line): DirectoryRow[] => {
    const match = line.match(/^\s*([0-9.]+)\s+(.+)$/)
    if (!match || !existsSync(expandHome(match[2]!))) return []
    return [{ path: match[2]!, source: "zoxide", branch: "", frecency: Number(match[1]) || 0 }]
  })),
)

const parseWorktrees = (output: string): DirectoryRow[] => output.trim().split("\n\n").flatMap((block) => {
  let path = ""
  let branch = ""
  for (const line of block.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length)
    if (line === "detached") branch = "detached"
  }
  return path && existsSync(path) && !isSpareWorktreePath(path) ? [{ path, source: "worktree" as const, branch }] : []
})

const gitRecoveryCache = new Map<string, { checkedAt: number; activity?: ActivityRecord }>()
const gitRecoveryRefreshMs = 60_000
const collectGitRecoveryActivity = (path: string) => {
  const canonical = canonicalActivityPath(path)
  const cached = gitRecoveryCache.get(canonical)
  if (cached && Date.now() - cached.checkedAt < gitRecoveryRefreshMs) return Effect.succeed(cached.activity)
  return Effect.all([
    runCommand(["git", "-C", canonical, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true }),
    runCommand(["git", "-C", canonical, "reflog", "-1", "--format=%ct"], { allowFailure: true }),
    runCommand(["git", "-C", canonical, "log", "-1", "--format=%ct"], { allowFailure: true }),
  ], { concurrency: "unbounded" }).pipe(
    Effect.map(([status, reflog, commit]) => {
      let editedAt = 0
      if (status) {
        for (const file of gitStatusPaths(status)) {
          try { editedAt = Math.max(editedAt, statSync(resolve(canonical, file)).mtimeMs) }
          catch {
            try { editedAt = Math.max(editedAt, statSync(dirname(resolve(canonical, file))).mtimeMs) }
            catch {}
          }
        }
      }
      const activity = newestActivity(
        editedAt ? { path: canonical, source: "edited", updatedAt: editedAt } : undefined,
        Number(reflog.trim()) > 0 ? { path: canonical, source: "reflog", updatedAt: Number(reflog.trim()) * 1000 } : undefined,
        Number(commit.trim()) > 0 ? { path: canonical, source: "commit", updatedAt: Number(commit.trim()) * 1000 } : undefined,
      )
      gitRecoveryCache.set(canonical, { checkedAt: Date.now(), activity })
      return activity
    }),
  )
}

const devRoot = Bun.env.CLANKERHOUSE_DEV_ROOT ?? `${Bun.env.HOME ?? ""}/dev`
const collectDevWorktrees = existsSync(devRoot)
  ? runCommand(["fd", "--hidden", "--exclude", ".archive", "--type", "directory", "^\\.git$", devRoot], { allowFailure: true }).pipe(
      Effect.flatMap((output) => Effect.forEach(
        output.split("\n").filter(Boolean),
        (gitDir) => runCommand(["git", "-C", dirname(gitDir), "worktree", "list", "--porcelain"], { allowFailure: true }).pipe(
          Effect.map((worktrees) => ({ repositoryPath: dirname(gitDir), worktrees: parseWorktrees(worktrees) })),
        ),
        { concurrency: 8 },
      )),
      Effect.map(selectIndependentRepositoryWorktrees),
    )
  : Effect.succeed([] as DirectoryRow[])

const collectDirectoriesUncached = Effect.all([collectDevWorktrees, collectZoxideDirectories], { concurrency: "unbounded" }).pipe(
  Effect.flatMap(([worktrees, zoxide]) => {
    const durableActivities = readDirectoryActivities()
    const directories = new Map<string, DirectoryRow>()
    const durableDirectories: DirectoryRow[] = [...durableActivities.values()].flatMap((activity) => existsSync(activity.path) ? [{ path: activity.path, source: "activity", branch: "" }] : [])
    for (const row of [...worktrees, ...zoxide, ...durableDirectories]) {
      const path = canonicalActivityPath(row.path)
      const existing = directories.get(path)
      if (!existing) directories.set(path, { ...row, path })
      else if (row.frecency) directories.set(path, { ...existing, frecency: Math.max(existing.frecency ?? 0, row.frecency) })
    }
    return Effect.forEach(
      [...directories.values()],
      (row) => collectGitRecoveryActivity(row.path).pipe(Effect.map((fallback) => {
        const activity = newestActivity(durableActivities.get(canonicalActivityPath(row.path)), fallback)
        return { ...row, activityAt: activity?.updatedAt, activitySource: activity?.source }
      })),
      { concurrency: 4 },
    )
  }),
)

let directoryCache: { refreshedAt: number; rows: DirectoryRow[] } | undefined
/**
 * Directory discovery walks every dev repository, so its result is kept on disk and shared: a process reloads it
 * whenever another one (the runner's rediscovery, a CLI mutation) has written a newer copy.
 */
let directoryCacheMtime = 0
const loadDirectoryCache = () => {
  try {
    const mtime = statSync(directoryCachePath).mtimeMs
    if (directoryCache && mtime <= directoryCacheMtime) return
    const cached = JSON.parse(readFileSync(directoryCachePath, "utf8")) as { refreshedAt?: number; rows?: DirectoryRow[] }
    if (typeof cached.refreshedAt === "number" && Array.isArray(cached.rows)) directoryCache = { refreshedAt: cached.refreshedAt, rows: cached.rows }
    directoryCacheMtime = mtime
  } catch {}
}
const saveDirectoryCache = () => {
  if (!directoryCache || readOnly) return
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    const temporary = `${directoryCachePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(directoryCache), { mode: 0o600 })
    renameSync(temporary, directoryCachePath)
    directoryCacheMtime = statSync(directoryCachePath).mtimeMs
  } catch {}
}
let directoryRefreshInFlight: Promise<DirectoryRow[]> | undefined
/** A long-lived process rediscovers stale directories in the background; a one-shot snapshot serves what is cached. */
let staleDirectoriesRefresh = false
export const refreshStaleDirectories = (value: boolean) => { staleDirectoriesRefresh = value }
// Mutations patch the cached rows they affect; a full rediscovery walks every dev repository.
export const rememberDirectory = (row: DirectoryRow) => {
  const path = canonicalActivityPath(row.path)
  gitRecoveryCache.delete(path)
  gitMetaCache.delete(path)
  // The activity mark keeps the row through the next rediscovery, which also covers a process with no cache yet.
  if (!readOnly) markDirectoryActivity(path, row.activitySource === "opened" ? "opened" : "edited", row.activityAt ?? Date.now(), 0)
  loadDirectoryCache()
  if (!directoryCache) return
  directoryCache = { ...directoryCache, rows: [...directoryCache.rows.filter((candidate) => candidate.path !== path), { ...row, path }] }
  saveDirectoryCache()
}
export const forgetMissingDirectories = () => {
  loadDirectoryCache()
  if (!directoryCache) return
  const rows = directoryCache.rows.filter((row) => existsSync(row.path))
  if (rows.length === directoryCache.rows.length) return
  const present = new Set(rows.map((row) => row.path))
  for (const row of directoryCache.rows) {
    if (present.has(row.path)) continue
    gitRecoveryCache.delete(row.path)
    gitMetaCache.delete(row.path)
  }
  directoryCache = { ...directoryCache, rows }
  saveDirectoryCache()
}
export const refreshDirectoryCache = () => {
  if (!directoryRefreshInFlight) {
    directoryRefreshInFlight = Effect.runPromise(collectDirectoriesUncached)
      .then((rows) => {
        directoryCache = { refreshedAt: Date.now(), rows }
        saveDirectoryCache()
        return rows
      })
      .finally(() => { directoryRefreshInFlight = undefined })
  }
  return directoryRefreshInFlight
}
const collectDirectories = Effect.tryPromise({
  try: async () => {
    loadDirectoryCache()
    if (!directoryCache) return refreshDirectoryCache()
    if (Date.now() - directoryCache.refreshedAt >= directoryRefreshMs && !directoryRefreshInFlight && staleDirectoriesRefresh) {
      // Serve the stale rows now; the projection catches up when rediscovery lands.
      void refreshDirectoryCache().then(() => scheduleProjectionRefresh()).catch((error) => console.error(`Directory refresh failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    return directoryCache.rows
  },
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
})

const collectClankerReports = Effect.sync(() => {
  const reports: LifecycleObservation[] = []
  for (const directory of [previousClankerStateDir, clankerStateDir]) {
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue
      try {
        const report = parseClankerObservation(JSON.parse(readFileSync(`${directory}/${entry}`, "utf8")))
        if (report) reports.push(report)
        if (report?.clankerId && (report.turnStartedAt || report.transcriptPath)) turnFacts.set(report.clankerId, { turnStartedAt: report.turnStartedAt, transcriptPath: report.transcriptPath })
      } catch {}
    }
  }
  reports.push(...liveLifecycleReports.values())
  return selectCurrentLifecycleObservations(reports)
})

const gitMetaCache = new Map<string, { refreshedAt: number; value: { branch: string; flags: string } }>()
const gitMetaCachePath = `${runtimeDir}/git-meta.json`
let gitMetaCacheLoaded = false
/** Branch and dirty state per worktree, kept on disk by the runner so a fresh process reuses what is under a minute old. */
const loadGitMetaCache = () => {
  if (gitMetaCacheLoaded) return
  gitMetaCacheLoaded = true
  try {
    for (const [path, entry] of Object.entries(JSON.parse(readFileSync(gitMetaCachePath, "utf8")) as Record<string, { refreshedAt: number; value: { branch: string; flags: string } }>)) {
      if (!gitMetaCache.has(path) && typeof entry?.refreshedAt === "number") gitMetaCache.set(path, entry)
    }
  } catch {}
}
const saveGitMetaCache = () => {
  if (readOnly) return
  try {
    const temporary = `${gitMetaCachePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(gitMetaCache)), { mode: 0o600 })
    renameSync(temporary, gitMetaCachePath)
  } catch {}
}
const gitMeta = (path: string) => Effect.gen(function* () {
  if (!path) return { branch: "", flags: "" }
  const gitPath = expandHome(path)
  loadGitMetaCache()
  const cached = gitMetaCache.get(gitPath)
  if (cached && Date.now() - cached.refreshedAt < coldRefreshMs) return cached.value
  const branch = yield* runCommand(["git", "-C", gitPath, "branch", "--show-current"], { allowFailure: true }).pipe(Effect.map((out) => out.trim()))
  if (!branch) {
    const value = { branch: "", flags: "" }
    gitMetaCache.set(gitPath, { refreshedAt: Date.now(), value })
    return value
  }
  const dirty = yield* runCommand(["git", "-C", gitPath, "status", "--porcelain"], { allowFailure: true }).pipe(Effect.map((out) => out.trim().length > 0))
  const value = { branch, flags: dirty ? "dirty" : "clean" }
  gitMetaCache.set(gitPath, { refreshedAt: Date.now(), value })
  return value
})

const applyProjectEffect = (effect: ProjectEffect) => {
  markDirectoryActivity(effect.path, effect.source, effect.updatedAt, effect.minIntervalMs)
}

/** Clankers left running on another lane's server; read every 30 s, since it only changes when one is moved or ends. */
const collectSessions = Effect.all([
  collectMultiplexerResources,
  collectDirectories,
  collectClankerReports,
  collectProjectionEnrichment,
], { concurrency: "unbounded" }).pipe(
  Effect.flatMap(([multiplexer, directories, clankerReports, enrichment]) => {
    const { lineage } = enrichment
    const { managedResources } = multiplexer
    return Effect.forEach(multiplexer.sessions, (session) => gitMeta(session.path).pipe(Effect.map((meta) => [session.path, meta] as const)), { concurrency: 8 }).pipe(Effect.map((gitMetas) => {
      const projection = projectResources({
        sessions: multiplexer.sessions,
        windows: multiplexer.windows,
        directories,
        clankerReports,
        lineage,
        gitMetaByPath: new Map(gitMetas),
        managedResources,
        observedAt: Date.now(),
        instanceId: multiplexer.instanceId,
        multiplexerKind: multiplexer.kind,
        home: Bun.env.HOME,
      })
      if (!readOnly) for (const effect of projection.effects) applyProjectEffect(effect)
      saveGitMetaCache()
      if (multiplexer.serverEpoch) syncClankerLedger(multiplexer.serverEpoch, projection.sessions, multiplexer.windows)
      annotateNeedsMe(projection.sessions)
      return projection.sessions
    }))
  }),
)

/** The newest words of a finished Claude clanker, read again only when its transcript changes. */
const clankerLastText = (clankerId: string) => {
  const path = turnFacts.get(clankerId)?.transcriptPath
  if (!path) return null
  let key: string
  try { key = `${path}:${statSync(path).mtimeMs}` } catch { return null }
  const cached = lastTextCache.get(clankerId)
  if (cached?.key === key) return cached.text
  const text = lastClaudeTranscriptText(path)
  lastTextCache.set(clankerId, { key, text })
  return text
}

/** Decides, once per projection, which Workshops need the operator (src/needs-me.ts); a failed read only hides reasons. */
const annotateNeedsMe = (rows: SessionRow[]) => {
  let reports = new Map<string, ClankerReportRecord>()
  try { reports = new Map(withOrchestrationStore((store) => store.latestReports()).map((report) => [report.clankerId, report])) } catch {}
  const labelled = new Map<string, { value: string; at: number }>()
  try {
    for (const { key, value } of yourMoveLabels()) {
      for (const workshop of workshopsWithLabel(key, value)) {
        const known = labelled.get(workshop.workshopId)
        if (!known || workshop.labelledAt < known.at) labelled.set(workshop.workshopId, { value, at: workshop.labelledAt })
      }
    }
  } catch {}
  let labels = new Map<string, Record<string, string>>()
  try { labels = allWorkshopLabels() } catch {}
  const open = new Map<string, SessionRow>()
  for (const row of rows) if (row.workshopId && row.target.type === "session" && !open.has(row.workshopId)) open.set(row.workshopId, row)
  /** `waits-on` names a Workshop by ID, else by branch (its own project first). Settled is done, or gone. */
  const waitingOn = (workshopId: string) => {
    const named = labels.get(workshopId)?.[WAITS_ON_KEY]
    if (!named) return undefined
    const own = open.get(workshopId)
    const other = open.get(named) ?? [...open.values()].filter((row) => row.branch === named && row.workshopId !== workshopId)
      .toSorted((left, right) => Number(right.project === own?.project) - Number(left.project === own?.project))[0]
    if (!other?.workshopId || other.workshopId === workshopId || labels.get(other.workshopId)?.[DONE_LABEL.key] === DONE_LABEL.value) return undefined
    return other.title ?? other.name
  }
  const facts = {
    now: Date.now(),
    snooze: (workshopId: string) => parseSnooze(labels.get(workshopId)?.[SNOOZE_KEY]),
    waitingOn,
    latestReport: (clankerId: string) => reports.get(clankerId),
    turnStartedAt: (clankerId: string) => turnFacts.get(clankerId)?.turnStartedAt,
    lastText: clankerLastText,
    interrupted: (workshopId: string) => interruptedByWorkshop.get(workshopId) ?? [],
    yourMoveLabel: (workshopId: string) => labelled.get(workshopId),
    // The Reaper's retention; with reaping off, its default.
    staleAfterMs: doneTtlMs() ?? doneTtlMs({})!,
    readyAfterMs: READY_AFTER_MS,
  }
  for (const row of rows) {
    const reason = needsMe(row, facts)
    if (reason) row.needsMe = reason
  }
}

const readCachePayload = () => {
  try {
    return parseProjectionSnapshot<SessionRow>(JSON.parse(readFileSync(cachePath, "utf8")), cacheVersion)
  } catch {
    return undefined
  }
}

const writeCache = (sessions: SessionRow[]) => Effect.sync(() => {
  const semanticKey = JSON.stringify(sessions, function (key, value) {
    if (key === "age" || key === "observedAt" || key === "updatedAt" || key === "recency") return undefined
    return value
  })
  if (latestWrittenProjection && latestProjectionSemanticKey === semanticKey) return latestWrittenProjection
  if (readOnly) return advanceProjection(latestWrittenProjection, sessions, cacheVersion, projectionSource)
  mkdirSync(runtimeDir, { recursive: true })
  const tmpPath = `${cachePath}.${process.pid}.tmp`
  const payload = advanceProjection(latestWrittenProjection, sessions, cacheVersion, projectionSource)
  latestWrittenProjection = payload
  latestProjectionSemanticKey = semanticKey
  writeFileSync(tmpPath, JSON.stringify(payload))
  renameSync(tmpPath, cachePath)
  return payload
})

export const readCache = () => readCachePayload()?.sessions

/** One snapshot of Rex and the stores; concurrent calls share the computation in flight. */
export const refreshProjectionSnapshot = () => {
  if (!projectionRefreshInFlight) {
    projectionRefreshInFlight = Effect.runPromise(collectSessions.pipe(Effect.flatMap(writeCache)))
      .then((snapshot) => {
        for (const listener of snapshotListeners) listener(snapshot.sessions)
        return snapshot
      })
      .finally(() => { projectionRefreshInFlight = undefined })
  }
  return projectionRefreshInFlight
}

export const refreshProjectionAfterMutation = async () => {
  const previousRefresh = projectionRefreshInFlight
  if (previousRefresh) {
    try { await previousRefresh } catch {}
  }
  invalidateProjectionEnrichment()
  forgetMissingDirectories()
  return refreshProjectionSnapshot()
}

export const scheduleProjectionRefresh = () => {
  if (projectionRefreshScheduled) return
  projectionRefreshScheduled = true
  queueMicrotask(() => {
    projectionRefreshScheduled = false
    void refreshProjectionSnapshot()
      .catch((error) => console.error(`Lifecycle projection refresh failed: ${error instanceof Error ? error.message : String(error)}`))
  })
}


/** The herd as of the newest observation. */
export const latestHerdOf = () => latestHerd
/** The newest computed snapshot's rows. */
export const latestSnapshotRows = () => latestWrittenProjection?.sessions
export { cachePath, repositoryCachePath, runtimeDir, clankerStateDir }
const repositoryIdentityPlan = (rows: SessionRow[]) => {
  const paths = rows.flatMap((row) => {
    if (!row.path) return []
    const path = expandHome(row.path)
    return existsSync(path) ? [path] : []
  })
  const lineage = readLineageSnapshot()
  const lineageCommonDirs = new Map([...lineage.byPath].map(([path, workshop]) => [path, workshop.commonDir]))
  return planRepositoryIdentities(paths, lineageCommonDirs, readRepositoryIdentityCache(repositoryCachePath))
}

const repositoryRowsFromIdentities = (rows: SessionRow[], identities: ReadonlyMap<string, string>) => {
  const repositories = new Map<string, SessionRow>()
  for (const row of rows) {
    if (!row.path) continue
    const path = expandHome(row.path)
    const commonDir = identities.get(path)
    if (!commonDir) continue
    const repoPath = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir
    const existing = repositories.get(commonDir)
    if (existing && !["main", "master"].includes(row.branch)) continue
    const name = repoPath.split("/").filter(Boolean).at(-1) ?? repoPath
    const details: DetailRow[] = [{ kind: "repository", status: "", detail: "choose branch next", title: repoPath, age: "", state: "unknown", target: { type: "directory", path }, updatedAt: 0 }]
    repositories.set(commonDir, { ...row, name, path, target: { type: "directory", path }, details, markers: [], age: "", searchText: `${name} ${repoPath} ${path}`.toLowerCase() })
  }
  return [...repositories.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export const cachedRepositoryRows = (rows: SessionRow[]) => {
  const plan = repositoryIdentityPlan(rows)
  return repositoryRowsFromIdentities(rows, plan.identities)
}

export const refreshRepositoryRows = (rows: SessionRow[]) => Effect.gen(function* () {
  const plan = repositoryIdentityPlan(rows)
  if (plan.pathsToProbe.length > 0) {
    const checkedAt = Date.now()
    const resolved = yield* Effect.forEach(
      plan.pathsToProbe,
      (path) => runCommand(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFailure: true }).pipe(
        Effect.map((output) => [path, output.trim()] as const),
      ),
      { concurrency: 4 },
    )
    for (const [path, commonDir] of resolved) {
      plan.entries[path] = { commonDir, checkedAt }
      if (commonDir) plan.identities.set(path, commonDir)
      else plan.identities.delete(path)
    }
  }
  yield* Effect.sync(() => writeRepositoryIdentityCache(repositoryCachePath, plan.entries))
  return repositoryRowsFromIdentities(rows, plan.identities)
})

export const dumpState = collectSessions.pipe(
  Effect.flatMap((sessions) => Effect.sync(() => {
    console.log(JSON.stringify(sessions.map((session) => ({
      name: session.name,
      resourceId: session.resourceId,
      management: session.management,
      location: session.target.type === "session" ? session.target.location : undefined,
      path: session.path,
      state: sessionState(session),
      recency: session.recency,
      age: session.age,
      activitySource: session.activitySource,
      branch: session.branch,
      flags: session.flags,
      markers: session.markers,
      workshopId: session.workshopId,
      parentWorkshopId: session.parentWorkshopId,
      childWorkshopCount: session.childWorkshopCount,
      labels: session.labels,
      title: session.title,
      project: session.project,
      lineageLabel: session.lineageLabel,
      clankers: session.details
        .filter((detail) => detail.kind === "clanker")
        .map((detail) => ({ harness: detail.harness, state: detail.state, status: detail.status, detail: detail.detail, title: detail.title, terminalId: detail.terminalId, clankerId: detail.clankerId, location: detail.target.type !== "directory" ? detail.target.location : undefined })),
      elsewhere: session.details
        .filter((detail) => detail.kind === "elsewhere")
        .map((detail) => ({ harness: detail.harness, status: detail.status, detail: detail.detail, title: detail.title })),
      observations: session.details
        .filter((detail) => detail.kind === "observation")
        .map((detail) => ({ harness: detail.harness, status: detail.status, detail: detail.detail, title: detail.title, terminalId: detail.terminalId, observation: detail.observation, location: detail.target.type !== "directory" ? detail.target.location : undefined })),
    })), null, 2))
  })),
)

export const dumpCachedState = Effect.sync(() => {
  console.log(JSON.stringify(readCache() ?? [], null, 2))
})


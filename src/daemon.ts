import { Effect, Exit } from "effect"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { canonicalActivityPath, gitStatusPaths, markDirectoryActivity, newestActivity, readDirectoryActivities } from "./activity"
import type { ActivityRecord } from "./activity"
import { listClankers } from "./clanker-api"
import { readResourceIncidents } from "./incidents"
import { applicationRoot, binPath, libexecPath } from "./installation"
import { attachWorkshopToParent, attachmentCandidatesForWorkshop, detachWorkshopFromParent, readLineageSnapshot, spliceDeletedWorkshopFromLineage, workshopDetails, workshopForId, workshopStatePath } from "./workshop"
import { sessionState } from "./model"
import type { DetailRow, SessionRow } from "./model"
import { advanceProjection, parseProjectionSnapshot } from "./projection"
import type { ProjectionSnapshot } from "./projection"
import { planRepositoryIdentities, readRepositoryIdentityCache, writeRepositoryIdentityCache } from "./repository-cache"
import { openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import { instanceSlug, runtimeDirFor, stateHomeDefault } from "./paths"
import { paneLocation, sessionLocation } from "./multiplexer/interface"
import { openResourceRegistry, resourceRegistryStatePath } from "./resource-registry"
import { openDurableRegistry, type DurableRegistry } from "./registry"
import { openRecoveryStore, recoveryStatePath } from "./recovery/store"
import { reconcileRecovery, RecoveryController } from "./recovery/controller"
import { stopOwnedHarness } from "./recovery/process-owner"
import { createStagedMutationExecutor } from "./daemon-mutations"
import type { MutationExecution, MutationExecutor } from "./transport/operations"
import { createProcessDiscoveryProvider } from "./server/process-discovery"
import type { ForegroundAgentDiscovery, ForegroundAgentHarness } from "./server/process-discovery"
import { collectOpenCodeService, invalidateOpenCodeServiceState } from "./server/opencode"
import { parseClankerObservation, selectCurrentLifecycleObservations } from "./server/observations"
import type { LifecycleObservation } from "./server/observations"
import { isCodexWindow, projectResources } from "./server/project"
import type { ProjectEffect } from "./server/project"
import type { DirectoryRow, TmuxSession, TmuxWindow } from "./server/resources"
import { acquireProducerLease, startSnapshotServer } from "./transport"
import type { MutationIntent, ProducerLease, SnapshotServer } from "./transport"

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
const seenStateDir = `${runtimeDir}/seen-state`
const refreshMs = Number(Bun.env.CLANKERHOUSE_REFRESH_MS ?? 15_000) || 15_000
const coldRefreshMs = Number(Bun.env.CLANKERHOUSE_COLD_REFRESH_MS ?? 60_000) || 60_000
const directoryRefreshMs = Number(Bun.env.CLANKERHOUSE_DIRECTORY_REFRESH_MS ?? 10 * 60_000) || 10 * 60_000
const cacheVersion = 10
let projectionSource: string = randomUUID()
let producerLease: ProducerLease | undefined
let latestWrittenProjection: ProjectionSnapshot<SessionRow> | undefined
let latestProjectionSemanticKey = ""
let projectionRefreshInFlight: Promise<ProjectionSnapshot<SessionRow>> | undefined
let snapshotServer: SnapshotServer<SessionRow> | undefined
let durableRegistry: DurableRegistry | undefined
let recoveryController: RecoveryController | undefined
const liveLifecycleReports = new Map<string, LifecycleObservation>()
const lifecycleSequences = new Map<string, number>()
let projectionRefreshScheduled = false
let projectionEnrichmentCache: { refreshedAt: number; lineage: ReturnType<typeof readLineageSnapshot>; incidents: ReturnType<typeof readResourceIncidents>; managedResources: ReturnType<typeof readManagedResources> } | undefined
const invalidateProjectionEnrichment = () => { projectionEnrichmentCache = undefined }
const snapshotTransportEnabled = Bun.env.CLANKERHOUSE_SUBSCRIBE !== "0"
const ensurePrivateRuntimeDirectory = () => {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(runtimeDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe Clankerhouse runtime directory: ${runtimeDir}`)
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Clankerhouse runtime directory is not owned by the current user: ${runtimeDir}`)
  chmodSync(runtimeDir, 0o700)
}
const runCommand = (cmd: string[], options: { cwd?: string; allowFailure?: boolean } = {}) =>
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
const expandHome = (path: string) => path === "~" ? Bun.env.HOME ?? path : path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path
let daemonMultiplexerInstance: ManagedMultiplexer | undefined
/** The daemon's Multiplexer Adapter, selected once per process (tmux unless CLANKERHOUSE_MULTIPLEXER says otherwise). */
const daemonMultiplexer = () => (daemonMultiplexerInstance ??= openManagedMultiplexer())

const collectMultiplexerResources = Effect.tryPromise({
  try: async () => {
    const multiplexer = daemonMultiplexer()
    let snapshot = await multiplexer.observe()
    if (await multiplexer.reconcileAbsorbedTopology(snapshot)) {
      invalidateProjectionEnrichment()
      snapshot = await multiplexer.observe()
    }
    const sessions: TmuxSession[] = snapshot.sessions.map((session) => ({
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
    const windows: TmuxWindow[] = snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.map((pane) => ({
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
      recoveryAttemptId: pane.recoveryAttemptId,
      agentStatus: pane.agentStatus,
    }))))
    return { kind: snapshot.kind, instanceId: snapshot.instanceId, sessions, windows }
  },
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
})

const readManagedResources = () => {
  const registry = openResourceRegistry()
  try { return new Map(registry.list().map((resource) => [resource.id, resource])) }
  finally { registry.close() }
}

const collectProjectionEnrichment = Effect.sync(() => {
  if (projectionEnrichmentCache && Date.now() - projectionEnrichmentCache.refreshedAt < coldRefreshMs) return projectionEnrichmentCache
  projectionEnrichmentCache = {
    refreshedAt: Date.now(),
    lineage: readLineageSnapshot(),
    incidents: readResourceIncidents(),
    managedResources: readManagedResources(),
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
  return path && existsSync(path) ? [{ path, source: "worktree" as const, branch }] : []
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
        (gitDir) => runCommand(["git", "-C", dirname(gitDir), "worktree", "list", "--porcelain"], { allowFailure: true }),
        { concurrency: 8 },
      )),
      Effect.map((outputs) => outputs.flatMap(parseWorktrees)),
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
let directoryRefreshInFlight: Promise<DirectoryRow[]> | undefined
const invalidateDirectoryCache = () => {
  directoryCache = undefined
  gitRecoveryCache.clear()
  gitMetaCache.clear()
}
const collectDirectories = Effect.tryPromise({
  try: async () => {
    if (directoryCache && Date.now() - directoryCache.refreshedAt < directoryRefreshMs) return directoryCache.rows
    if (!directoryRefreshInFlight) {
      directoryRefreshInFlight = Effect.runPromise(collectDirectoriesUncached)
        .then((rows) => {
          directoryCache = { refreshedAt: Date.now(), rows }
          return rows
        })
        .finally(() => { directoryRefreshInFlight = undefined })
    }
    return directoryRefreshInFlight
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
      } catch {}
    }
  }
  reports.push(...liveLifecycleReports.values())
  return selectCurrentLifecycleObservations(reports)
})

const readSeenState = () => {
  const seen = new Map<string, number>()
  if (!existsSync(seenStateDir)) return seen
  for (const entry of readdirSync(seenStateDir)) {
    if (!entry.endsWith(".json")) continue
    try {
      const record = JSON.parse(readFileSync(`${seenStateDir}/${entry}`, "utf8")) as { key?: string; seenAt?: number }
      if (record.key) seen.set(record.key, Number(record.seenAt ?? 0) || 0)
    } catch {}
  }
  return seen
}

const markSeen = (key: string, seenAt = Date.now()) => {
  mkdirSync(seenStateDir, { recursive: true })
  const target = `${seenStateDir}/${encodeURIComponent(key)}.json`
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ key, seenAt }))
  renameSync(tmp, target)
}

const gitMetaCache = new Map<string, { refreshedAt: number; value: { branch: string; flags: string } }>()
const gitMeta = (path: string) => Effect.gen(function* () {
  if (!path) return { branch: "", flags: "" }
  const gitPath = expandHome(path)
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
  if (effect.type === "markSeen") {
    markSeen(effect.key, effect.seenAt)
    return
  }
  markDirectoryActivity(effect.path, effect.source, effect.updatedAt, effect.minIntervalMs)
}

const collectSessions = Effect.all([
  collectMultiplexerResources,
  collectDirectories,
  collectClankerReports,
  Effect.sync(readSeenState),
  collectProjectionEnrichment,
], { concurrency: "unbounded" }).pipe(
  Effect.flatMap(([multiplexer, directories, clankerReports, seen, enrichment]) => {
    const { lineage, incidents, managedResources } = enrichment
    const processDiscovery = createProcessDiscoveryProvider()
    return Effect.all([
      Effect.succeed(multiplexer),
      Effect.forEach(multiplexer.sessions, (session) => gitMeta(session.path).pipe(Effect.map((meta) => [session.path, meta] as const)), { concurrency: 8 }),
      Effect.forEach(
        multiplexer.windows,
        (window): Effect.Effect<readonly [string, ForegroundAgentDiscovery | undefined, ForegroundAgentHarness | undefined], Error> => {
          const discovery = processDiscovery.discover(Number(window.pid))
          if (discovery) return Effect.succeed([window.pane, discovery, discovery.harness] as const)
          if (isCodexWindow(window)) return Effect.succeed([window.pane, undefined, "codex"] as const)
          return Effect.succeed([window.pane, undefined, undefined] as const)
        },
        { concurrency: 8 },
      ),
    ], { concurrency: "unbounded" }).pipe(Effect.flatMap(([resources, gitMetas, harnessDetections]) => {
      const detectedHarnessByPane = new Map<string, ForegroundAgentHarness>()
      const discoveriesByPane = new Map<string, ForegroundAgentDiscovery>()
      for (const [pane, discovery, harness] of harnessDetections) {
        if (discovery) discoveriesByPane.set(pane, discovery)
        if (harness) detectedHarnessByPane.set(pane, harness)
      }
      return Effect.promise(() => collectOpenCodeService(resources.windows, discoveriesByPane)).pipe(Effect.map((opencodes) => {
        const projection = projectResources({
          sessions: resources.sessions,
          windows: resources.windows,
          opencodes,
          directories,
          clankerReports,
          seen,
          lineage,
          incidents,
          gitMetaByPath: new Map(gitMetas),
          detectedHarnessByPane,
          codexPanes: new Set([...detectedHarnessByPane].flatMap(([pane, harness]) => harness === "codex" ? [pane] : [])),
          managedResources,
          observedAt: Date.now(),
          tmuxServerKey: resources.instanceId,
          multiplexerKind: resources.kind,
          home: Bun.env.HOME,
        })
        for (const effect of projection.effects) applyProjectEffect(effect)
        return projection.sessions
      }))
    }))
  }),
)

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
  mkdirSync(runtimeDir, { recursive: true })
  const tmpPath = `${cachePath}.${process.pid}.tmp`
  const payload = advanceProjection(latestWrittenProjection, sessions, cacheVersion, projectionSource)
  latestWrittenProjection = payload
  latestProjectionSemanticKey = semanticKey
  writeFileSync(tmpPath, JSON.stringify(payload))
  renameSync(tmpPath, cachePath)
  return payload
})

const readCache = () => readCachePayload()?.sessions

const refreshProjectionSnapshot = () => {
  if (!projectionRefreshInFlight) {
    projectionRefreshInFlight = Effect.runPromise(collectSessions.pipe(Effect.flatMap(writeCache)))
      .finally(() => { projectionRefreshInFlight = undefined })
  }
  return projectionRefreshInFlight
}

const refreshProjectionAfterMutation = async () => {
  const previousRefresh = projectionRefreshInFlight
  if (previousRefresh) {
    try { await previousRefresh } catch {}
  }
  invalidateProjectionEnrichment()
  invalidateDirectoryCache()
  return refreshProjectionSnapshot()
}

const scheduleProjectionRefresh = () => {
  if (projectionRefreshScheduled) return
  projectionRefreshScheduled = true
  queueMicrotask(() => {
    projectionRefreshScheduled = false
    void refreshProjectionSnapshot()
      .then((snapshot) => snapshotServer?.publish(snapshot))
      .catch((error) => console.error(`Lifecycle projection refresh failed: ${error instanceof Error ? error.message : String(error)}`))
  })
}

const ingestLifecycleObservation = (report: import("./transport").ObservationReport) => {
  const sequenceKey = `${report.source}\0${report.pane}`
  const previousSequence = lifecycleSequences.get(sequenceKey)
  if (previousSequence !== undefined && report.seq <= previousSequence) return false
  lifecycleSequences.set(sequenceKey, report.seq)
  const parsed = parseClankerObservation(report)
  if (!parsed) return false
  const previous = liveLifecycleReports.get(parsed.pane)
  liveLifecycleReports.set(parsed.pane, parsed)
  if (parsed.harness === "opencode") invalidateOpenCodeServiceState()

  mkdirSync(clankerStateDir, { recursive: true, mode: 0o700 })
  const target = `${clankerStateDir}/${report.pane.replace(/[^A-Za-z0-9_.%-]/g, "_")}.json`
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 })
  renameSync(temporary, target)

  const changed = !previous
    || previous.state !== parsed.state
    || previous.harnessSessionId !== parsed.harnessSessionId
    || previous.clankerId !== parsed.clankerId
    || previous.recoveryAttemptId !== parsed.recoveryAttemptId
  if (changed) scheduleProjectionRefresh()
  return true
}

const serverProgram = Effect.gen(function* () {
  let transportUnavailable = !snapshotTransportEnabled
  const cleanup = () => {
    try {
      if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath)
    } catch {}
  }
  const shutdown = () => {
    cleanup()
    recoveryController?.stop()
    const closing = snapshotServer?.close() ?? Promise.resolve()
    snapshotServer = undefined
    void closing.finally(() => producerLease?.release()).finally(() => durableRegistry?.close()).finally(() => process.exit(0))
  }

  yield* Effect.sync(() => {
    ensurePrivateRuntimeDirectory()
    writeFileSync(pidPath, `${process.pid}\n`)
    writeFileSync(versionPath, `${cacheVersion}\n`)
    process.once("exit", cleanup)
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
  durableRegistry = yield* Effect.try({
    try: () => {
      const registry = openDurableRegistry()
      try {
        const stateHome = stateHomeDefault()
        registry.importLegacy({
          workshops: workshopStatePath,
          altKLineage: `${stateHome}/alt-k-tui${instanceSlug()}/workspaces.sqlite3`,
          resources: resourceRegistryStatePath(stateHome),
          recovery: recoveryStatePath(stateHome),
        }, { oncePerSource: true })
        const validation = registry.validate()
        if (validation.foreignKeyViolations.length || validation.semanticViolations.length) throw new Error(`Unified registry validation failed: ${[...validation.semanticViolations, ...validation.foreignKeyViolations.map(String)].join(", ")}`)
        // Compatibility gate: legacy stores remain mutable until every ingress is a socket client,
        // so imported domain rows are not preferred while operations already use this registry.
        registry.setMetadata("compatibility.authority", { domain: "legacy-mutable", operations: "registry" })
        return registry
      } catch (error) {
        registry.close()
        throw error
      }
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
  producerLease = yield* Effect.tryPromise({
    try: async () => acquireProducerLease(`${runtimeDir}/producer.lease`, daemonMultiplexer().kind === "tmux" ? `${process.env.TMUX?.split(",")[0] || "default-tmux"}` : await daemonMultiplexer().instanceId()),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
  projectionSource = producerLease.epoch
  // The authoritative daemon also owns Recovery reconciliation. A legacy
  // recovery process may remain during the compatibility window; the durable
  // global Recovery lease guarantees that only one controller can act.
  recoveryController = new RecoveryController(undefined, undefined, daemonMultiplexer())
  void recoveryController.run().catch((error) => {
    console.error(`Recovery controller stopped: ${error instanceof Error ? error.message : String(error)}`)
  }).finally(() => recoveryController?.close())
  if (daemonMultiplexer().capabilities().nativeChanges) {
    // Runtimes with a native Change Stream drive refreshes by event; polled runtimes rely on the refresh loop below.
    const changeSignal = new AbortController()
    void (async () => {
      try {
        for await (const change of daemonMultiplexer().changes(changeSignal.signal)) {
          if (change.kind === "reconnect") invalidateProjectionEnrichment()
          scheduleProjectionRefresh()
        }
      } catch (error) {
        console.error(`Multiplexer change stream stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  while (true) {
    const snapshot = yield* Effect.tryPromise({
      try: refreshProjectionSnapshot,
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    }).pipe(
      Effect.catchAll((error) => Effect.sync(() => {
        console.error(error.message)
        return undefined
      })),
    )
    if (snapshot) {
      if (snapshotServer) snapshotServer.publish(snapshot)
      else if (!transportUnavailable) {
        const started = yield* Effect.tryPromise({
          try: () => startSnapshotServer({
            socketPath: daemonSocketPath,
            initialSnapshot: snapshot,
            epoch: producerLease!.epoch,
            owner: producerLease!.owner,
            assertAuthoritative: () => producerLease!.assertCurrentSync(),
            refresh: refreshProjectionSnapshot,
            reportObservation: ingestLifecycleObservation,
            executeMutation: executeDaemonMutation,
            operationRegistry: durableRegistry!,
          }),
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }).pipe(
          Effect.map((server) => ({ server })),
          Effect.catchAll((error) => Effect.succeed({ error })),
        )
        if ("server" in started) snapshotServer = started.server
        else {
          transportUnavailable = true
          console.error(`Daemon socket transport disabled: ${started.error.message}`)
        }
      }
    }
    yield* Effect.promise(() => sleep(refreshMs))
  }
})

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

const cachedRepositoryRows = (rows: SessionRow[]) => {
  const plan = repositoryIdentityPlan(rows)
  return repositoryRowsFromIdentities(rows, plan.identities)
}

const refreshRepositoryRows = (rows: SessionRow[]) => Effect.gen(function* () {
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

const dumpState = collectSessions.pipe(
  Effect.flatMap((sessions) => Effect.sync(() => {
    console.log(JSON.stringify(sessions.map((session) => ({
      name: session.name,
      resourceId: session.resourceId,
      management: session.management,
      location: session.target.type === "tmux_session" ? session.target.location : undefined,
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
      lineageLabel: session.lineageLabel,
      clankers: session.details
        .filter((detail) => detail.kind === "clanker")
        .map((detail) => ({ harness: detail.harness, state: detail.state, status: detail.status, detail: detail.detail, title: detail.title, terminalId: detail.terminalId, clankerId: detail.clankerId, location: detail.target.type !== "directory" ? detail.target.location : undefined })),
      observations: session.details
        .filter((detail) => detail.kind === "observation")
        .map((detail) => ({ harness: detail.harness, status: detail.status, detail: detail.detail, title: detail.title, terminalId: detail.terminalId, observation: detail.observation, location: detail.target.type !== "directory" ? detail.target.location : undefined })),
    })), null, 2))
  })),
)

const dumpCachedState = Effect.sync(() => {
  console.log(JSON.stringify(readCache() ?? [], null, 2))
})

const isLinkedWorktreeSync = (path: string) => {
  if (!path || !existsSync(expandHome(path))) return false
  const result = Bun.spawnSync(["git", "-C", expandHome(path), "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" })
  if (result.exitCode !== 0) return false
  const [gitDir, commonDir] = result.stdout.toString().trim().split("\n")
  return Boolean(gitDir && commonDir && gitDir !== commonDir)
}

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
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...Bun.env, CLANKERHOUSE_MULTIPLEXER: daemonMultiplexer().kind, CLANKERHOUSE_PROGRESS: "1", CLANKERHOUSE_DAEMON_INTERNAL: "1" } })
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
  const args = ["wt", "-C", repository, "switch", ...(create ? ["--create"] : []), switchRef, "--no-cd", "--format", "json", ...(create && base ? ["--base", base] : [])]
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
  const created = Bun.spawnSync([binPath("clankers"), "workshop", "ensure", "--cwd", path], { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, CLANKERHOUSE_MULTIPLEXER: daemonMultiplexer().kind, CLANKERHOUSE_DAEMON_INTERNAL: "1" } })
  if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || `session creation exited ${created.exitCode}`)
  const session = created.stdout.toString().trim()
  if (!session) throw new Error("Session creation did not return a session name")
  return session
}

const reconcileMutationStage = async (intent: MutationIntent, stage: string, execution: MutationExecution) => {
  const checkpoint = mutationCheckpoint(execution)
  if (stage === "projection.refreshed") {
    const refreshed = await refreshProjectionAfterMutation()
    snapshotServer?.publish(refreshed)
    return { checkpoint, result: checkpoint.outcome ?? checkpoint }
  }
  if (intent.type === "repository.refresh") {
    const rows = latestWrittenProjection?.sessions ?? []
    if (stage === "repository-cache.checked") {
      const current = existsSync(repositoryCachePath) && statSync(repositoryCachePath).mtimeMs >= execution.operation.createdAt
      return { checkpoint: { ...checkpoint, cacheCurrent: current } }
    }
    const repositories = checkpoint.cacheCurrent ? cachedRepositoryRows(rows) : await Effect.runPromise(refreshRepositoryRows(rows))
    return { checkpoint: { ...checkpoint, cacheCurrent: true }, result: { repositories } }
  }

  if (intent.type === "open" || intent.type === "absorb") {
    const multiplexer = daemonMultiplexer()
    const requestingClient = intent.type === "open" ? intent.client : undefined
    if (stage === "identity.validated") {
      if (intent.target.type === "directory") {
        const path = realpathSync(expandHome(intent.target.path))
        return { checkpoint: { ...checkpoint, path } }
      }
      if (intent.type === "absorb" && !intent.target.location) throw new Error("Absorption requires an exact Multiplexer Location")
      const target = intent.target
      if (requestingClient && !await multiplexer.currentLocation(requestingClient)) throw new Error("Requesting multiplexer client no longer exists")
      const snapshot = await multiplexer.observe()
      const session = target.location
        ? snapshot.sessions.find((candidate) => candidate.id === target.location!.nativeSessionId && snapshot.instanceId === target.location!.instanceId)
        : snapshot.sessions.find((candidate) => candidate.nativeName === target.session)
      if (!session) throw new Error("Selected Multiplexer target no longer exists")
      const location = target.location ?? { kind: snapshot.kind, instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: target.type === "tmux_window" ? target.windowId : null, nativePaneId: target.type === "tmux_window" || target.type === "opencode" ? target.pane : null }
      return { checkpoint: { ...checkpoint, location } }
    }
    if (stage === "topology.absorbed") {
      const location = checkpoint.location as NonNullable<Exclude<typeof intent.target, { type: "directory" }>["location"]>
      const registry = openResourceRegistry()
      try {
        const existing = registry.findByNativeLocation({ kind: location.kind, instanceId: location.instanceId, nativeSessionId: location.nativeSessionId })
        const snapshot = await multiplexer.observe()
        const session = snapshot.sessions.find((candidate) => candidate.id === location.nativeSessionId)
        const claimsComplete = existing && session?.resourceId === existing.id && session.windows.every((window) => {
          if (!window.resourceId) return false
          const windowRecord = registry.get(window.resourceId)
          if (windowRecord?.kind !== "window" || windowRecord.parentId !== existing.id || windowRecord.location?.nativeWindowId !== window.id) return false
          return window.panes.every((pane) => {
            if (!pane.terminalId) return false
            const terminal = registry.get(pane.terminalId)
            return terminal?.kind === "terminal" && terminal.parentId === windowRecord.id && terminal.location?.nativePaneId === pane.id
          })
        })
        if (!claimsComplete) await multiplexer.absorb(location)
      } finally { registry.close() }
      return { checkpoint: { ...checkpoint, outcome: { absorbed: true } } }
    }
    if (stage === "target.opened") {
      const location = checkpoint.location as { nativeSessionId?: string; nativeWindowId?: string | null; nativePaneId?: string | null } | undefined
      const current = await multiplexer.currentLocation(requestingClient)
      const alreadyOpen = location && current?.nativeSessionId === location.nativeSessionId
        && (!location.nativeWindowId || current?.nativeWindowId === location.nativeWindowId)
        && (!location.nativePaneId || current?.nativePaneId === location.nativePaneId)
      if (!alreadyOpen) {
        const command = await runDeleteCommand([binPath("clankers"), "target", "open", "--json", JSON.stringify(intent.target), ...(requestingClient ? ["--client", requestingClient] : [])])
        if (command.exitCode !== 0) throw new Error(command.stderr.trim() || command.stdout.trim() || "Unable to open target")
      }
      const openedLocation = checkpoint.location as { instanceId?: string; nativeSessionId?: string; nativeWindowId?: string | null; nativePaneId?: string | null } | undefined
      const completionKey = latestWrittenProjection?.sessions
        .flatMap((session) => session.details)
        .find((detail) => {
          const candidate = "location" in detail.target ? detail.target.location : undefined
          return candidate && openedLocation
            && candidate.instanceId === openedLocation.instanceId
            && candidate.nativeSessionId === openedLocation.nativeSessionId
            && (!openedLocation.nativeWindowId || candidate.nativeWindowId === openedLocation.nativeWindowId)
            && (!openedLocation.nativePaneId || candidate.nativePaneId === openedLocation.nativePaneId)
        })?.completionKey
      if (completionKey) markSeen(completionKey)
      return { checkpoint: { ...checkpoint, outcome: { opened: true } }, result: { opened: true } }
    }
  }

  if (intent.type === "rename") {
    if (stage === "identity.validated") {
      let row = await exactSession({ session: intent.session }) ?? await exactSession({ session: intent.displayName })
      if (!row) throw new Error("Selected session no longer exists")
      if (intent.resourceId) {
        const registry = openResourceRegistry()
        try {
          const resource = registry.get(intent.resourceId)
          if (!resource || resource.kind !== "session" || resource.location?.nativeSessionId !== row[0]) throw new Error("Managed session identity no longer matches its exact Multiplexer Location")
        } finally { registry.close() }
      }
      return { checkpoint: { ...checkpoint, nativeSessionId: row[0] } }
    }
    const nativeSessionId = String(checkpoint.nativeSessionId)
    if (stage === "tmux.renamed") {
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
        const registry = openResourceRegistry()
        try {
          const resource = registry.get(intent.resourceId)
          if (!resource || resource.location?.nativeSessionId !== nativeSessionId) throw new Error("Managed session identity changed before Display Name persistence")
          if (resource.displayName !== intent.displayName) registry.updateDisplayName(intent.resourceId, intent.displayName)
        } finally { registry.close() }
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
    if (stage === "tmux-parent.updated") {
      if (checkpoint.nativeSessionId) await applyExactWorkshopParent(String(checkpoint.nativeSessionId), intent.workshopId, parentWorkshopId)
      const outcome = parentWorkshopId ? { attached: true } : { detached: true }
      return { checkpoint: { ...checkpoint, outcome } }
    }
  }

  if (intent.type === "delete") {
    if (stage === "identity.validated") {
      if (intent.kind === "worktree") {
        if (!intent.path || !isLinkedWorktreeSync(intent.path)) throw new Error("Selected path is not a linked worktree")
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
    if (stage === "tmux.marked") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (await exactSession({ nativeSessionId })) {
        const ids = await sessionClankerIds(nativeSessionId)
        const recovery = openRecoveryStore()
        let allStopped = false
        try { allStopped = ids.every((id) => recovery.getDesired(id)?.desiredState === "stopped") } finally { recovery.close() }
        if (!allStopped) {
          const marked = await runDeleteCommand([binPath("clankerhouse-tmux-stop"), "mark-session", nativeSessionId])
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
    if (stage === "tmux-children.updated") {
      const parentWorkshopId = typeof checkpoint.deletedParentWorkshopId === "string" ? checkpoint.deletedParentWorkshopId : null
      const childWorkshopIds = Array.isArray(checkpoint.deletedChildren) ? checkpoint.deletedChildren.flatMap((value) => value && typeof value === "object" && typeof (value as { workshopId?: unknown }).workshopId === "string" ? [(value as { workshopId: string }).workshopId] : []) : []
      const rows = (await multiplexerSessionRows()).rows
      for (const childWorkshopId of childWorkshopIds) {
        for (const row of rows.filter((candidate) => candidate[2] === childWorkshopId)) await applyExactWorkshopParent(row[0]!, childWorkshopId, parentWorkshopId)
      }
      return { checkpoint }
    }
    if (stage === "tmux.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (await exactSession({ nativeSessionId })) await daemonMultiplexer().kill(sessionLocation(nativeSessionId))
      return { checkpoint: { ...checkpoint, outcome: { deleted: true } } }
    }
    if (stage === "target.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      const exists = intent.kind === "pane" ? await exactPaneExists(nativeSessionId, String(checkpoint.pane)) : Boolean(await exactSession({ nativeSessionId }))
      if (exists) {
        const command = intent.kind === "pane"
          ? await runDeleteCommand([binPath("clankerhouse-tmux-stop"), "pane", String(checkpoint.pane)])
          : await runDeleteCommand([binPath("clankerhouse-tmux-stop"), "session", nativeSessionId])
        if (command.exitCode !== 0) throw new Error(command.stderr.trim() || command.stdout.trim() || "Deletion failed")
      }
      return { checkpoint: { ...checkpoint, outcome: { deleted: true } } }
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
        if (fetched.exitCode !== 0) throw new Error(fetched.stderr.toString().trim() || "Unable to refresh remote branches")
        const verified = Bun.spawnSync(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/remotes/${intent.remoteRef}`], { stdout: "ignore", stderr: "ignore" })
        if (verified.exitCode !== 0) throw new Error(`Remote branch ${intent.remoteRef} no longer exists`)
        const local = Bun.spawnSync(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${intent.branch}`], { stdout: "ignore", stderr: "ignore" })
        if (local.exitCode === 0) throw new Error(`Local branch ${intent.branch} appeared after remote selection`)
      }
      const path = createWorktreeSync(repository, intent.branch, intent.create, intent.base, intent.remoteRef)
      return { checkpoint: { ...checkpoint, path } }
    }
    if (stage === "tmux.ready") {
      const path = realpathSync(String(checkpoint.path))
      const session = await ensureWorktreeSession(path)
      return { checkpoint: { ...checkpoint, session, outcome: { target: { type: "tmux_session", session } } } }
    }
  }

  if (intent.type === "start" || intent.type === "stop" || intent.type === "recovery") {
    const store = openRecoveryStore()
    try {
      if (stage === "identity.validated") {
        if (!store.getDesired(intent.clankerId)) throw new Error(`Unknown Clanker ${intent.clankerId}`)
        return { checkpoint }
      }
      const action = intent.type === "start" ? "resume" : intent.type === "stop" ? "stop" : intent.action
      if (stage === "desired-state.updated") {
        const state = action === "resume" || action === "reconcile" ? "running" : action === "suspend" ? "suspended_resource_pressure" : action === "tombstone" ? "tombstoned" : "stopped"
        const desired = store.getDesired(intent.clankerId)!
        if (desired.desiredState !== state) store.setDesiredState(intent.clankerId, state, { reason: intent.type === "stop" ? intent.reason || "daemon-stop" : intent.type === "recovery" ? intent.reason || intent.action : "daemon-start" })
        return { checkpoint }
      }
      if (stage === "harness.stopped") {
        const desired = store.getDesired(intent.clankerId)!
        const matches = (await listClankers()).filter((row) => row.id === intent.clankerId)
        if (matches.length > 1) throw new Error(`Ambiguous live panes for ${intent.clankerId}`)
        if (desired.ownerUnit) {
          const active = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", desired.ownerUnit], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
          if (active) stopOwnedHarness(desired.ownerUnit)
        }
        if (matches.length) await daemonMultiplexer().kill(paneLocation(matches[0]!.sessionId, matches[0]!.window, matches[0]!.pane))
        return { checkpoint: { ...checkpoint, outcome: { stopped: true } } }
      }
      if (stage === "recovery.reconciled") {
        const shouldLaunch = action === "resume" || action === "reconcile"
        if (!shouldLaunch) {
          const desired = store.getDesired(intent.clankerId)!
          if (desired.ownerUnit) {
            const active = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", desired.ownerUnit], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
            if (active) stopOwnedHarness(desired.ownerUnit)
          }
          const matches = (await listClankers()).filter((row) => row.id === intent.clankerId)
          if (matches.length > 1) throw new Error(`Ambiguous live panes for ${intent.clankerId}`)
          if (matches.length === 1) await daemonMultiplexer().kill(paneLocation(matches[0]!.sessionId, matches[0]!.window, matches[0]!.pane))
        }
        const result = shouldLaunch ? await reconcileRecovery(store, { trigger: "daemon", clankerId: intent.clankerId, allowLaunch: true, automatic: false, bypassAdmission: intent.type !== "stop" && intent.force === true }) : { clankerId: intent.clankerId, state: store.getDesired(intent.clankerId)?.desiredState }
        return { checkpoint: { ...checkpoint, outcome: result } }
      }
    } finally { store.close() }
  }

  throw new Error(`Unsupported mutation stage ${intent.type}/${stage}`)
}

const stagedDaemonMutation = createStagedMutationExecutor(reconcileMutationStage)
const executeDaemonMutation: MutationExecutor = async (intent, execution) => {
  const result = await stagedDaemonMutation(intent, execution)
  invalidateProjectionEnrichment()
  invalidateDirectoryCache()
  return result
}

const program = process.argv.includes("--server")
  ? serverProgram
  : process.argv.includes("--dump-cache")
    ? dumpCachedState
    : process.argv.includes("--dump-state")
      ? dumpState
      : Effect.fail(new Error("Interactive Bun renderer removed; run the Rust native client with clankerhouse-native."))

if (import.meta.main) {
  Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isFailure(exit)) {
      console.error(exit.cause.toString())
      process.exitCode = 1
    }
  })
}

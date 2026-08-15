import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import { Effect, Exit } from "effect"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { canonicalActivityPath, gitStatusPaths, markDirectoryActivity, newestActivity, readDirectoryActivities } from "./activity"
import { listClankers } from "./clanker-api"
import type { ActivityRecord } from "./activity"
import { readResourceIncidents } from "./incidents"
import { applicationRoot, binPath, libexecPath } from "./installation"
import { attachWorkshopToParent, attachmentCandidatesForWorkshop, detachWorkshopFromParent, readLineageSnapshot, workshopForId, workshopStatePath } from "./workshop"
import { buildTreeRows, defaultExpandedLineageSessions, fuzzyResult, normalizeReportedState, sessionSortRank, sessionState, structuredSearch, targetKey } from "./model"
import type { ClankerState, DetailRow, ReportedClankerState, SessionRow, Target, TreeRow } from "./model"
import { pickSelection, refreshSessionsAuthoritatively, selectedItem, treeRowAnchor, visibleSlice } from "./picker"
import { advanceProjection, parseProjectionSnapshot, shouldApplyProjection } from "./projection"
import type { ProjectionRevision, ProjectionSnapshot } from "./projection"
import { detailStatusLabel, ellipsize, inlineSummaryWidth, jumpFooterAction, prefixedLabelWidth, sessionMeta, treePrefix, usesNeutralStateGlyph, visibleInlineSummary } from "./presentation"
import { planRepositoryIdentities, readRepositoryIdentityCache, writeRepositoryIdentityCache } from "./repository-cache"
import { TmuxMultiplexer } from "./multiplexer"
import { openResourceRegistry, resourceRegistryStatePath } from "./resource-registry"
import { openDurableRegistry, type DurableRegistry } from "./registry"
import { openRecoveryStore, recoveryStatePath } from "./recovery/store"
import { reconcileRecovery, RecoveryController } from "./recovery/controller"
import { stopOwnedHarness } from "./recovery/process-owner"
import { createStagedMutationExecutor } from "./daemon-mutations"
import type { MutationExecution } from "./transport/operations"
import { discoverForegroundAgent } from "./server/process-discovery"
import type { ForegroundAgentHarness } from "./server/process-discovery"
import { isCodexWindow, projectResources } from "./server/project"
import type { ProjectEffect } from "./server/project"
import type { ClankerReport, DirectoryRow, TmuxSession, TmuxWindow } from "./server/resources"
import { acquireProducerLease, getSnapshot, refreshProjection, startSnapshotServer, submitMutation, subscribeSnapshots, waitForOperation } from "./transport"
import type { MutationIntent, ProducerLease, SnapshotServer, SnapshotSubscription } from "./transport"
import { parseTmuxRows, tmuxFields } from "./tmux-fields"

interface BranchRow { key: string; name: string; value: string; kind: "worktree" | "local" | "remote" | "create"; path: string; recency: number; searchText: string }
interface DeleteAction { row: TreeRow; kind: "pane" | "session" | "worktree"; pane?: string; finalPane?: boolean }
type PickerMode = "jump" | "repo" | "new" | "branch" | "rename" | "attach"

const repoRoot = applicationRoot
const runtimeDir = `${Bun.env.XDG_RUNTIME_DIR ?? "/tmp"}/clankerhouse-${process.getuid?.() ?? Bun.env.USER ?? "user"}`
const cachePath = `${runtimeDir}/state.json`
const pidPath = `${runtimeDir}/server.pid`
const versionPath = `${runtimeDir}/server.version`
const daemonSocketPath = `${runtimeDir}/daemon.sock`
const repositoryCachePath = `${runtimeDir}/repositories.json`
const clankerStateDir = `${runtimeDir}/clanker-state`
// Read reports from clankers that were already running before the rename.
const previousClankerStateDir = `${Bun.env.XDG_RUNTIME_DIR ?? "/tmp"}/alt-k-tui-${process.getuid?.() ?? Bun.env.USER ?? "user"}/agent-state`
const seenStateDir = `${runtimeDir}/seen-state`
const refreshMs = Number(Bun.env.CLANKERHOUSE_REFRESH_MS ?? 1500) || 1500
const cacheVersion = 10
let projectionSource: string = randomUUID()
let producerLease: ProducerLease | undefined
let latestWrittenProjection: ProjectionSnapshot<SessionRow> | undefined
let projectionRefreshInFlight: Promise<ProjectionSnapshot<SessionRow>> | undefined
let snapshotServer: SnapshotServer<SessionRow> | undefined
let durableRegistry: DurableRegistry | undefined
let recoveryController: RecoveryController | undefined
const snapshotTransportEnabled = Bun.env.CLANKERHOUSE_SUBSCRIBE !== "0"
const ensurePrivateRuntimeDirectory = () => {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(runtimeDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe Clankerhouse runtime directory: ${runtimeDir}`)
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Clankerhouse runtime directory is not owned by the current user: ${runtimeDir}`)
  chmodSync(runtimeDir, 0o700)
}
const spawnMode = Bun.env.CLANKERHOUSE_MODE === "spawn"
const theme = {
  accent: "#7dd3fc",
  accentStrong: "#38bdf8",
  border: "#334155",
  header: "#e2e8f0",
  muted: "#94a3b8",
  waiting: "#f87171",
  working: "#fb923c",
  ready: "#4ade80",
  idle: "#60a5fa",
  unknown: "#a78bfa",
  selectedBg: "#1e3a5f",
  selectedFg: "#f8fafc",
  warning: "#fde68a",
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

const parseTsv = (output: string) => output.split("\n").filter(Boolean).map((line) => line.split("\t"))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const expandHome = (path: string) => path === "~" ? Bun.env.HOME ?? path : path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
const ageFromUnixSeconds = (seconds: number) => {
  if (seconds <= 0) return ""
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

const collectMultiplexerResources = Effect.tryPromise({
  try: async () => {
    const snapshot = await new TmuxMultiplexer().observe()
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
    }))))
    return { instanceId: snapshot.instanceId, sessions, windows }
  },
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
})

const readManagedResources = () => {
  const registry = openResourceRegistry()
  try { return new Map(registry.list().map((resource) => [resource.id, resource])) }
  finally { registry.close() }
}

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

const collectDirectories = Effect.all([collectDevWorktrees, collectZoxideDirectories], { concurrency: "unbounded" }).pipe(
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

const collectClankerReports = Effect.sync(() => {
  const byPane = new Map<string, ClankerReport>()
  for (const directory of [previousClankerStateDir, clankerStateDir]) {
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(`${directory}/${entry}`, "utf8")) as Partial<ClankerReport> & { agent?: string; state?: ReportedClankerState }
        const harness = raw.harness || raw.agent
        if (!harness || !raw.pane || !raw.state || !["blocked", "working", "done", "idle", "unknown"].includes(raw.state)) continue
        const report = { harness, pane: raw.pane, state: normalizeReportedState(raw.state, raw.hookEvent), updatedAt: Number(raw.updatedAt ?? 0) || 0, hookEvent: raw.hookEvent, harnessSessionId: typeof raw.harnessSessionId === "string" ? raw.harnessSessionId : undefined, recoveryAttemptId: typeof raw.recoveryAttemptId === "string" ? raw.recoveryAttemptId : undefined }
        const existing = byPane.get(raw.pane)
        if (!existing || report.updatedAt >= existing.updatedAt) byPane.set(raw.pane, report)
      } catch {}
    }
  }
  return [...byPane.values()]
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

const gitMeta = (path: string) => Effect.gen(function* () {
  if (!path) return { branch: "", flags: "" }
  const gitPath = expandHome(path)
  const branch = yield* runCommand(["git", "-C", gitPath, "branch", "--show-current"], { allowFailure: true }).pipe(Effect.map((out) => out.trim()))
  if (!branch) return { branch: "", flags: "" }
  const dirty = yield* runCommand(["git", "-C", gitPath, "status", "--porcelain"], { allowFailure: true }).pipe(Effect.map((out) => out.trim().length > 0))
  return { branch, flags: dirty ? "dirty" : "clean" }
})

const processGroupContains = (pid: string, needle: string) => pid
  ? runCommand(["ps", "-o", "args=", "--forest", "-g", pid], { allowFailure: true }).pipe(Effect.map((output) => output.toLowerCase().includes(needle.toLowerCase())))
  : Effect.succeed(false)

const buildLineageFields = (workshopId?: string, parentWorkshopId?: string | null, childWorkshopCount = 0) => {
  const label = [parentWorkshopId ? "↖" : "", childWorkshopCount > 0 ? `⇣${childWorkshopCount}` : ""].filter(Boolean).join(" ")
  const searchText = [workshopId, parentWorkshopId || "", childWorkshopCount > 0 ? `child-count-${childWorkshopCount}` : "root"].filter(Boolean).join(" ")
  return { lineageLabel: label, lineageSearchText: searchText }
}

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
  Effect.sync(readLineageSnapshot),
  Effect.sync(readResourceIncidents),
  Effect.sync(readManagedResources),
], { concurrency: "unbounded" }).pipe(
  Effect.flatMap(([multiplexer, directories, clankerReports, seen, lineage, incidents, managedResources]) => Effect.all([
    Effect.succeed(multiplexer),
    Effect.forEach(multiplexer.sessions, (session) => gitMeta(session.path).pipe(Effect.map((meta) => [session.path, meta] as const)), { concurrency: 8 }),
    Effect.forEach(
      multiplexer.windows,
      (window): Effect.Effect<readonly [string, ForegroundAgentHarness | undefined], Error> => {
        const discovery = discoverForegroundAgent(Number(window.pid))
        if (discovery) return Effect.succeed([window.pane, discovery.harness] as const)
        if (isCodexWindow(window)) return Effect.succeed([window.pane, "codex"] as const)
        return processGroupContains(window.pid, "codex").pipe(Effect.map((detected) => [window.pane, detected ? "codex" : undefined] as const))
      },
      { concurrency: 8 },
    ),
  ], { concurrency: "unbounded" }).pipe(Effect.map(([resources, gitMetas, harnessDetections]) => {
    const detectedHarnessByPane = new Map<string, ForegroundAgentHarness>()
    for (const [pane, harness] of harnessDetections) {
      if (harness) detectedHarnessByPane.set(pane, harness)
    }
    const projection = projectResources({
      sessions: resources.sessions,
      windows: resources.windows,
      opencodes: [],
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
      home: Bun.env.HOME,
    })
    for (const effect of projection.effects) applyProjectEffect(effect)
    return projection.sessions
  }))),
)

const readCachePayload = () => {
  try {
    return parseProjectionSnapshot<SessionRow>(JSON.parse(readFileSync(cachePath, "utf8")), cacheVersion)
  } catch {
    return undefined
  }
}

const writeCache = (sessions: SessionRow[]) => Effect.sync(() => {
  mkdirSync(runtimeDir, { recursive: true })
  const tmpPath = `${cachePath}.${process.pid}.tmp`
  const payload = advanceProjection(latestWrittenProjection, sessions, cacheVersion, projectionSource)
  latestWrittenProjection = payload
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

const invalidateCacheSync = () => {
  try {
    unlinkSync(cachePath)
  } catch {}
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
        const stateHome = Bun.env.XDG_STATE_HOME || `${Bun.env.HOME || ""}/.local/state`
        registry.importLegacy({
          workshops: workshopStatePath,
          altKLineage: `${stateHome}/alt-k-tui/workspaces.sqlite3`,
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
    try: () => acquireProducerLease(`${runtimeDir}/producer.lease`, `${process.env.TMUX?.split(",")[0] || "default-tmux"}`),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
  projectionSource = producerLease.epoch
  // The authoritative daemon also owns Recovery reconciliation. A legacy
  // recovery process may remain during the compatibility window; the durable
  // global Recovery lease guarantees that only one controller can act.
  recoveryController = new RecoveryController()
  void recoveryController.run().catch((error) => {
    console.error(`Recovery controller stopped: ${error instanceof Error ? error.message : String(error)}`)
  }).finally(() => recoveryController?.close())

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

const authoritativeOrStartupFallbackSnapshot = Effect.tryPromise({
  try: async () => {
    // Isolated deterministic render QA can explicitly exercise only the
    // one-time crash fallback. Production clients always try the socket first.
    if (Bun.env.CLANKERHOUSE_STARTUP_FALLBACK_ONLY === "1") {
      const cached = readCachePayload()
      if (cached) return cached
      throw new Error("Startup fallback snapshot is unavailable")
    }
    try { return await getSnapshot<SessionRow>(daemonSocketPath) }
    catch (socketError) {
      const cached = readCachePayload()
      if (cached) return cached
      throw socketError
    }
  },
  catch: (error) => error instanceof Error ? error : new Error(String(error)),
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

const collectBranchesSync = (repoPath: string): BranchRow[] => {
  const worktrees = new Map<string, string>()
  const worktreeResult = Bun.spawnSync(["git", "-C", repoPath, "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "ignore" })
  let currentPath = ""
  for (const line of worktreeResult.stdout.toString().split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length)
    if (line.startsWith("branch refs/heads/")) worktrees.set(line.slice("branch refs/heads/".length), currentPath)
  }

  const refsResult = Bun.spawnSync(
    ["git", "-C", repoPath, "for-each-ref", "--format=%(refname)\t%(refname:short)\t%(committerdate:unix)", "refs/heads", "refs/remotes"],
    { stdout: "pipe", stderr: "ignore" },
  )
  if (refsResult.exitCode !== 0) return []
  const localBranches = new Set<string>()
  const remoteBranches = new Set<string>()
  const rows: BranchRow[] = []
  const refs = parseTsv(refsResult.stdout.toString())
  for (const [ref = "", short = "", timestamp = "0"] of refs) {
    if (!ref.startsWith("refs/heads/")) continue
    const name = ref.slice("refs/heads/".length)
    localBranches.add(name)
    const path = worktrees.get(name) ?? ""
    const kind = path ? "worktree" : "local"
    rows.push({ key: `${kind}:${path || name}`, name, value: name, kind, path, recency: Number(timestamp) || 0, searchText: `${name} ${kind} ${path}`.toLowerCase() })
  }
  for (const [ref = "", short = "", timestamp = "0"] of refs) {
    if (!ref.startsWith("refs/remotes/") || ref.endsWith("/HEAD")) continue
    const slash = short.indexOf("/")
    const branchName = slash >= 0 ? short.slice(slash + 1) : short
    if (!branchName || localBranches.has(branchName) || remoteBranches.has(branchName)) continue
    remoteBranches.add(branchName)
    rows.push({ key: `remote:${branchName}`, name: short, value: branchName, kind: "remote", path: "", recency: Number(timestamp) || 0, searchText: `${short} ${branchName} remote`.toLowerCase() })
  }
  const rank = { worktree: 0, local: 1, remote: 2, create: 3 }
  return rows.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "remote" ? b.recency - a.recency : a.name.localeCompare(b.name)))
}

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
    })), null, 2))
  })),
)

const dumpCachedState = Effect.sync(() => {
  console.log(JSON.stringify(readCache() ?? [], null, 2))
})

const searchFieldsForSession = (session: SessionRow) => [
  session.name,
  session.path,
  session.branch,
  session.flags,
  session.markers.join(" "),
  session.lineageLabel || "",
  session.lineageSearchText || "",
  ...session.details.flatMap((detail) => [detail.kind, detail.harness || "", detail.status, detail.detail, detail.title, detail.age, detail.state]),
]

const filterSessions = (sessions: SessionRow[], query: string) => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return sessions
  return sessions
    .map((session) => ({ session, match: structuredSearch(searchFieldsForSession(session), normalized) }))
    .filter((row): row is { session: SessionRow; match: { score: number } } => Boolean(row.match))
    .sort((a, b) => b.match.score - a.match.score || sessionSortRank(a.session) - sessionSortRank(b.session) || b.session.recency - a.session.recency || (b.session.frecency ?? 0) - (a.session.frecency ?? 0) || a.session.name.localeCompare(b.session.name))
    .map((row) => row.session)
}

const filterBranches = (rows: BranchRow[], query: string) => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return rows
  const matches = rows
    .map((branch) => ({ branch, match: structuredSearch([branch.name, branch.value, branch.kind, branch.path], normalized) }))
    .filter((row): row is { branch: BranchRow; match: { score: number } } => Boolean(row.match))
    .sort((a, b) => b.match.score - a.match.score || b.branch.recency - a.branch.recency || a.branch.name.localeCompare(b.branch.name))
    .map((row) => row.branch)
  const exact = rows.some((branch) => branch.value.toLowerCase() === normalized || branch.name.toLowerCase() === normalized)
  return exact ? matches : [{ key: `create:${query.trim()}`, name: query.trim(), value: query.trim(), kind: "create" as const, path: "", recency: 0, searchText: `${normalized} create new branch` }, ...matches]
}

const workingGlyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]
const animationFrameCount = 40
const stateGlyph = (state: ClankerState, frame = 0) => {
  if (state === "failed") return "×"
  if (state === "blocked") return Math.floor(frame / 5) % 2 === 0 ? "!" : " "
  if (state === "working") return workingGlyphs[frame % workingGlyphs.length]!
  return state === "done" ? "✓" : state === "idle" ? "○" : "?"
}
const stateColor = (state: ClankerState) => state === "failed" || state === "blocked" ? theme.waiting : state === "working" ? theme.working : state === "done" ? theme.ready : state === "idle" ? theme.idle : theme.unknown
const selectedColor = (selected: boolean) => selected ? theme.selectedFg : theme.header
const targetLabel = (target: Target) => {
  switch (target.type) {
    case "opencode": return `opencode pane ${target.pane}`
    case "tmux_session": return `tmux session ${target.session}`
    case "tmux_window": return `tmux window ${target.windowId}`
    case "directory": return "directory"
  }
}
const enterAction = (target: Target) => {
  switch (target.type) {
    case "opencode": return "attach to opencode"
    case "tmux_session": return process.env.TMUX ? "switch to session" : "attach to session"
    case "tmux_window": return process.env.TMUX ? "switch to window" : "attach to window"
    case "directory": return "open directory session"
  }
}
const openTarget = (target: Target) => {
  return runCommand([binPath("clankers"), "target", "open", "--json", JSON.stringify(target)]).pipe(Effect.asVoid)
}

const openTargetSync = (target: Target | undefined) => {
  if (!target) return false
  return Bun.spawnSync([binPath("clankers"), "target", "open", "--json", JSON.stringify(target)], { cwd: repoRoot, stdout: "ignore", stderr: "ignore" }).exitCode === 0
}

const requestingTmuxClient = (() => {
  if (Bun.env.CLANKERHOUSE_TMUX_CLIENT) return Bun.env.CLANKERHOUSE_TMUX_CLIENT
  if (!Bun.env.TMUX) return ""
  const result = Bun.spawnSync(["tmux", "display-message", "-p", "#{client_name}"], { stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : ""
})()

const paneForTargetSync = (target: Target) => {
  if (target.type !== "tmux_window" && target.type !== "opencode") return ""
  const resolved = Bun.spawnSync(["tmux", "display-message", "-p", "-t", target.pane, "#{pane_id}"], { stdout: "pipe", stderr: "ignore" })
  return resolved.exitCode === 0 ? resolved.stdout.toString().trim() : ""
}

const sessionPaneIdsSync = (session: string) => {
  const result = Bun.spawnSync(["tmux", "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], { stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().split("\n").filter(Boolean) : []
}

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

const tmuxSessionsSync = () => {
  const listed = Bun.spawnSync(["tmux", "list-sessions", "-F", tmuxFields("#{session_id}", "#{session_name}", "#{@dotfiles_workshop_id}", "#{@dotfiles_worktree_path}", "#{@dotfiles_directory_path}", "#{session_path}", "#{@dotfiles_workshop_parent_id}", "#{@clankerhouse_display_name}", "#{@clankerhouse_session_id}")], { stdout: "pipe", stderr: "pipe" })
  if (listed.exitCode !== 0) return { rows: [] as string[][], error: listed.stderr.toString().trim() }
  return { rows: parseTmuxRows(listed.stdout.toString()), error: "" }
}

const exactSession = (identity: { session?: string; nativeSessionId?: string }) => {
  const listed = tmuxSessionsSync()
  const matches = listed.rows.filter(([id, name]) => identity.nativeSessionId ? id === identity.nativeSessionId : name === identity.session)
  if (matches.length > 1) throw new Error("Selected tmux session identity is ambiguous")
  return matches[0]
}

const exactPaneExists = (nativeSessionId: string, paneId: string) => {
  const found = Bun.spawnSync(["tmux", "display-message", "-p", "-t", paneId, tmuxFields("#{session_id}", "#{pane_id}")], { stdout: "pipe", stderr: "ignore" })
  return found.exitCode === 0 && parseTmuxRows(found.stdout.toString()).some(([session, pane]) => session === nativeSessionId && pane === paneId)
}

const sessionClankerIds = (nativeSessionId: string) => {
  const listed = Bun.spawnSync(["tmux", "list-panes", "-s", "-t", nativeSessionId, "-F", "#{@clankerhouse_clanker_id}"], { stdout: "pipe", stderr: "ignore" })
  return listed.exitCode === 0 ? [...new Set(listed.stdout.toString().split("\n").filter(Boolean))] : []
}

const applyExactTmuxParent = (nativeSessionId: string, workshopId: string, parentWorkshopId: string | null) => {
  const row = exactSession({ nativeSessionId })
  if (!row) throw new Error("Selected session no longer exists")
  if (row[2] && row[2] !== workshopId) throw new Error(`Tmux session ${nativeSessionId} belongs to a different Workshop`)
  if ((row[6] || null) === parentWorkshopId) return
  const args = parentWorkshopId === null
    ? ["tmux", "set-option", "-u", "-t", nativeSessionId, "@dotfiles_workshop_parent_id"]
    : ["tmux", "set-option", "-t", nativeSessionId, "@dotfiles_workshop_parent_id", parentWorkshopId]
  const updated = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
  if (updated.exitCode !== 0) throw new Error(updated.stderr.toString().trim() || "Unable to update tmux Workshop parent claim")
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

const createWorktreeSync = (repository: string, branch: string, create: boolean, base?: string) => {
  const existing = worktreeForBranch(repository, branch)
  if (existing) return existing
  const args = ["wt", "-C", repository, "switch", ...(create ? ["--create"] : []), branch, "--no-cd", "--format", "json", ...(create && base ? ["--base", base] : [])]
  const switched = Bun.spawnSync(args, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
  if (switched.exitCode !== 0) throw new Error(switched.stderr.toString().trim() || `wt exited ${switched.exitCode}`)
  const parsed = JSON.parse(switched.stdout.toString()) as { path?: string }
  if (!parsed.path) throw new Error("Worktrunk did not return a worktree path")
  return realpathSync(parsed.path)
}

const ensureWorktreeSessionSync = (path: string) => {
  const existing = tmuxSessionsSync().rows.find((row) => {
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
  if (stage === "projection.refreshed") {
    const refreshed = await refreshProjectionSnapshot()
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
    const multiplexer = new TmuxMultiplexer()
    const requestingClient = intent.type === "open" ? intent.client : undefined
    if (stage === "identity.validated") {
      if (intent.target.type === "directory") {
        const path = realpathSync(expandHome(intent.target.path))
        return { checkpoint: { ...checkpoint, path } }
      }
      if (intent.type === "absorb" && !intent.target.location) throw new Error("Absorption requires an exact Multiplexer Location")
      const target = intent.target
      if (requestingClient && !await multiplexer.currentLocation(requestingClient)) throw new Error("Requesting tmux client no longer exists")
      const snapshot = await multiplexer.observe()
      const session = target.location
        ? snapshot.sessions.find((candidate) => candidate.id === target.location!.nativeSessionId && snapshot.instanceId === target.location!.instanceId)
        : snapshot.sessions.find((candidate) => candidate.nativeName === target.session)
      if (!session) throw new Error("Selected Multiplexer target no longer exists")
      const location = target.location ?? { kind: "tmux", instanceId: snapshot.instanceId, nativeSessionId: session.id, nativeWindowId: target.type === "tmux_window" ? target.windowId : null, nativePaneId: target.type === "tmux_window" || target.type === "opencode" ? target.pane : null }
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
      return { checkpoint: { ...checkpoint, outcome: { opened: true } }, result: { opened: true } }
    }
  }

  if (intent.type === "rename") {
    if (stage === "identity.validated") {
      let row = exactSession({ session: intent.session }) ?? exactSession({ session: intent.displayName })
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
      const row = exactSession({ nativeSessionId })
      if (!row) throw new Error("Selected session disappeared before rename reconciliation")
      if (row[1] !== intent.displayName) {
        if (row[1] !== intent.session) throw new Error("Selected session name changed outside this operation")
        const renamed = Bun.spawnSync(["tmux", "rename-session", "-t", nativeSessionId, intent.displayName], { stdout: "pipe", stderr: "pipe" })
        if (renamed.exitCode !== 0) throw new Error(renamed.stderr.toString().trim() || "Unable to rename session")
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
        const current = exactSession({ nativeSessionId })
        if (!current) throw new Error("Managed session disappeared before Display Name claim persistence")
        if (current[7] !== intent.displayName) {
          const option = Bun.spawnSync(["tmux", "set-option", "-t", nativeSessionId, "@clankerhouse_display_name", intent.displayName], { stdout: "pipe", stderr: "pipe" })
          if (option.exitCode !== 0) throw new Error(option.stderr.toString().trim() || "Unable to persist tmux Display Name claim")
        }
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
      const row = intent.session ? exactSession({ session: intent.session }) : undefined
      if (intent.session && !row) throw new Error("Selected Workshop session no longer exists")
      if (row?.[2] && row[2] !== intent.workshopId) throw new Error("Selected tmux session belongs to a different Workshop")
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
      if (checkpoint.nativeSessionId) applyExactTmuxParent(String(checkpoint.nativeSessionId), intent.workshopId, parentWorkshopId)
      const outcome = parentWorkshopId ? { attached: true } : { detached: true }
      return { checkpoint: { ...checkpoint, outcome } }
    }
  }

  if (intent.type === "delete") {
    if (stage === "identity.validated") {
      const session = exactSession({ session: intent.session })
      if (!session) throw new Error("Selected session no longer exists")
      if (intent.kind === "pane") {
        if (!intent.pane || !sessionPaneIdsSync(intent.session).includes(intent.pane)) throw new Error("Selected pane is not in the exact session")
        return { checkpoint: { ...checkpoint, nativeSessionId: session[0], pane: intent.pane } }
      }
      if (intent.kind === "worktree") {
        if (!intent.path || !isLinkedWorktreeSync(intent.path)) throw new Error("Selected path is not a linked worktree")
        const path = realpathSync(expandHome(intent.path))
        const sessionPath = session[3] || session[4] || session[5]
        if (!sessionPath || realpathSync(sessionPath) !== path) throw new Error("Selected session does not own the exact worktree path")
        const identity = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" })
        if (identity.exitCode !== 0) throw new Error(identity.stderr.toString().trim() || "Unable to capture exact worktree identity")
        const [commonDir, branch] = identity.stdout.toString().trim().split("\n")
        if (!commonDir || !branch || branch === "HEAD") throw new Error("Refusing worktree deletion without an exact branch identity")
        return { checkpoint: { ...checkpoint, nativeSessionId: session[0], path, commonDir: realpathSync(commonDir), branch } }
      }
      return { checkpoint: { ...checkpoint, nativeSessionId: session[0] } }
    }
    if (stage === "tmux.marked") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (exactSession({ nativeSessionId })) {
        const ids = sessionClankerIds(nativeSessionId)
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
    if (stage === "tmux.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      if (exactSession({ nativeSessionId })) {
        const killed = Bun.spawnSync(["tmux", "kill-session", "-t", nativeSessionId], { stdout: "pipe", stderr: "pipe" })
        if (killed.exitCode !== 0) throw new Error(killed.stderr.toString().trim() || "Unable to close deleted worktree session")
      }
      return { checkpoint: { ...checkpoint, outcome: { deleted: true } } }
    }
    if (stage === "target.deleted") {
      const nativeSessionId = String(checkpoint.nativeSessionId)
      const exists = intent.kind === "pane" ? exactPaneExists(nativeSessionId, String(checkpoint.pane)) : Boolean(exactSession({ nativeSessionId }))
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
      const path = createWorktreeSync(String(checkpoint.repository), intent.branch, intent.create, intent.base)
      return { checkpoint: { ...checkpoint, path } }
    }
    if (stage === "tmux.ready") {
      const path = realpathSync(String(checkpoint.path))
      const session = ensureWorktreeSessionSync(path)
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
        if (matches.length) {
          const killed = Bun.spawnSync(["tmux", "kill-pane", "-t", matches[0]!.pane], { stdout: "pipe", stderr: "pipe" })
          if (killed.exitCode !== 0) throw new Error(killed.stderr.toString().trim() || "Unable to stop Clanker pane")
        }
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
          if (matches.length === 1) {
            const killed = Bun.spawnSync(["tmux", "kill-pane", "-t", matches[0]!.pane], { stdout: "pipe", stderr: "pipe" })
            if (killed.exitCode !== 0) throw new Error(killed.stderr.toString().trim() || "Unable to stop recovered Clanker pane")
          }
        }
        const result = shouldLaunch ? await reconcileRecovery(store, { trigger: "daemon", clankerId: intent.clankerId, allowLaunch: true, automatic: false, bypassAdmission: intent.type !== "stop" && intent.force === true }) : { clankerId: intent.clankerId, state: store.getDesired(intent.clankerId)?.desiredState }
        return { checkpoint: { ...checkpoint, outcome: result } }
      }
    } finally { store.close() }
  }

  throw new Error(`Unsupported mutation stage ${intent.type}/${stage}`)
}

const executeDaemonMutation = createStagedMutationExecutor(reconcileMutationStage)

const issueDaemonMutation = async (intent: MutationIntent) => {
  const idempotencyKey = randomUUID()
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const submitted = await submitMutation(daemonSocketPath, idempotencyKey, intent)
      return await waitForOperation(daemonSocketPath, submitted.operation.operationId)
    } catch (error) {
      lastError = error
      await sleep(Math.min(500, 25 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function HighlightText(props: { text: string; query: string; fg: string }) {
  const positions = createMemo(() => fuzzyResult(props.text, props.query)?.positions ?? [])
  return <>{Array.from(props.text).map((char, index) => positions().includes(index) ? <b>{char}</b> : char)}</>
}

const isSessionRow = (row: TreeRow | undefined): row is TreeRow => Boolean(row && !row.detail)

function TreeRowView(props: { row: TreeRow; selected: boolean; query: string; animationFrame: number }) {
  const dimensions = useTerminalDimensions()
  const rowFg = () => selectedColor(props.selected)
  const detail = () => props.row.detail
  const detailName = () => detail()?.kind === "window" ? detail()!.title : detail()?.harness ?? detail()?.kind ?? ""
  const detailTitle = () => ""
  const neutralState = () => usesNeutralStateGlyph(props.row)
  const bulletState = () => detail()?.state ?? props.row.state
  const bulletGlyph = () => neutralState() ? "○" : stateGlyph(bulletState(), props.animationFrame)
  const bulletColor = () => neutralState() ? theme.muted : stateColor(bulletState())
  const meta = () => sessionMeta(props.row.session)
  const metaText = () => meta() ? `[${meta()}]` : ""
  const hiddenChildrenLabel = () => !props.row.expanded && props.row.hiddenChildCount > 0 ? `⇣${props.row.hiddenChildCount}` : ""
  const hiddenChildrenWidth = () => prefixedLabelWidth(hiddenChildrenLabel())
  const summaryMaxWidth = () => {
    const width = dimensions().width
    const fixedWidth = 2 + Array.from(treePrefix(props.row)).length + 2 + hiddenChildrenWidth() + Array.from(metaText()).length + 18
    return Math.max(0, Math.min(24, width - fixedWidth))
  }
  const summary = createMemo(() => visibleInlineSummary(props.row.session, summaryMaxWidth(), props.query))
  const summaryWidth = () => inlineSummaryWidth(summary())
  const nameWidth = () => {
    const width = dimensions().width
    const reserved = 2 + Array.from(treePrefix(props.row)).length + 2 + summaryWidth() + hiddenChildrenWidth() + Array.from(metaText()).length + 2
    return Math.max(4, width - reserved)
  }
  const sessionName = () => ellipsize(props.row.session.name, nameWidth())
  const metaColor = () => props.row.session.flags === "dirty" ? theme.warning : props.selected ? theme.selectedFg : theme.muted
  return (
    <box flexDirection="row" height={1} backgroundColor={props.selected ? theme.selectedBg : undefined}>
      <text width={2} fg={rowFg()}>{props.selected ? ">" : " "}</text>
      {props.row.depth === 0 ? (
        <>
          <text width={2} fg={bulletColor()} flexShrink={0}>{bulletGlyph()}</text>
          <text fg={theme.muted} flexShrink={0}>{treePrefix(props.row)}</text>
        </>
      ) : (
        <>
          <text fg={theme.muted} flexShrink={0}>{treePrefix(props.row)}</text>
          <text width={2} fg={bulletColor()} flexShrink={0}>{bulletGlyph()}</text>
        </>
      )}
      {detail() ? (
        <>
          <text width={14} fg={rowFg()}><HighlightText text={detailName()} query={props.query} fg={rowFg()} /></text>
          <text fg={theme.muted} flexShrink={1}><HighlightText text={detailTitle()} query={props.query} fg={theme.muted} /></text>
          <text flexGrow={1}> </text>
          <text width={9} flexShrink={0} fg={detail()?.kind === "window" ? theme.muted : stateColor(detail()!.state)}>{detailStatusLabel(detail()!)}</text>
        </>
      ) : (
        <>
          <text fg={rowFg()} flexShrink={0}><HighlightText text={sessionName()} query={props.query} fg={rowFg()} /></text>
          {summary().entries.length > 0 ? <text fg={theme.muted} flexShrink={0}>  </text> : null}
          <For each={summary().entries}>{(entry, index) => (
            <>
              {index() > 0 ? <text fg={theme.muted} flexShrink={0}>  </text> : null}
              <text fg={props.selected ? theme.selectedFg : theme.muted} flexShrink={0}>{entry.label}</text>
            </>
          )}</For>
          {summary().hiddenCount > 0 ? <text fg={theme.muted} flexShrink={0}>{summary().entries.length > 0 ? `  +${summary().hiddenCount}` : `  +${summary().hiddenCount}`}</text> : null}
          {hiddenChildrenLabel() ? <text fg={props.selected ? theme.selectedFg : theme.muted} flexShrink={0}>{`  ${hiddenChildrenLabel()}`}</text> : null}
          <text flexGrow={1}> </text>
          {metaText() ? <text flexShrink={0} fg={metaColor()}>{metaText()}</text> : null}
        </>
      )}
    </box>
  )
}

function JumpFooter(props: { row: TreeRow | undefined; error?: string }) {
  return (
    <box height={1} flexDirection="row">
      <text fg={props.error ? theme.warning : theme.muted} flexShrink={1}>{props.error || props.row?.session.path || "No matches"}</text>
      <text flexGrow={1}> </text>
      <text fg={theme.muted} flexShrink={0}>{jumpFooterAction(props.row)}</text>
    </box>
  )
}

function PickerRowView(props: { name: string; meta: string; selected: boolean; query: string }) {
  const color = () => props.selected ? theme.selectedFg : theme.header
  return (
    <box flexDirection="row" height={1} backgroundColor={props.selected ? theme.selectedBg : undefined}>
      <text width={2} fg={color()}>{props.selected ? ">" : " "}</text>
      <text fg={color()} flexShrink={1}><HighlightText text={props.name} query={props.query} fg={color()} /></text>
      <text flexGrow={1}> </text>
      <text fg={props.selected ? theme.selectedFg : theme.muted}>{props.meta}</text>
    </box>
  )
}

function App(props: { sessions: SessionRow[]; initialRevision: ProjectionRevision; repositories: SessionRow[]; refreshRepositories: (sessions: SessionRow[]) => Promise<SessionRow[]>; currentSession: string; onOpen: (target: Target | undefined) => void }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const currentSessionIdentities = new Set(props.currentSession.split("\t"))
  const prioritySessionKeys = new Set(props.sessions
    .filter((session) => session.target.type === "tmux_session" && (currentSessionIdentities.has(session.target.location?.nativeSessionId || "") || currentSessionIdentities.has(session.target.session)))
    .map((session) => targetKey(session.target)))
  const initialExpandedLineage = defaultExpandedLineageSessions(props.sessions)
  const initialExpandedDetails = new Set<string>()
  const initialRows = buildTreeRows(props.sessions, "", { expandedLineageSessions: initialExpandedLineage, expandedDetailSessions: initialExpandedDetails, prioritySessionKeys, bottomUp: true })
  const [sessions, setSessions] = createSignal(props.sessions)
  const [repositories, setRepositories] = createSignal(props.repositories)
  const [expandedLineageSessions, setExpandedLineageSessions] = createSignal<ReadonlySet<string>>(initialExpandedLineage)
  const [expandedDetailSessions, setExpandedDetailSessions] = createSignal<ReadonlySet<string>>(initialExpandedDetails)
  const [mode, setMode] = createSignal<PickerMode>(spawnMode ? "repo" : "jump")
  const [query, setQuery] = createSignal("")
  const initialIndex = initialRows.findIndex((row) => !row.detail && row.target.type === "tmux_session" && (currentSessionIdentities.has(row.target.location?.nativeSessionId || "") || currentSessionIdentities.has(row.target.session)))
  const [index, setIndex] = createSignal(Math.max(0, initialIndex))
  const [repository, setRepository] = createSignal<SessionRow>()
  const [branches, setBranches] = createSignal<BranchRow[]>([])
  const [branchName, setBranchName] = createSignal("")
  const [base, setBase] = createSignal("^")
  const [renameName, setRenameName] = createSignal("")
  const [renameSession, setRenameSession] = createSignal<SessionRow>()
  const [attachSession, setAttachSession] = createSignal<SessionRow>()
  const [attachCandidateIds, setAttachCandidateIds] = createSignal<ReadonlySet<string>>(new Set())
  const [deleteAction, setDeleteAction] = createSignal<DeleteAction>()
  const [deleteError, setDeleteError] = createSignal("")
  const [deletePending, setDeletePending] = createSignal(false)
  const [deleteSteps, setDeleteSteps] = createSignal<string[]>([])
  const [newField, setNewField] = createSignal<"branch" | "base">("branch")
  const [error, setError] = createSignal("")
  const [fetchStatus, setFetchStatus] = createSignal<"" | "fetching" | "done" | "failed">("")
  const [animationFrame, setAnimationFrame] = createSignal(0)
  let fetchRequest = 0
  let repositoryRefresh: Promise<void> | undefined
  const deletedSessionNames = new Set<string>()
  let appliedCacheRevision = props.initialRevision.source === "legacy" ? undefined : props.initialRevision

  const treeRows = (rows = sessions(), search = query(), lineage = expandedLineageSessions(), details = expandedDetailSessions()) => buildTreeRows(rows, search, { expandedLineageSessions: lineage, expandedDetailSessions: details, prioritySessionKeys, bottomUp: true })
  const filteredTreeRows = createMemo(() => treeRows())
  const filteredRepositories = createMemo(() => filterSessions(repositories(), query()))
  const filteredBranches = createMemo(() => filterBranches(branches(), query()))
  const attachCandidates = createMemo(() => sessions().filter((session) => session.workshopId && attachCandidateIds().has(session.workshopId)))
  const filteredAttachCandidates = createMemo(() => filterSessions(attachCandidates(), query()))
  const activeLength = createMemo(() => mode() === "jump" ? filteredTreeRows().length : mode() === "repo" ? filteredRepositories().length : mode() === "branch" ? filteredBranches().length : mode() === "attach" ? filteredAttachCandidates().length : 0)
  const selectedTreeRow = createMemo(() => mode() === "jump" ? filteredTreeRows()[index()] : undefined)
  const selectedParent = createMemo(() => isSessionRow(selectedTreeRow()) ? selectedTreeRow()!.session : undefined)
  const selectedRepository = createMemo(() => mode() === "repo" ? filteredRepositories()[index()] : undefined)
  const selectedBranch = createMemo(() => mode() === "branch" ? filteredBranches()[index()] : undefined)
  const selectedAttachCandidate = createMemo(() => mode() === "attach" ? filteredAttachCandidates()[index()] : undefined)
  const visibleCount = createMemo(() => Math.max(1, dimensions().height - (mode() === "jump" && !deleteAction() ? 5 : 11)))
  const visibleTreeRows = createMemo(() => visibleSlice(filteredTreeRows(), index(), visibleCount()))
  const visibleRepositories = createMemo(() => visibleSlice(filteredRepositories(), index(), visibleCount()))
  const visibleBranches = createMemo(() => visibleSlice(filteredBranches(), index(), visibleCount()))
  const visibleAttachCandidates = createMemo(() => visibleSlice(filteredAttachCandidates(), index(), visibleCount()))

  const indexForTreeQuery = (search: string, anchor = treeRowAnchor(selectedTreeRow())) => {
    const rows = treeRows(sessions(), search, expandedLineageSessions(), expandedDetailSessions())
    const selected = pickSelection(rows, index(), search, anchor)
    return selected ? rows.findIndex((row) => row === selected) : 0
  }
  const indexForFlatQuery = <T,>(rows: T[], search: string, preserve: (row: T) => boolean) => {
    const preserved = rows.findIndex(preserve)
    if (preserved >= 0) return preserved
    return search.trim() ? 0 : clamp(index(), 0, Math.max(0, rows.length - 1))
  }
  const updateSearch = (nextQuery: string) => {
    const currentTreeAnchor = treeRowAnchor(selectedTreeRow())
    const currentRepositoryPath = selectedRepository()?.path
    const currentBranchKey = selectedBranch()?.key
    setQuery(nextQuery)
    if (mode() === "jump") {
      setIndex(indexForTreeQuery(nextQuery, currentTreeAnchor))
      return
    }
    if (mode() === "repo") {
      setIndex(indexForFlatQuery(filterSessions(repositories(), nextQuery), nextQuery, (row) => row.path === currentRepositoryPath))
      return
    }
    if (mode() === "attach") {
      const currentWorkshopId = selectedAttachCandidate()?.workshopId
      setIndex(indexForFlatQuery(filterSessions(attachCandidates(), nextQuery), nextQuery, (row) => row.workshopId === currentWorkshopId))
      return
    }
    if (mode() === "branch") setIndex(indexForFlatQuery(filterBranches(branches(), nextQuery), nextQuery, (row) => row.key === currentBranchKey))
  }

  const firstSessionIndex = (rows: TreeRow[]) => rows.findIndex((row) => !row.detail)
  const jumpToTreeRow = (rowKey: string | undefined, rows = filteredTreeRows()) => {
    if (!rowKey) return false
    const nextIndex = rows.findIndex((row) => row.key === rowKey)
    if (nextIndex < 0) return false
    setIndex(nextIndex)
    return true
  }
  const refreshRepositories = () => {
    if (repositoryRefresh) return repositoryRefresh
    repositoryRefresh = props.refreshRepositories(sessions()).then((next) => {
      setRepositories(next)
      if (mode() === "repo") setIndex((current) => clamp(current, 0, Math.max(0, filterSessions(next, query()).length - 1)))
    }).catch(() => {}).finally(() => { repositoryRefresh = undefined })
    return repositoryRefresh
  }
  const resetList = (nextMode: PickerMode) => {
    if (nextMode === "repo") void refreshRepositories()
    setMode(nextMode)
    setQuery("")
    const parentIndex = nextMode === "jump" ? firstSessionIndex(treeRows(sessions(), "")) : 0
    setIndex(Math.max(0, parentIndex))
    setError("")
  }
  const updateIndex = (next: number) => setIndex(clamp(next, 0, Math.max(0, activeLength() - 1)))
  const setLineageExpanded = (session: string, expanded: boolean) => {
    const next = new Set(expandedLineageSessions())
    if (expanded) next.add(session)
    else next.delete(session)
    setExpandedLineageSessions(next)
    const rows = treeRows(sessions(), query(), next, expandedDetailSessions())
    const nextIndex = rows.findIndex((row) => !row.detail && row.session.name === session)
    setIndex(Math.max(0, nextIndex))
  }
  const setDetailExpanded = (session: string, expanded: boolean) => {
    const next = new Set(expandedDetailSessions())
    if (expanded) next.add(session)
    else next.delete(session)
    setExpandedDetailSessions(next)
    const rows = treeRows(sessions(), query(), expandedLineageSessions(), next)
    const nextIndex = rows.findIndex((row) => !row.detail && row.session.name === session)
    setIndex(Math.max(0, nextIndex))
  }
  const closeWith = (target?: Target, completionKey?: string, activityPath?: string) => {
    props.onOpen(target)
    if (!target) { renderer.destroy(); return }
    setError("")
    void issueDaemonMutation({ type: "open", target, ...(requestingTmuxClient ? { client: requestingTmuxClient } : {}) }).then(() => {
      if (completionKey) markSeen(completionKey)
      if (activityPath) markDirectoryActivity(activityPath, "opened")
      renderer.destroy()
    }).catch((openError) => setError(openError instanceof Error ? openError.message : String(openError)))
  }
  const finishBranch = (branch: string, create: boolean) => {
    const repo = repository()
    if (!repo) return
    setError("")
    void issueDaemonMutation({ type: "create", repository: expandHome(repo.path), branch, create, base: base() }).then((operation) => {
      const target = (operation.result as { target?: Target } | undefined)?.target
      if (!target) throw new Error("Daemon did not return the created target")
      closeWith(target)
    }).catch((createError) => setError(createError instanceof Error ? createError.message : String(createError)))
  }
  const appendInput = (raw: string) => {
    const text = raw.replace(/[\x00-\x1f\x7f]/g, "")
    if (!text) return
    if (mode() === "new") {
      if (newField() === "branch") setBranchName((value) => value + text)
      else setBase((value) => value + text)
    } else if (mode() === "rename") {
      setRenameName((value) => value + text)
    } else {
      updateSearch(`${query()}${text}`)
    }
  }
  const refreshRemoteBranches = (repo: SessionRow) => {
    const request = ++fetchRequest
    const path = expandHome(repo.path)
    setFetchStatus("fetching")
    void (async () => {
      try {
        const proc = Bun.spawn(["git", "-C", path, "fetch", "--all", "--prune", "--quiet"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
        })
        proc.unref()
        const exitCode = await proc.exited
        if (request !== fetchRequest) return
        if (exitCode !== 0) {
          setFetchStatus("failed")
          return
        }
        setBranches(collectBranchesSync(path))
        setFetchStatus("done")
        setIndex((value) => clamp(value, 0, Math.max(0, filteredBranches().length - 1)))
      } catch {
        if (request === fetchRequest) setFetchStatus("failed")
      }
    })()
  }
  const deleteActionForRow = (row: TreeRow): DeleteAction | undefined => {
    if (!row.detail) {
      if (row.session.path && isLinkedWorktreeSync(row.session.path)) return { row, kind: "worktree" }
      if (row.target.type === "tmux_session") return { row, kind: "session" }
      if (row.session.branch && row.session.path) return { row, kind: "worktree" }
      return undefined
    }

    const pane = paneForTargetSync(row.target)
    if (!pane) return undefined
    const panes = sessionPaneIdsSync(row.session.name)
    if (panes.length !== 1 || panes[0] !== pane) return { row, kind: "pane", pane }
    if (isLinkedWorktreeSync(row.session.path)) return { row, kind: "worktree", pane, finalPane: true }
    return { row, kind: "session", pane, finalPane: true }
  }
  const requestDelete = (row: TreeRow) => {
    setDeleteError("")
    setDeleteSteps([])
    setDeleteAction(deleteActionForRow(row))
  }
  const deletePrompt = () => {
    const action = deleteAction()
    if (!action) return ""
    const row = action.row
    if (action.kind === "pane") return `Destroy pane '${row.detail?.title || row.detail?.kind || action.pane}'?`
    if (action.finalPane && action.kind === "worktree") return `Destroy final pane, session, and worktree '${row.session.branch || row.session.path}'?`
    if (action.finalPane) return `Destroy final pane and session '${row.session.name}'?`
    if (action.kind === "worktree") return `Destroy session and worktree '${row.session.branch || row.session.path}'?`
    return `Destroy ${action.kind} '${row.session.name}'?`
  }
  const deleteProgress = () => {
    const width = 18
    const segment = 5
    const position = animationFrame() % (width - segment + 1)
    return `[${"·".repeat(position)}${"█".repeat(segment)}${"·".repeat(width - segment - position)}]`
  }
  const reportDeleteStep = (step: string) => {
    setDeleteSteps((steps) => steps.at(-1) === step ? steps : [...steps, step])
  }
  const removeDeletedAction = (action: DeleteAction) => {
    if (action.kind !== "pane") deletedSessionNames.add(action.row.session.name)
    const nextSessions = action.kind === "pane" && action.pane
      ? sessions().map((session) => session.name === action.row.session.name
        ? { ...session, details: session.details.filter((detail) => detail.target.type !== "tmux_window" || detail.target.pane !== action.pane) }
        : session)
      : sessions().filter((session) => session.name !== action.row.session.name)
    setSessions(nextSessions)
    setExpandedLineageSessions((expanded) => new Set([...expanded].filter((session) => session !== action.row.session.name)))
    setExpandedDetailSessions((expanded) => new Set([...expanded].filter((session) => session !== action.row.session.name)))
    const nextRows = treeRows(nextSessions, query())
    setIndex(clamp(index(), 0, Math.max(0, nextRows.length - 1)))
  }
  const setTmuxWorkshopParent = (sessionName: string, parentWorkshopId: string | null) => {
    const found = Bun.spawnSync(["tmux", "list-sessions", "-F", tmuxFields("#{session_id}", "#{session_name}")], { stdout: "pipe", stderr: "pipe" })
    const sessionId = parseTmuxRows(found.stdout.toString()).find(([, name]) => name === sessionName)?.[0] ?? ""
    if (found.exitCode !== 0 || !sessionId) return found.stderr.toString().trim() || "Selected session no longer exists"
    const args = parentWorkshopId === null
      ? ["tmux", "set-option", "-u", "-t", sessionId, "@dotfiles_workshop_parent_id"]
      : ["tmux", "set-option", "-t", sessionId, "@dotfiles_workshop_parent_id", parentWorkshopId]
    const updated = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
    return updated.exitCode === 0 ? "" : updated.stderr.toString().trim() || "Unable to update tmux workshop parent metadata"
  }
  const refreshLineageRows = (selectedWorkshopId: string, search: string) => {
    const lineage = readLineageSnapshot()
    const refreshedSessions = sessions().map((session) => {
      const workshop = session.workshopId ? lineage.byId.get(session.workshopId) : lineage.byPath.get(session.path)
      if (!workshop) return session
      const fields = buildLineageFields(workshop.workshopId, workshop.parentWorkshopId, workshop.childWorkshopCount)
      return { ...session, parentWorkshopId: workshop.parentWorkshopId, childWorkshopCount: workshop.childWorkshopCount, lineageLabel: fields.lineageLabel, lineageSearchText: fields.lineageSearchText }
    })
    setSessions(refreshedSessions)
    const refreshedRows = treeRows(refreshedSessions, search)
    const refreshedIndex = refreshedRows.findIndex((row) => !row.detail && row.session.workshopId === selectedWorkshopId)
    setIndex(Math.max(0, refreshedIndex))
    invalidateCacheSync()
    if (snapshotTransportEnabled) void refreshProjection(daemonSocketPath).catch(() => {})
  }

  usePaste((event) => {
    appendInput(new TextDecoder().decode(event.bytes))
    event.preventDefault()
  })

  useKeyboard((key) => {
    if (deleteAction()) {
      if (deletePending()) return
      if (key.name === "n" || key.name === "escape") {
        setDeleteAction(undefined)
        setDeleteError("")
        setDeleteSteps([])
        return
      }
      if (key.name !== "y") return
      const action = deleteAction()!
      const currentAction = deleteActionForRow(action.row)
      if (!currentAction) {
        setDeleteAction(undefined)
        setDeleteError("")
        setDeleteSteps([])
        return
      }
      if (currentAction.kind !== action.kind || currentAction.pane !== action.pane || currentAction.finalPane !== action.finalPane) {
        setDeleteAction(currentAction)
        setDeleteError("Target changed; review the updated deletion scope.")
        return
      }

      setDeletePending(true)
      setDeleteError("")
      setDeleteSteps(["Preparing deletion"])
      reportDeleteStep("Submitting daemon deletion intent")
      void issueDaemonMutation({ kind: action.kind, type: "delete", session: action.row.session.name, confirmed: true, pane: action.pane, path: action.row.session.path || undefined })
        .then(() => {
          removeDeletedAction(action)
          setDeleteAction(undefined)
          setDeleteError("")
          setDeletePending(false)
          setDeleteSteps([])
        })
        .catch((deleteFailure) => {
          setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : String(deleteFailure))
          setDeletePending(false)
        })
      return
    }
    if (key.meta && key.name === "k") return resetList("repo")
    if (key.meta && key.name === "r" && mode() === "jump") {
      const selected = selectedParent()
      if (selected?.target.type !== "tmux_session") return
      setRenameSession(selected)
      setRenameName(selected.target.session)
      setError("")
      setMode("rename")
      return
    }
    if (key.meta && key.name === "a" && mode() === "jump") {
      const selected = selectedTreeRow()
      const workshopId = selected && !selected.detail ? selected.session.workshopId : undefined
      if (!selected || !workshopId) return
      setError("")
      try {
        const candidates = attachmentCandidatesForWorkshop(workshopId)
        setAttachCandidateIds(new Set(candidates.map((candidate) => candidate.workshopId)))
      } catch (candidateError) {
        setError(candidateError instanceof Error ? candidateError.message : String(candidateError))
        return
      }
      setAttachSession(selected.session)
      setQuery("")
      setIndex(0)
      setMode("attach")
      return
    }
    if (key.meta && key.name === "l" && mode() === "jump") {
      const selected = selectedTreeRow()
      const workshopId = selected && !selected.detail ? selected.session.workshopId : undefined
      if (!workshopId || !selected?.session.parentWorkshopId) return
      setError("")
      void issueDaemonMutation({ type: "detach", workshopId, session: selected.target.type === "tmux_session" ? selected.target.session : undefined })
        .catch((detachError) => setError(detachError instanceof Error ? detachError.message : String(detachError)))
      return
    }
    if (key.ctrl && key.name === "r" && mode() === "branch" && repository()) {
      refreshRemoteBranches(repository()!)
      return
    }
    if (key.name === "escape") {
      if (mode() === "rename" || mode() === "attach") {
        setMode("jump")
        setQuery("")
        setError("")
        setAttachSession(undefined)
        setAttachCandidateIds(new Set<string>())
        return
      }
      if (mode() === "new") {
        const name = branchName()
        resetList("branch")
        setQuery(name)
        return
      }
      if (mode() === "branch") return resetList("repo")
      if (query()) {
        setQuery("")
        setIndex(Math.max(0, firstSessionIndex(treeRows(sessions(), ""))))
        return
      }
      if (mode() === "repo") return resetList("jump")
      return closeWith()
    }
    if (key.name === "tab" && mode() === "new") {
      setNewField((field) => field === "branch" ? "base" : "branch")
      return
    }
    if (key.name === "backspace") {
      if (mode() === "new") {
        if (newField() === "branch") setBranchName((value) => value.slice(0, -1))
        else setBase((value) => value.slice(0, -1))
      } else if (mode() === "rename") {
        setRenameName((value) => value.slice(0, -1))
      } else {
        updateSearch(query().slice(0, -1))
      }
      return
    }
    if (mode() === "jump" && key.name === "right") {
      const selected = selectedTreeRow()
      if (!isSessionRow(selected)) return
      if (selected.expandable && !expandedLineageSessions().has(selected.session.name)) {
        setLineageExpanded(selected.session.name, true)
        return
      }
      if (selected.detailsExpandable && !expandedDetailSessions().has(selected.session.name)) setDetailExpanded(selected.session.name, true)
      return
    }
    if (mode() === "jump" && key.name === "left") {
      const selected = selectedTreeRow()
      if (!selected) return
      if (selected.detail) {
        jumpToTreeRow(selected.ownerSessionKey)
        return
      }
      if (selected.detailsExpanded) {
        setDetailExpanded(selected.session.name, false)
        return
      }
      if (selected.expandable && expandedLineageSessions().has(selected.session.name)) {
        setLineageExpanded(selected.session.name, false)
        return
      }
      jumpToTreeRow(selected.parentSessionKey)
      return
    }
    if (key.name === "up") return updateIndex(index() + 1)
    if (key.name === "down") return updateIndex(index() - 1)
    if (key.name === "return") {
      if (mode() === "attach") {
        const source = attachSession()
        const parent = selectedAttachCandidate()
        if (!source?.workshopId || !parent?.workshopId) return
        setError("")
        void issueDaemonMutation({ type: "attach", workshopId: source.workshopId, parentWorkshopId: parent.workshopId, session: source.target.type === "tmux_session" ? source.target.session : undefined })
          .then(() => {
            setMode("jump")
            setQuery("")
            setAttachSession(undefined)
            setAttachCandidateIds(new Set<string>())
          })
          .catch((attachError) => setError(attachError instanceof Error ? attachError.message : String(attachError)))
        return
      }
      if (mode() === "rename" && renameSession()?.target.type === "tmux_session" && renameName().trim()) {
        const row = renameSession()!
        const oldName = row.target.type === "tmux_session" ? row.target.session : ""
        setError("")
        void issueDaemonMutation({ type: "rename", session: oldName, resourceId: row.resourceId, displayName: renameName().trim() })
          .then(() => {
            setRenameSession(undefined)
            resetList("jump")
          })
          .catch((renameError) => setError(renameError instanceof Error ? renameError.message : String(renameError)))
        return
      }
      if (mode() === "jump") {
        const selected = selectedItem(filteredTreeRows(), index())
        if (!selected) return
        return closeWith(selected.target, selected.detail?.completionKey, selected.session.path)
      }
      if (mode() === "repo") {
        const repo = selectedRepository()
        if (!repo) return
        setRepository(repo)
        setBranches(collectBranchesSync(expandHome(repo.path)))
        resetList("branch")
        refreshRemoteBranches(repo)
        return
      }
      if (mode() === "branch" && selectedBranch()?.kind === "create") {
        setBranchName(selectedBranch()!.value)
        setBase("^")
        setNewField("base")
        return resetList("new")
      }
      if (mode() === "branch" && selectedBranch()) return finishBranch(selectedBranch()!.value, false)
      if (mode() === "new" && branchName().trim()) return finishBranch(branchName().trim(), true)
      return
    }
    if (key.meta && key.name === "d" && mode() === "jump") {
      const selected = selectedTreeRow()
      if (!selected) return
      requestDelete(selected)
      return
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) appendInput(key.sequence)
  }, {})

  const applySnapshot = (refreshed: ProjectionSnapshot<SessionRow>) => {
    if (!shouldApplyProjection(appliedCacheRevision, refreshed.revision)) return
    if (refreshed.revision.source !== "legacy") appliedCacheRevision = refreshed.revision
    const currentAnchor = treeRowAnchor(selectedTreeRow())
    for (const sessionName of deletedSessionNames) {
      if (!refreshed.sessions.some((session) => session.name === sessionName)) deletedSessionNames.delete(sessionName)
    }
    const visibleSessions = refreshed.sessions.filter((session) => !deletedSessionNames.has(session.name))
    const nextSessions = refreshSessionsAuthoritatively(sessions(), visibleSessions)
    setSessions(nextSessions)
    if (mode() === "jump") {
      const nextRows = treeRows(nextSessions, query(), expandedLineageSessions(), expandedDetailSessions())
      const nextSelection = pickSelection(nextRows, index(), query(), currentAnchor)
      setIndex(nextSelection ? nextRows.findIndex((row) => row === nextSelection) : clamp(index(), 0, Math.max(0, nextRows.length - 1)))
    }
  }

  onMount(() => {
    let disposed = false
    let subscription: SnapshotSubscription | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectDelay = 250
    const scheduleReconnect = () => {
      if (disposed || !snapshotTransportEnabled || reconnectTimer) return
      const delay = reconnectDelay + Math.floor(Math.random() * Math.max(1, reconnectDelay / 4))
      reconnectDelay = Math.min(5_000, reconnectDelay * 2)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connectSnapshotTransport()
      }, delay)
    }
    const connectSnapshotTransport = () => {
      if (disposed || !snapshotTransportEnabled || subscription) return
      void subscribeSnapshots<SessionRow>(daemonSocketPath, {
        onSnapshot: applySnapshot,
        onDisconnect() {
          subscription = undefined
          scheduleReconnect()
        },
      }).then((connected) => {
        if (disposed) connected.close()
        else {
          subscription = connected
          reconnectDelay = 250
        }
      }).catch(scheduleReconnect)
    }

    const initialRepositoryRefresh = setTimeout(() => { void refreshRepositories() }, 0)
    const animationInterval = setInterval(() => {
      if (deletePending() || (mode() === "jump" && filteredTreeRows().some((row) => row.state === "working" || row.state === "blocked"))) {
        setAnimationFrame((frame) => (frame + 1) % animationFrameCount)
      }
    }, 100)
    connectSnapshotTransport()
    onCleanup(() => {
      disposed = true
      clearTimeout(initialRepositoryRefresh)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(animationInterval)
      subscription?.close()
    })
  })

  const title = () => mode() === "jump" ? "Clankerhouse · Jump" : mode() === "repo" ? "Clankerhouse · Open or create branch" : mode() === "branch" ? `Clankerhouse · ${repository()?.name ?? ""}` : mode() === "rename" ? "Clankerhouse · Rename tmux session" : mode() === "attach" ? `Clankerhouse · Attach ${attachSession()?.name ?? "workshop"}` : `Clankerhouse · New branch · ${repository()?.name ?? ""}`

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box height={1} flexDirection="row">
        <text fg={theme.accentStrong}>{title()}</text>
        <text flexGrow={1}> </text>
        <text fg={fetchStatus() === "failed" ? theme.warning : theme.muted}>{mode() === "jump" ? `Alt-K branches${selectedParent()?.target.type === "tmux_session" ? " · Alt-R rename" : ""} · Alt-A attach · Alt-L detach · Esc close` : mode() === "attach" ? "Type to search parents · Enter attach · Esc cancel" : `Alt-K open/create${mode() === "branch" ? ` · ^r ${fetchStatus() === "fetching" ? "fetching" : fetchStatus() === "failed" ? "fetch failed" : fetchStatus() === "done" ? "synced" : "refresh"}` : ""} · Esc back`}</text>
      </box>
      <box border borderStyle="single" borderColor={theme.border} flexGrow={1} flexDirection="column" justifyContent="flex-end">
        {mode() === "jump" ? <For each={visibleTreeRows()}>{(row) => <TreeRowView row={row} selected={row === selectedTreeRow()} query={query()} animationFrame={animationFrame()} />}</For> : null}
        {mode() === "repo" ? <For each={visibleRepositories()}>{(repo) => <PickerRowView name={repo.name} meta={repo.path} selected={repo === selectedRepository()} query={query()} />}</For> : null}
        {mode() === "branch" ? <For each={visibleBranches()}>{(branch) => <PickerRowView name={branch.name} meta={branch.kind === "worktree" ? `worktree · ${branch.path}` : branch.kind === "create" ? "create new branch" : branch.kind === "remote" ? `remote${branch.recency ? ` · ${ageFromUnixSeconds(branch.recency)}` : ""}` : branch.kind} selected={branch === selectedBranch()} query={query()} />}</For> : null}
        {mode() === "attach" ? <For each={visibleAttachCandidates()}>{(candidate) => <PickerRowView name={candidate.name} meta={`${candidate.branch} · ${candidate.path}`} selected={candidate === selectedAttachCandidate()} query={query()} />}</For> : null}
        {mode() === "new" ? (
          <box flexDirection="column" padding={2}>
            <text fg={newField() === "branch" ? theme.accentStrong : theme.header}>Branch: {branchName()}{newField() === "branch" ? "_" : ""}</text>
            <text fg={newField() === "base" ? theme.accentStrong : theme.header}>Base:   {base()}{newField() === "base" ? "_" : ""}</text>
            <text fg={theme.muted}>Tab changes field · Enter creates worktree and session</text>
          </box>
        ) : mode() === "rename" ? (
          <box flexDirection="column" padding={2}>
            <text fg={theme.accentStrong}>Session: {renameName()}_</text>
            <text fg={theme.muted}>Enter renames only the tmux display label</text>
          </box>
        ) : null}
      </box>
      {deleteAction() ? (
        <box border borderStyle="single" borderColor={theme.warning} height={deletePending() ? 12 : 8} flexDirection="column" padding={1}>
          <text fg={theme.warning}>{deletePrompt()}</text>
          {deletePending() ? (
            <>
              <text fg={theme.accentStrong}>Destroying workshop… {deleteProgress()}</text>
              <For each={deleteSteps().slice(-5)}>{(step, stepIndex) => {
                const current = () => stepIndex() === deleteSteps().slice(-5).length - 1
                return <text fg={current() ? theme.working : theme.muted}>{current() ? "▶" : "✓"} {step}</text>
              }}</For>
            </>
          ) : <text fg={theme.header}>Press y to confirm or n to cancel.</text>}
          {deleteError() ? <text fg={theme.warning}>{deleteError()}</text> : null}
        </box>
      ) : mode() === "jump" ? <JumpFooter row={selectedTreeRow()} error={error()} /> : (
        <box border borderStyle="single" borderColor={theme.border} height={8} flexDirection="column">
          <text fg={theme.header}>{mode() === "rename" ? renameSession()?.path ?? "" : mode() === "attach" ? attachSession()?.path ?? "Select a workshop to attach" : mode() === "repo" ? selectedRepository()?.path ?? "Select a repository" : repository()?.path ?? "Select a repository"}</text>
          <text fg={theme.muted}>{mode() === "branch" ? "Worktrees, local branches, and recently updated remote branches; remotes refresh in the background" : mode() === "new" ? "Worktrunk will create the branch, worktree, and setup hooks" : mode() === "rename" ? "Canonical worktree identity and included clankers are unchanged" : mode() === "attach" ? selectedAttachCandidate() ? `New parent: ${selectedAttachCandidate()!.name}` : "No valid parent workshops match" : "Enter chooses repository"}</text>
          {error() ? <text fg={theme.warning}>{error()}</text> : null}
        </box>
      )}
      {mode() !== "new" && mode() !== "rename" ? (
        <box flexDirection="row" height={1}>
          <text fg={theme.accent}>{"> "}{query()}_</text>
          <text flexGrow={1}> </text>
          <text fg={theme.muted}>{activeLength()} targets</text>
        </box>
      ) : <box height={1}><text fg={theme.muted}>{mode() === "rename" ? "Enter rename · Esc cancel" : "Enter create · Tab field · Esc branch picker"}</text></box>}
    </box>
  )
}

const program = process.argv.includes("--server") ? serverProgram : process.argv.includes("--dump-cache") ? dumpCachedState : process.argv.includes("--dump-state") ? dumpState : Effect.gen(function* () {
  const snapshot = yield* authoritativeOrStartupFallbackSnapshot
  const sessions = snapshot.sessions
  const repositories = cachedRepositoryRows(sessions)
  let currentSession = Bun.env.CLANKERHOUSE_CURRENT_SESSION ?? ""
  if (!currentSession && Bun.env.TMUX) currentSession = yield* runCommand(["tmux", "display-message", "-p", tmuxFields("#{session_id}", "#{session_name}")], { allowFailure: true }).pipe(Effect.map((output) => output.trim()))
  let target: Target | undefined
  yield* Effect.tryPromise({
    try: () => render(() => <App sessions={sessions} initialRevision={snapshot.revision} repositories={repositories} refreshRepositories={async () => {
      const operation = await issueDaemonMutation({ type: "repository.refresh" })
      return (operation.result as { repositories?: SessionRow[] } | undefined)?.repositories ?? repositories
    }} currentSession={currentSession} onOpen={(next) => { target = next }} />, { exitOnCtrlC: true }),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
})

if (import.meta.main) {
  Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isFailure(exit)) {
      console.error(exit.cause.toString())
      process.exitCode = 1
    }
  })
}

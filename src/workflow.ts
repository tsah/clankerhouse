import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { markDirectoryActivity } from "./activity"
import { ensureManagedSession, openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import { paneLocation, sessionLocation, windowLocation, type MultiplexerSession } from "./multiplexer/interface"
import { clankerForPane, generatedClankerId, listClankers, resultForClanker, sendClanker, waitForClanker, type ClankerDelivery } from "./clanker-api"
import { initialHarnessCommand } from "./recovery/harness"
import type { LaunchSpec, RecoveryResourceClass } from "./recovery/model"
import { recoveryUnitName } from "./recovery/process-owner"
import { openRecoveryStore, type RecoveryStore } from "./recovery/store"
import { lineageMode, persistWorkshopLineage, type LineageMode, type WorkshopRecord, workshopForId, workshopForPath } from "./workshop"

export type Harness = "pi" | "claude" | "opencode" | "codex"
export interface WorktreeIdentity { path: string; commonDir: string; repo: string; branch: string }

const spawnedRuntimeEnv = (multiplexer: ManagedMultiplexer) => {
  const instance = Bun.env.CLANKERHOUSE_INSTANCE?.trim()
  return { CLANKERHOUSE_MULTIPLEXER: multiplexer.kind, ...(instance ? { CLANKERHOUSE_INSTANCE: instance } : {}) }
}

export class ClankerRegistrationError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = "ClankerRegistrationError"
  }
}

async function command(argv: string[], cwd?: string, allowFailure = false) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `${argv.join(" ")} exited ${code}`)
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

export async function identity(cwd = process.cwd()): Promise<WorktreeIdentity> {
  const top = (await command(["git", "rev-parse", "--show-toplevel"], cwd)).stdout
  const commonRaw = (await command(["git", "rev-parse", "--git-common-dir"], top)).stdout
  const commonDir = realpathSync(resolve(top, commonRaw))
  const branch = (await command(["git", "branch", "--show-current"], top)).stdout || "detached"
  return { path: realpathSync(top), commonDir, repo: basename(dirname(commonDir)), branch }
}

const safeName = (value: string) => value.replace(/[.:]/g, "-").replace(/[^A-Za-z0-9_@-]/g, "-").slice(0, 80)
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

const sessionPathOf = (session: MultiplexerSession) => realpathSafe(session.worktreePath || session.directoryPath || session.path)

/** The most recently active session bound to `path`, if any. */
export async function sessionForPath(path: string, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  const canonical = realpathSafe(path)
  const snapshot = await multiplexer.observe()
  return snapshot.sessions
    .filter((session) => sessionPathOf(session) === canonical)
    .sort((a, b) => b.recency - a.recency)
    .map((session) => ({ id: session.id, name: session.nativeName, candidatePath: session.path, activity: session.recency }))[0]
}

const sessionBySelector = (sessions: MultiplexerSession[], selector: string) => sessions.find((session) => session.id === selector || session.nativeName === selector)

export async function sessionName(id: WorktreeIdentity, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  const human = safeName(`${id.repo}@${id.branch}`)
  const existing = sessionBySelector((await multiplexer.observe()).sessions, human)
  if (!existing) return human
  if (sessionPathOf(existing) === id.path) return human
  return `${human}-${createHash("sha256").update(id.path).digest("hex").slice(0, 8)}`
}

const applyWorkshopClaims = async (multiplexer: ManagedMultiplexer, nativeSessionId: string, id: WorktreeIdentity, record?: WorkshopRecord) => {
  const at = sessionLocation(nativeSessionId)
  await multiplexer.claim(at, "worktreePath", id.path)
  await multiplexer.claim(at, "gitCommonDir", id.commonDir)
  if (!record) return
  await multiplexer.claim(at, "workshopId", record.workshopId)
  await multiplexer.claim(at, "workshopParentId", record.parentWorkshopId ?? null)
}

export async function ensureSession(id: WorktreeIdentity, options: { parentWorkshopId?: string | null; preserveParent?: boolean; mode?: LineageMode; multiplexer?: ManagedMultiplexer } = {}) {
  const multiplexer = options.multiplexer ?? openManagedMultiplexer()
  markDirectoryActivity(id.path, "opened")
  const record = persistWorkshopLineage(id, { parentWorkshopId: options.parentWorkshopId, preserveParent: options.preserveParent, mode: options.mode })
  const existing = await sessionForPath(id.path, multiplexer)
  const name = existing?.name ?? await sessionName(id, multiplexer)
  let nativeSessionId = existing?.id
  if (!nativeSessionId) {
    const present = sessionBySelector((await multiplexer.observe()).sessions, name)
    nativeSessionId = present?.id ?? (await multiplexer.spawn({ scope: "session", name, cwd: id.path, windowName: "main", env: spawnedRuntimeEnv(multiplexer) })).nativeSessionId
  }
  await applyWorkshopClaims(multiplexer, nativeSessionId, id, record)
  await ensureManagedSession(nativeSessionId, multiplexer)
  return name
}

const codexCommand = (prompt: string, clankerId: string) => [
  "env",
  `BROWSER=${Bun.env.BROWSER || "xdg-open"}`,
  `PLANNOTATOR_BROWSER=${Bun.env.PLANNOTATOR_BROWSER || `${Bun.env.HOME}/.local/bin/xdg-open`}`,
  `PLANNOTATOR_REMOTE=${Bun.env.PLANNOTATOR_REMOTE || "1"}`,
  `PLANNOTATOR_PORT=${Bun.env.PLANNOTATOR_PORT || "19432-19439"}`,
  `CLANKER_ID=${clankerId}`,
  "codex",
  prompt,
]

export async function spawnClanker(harness: Harness, cwd: string, prompt: string, profile?: string, requestedName?: string, wait = false, resourceClass?: RecoveryResourceClass, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  if (wait && harness === "opencode") throw new Error("OpenCode does not expose a verified lifecycle report transport for waiting")
  const id = await identity(cwd)
  const session = await ensureSession(id, { multiplexer })
  markDirectoryActivity(id.path, "clanker")
  const prefix = requestedName || harness
  const live = sessionBySelector((await multiplexer.observe()).sessions, session)
  if (!live) throw new Error(`Session ${session} disappeared before the clanker was launched`)
  const existing = live.windows.map((window) => window.nativeName)
  let name = prefix; let n = 2
  while (existing.includes(name)) name = `${prefix}-${n++}`
  const clankerId = generatedClankerId()
  const recoverable = harness !== "codex"
  const harnessSessionId = harness === "pi" || harness === "claude" ? randomUUID() : null
  let argv = codexCommand(prompt, clankerId)
  if (recoverable) {
    const recoverableHarness = harness as Exclude<Harness, "codex">
    const workshop = workshopForPath(id.path)
    let store: RecoveryStore | undefined
    try {
      store = openRecoveryStore()
      const launchSpec: LaunchSpec = resourceClass ? { version: 2, profile: profile || null, resourceClass } : { version: 1, profile: profile || null }
      store.createDesired({
        clankerId,
        harness: recoverableHarness,
        workshopId: workshop?.workshopId || `path-${createHash("sha256").update(id.path).digest("hex").slice(0, 24)}`,
        workshopPath: id.path,
        tmuxSessionName: session,
        tmuxWindowName: name,
        cwd: id.path,
        harnessSessionId,
        launchSpec,
        originalTask: prompt,
      })
      const attempt = store.beginAttempt(clankerId, "initial")
      const attemptId = String(attempt.id)
      store.setRecoveryOwner(clankerId, recoveryUnitName(clankerId, attemptId))
      argv = initialHarnessCommand({ harness: recoverableHarness, cwd: id.path, prompt, clankerId, harnessSessionId, launchSpec, attemptId })
    } catch (error) {
      try {
        const registered = store?.getDesired(clankerId)
        if (registered && registered.desiredState !== "tombstoned") store!.tombstone(clankerId, { reason: "initial registration failed" })
      } catch {}
      throw new ClankerRegistrationError(error instanceof Error ? error.message : String(error), { cause: error })
    } finally { store?.close() }
  }
  const spawnedLocation = await multiplexer.spawn({ scope: "window", nativeSessionId: live.id, name, cwd: id.path, env: spawnedRuntimeEnv(multiplexer), launch: { kind: "argv", argv } })
  const { nativeSessionId, nativeWindowId: window, nativePaneId: pane } = spawnedLocation
  const at = paneLocation(nativeSessionId, window, pane)
  await multiplexer.claim(at, "clankerId", clankerId)
  await multiplexer.claim(at, "harness", harness)
  await multiplexer.claim(windowLocation(nativeSessionId, window), "windowHarness", harness)
  await ensureManagedSession(nativeSessionId, multiplexer)
  const spawned: Record<string, unknown> = { identity: id, session, window, pane, name, clankerId, ...(recoverable ? { harnessSessionId } : {}) }
  if (wait) {
    const timeout = Number(Bun.env.CLANKER_WAIT_TIMEOUT || 600) * 1000
    const settled = await waitForClanker(clankerId, { afterGeneration: 0, timeoutMs: timeout })
    spawned.settled = settled
    if (harness === "pi") {
      const result = await resultForClanker(clankerId, settled.settledGeneration)
      if (result.status !== 0) throw new Error(result.errorMessage || result.stopReason || "clanker failed")
      spawned.result = result.reply
    }
  }
  return spawned
}

export async function createWorkshop(branch: string, base?: string, options: { parentWorkshopId?: string | null; preserveParent?: boolean; mode?: LineageMode; copy?: string; multiplexer?: ManagedMultiplexer } = {}) {
  const result = await command(["wt", "switch", "--create", branch, "--no-cd", "--format", "json", ...(base ? ["--base", base] : []), ...(options.copy ? ["--copy", options.copy] : [])])
  let worktree: { path?: string }
  try { worktree = JSON.parse(result.stdout) }
  catch { throw new Error(`Worktrunk returned invalid JSON while creating '${branch}'`) }
  if (!worktree.path) throw new Error(`Worktrunk created '${branch}', but did not return its path`)
  const id = await identity(worktree.path)
  return { identity: id, session: await ensureSession(id, options) }
}

export interface InvokingSessionTarget { nativeSessionId: string; panePath?: string }

export const invokingSessionTarget = async (multiplexer: ManagedMultiplexer, env: Record<string, string | undefined> = Bun.env): Promise<InvokingSessionTarget | undefined> => {
  if (!multiplexer.adapter.insideRuntime()) return undefined
  const paneAddress = env[multiplexer.paneAddressEnv()]?.trim()
  if (paneAddress) {
    const snapshot = await multiplexer.observe()
    const matches = snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes
      .filter((pane) => pane.id === paneAddress)
      .map((pane) => ({ nativeSessionId: session.id, panePath: pane.currentPath }))))
    if (matches.length !== 1) throw new Error(`Invoking ${multiplexer.kind} pane ${paneAddress} does not identify exactly one session`)
    return matches[0]
  }
  const current = await multiplexer.currentLocation()
  return current ? { nativeSessionId: current.nativeSessionId } : undefined
}

const explicitParentRecord = (parentWorkshopId: string) => {
  const record = workshopForId(parentWorkshopId)
  if (record) return record
  throw new Error(`Unknown workshop parent id: ${parentWorkshopId}`)
}

const captureAutomaticParent = async (mode: LineageMode, multiplexer: ManagedMultiplexer) => {
  try {
    const parentIdentity = await identity(process.cwd())
    const record = persistWorkshopLineage(parentIdentity, { mode })
    const target = await invokingSessionTarget(multiplexer)
    if (target && record) {
      if (target.panePath) {
        const paneIdentity = await identity(target.panePath)
        if (paneIdentity.path !== parentIdentity.path || paneIdentity.commonDir !== parentIdentity.commonDir) {
          throw new Error(`Invoking pane Workshop ${paneIdentity.path} differs from parent Workshop ${parentIdentity.path}`)
        }
      }
      await applyWorkshopClaims(multiplexer, target.nativeSessionId, parentIdentity, record)
    }
    return record
  } catch (error) {
    if (mode === "strict") throw error
    return undefined
  }
}

export async function resolveWorkshopParent(options: { parentWorkshopId?: string; noParent?: boolean }, mode = lineageMode(), multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  if (options.parentWorkshopId && mode === "off") throw new Error("DOTFILES_WORKSHOP_LINEAGE=off does not support --parent")
  if (mode === "off") return { mode, preserveParent: true } as const
  if (options.noParent) return { mode, parentWorkshopId: null, preserveParent: false } as const
  if (options.parentWorkshopId) {
    const parent = explicitParentRecord(options.parentWorkshopId)
    return { mode, parentWorkshopId: parent.workshopId, preserveParent: false } as const
  }
  const parent = await captureAutomaticParent(mode, multiplexer)
  return parent ? { mode, parentWorkshopId: parent.workshopId, preserveParent: false } as const : { mode, preserveParent: true } as const
}

export async function spawnWorkshop(harness: Harness, branch: string, prompt: string, options: { profile?: string; resourceClass?: RecoveryResourceClass; base?: string; copy?: string; window?: string; wait?: boolean; parentWorkshopId?: string; noParent?: boolean; multiplexer?: ManagedMultiplexer } = {}) {
  const multiplexer = options.multiplexer ?? openManagedMultiplexer()
  const parent = await resolveWorkshopParent(options, undefined, multiplexer)
  const created = await createWorkshop(branch, options.base, { ...parent, copy: options.copy, multiplexer })
  return completeWorkshopRegistration(created, () => spawnClanker(harness, created.identity.path, prompt, options.profile, options.window, options.wait, options.resourceClass, multiplexer), (workshop) => rollbackCreatedWorkshop(workshop, { multiplexer }))
}

type CreatedWorkshop = Awaited<ReturnType<typeof createWorkshop>>
type CommandResult = Awaited<ReturnType<typeof command>>

export interface RollbackOptions {
  /** Runs the worktree removal command; injectable for tests. */
  run?: (argv: string[]) => Promise<CommandResult>
  multiplexer?: ManagedMultiplexer
}

export async function rollbackCreatedWorkshop(created: CreatedWorkshop, options: RollbackOptions = {}) {
  const run = options.run ?? ((argv: string[]) => command(argv, undefined, true))
  const multiplexer = options.multiplexer ?? openManagedMultiplexer()
  const cleanupErrors: string[] = []
  try {
    const session = sessionBySelector((await multiplexer.observe()).sessions, created.session)
    if (session) await multiplexer.kill(sessionLocation(session.id))
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : `unable to remove ${multiplexer.kind} session`)
  }
  const removed = await run(["wt", "-C", created.identity.path, "remove", "--foreground", "--force", "--force-delete", "--yes", created.identity.path])
  if (removed.code !== 0) cleanupErrors.push(removed.stderr || "unable to remove worktree and branch")
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "))
}

export async function completeWorkshopRegistration<T>(created: CreatedWorkshop, operation: () => Promise<T>, rollback: (created: CreatedWorkshop) => Promise<void> = rollbackCreatedWorkshop) {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof ClankerRegistrationError)) throw error
    try { await rollback(created) }
    catch (cleanupError) {
      throw new Error(`${error.message}; workshop rollback also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error })
    }
    throw error
  }
}

export async function ensureDirectorySession(directory: string, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {
  const canonical = realpathSync(directory)
  markDirectoryActivity(canonical, "opened")
  const existing = await sessionForPath(canonical, multiplexer)
  if (existing) {
    await multiplexer.claim(sessionLocation(existing.id), "directoryPath", canonical)
    await ensureManagedSession(existing.id, multiplexer)
    return existing.name
  }
  const base = safeName(basename(canonical)) || "shell"
  let name = base
  const sessions = (await multiplexer.observe()).sessions
  const current = sessionBySelector(sessions, name)
  if (current && sessionPathOf(current) !== canonical) name = `${base}-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`
  const present = sessionBySelector(sessions, name)
  const nativeSessionId = present?.id ?? (await multiplexer.spawn({ scope: "session", name, cwd: canonical, windowName: "main", env: spawnedRuntimeEnv(multiplexer) })).nativeSessionId
  await multiplexer.claim(sessionLocation(nativeSessionId), "directoryPath", canonical)
  await ensureManagedSession(nativeSessionId, multiplexer)
  return name
}

export async function currentWorkshopClankers(cwd = process.cwd()) {
  return listClankers({ cwd })
}

export async function sendToPane(pane: string, text: string, submit = true, delivery?: ClankerDelivery) {
  if (!submit) throw new Error("Native clanker transports cannot append without submitting a user message")
  const clanker = await clankerForPane(pane)
  return sendClanker(clanker.id, text, { delivery })
}

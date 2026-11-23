/**
 * `clankers routine`: a clanker registers, lists, changes and cancels its own Routines. Without
 * `--clanker`, the Routine belongs to the calling clanker (CLANKER_ID, else the pane's claim);
 * naming another clanker has to be explicit, and from inside a clanker a Routine of another one
 * can be changed or cancelled only by naming its clanker too.
 */
import { existsSync } from "node:fs"
import { ClankerApiError, listClankers, messageDeliveryProof, retypeMessage, sendClanker, type ClankerInfo } from "./clanker-api"
import { openClankerLedger, type LedgerClanker } from "./clanker-ledger"
import { isDone } from "./labels"
import type { ManagedMultiplexer } from "./multiplexer"
import { withOrchestrationStore } from "./orchestration"
import { reportingClankerId } from "./report"
import { RoutineNotFoundError, defaultRoutineTimeZone, describeRoutine, fireDueRoutines, withRoutineStore, type Routine, type RoutineNotice, type RoutineWorkshopVerdict } from "./routines"
import { workshopForId, workshopLabels } from "./workshop"
import { resumeClanker } from "./workflow"

export interface RoutineCaller {
  /** The clanker running the command, or null for the operator outside any clanker. */
  self: string | null
  /** The caller's workshop: a Routine of its workshop is its own, whichever clanker took its last wake. */
  workshopId?: string | null
}

/** A clanker's workshop: its ledger row, else the workshop it was launched in. */
const workshopOfClanker = (clankerId: string, env: Record<string, string | undefined> = {}) => {
  try {
    const ledger = openClankerLedger()
    try { const row = ledger.get(clankerId); if (row) return row.workshopId } finally { ledger.close() }
  } catch {}
  return env.CLANKER_ID?.trim() === clankerId ? env.CLANKERHOUSE_WORKSHOP_ID?.trim() || null : null
}

export const routineCaller = async (env: Record<string, string | undefined> = Bun.env, multiplexer?: ManagedMultiplexer): Promise<RoutineCaller> => {
  let self: string
  try { self = await reportingClankerId(env, multiplexer) }
  catch { return { self: null } }
  return { self, workshopId: workshopOfClanker(self, env) }
}

const sameWorkshop = (caller: RoutineCaller, routine: Routine) => Boolean(caller.workshopId && routine.workshopId === caller.workshopId)

const notFound = (error: unknown): never => {
  if (error instanceof RoutineNotFoundError) throw new ClankerApiError("NOT_FOUND", error.message, 3)
  throw error
}

/** An explicitly named clanker must be one Clankerhouse knows: live now, or open in the ledger. */
const knownClanker = async (clankerId: string) => {
  const live = await listClankers().then((clankers) => clankers.some((clanker) => clanker.id === clankerId), () => false)
  if (live) return
  const ledger = openClankerLedger()
  try { if (ledger.get(clankerId)?.state === "open") return } finally { ledger.close() }
  throw new ClankerApiError("NOT_FOUND", `Unknown clanker ${clankerId}`, 3)
}

const owner = (caller: RoutineCaller, explicit: string | undefined) => {
  const clankerId = explicit ?? caller.self
  if (!clankerId) throw new Error("Cannot tell which clanker this routine is for: CLANKER_ID is unset and this pane has no clanker claim. Run it from inside a clanker, or name one with --clanker ID")
  return clankerId
}

/** A Routine is changed by its own clanker, by the operator, or by a caller that names its clanker. */
const authorise = (caller: RoutineCaller, routine: Routine, explicit: string | undefined) => {
  if (explicit !== undefined && explicit !== routine.clankerId) throw new ClankerApiError("NOT_FOUND", `Routine ${routine.routineId} does not belong to clanker ${explicit}`, 3)
  if (caller.self === null || caller.self === routine.clankerId || explicit === routine.clankerId || sameWorkshop(caller, routine)) return
  throw new Error(`Routine ${routine.routineId} belongs to clanker ${routine.clankerId}, not to you (${caller.self}); pass --clanker ${routine.clankerId} to change another clanker's routine`)
}

export interface AddRoutineRequest { cron: string; message: string; name?: string; timeZone?: string; clanker?: string; workshop?: string }

export async function addRoutine(request: AddRoutineRequest, caller: RoutineCaller, options: { storePath?: string; env?: Record<string, string | undefined>; now?: number } = {}) {
  const clankerId = owner(caller, request.clanker)
  if (request.clanker !== undefined && request.clanker !== caller.self) await knownClanker(clankerId)
  const timeZone = request.timeZone ?? defaultRoutineTimeZone(options.env)
  // The Routine belongs to the clanker's workshop, so it outlives the clanker.
  const workshopId = request.workshop ?? (clankerId === caller.self ? caller.workshopId ?? null : workshopOfClanker(clankerId, options.env ?? Bun.env))
  const routine = withRoutineStore((store) => store.add({ clankerId, workshopId, cron: request.cron, timeZone, message: request.message, name: request.name, createdBy: caller.self ?? "operator", now: options.now }), options.storePath)
  return describeRoutine(routine)
}

export function listRoutines(request: { clanker?: string; all?: boolean; includeEnded?: boolean }, caller: RoutineCaller, options: { storePath?: string } = {}) {
  // Inside a clanker the default is its own Routines; the operator sees every clanker's.
  const clankerId = request.all ? undefined : request.clanker ?? caller.self ?? undefined
  const workshopId = request.all || request.clanker ? undefined : caller.workshopId ?? undefined
  const routines = withRoutineStore((store) => store.list({ clankerId, workshopId, includeEnded: request.includeEnded }), options.storePath)
  return { clankerId: clankerId ?? null, routines: routines.map(describeRoutine) }
}

export function showRoutine(routineId: string, options: { storePath?: string } = {}) {
  const routine = withRoutineStore((store) => store.get(routineId), options.storePath)
  if (!routine) notFound(new RoutineNotFoundError(routineId))
  return describeRoutine(routine!)
}

export function updateRoutine(routineId: string, changes: { cron?: string; message?: string; name?: string; timeZone?: string }, caller: RoutineCaller, options: { clanker?: string; storePath?: string; now?: number } = {}) {
  if (changes.cron === undefined && changes.message === undefined && changes.name === undefined && changes.timeZone === undefined) throw new Error("Nothing to update: pass --cron, --message, --name or --tz")
  return withRoutineStore((store) => {
    const routine = store.get(routineId)
    if (!routine) notFound(new RoutineNotFoundError(routineId))
    authorise(caller, routine!, options.clanker)
    return describeRoutine(store.update(routineId, changes, options.now))
  }, options.storePath)
}

export function cancelRoutine(routineId: string, caller: RoutineCaller, options: { clanker?: string; storePath?: string } = {}) {
  return withRoutineStore((store) => {
    const routine = store.get(routineId)
    if (!routine) notFound(new RoutineNotFoundError(routineId))
    authorise(caller, routine!, options.clanker)
    return { ...describeRoutine(store.cancel(routineId)), cancelled: true }
  }, options.storePath)
}

/** Clear a Routine's alert once the operator has seen it (it leaves the needs-me list). */
export function dismissRoutineAlert(routineId: string, caller: RoutineCaller, options: { clanker?: string; storePath?: string } = {}) {
  return withRoutineStore((store) => {
    const routine = store.get(routineId)
    if (!routine) notFound(new RoutineNotFoundError(routineId))
    authorise(caller, routine!, options.clanker)
    return describeRoutine(store.dismissAlert(routineId))
  }, options.storePath)
}

/** Routines that need the operator, for `clankers needs-me`. */
export function routineAlerts(options: { storePath?: string; now?: number } = {}) {
  try { return withRoutineStore((store) => store.alerts(options.now), options.storePath) }
  catch { return [] }
}

const withLedger = <T>(work: (ledger: ReturnType<typeof openClankerLedger>) => T): T => {
  const ledger = openClankerLedger()
  try { return work(ledger) } finally { ledger.close() }
}

/** A Routine's workshop: done (status=done) or gone (removed, self-destructed) ends it; otherwise it is open. */
export const routineWorkshopVerdict = (routine: Routine): RoutineWorkshopVerdict => {
  const workshopId = routine.workshopId ?? withLedger((ledger) => ledger.get(routine.clankerId)?.workshopId ?? null)
  if (!workshopId) return { kind: "open", workshopId: null }
  const record = workshopForId(workshopId)
  if (!record || !existsSync(record.canonicalPath)) return { kind: "ended", reason: `its workshop ${workshopId} no longer exists (removed or self-destructed)` }
  if (isDone(workshopLabels(workshopId))) return { kind: "ended", reason: `its workshop ${record.canonicalPath} is marked done` }
  return { kind: "open", workshopId }
}

const settled = (clanker: ClankerInfo) => clanker.state === "idle" || clanker.state === "done"

/**
 * The clanker that takes the workshop's wake: the Routine's own clanker while it lives, else the
 * workshop's live clanker on the same harness session (it was closed and came back), else the
 * workshop's newest live clanker.
 */
export const liveWorkshopClanker = async (routine: Routine, workshopId: string | null, live?: ClankerInfo[]): Promise<string | undefined> => {
  const clankers = live ?? await listClankers()
  if (clankers.some((clanker) => clanker.id === routine.clankerId)) return routine.clankerId
  if (!workshopId) return undefined
  const rows = withLedger((ledger) => ledger.list({ workshopId }))
  const liveIds = new Set(clankers.map((clanker) => clanker.id))
  const inWorkshop = rows.filter((row) => liveIds.has(row.clankerId))
  const session = rows.find((row) => row.clankerId === routine.clankerId)?.harnessSessionId
  const sameSession = session ? inWorkshop.filter((row) => row.harnessSessionId === session) : []
  const pick = (candidates: LedgerClanker[]) => candidates.toSorted((left, right) => right.createdAt - left.createdAt)[0]?.clankerId
  return pick(sameSession) ?? pick(inWorkshop)
}

export const ROUTINE_RESUME_WAIT_MS = Number(Bun.env.CLANKERHOUSE_ROUTINE_RESUME_WAIT_MS ?? 180_000) || 180_000

/**
 * Resume the workshop's last session (the newest ledger row with a harness session) and wait until
 * its harness reports in and settles: its input box is up. Rejects with why it did not come back.
 */
export const resumeWorkshopSession = async (routine: Routine, workshopId: string | null, options: { multiplexer?: ManagedMultiplexer; waitMs?: number; pollMs?: number } = {}): Promise<string> => {
  const rows = withLedger((ledger) => workshopId ? ledger.list({ workshopId }) : [ledger.get(routine.clankerId)].filter((row): row is LedgerClanker => !!row))
  const last = rows.filter((row) => row.harnessSessionId).toSorted((left, right) => right.updatedAt - left.updatedAt)[0]
  if (!last) throw new Error("the workshop has no session to resume")
  const startedAt = Date.now()
  await resumeClanker(last.clankerId, { multiplexer: options.multiplexer })
  const deadline = startedAt + (options.waitMs ?? ROUTINE_RESUME_WAIT_MS)
  let seen: ClankerInfo | undefined
  while (Date.now() < deadline) {
    await Bun.sleep(options.pollMs ?? 2_000)
    seen = (await listClankers().catch(() => [])).find((clanker) => clanker.id === last.clankerId)
    if (seen && settled(seen) && (seen.lastEventAt ?? 0) >= startedAt - 1_000) return last.clankerId
  }
  throw new Error(seen
    ? `resumed ${last.clankerId}, but its input box did not come up within ${Math.round((options.waitMs ?? ROUTINE_RESUME_WAIT_MS) / 1000)}s (state ${seen.state}${seen.blockedMessage ? `: ${seen.blockedMessage}` : ""}; a startup dialog or quota?)`
    : `resumed ${last.clankerId}, but it never appeared (did the harness exit at once?)`)
}

/** A notice as a Status Event draft, for the configured sinks (a phone push) to carry. */
export const routineNoticeEvent = (notice: RoutineNotice) => {
  const { routine } = notice
  const label = routine.name ?? routine.routineId
  const workshop = routine.workshopId ? workshopForId(routine.workshopId) : undefined
  const where = workshop?.canonicalPath ?? null
  const summary = notice.kind === "ended"
    ? `Routine ${label} ended: ${notice.reason}`
    : `Routine ${label} is broken: ${notice.reason}`
  return {
    dedupeKey: `routine.${notice.kind}:${routine.routineId}:${notice.at}`,
    type: `routine.${notice.kind}` as const,
    at: notice.at,
    clankerId: routine.clankerId,
    oldState: notice.kind === "ended" ? "active" : "working",
    newState: notice.kind,
    summary,
    facts: { workshopId: routine.workshopId, workshop: where ? where.split("/").pop() ?? null : null, title: label, repo: null, branch: workshop?.branch ?? null, worktree: where, pane: null, harness: null },
    details: { routineId: routine.routineId, name: routine.name, cron: routine.cron, timeZone: routine.timeZone, reason: notice.reason, missedAt: routine.missedAt },
  }
}

/** The daemon's pass: wake each due Routine's workshop through the ordinary send path. */
export const fireRoutinesThroughSend = (multiplexer?: ManagedMultiplexer, options: { now?: () => number; storePath?: string; notify?: (notice: RoutineNotice) => void | Promise<void> } = {}) => fireDueRoutines({
  ...options,
  workshop: routineWorkshopVerdict,
  liveClanker: (routine, workshopId) => liveWorkshopClanker(routine, workshopId),
  resume: (routine, workshopId) => resumeWorkshopSession(routine, workshopId, { multiplexer }),
  send: async (routine, requestId, clankerId) => {
    // `auto`: delivered now to a settled clanker, queued behind a running turn or the operator's draft.
    const receipt = await sendClanker(clankerId, routine.message, { delivery: "auto", requestId, sender: `routine:${routine.routineId}`, source: "routine" }, multiplexer)
    return { messageId: receipt.messageId, delivery: receipt.delivery }
  },
  proof: (clankerId, messageId) => messageDeliveryProof(clankerId, messageId, multiplexer),
  retype: (clankerId, messageId) => retypeMessage(clankerId, messageId, multiplexer),
  stillQueued: (messageId) => {
    try { return withOrchestrationStore((store) => store.message(messageId)?.state === "queued") }
    catch { return false }
  },
  clankerEnded: (clankerId) => {
    try { return withLedger((ledger) => ledger.get(clankerId)?.state === "closed") }
    catch { return false }
  },
})

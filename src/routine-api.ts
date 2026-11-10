/**
 * `clankers routine`: a clanker registers, lists, changes and cancels its own Routines. Without
 * `--clanker`, the Routine belongs to the calling clanker (CLANKER_ID, else the pane's claim);
 * naming another clanker has to be explicit, and from inside a clanker a Routine of another one
 * can be changed or cancelled only by naming its clanker too.
 */
import { ClankerApiError, listClankers, sendClanker } from "./clanker-api"
import { openClankerLedger } from "./clanker-ledger"
import type { ManagedMultiplexer } from "./multiplexer"
import { withOrchestrationStore } from "./orchestration"
import { reportingClankerId } from "./report"
import { RoutineNotFoundError, defaultRoutineTimeZone, describeRoutine, fireDueRoutines, withRoutineStore, type Routine } from "./routines"

export interface RoutineCaller {
  /** The clanker running the command, or null for the operator outside any clanker. */
  self: string | null
}

export const routineCaller = async (env: Record<string, string | undefined> = Bun.env, multiplexer?: ManagedMultiplexer): Promise<RoutineCaller> => {
  try { return { self: await reportingClankerId(env, multiplexer) } }
  catch { return { self: null } }
}

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
  if (caller.self === null || caller.self === routine.clankerId || explicit === routine.clankerId) return
  throw new Error(`Routine ${routine.routineId} belongs to clanker ${routine.clankerId}, not to you (${caller.self}); pass --clanker ${routine.clankerId} to change another clanker's routine`)
}

export interface AddRoutineRequest { cron: string; message: string; name?: string; timeZone?: string; clanker?: string }

export async function addRoutine(request: AddRoutineRequest, caller: RoutineCaller, options: { storePath?: string; env?: Record<string, string | undefined>; now?: number } = {}) {
  const clankerId = owner(caller, request.clanker)
  if (request.clanker !== undefined && request.clanker !== caller.self) await knownClanker(clankerId)
  const timeZone = request.timeZone ?? defaultRoutineTimeZone(options.env)
  const routine = withRoutineStore((store) => store.add({ clankerId, cron: request.cron, timeZone, message: request.message, name: request.name, createdBy: caller.self ?? "operator", now: options.now }), options.storePath)
  return describeRoutine(routine)
}

export function listRoutines(request: { clanker?: string; all?: boolean; includeEnded?: boolean }, caller: RoutineCaller, options: { storePath?: string } = {}) {
  // Inside a clanker the default is its own Routines; the operator sees every clanker's.
  const clankerId = request.all ? undefined : request.clanker ?? caller.self ?? undefined
  const routines = withRoutineStore((store) => store.list({ clankerId, includeEnded: request.includeEnded }), options.storePath)
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

/** The daemon's pass: wake each due Routine's clanker through the ordinary send path. */
export const fireRoutinesThroughSend = (multiplexer?: ManagedMultiplexer, options: { now?: () => number; storePath?: string } = {}) => fireDueRoutines({
  ...options,
  send: async (routine, requestId) => {
    // `auto`: delivered now to a settled clanker, queued behind a running turn or the operator's draft.
    const receipt = await sendClanker(routine.clankerId, routine.message, { delivery: "auto", requestId, sender: `routine:${routine.routineId}`, source: "routine" }, multiplexer)
    return { messageId: receipt.messageId, delivery: receipt.delivery }
  },
  stillQueued: (messageId) => {
    try { return withOrchestrationStore((store) => store.message(messageId)?.state === "queued") }
    catch { return false }
  },
  clankerEnded: (clankerId) => {
    try {
      const ledger = openClankerLedger()
      try { return ledger.get(clankerId)?.state === "closed" } finally { ledger.close() }
    } catch { return false }
  },
})

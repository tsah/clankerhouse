/**
 * Clanker Routines: a clanker's own wake-up schedule. A Routine is a standard five-field cron
 * expression read in an IANA time zone, plus the message the clanker receives when it fires. The
 * daemon fires due Routines through the ordinary send path (`sendClanker`), so a wake to a busy,
 * blocked or focused clanker queues exactly like any other message and nothing is ever typed over
 * the operator's draft. Routines live in the orchestration store, so they survive daemon restarts.
 */
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { orchestrationStatePath } from "./orchestration"

export class RoutineInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RoutineInputError"
  }
}

// ---------------------------------------------------------------------------------------------
// Cron expressions

export interface CronSchedule {
  readonly expression: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** 0 = Sunday ... 6 = Saturday; 7 is accepted as Sunday. */
  readonly daysOfWeek: ReadonlySet<number>
  /** Vixie cron: when both day fields are restricted, a day matching either one fires. */
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
] as const

const parseField = (text: string, field: (typeof FIELDS)[number]): { values: Set<number>; restricted: boolean } => {
  const values = new Set<number>()
  const value = (token: string) => {
    const lower = token.toLowerCase()
    const names = "names" in field ? field.names as readonly string[] : undefined
    const named = names?.indexOf(lower) ?? -1
    if (named >= 0) return named + ("nameBase" in field ? field.nameBase : 0)
    if (!/^\d+$/.test(token)) throw new RoutineInputError(`Invalid ${field.name} '${token}' in cron field '${text}'`)
    const number = Number(token)
    if (number < field.min || number > field.max) throw new RoutineInputError(`${field.name} ${number} is outside ${field.min}-${field.max}`)
    return number
  }
  for (const part of text.split(",")) {
    if (!part) throw new RoutineInputError(`Empty list item in cron field '${text}'`)
    const [range, stepText, extra] = part.split("/")
    if (extra !== undefined || range === undefined || range === "") throw new RoutineInputError(`Invalid cron field '${text}'`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new RoutineInputError(`Invalid step '/${stepText}' in cron field '${text}'`)
      step = Number(stepText)
    }
    let start: number
    let end: number
    if (range === "*") { start = field.min; end = field.name === "day of week" ? 6 : field.max }
    else if (range.includes("-")) {
      const [from, to, more] = range.split("-")
      if (more !== undefined || !from || !to) throw new RoutineInputError(`Invalid range '${range}' in cron field '${text}'`)
      start = value(from)
      end = value(to)
      if (end < start) throw new RoutineInputError(`Range '${range}' runs backwards`)
    } else {
      start = value(range)
      // `5/15` means from 5 to the end of the field, every 15.
      end = stepText !== undefined ? field.max : start
    }
    for (let current = start; current <= end; current += step) values.add(current)
  }
  if (field.name === "day of week" && values.has(7)) { values.delete(7); values.add(0) }
  // As in Vixie cron, a field written from `*` (including `*/2`) counts as unrestricted.
  return { values, restricted: !text.startsWith("*") }
}

/** Parse a five-field cron expression (minute hour day-of-month month day-of-week) or an @macro. */
export const parseCron = (expression: string): CronSchedule => {
  const trimmed = expression.trim().replace(/\s+/g, " ")
  if (!trimmed) throw new RoutineInputError("Cron expression is empty")
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed
  if (expanded.startsWith("@")) throw new RoutineInputError(`Unknown cron macro '${trimmed}'; use ${Object.keys(MACROS).join(", ")}`)
  const parts = expanded.split(" ")
  if (parts.length !== 5) throw new RoutineInputError(`Cron expression '${trimmed}' must have five fields: minute hour day-of-month month day-of-week`)
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((part, index) => parseField(part, FIELDS[index]!))
  return {
    expression: trimmed,
    minutes: minutes!.values,
    hours: hours!.values,
    daysOfMonth: daysOfMonth!.values,
    months: months!.values,
    daysOfWeek: daysOfWeek!.values,
    dayOfMonthRestricted: daysOfMonth!.restricted,
    dayOfWeekRestricted: daysOfWeek!.restricted,
  }
}

// ---------------------------------------------------------------------------------------------
// Time zones

const formatters = new Map<string, Intl.DateTimeFormat>()
const formatterFor = (timeZone: string) => {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/** The wall-clock reading of an instant in `timeZone`. */
export const wallClock = (at: number, timeZone: string): WallClock => {
  const parts: Record<string, string> = {}
  for (const part of formatterFor(timeZone).formatToParts(at)) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAY_NAMES.indexOf((parts.weekday ?? "").toLowerCase().slice(0, 3)),
  }
}

/** An IANA zone name the runtime knows, canonicalised; throws otherwise. */
export const validTimeZone = (timeZone: string) => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone }
  catch { throw new RoutineInputError(`Unknown time zone '${timeZone}'; use an IANA name such as Europe/Amsterdam`) }
}

/**
 * The zone a new Routine's cron is read in when none is given: CLANKERHOUSE_TIMEZONE, else TZ,
 * else the host's zone. It is resolved once, at registration, and stored with the Routine.
 */
export const defaultRoutineTimeZone = (env: Record<string, string | undefined> = Bun.env) => {
  for (const candidate of [env.CLANKERHOUSE_TIMEZONE, env.TZ]) {
    const value = candidate?.trim().replace(/^:/, "")
    if (value) return validTimeZone(value)
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

/** `2026-11-11 09:00 Europe/Amsterdam (Wed)` */
export const formatWallClock = (at: number, timeZone: string) => {
  const wall = wallClock(at, timeZone)
  const two = (value: number) => String(value).padStart(2, "0")
  return `${wall.year}-${two(wall.month)}-${two(wall.day)} ${two(wall.hour)}:${two(wall.minute)} ${timeZone} (${DAY_NAMES[wall.weekday]?.replace(/^./, (c) => c.toUpperCase()) ?? "?"})`
}

const MINUTE_MS = 60_000
// Five years covers every satisfiable expression, including 29 February on a given weekday.
const SEARCH_HORIZON_MS = 5 * 366 * 86_400_000

const dayMatches = (schedule: CronSchedule, wall: WallClock) => {
  const byMonth = schedule.daysOfMonth.has(wall.day)
  const byWeek = schedule.daysOfWeek.has(wall.weekday)
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return byMonth || byWeek
  return byMonth && byWeek
}

/**
 * The first minute strictly after `after` whose wall-clock time in `timeZone` matches the
 * schedule, or null when none exists within five years (e.g. `0 0 31 2 *`). Wall-clock times a
 * daylight-saving change skips never fire; ones it repeats fire at both instants.
 */
export const nextCronTime = (schedule: CronSchedule, after: number, timeZone: string): number | null => {
  let candidate = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = after + SEARCH_HORIZON_MS
  while (candidate <= limit) {
    const wall = wallClock(candidate, timeZone)
    if (!schedule.months.has(wall.month) || !dayMatches(schedule, wall) || !schedule.hours.has(wall.hour)) {
      // Step to the next wall-clock hour; zones offset by 30 or 45 minutes stay aligned to theirs.
      candidate += (60 - wall.minute) * MINUTE_MS
      continue
    }
    if (!schedule.minutes.has(wall.minute)) { candidate += MINUTE_MS; continue }
    return candidate
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Store

export type RoutineState = "active" | "ended"

export interface Routine {
  routineId: string
  clankerId: string
  name: string | null
  cron: string
  timeZone: string
  message: string
  state: RoutineState
  createdAt: number
  createdBy: string
  updatedAt: number
  /** The next scheduled wall-clock minute as an instant; null when the expression never fires again. */
  nextFireAt: number | null
  lastScheduledAt: number | null
  lastFiredAt: number | null
  lastMessageId: string | null
  lastOutcome: string | null
  lastError: string | null
  endedReason: string | null
}

interface RoutineRow {
  routine_id: string
  clanker_id: string
  name: string | null
  cron: string
  time_zone: string
  message: string
  state: RoutineState
  created_at: number
  created_by: string
  updated_at: number
  next_fire_at: number | null
  last_scheduled_at: number | null
  last_fired_at: number | null
  last_message_id: string | null
  last_outcome: string | null
  last_error: string | null
  ended_reason: string | null
}

const fromRow = (row: RoutineRow): Routine => ({
  routineId: row.routine_id,
  clankerId: row.clanker_id,
  name: row.name,
  cron: row.cron,
  timeZone: row.time_zone,
  message: row.message,
  state: row.state,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  nextFireAt: row.next_fire_at,
  lastScheduledAt: row.last_scheduled_at,
  lastFiredAt: row.last_fired_at,
  lastMessageId: row.last_message_id,
  lastOutcome: row.last_outcome,
  lastError: row.last_error,
  endedReason: row.ended_reason,
})

export const MAX_ROUTINE_MESSAGE_BYTES = 64 * 1024
export const MAX_ROUTINE_NAME_CHARS = 80

const generatedRoutineId = () => `routine-${randomBytes(6).toString("hex")}`

const checkedMessage = (message: string) => {
  if (!message.trim()) throw new RoutineInputError("Routine message must not be empty")
  if (Buffer.byteLength(message) > MAX_ROUTINE_MESSAGE_BYTES) throw new RoutineInputError(`Routine message exceeds ${MAX_ROUTINE_MESSAGE_BYTES} bytes`)
  return message
}

const checkedName = (name: string | null | undefined) => {
  if (name === undefined || name === null) return null
  const trimmed = name.trim()
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > MAX_ROUTINE_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RoutineInputError(`Routine name must be 1-${MAX_ROUTINE_NAME_CHARS} characters without control characters`)
  return trimmed
}

const scheduleOrThrow = (cron: string, timeZone: string, now: number) => {
  const schedule = parseCron(cron)
  const zone = validTimeZone(timeZone)
  const next = nextCronTime(schedule, now, zone)
  if (next === null) throw new RoutineInputError(`Cron expression '${schedule.expression}' never fires`)
  return { cron: schedule.expression, timeZone: zone, next }
}

export class RoutineStore {
  private constructor(readonly db: Database) {}

  static open(path = orchestrationStatePath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    db.exec("PRAGMA busy_timeout = 5000")
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null
    if (journal?.journal_mode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        routine_id TEXT PRIMARY KEY,
        clanker_id TEXT NOT NULL,
        name TEXT,
        cron TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        message TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        next_fire_at INTEGER,
        last_scheduled_at INTEGER,
        last_fired_at INTEGER,
        last_message_id TEXT,
        last_outcome TEXT,
        last_error TEXT,
        ended_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS routines_due_idx ON routines(state, next_fire_at);
      CREATE INDEX IF NOT EXISTS routines_clanker_idx ON routines(clanker_id, created_at);
    `)
    return new RoutineStore(db)
  }

  close() { this.db.close() }

  add(input: { clankerId: string; cron: string; timeZone: string; message: string; name?: string | null; createdBy: string; now?: number }): Routine {
    const now = input.now ?? Date.now()
    const { cron, timeZone, next } = scheduleOrThrow(input.cron, input.timeZone, now)
    const row = this.db.query(`INSERT INTO routines (routine_id, clanker_id, name, cron, time_zone, message, state, created_at, created_by, updated_at, next_fire_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?7, ?9) RETURNING *`)
      .get(generatedRoutineId(), input.clankerId, checkedName(input.name), cron, timeZone, checkedMessage(input.message), now, input.createdBy, next) as RoutineRow
    return fromRow(row)
  }

  get(routineId: string): Routine | undefined {
    const row = this.db.query("SELECT * FROM routines WHERE routine_id = ?1").get(routineId) as RoutineRow | null
    return row ? fromRow(row) : undefined
  }

  list(options: { clankerId?: string; includeEnded?: boolean } = {}): Routine[] {
    const rows = this.db.query("SELECT * FROM routines WHERE (?1 IS NULL OR clanker_id = ?1) AND (?2 = 1 OR state = 'active') ORDER BY created_at, routine_id")
      .all(options.clankerId ?? null, options.includeEnded ? 1 : 0) as RoutineRow[]
    return rows.map(fromRow)
  }

  /** Change a Routine; a new cron or zone reschedules it from now, a new message or name does not. */
  update(routineId: string, changes: { cron?: string; timeZone?: string; message?: string; name?: string | null }, now = Date.now()): Routine {
    return this.db.transaction(() => {
      const current = this.get(routineId)
      if (!current) throw new RoutineNotFoundError(routineId)
      if (current.state !== "active") throw new RoutineInputError(`Routine ${routineId} has ended (${current.endedReason ?? "ended"}); add a new one`)
      const rescheduled = changes.cron !== undefined || changes.timeZone !== undefined
        ? scheduleOrThrow(changes.cron ?? current.cron, changes.timeZone ?? current.timeZone, now)
        : { cron: current.cron, timeZone: current.timeZone, next: current.nextFireAt }
      const message = changes.message === undefined ? current.message : checkedMessage(changes.message)
      const name = changes.name === undefined ? current.name : checkedName(changes.name)
      const row = this.db.query("UPDATE routines SET cron = ?2, time_zone = ?3, next_fire_at = ?4, message = ?5, name = ?6, updated_at = ?7 WHERE routine_id = ?1 RETURNING *")
        .get(routineId, rescheduled.cron, rescheduled.timeZone, rescheduled.next, message, name, now) as RoutineRow
      return fromRow(row)
    }).immediate()
  }

  /** Remove a Routine for good. */
  cancel(routineId: string): Routine {
    const row = this.db.query("DELETE FROM routines WHERE routine_id = ?1 RETURNING *").get(routineId) as RoutineRow | null
    if (!row) throw new RoutineNotFoundError(routineId)
    return fromRow(row)
  }

  /** Active Routines whose next fire time has come. */
  due(now: number): Routine[] {
    const rows = this.db.query("SELECT * FROM routines WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?1 ORDER BY next_fire_at, routine_id").all(now) as RoutineRow[]
    return rows.map(fromRow)
  }

  /**
   * Move a due Routine on to its next occurrence after `now`, only if nobody else already did:
   * the compare-and-set on the scheduled time makes each occurrence fire at most once.
   */
  claim(routine: Routine, now: number): boolean {
    if (routine.nextFireAt === null) return false
    let next: number | null
    try { next = nextCronTime(parseCron(routine.cron), now, routine.timeZone) } catch { next = null }
    const changed = this.db.query("UPDATE routines SET next_fire_at = ?3, last_scheduled_at = ?2 WHERE routine_id = ?1 AND state = 'active' AND next_fire_at = ?2")
      .run(routine.routineId, routine.nextFireAt, next).changes
    return changed === 1
  }

  recordOutcome(routineId: string, outcome: { at: number; outcome: string; messageId?: string | null; error?: string | null; fired: boolean }) {
    this.db.query(`UPDATE routines SET last_outcome = ?2, last_error = ?3,
        last_fired_at = CASE WHEN ?4 = 1 THEN ?5 ELSE last_fired_at END,
        last_message_id = CASE WHEN ?4 = 1 THEN ?6 ELSE last_message_id END
      WHERE routine_id = ?1`)
      .run(routineId, outcome.outcome, outcome.error ?? null, outcome.fired ? 1 : 0, outcome.at, outcome.messageId ?? null)
  }

  end(routineId: string, reason: string, now = Date.now()) {
    this.db.query("UPDATE routines SET state = 'ended', ended_reason = ?2, next_fire_at = NULL, updated_at = ?3 WHERE routine_id = ?1").run(routineId, reason, now)
  }
}

export class RoutineNotFoundError extends Error {
  constructor(readonly routineId: string) {
    super(`Unknown routine ${routineId}`)
    this.name = "RoutineNotFoundError"
  }
}

export const withRoutineStore = <T>(work: (store: RoutineStore) => T, path?: string): T => {
  const store = RoutineStore.open(path)
  try { return work(store) }
  finally { store.close() }
}

/** A Routine as the CLI prints it: instants also in the Routine's own zone. */
export const describeRoutine = (routine: Routine) => ({
  ...routine,
  nextFire: routine.nextFireAt === null ? null : formatWallClock(routine.nextFireAt, routine.timeZone),
  nextFireUtc: routine.nextFireAt === null ? null : new Date(routine.nextFireAt).toISOString(),
})

// ---------------------------------------------------------------------------------------------
// Firing

/** A missed occurrence older than this (the daemon was down) is skipped rather than fired late. */
export const ROUTINE_CATCH_UP_MS = 60 * 60_000

export interface RoutineSendResult { messageId: string; delivery: string }

export interface FireRoutinesDeps {
  /** Deliver through the ordinary send path; rejects when the clanker cannot take messages. */
  send: (routine: Routine, requestId: string) => Promise<RoutineSendResult>
  /** The stage of the Routine's previous wake message, if it is still waiting in the queue. */
  stillQueued?: (messageId: string) => boolean
  /** True when the clanker is gone for good (its ledger row is closed), which ends its Routines. */
  clankerEnded?: (clankerId: string) => boolean
  now?: () => number
  catchUpMs?: number
  storePath?: string
}

export interface FiredRoutine { routineId: string; clankerId: string; scheduledAt: number; outcome: "fired" | "skipped-missed" | "skipped-queued" | "failed" | "ended"; messageId?: string; error?: string }

const errorCode = (error: unknown) => (error as { code?: unknown })?.code

/**
 * Fire every due Routine once. Each occurrence is claimed before it is sent and sent with a
 * request id derived from it, so overlapping passes or a crash mid-send can never wake a clanker
 * twice for the same minute. Several missed occurrences collapse into the newest; one missed by
 * more than the catch-up window is skipped. A wake whose previous wake still waits in the queue
 * is skipped, so a long busy stretch never piles up wake-ups.
 */
export async function fireDueRoutines(deps: FireRoutinesDeps): Promise<FiredRoutine[]> {
  const now = deps.now?.() ?? Date.now()
  const catchUpMs = deps.catchUpMs ?? ROUTINE_CATCH_UP_MS
  const results: FiredRoutine[] = []
  const store = RoutineStore.open(deps.storePath)
  try {
    for (const routine of store.due(now)) {
      const scheduledAt = routine.nextFireAt!
      if (!store.claim(routine, now)) continue
      // When several occurrences were missed, the one to fire is the newest that has passed.
      let newest = scheduledAt
      try {
        const schedule = parseCron(routine.cron)
        // Only occurrences inside the catch-up window can fire, so the walk starts there.
        const floor = now - catchUpMs - MINUTE_MS
        if (newest < floor) {
          const first = nextCronTime(schedule, floor, routine.timeZone)
          if (first !== null && first <= now) newest = first
        }
        for (let next = nextCronTime(schedule, newest, routine.timeZone); next !== null && next <= now; next = nextCronTime(schedule, next, routine.timeZone)) newest = next
      } catch {}
      const base = { routineId: routine.routineId, clankerId: routine.clankerId, scheduledAt: newest }
      if (now - newest > catchUpMs) {
        const error = `missed ${new Date(newest).toISOString()}: the daemon was not running`
        store.recordOutcome(routine.routineId, { at: now, outcome: "skipped-missed", error, fired: false })
        results.push({ ...base, outcome: "skipped-missed", error })
        continue
      }
      if (routine.lastMessageId && deps.stillQueued?.(routine.lastMessageId)) {
        const error = `previous wake ${routine.lastMessageId} is still queued`
        store.recordOutcome(routine.routineId, { at: now, outcome: "skipped-queued", error, fired: false })
        results.push({ ...base, outcome: "skipped-queued", error })
        continue
      }
      try {
        const sent = await deps.send(routine, `${routine.routineId}:${newest}`)
        store.recordOutcome(routine.routineId, { at: now, outcome: `fired (${sent.delivery})`, messageId: sent.messageId, fired: true })
        results.push({ ...base, outcome: "fired", messageId: sent.messageId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (errorCode(error) === "NOT_FOUND" && deps.clankerEnded?.(routine.clankerId)) {
          store.recordOutcome(routine.routineId, { at: now, outcome: "ended", error: message, fired: false })
          store.end(routine.routineId, "clanker closed", now)
          results.push({ ...base, outcome: "ended", error: message })
          continue
        }
        store.recordOutcome(routine.routineId, { at: now, outcome: "failed", error: message, fired: false })
        results.push({ ...base, outcome: "failed", error: message })
      }
    }
    return results
  } finally { store.close() }
}

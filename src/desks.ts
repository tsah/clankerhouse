/**
 * Desks: standing Workshops that run on a schedule and publish one long-lived report, such as a weekly quality sweep.
 * A Workshop is a desk when it carries the label `role=desk`; its `report=<url>` label is the link to its latest report.
 * The snapshot decides each desk's facts once (this module is pure; src/snapshot.ts gathers the inputs), so the
 * picker's Desks group and Desks view (native-client) never read the stores, the filesystem or the network on a redraw.
 */
import type { SessionRow } from "./model"
import type { Routine } from "./routines"
import { wallClock } from "./routines"
import { DESK_ROLE, REPORT_KEY, ROLE_KEY, type WorkshopLabels } from "./labels"

export interface Desk {
  /** The desk's report link, its `report` label. */
  report?: string
  /** When the `report` label was last set, epoch ms. */
  reportAt?: number
  /** Active Routines of the desk's clankers. */
  routines: number
  /** The soonest of their next runs, epoch ms. */
  nextRunAt?: number
  /** That run as the operator reads it, in the Routine's own zone: `Sat 20:00 lint-sweep`. */
  nextRun?: string
}

export interface DeskFacts {
  labels: (workshopId: string) => WorkshopLabels | undefined
  /** When the Workshop's `report` label was last set. */
  reportAt: (workshopId: string) => number | undefined
  /** Active Routines. */
  routines: readonly Routine[]
  /** The Workshop a clanker belongs to, for a Routine whose clanker is not on screen. */
  clankerWorkshop: (clankerId: string) => string | undefined
}

export const isDeskLabels = (labels: WorkshopLabels | undefined) => labels?.[ROLE_KEY] === DESK_ROLE

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** `Sat 20:00`, read in the Routine's zone. */
export const routineRunLabel = (at: number, timeZone: string) => {
  const wall = wallClock(at, timeZone)
  const two = (value: number) => String(value).padStart(2, "0")
  return `${DAYS[wall.weekday] ?? "?"} ${two(wall.hour)}:${two(wall.minute)}`
}

/** Marks every row of a desk Workshop with its desk facts. */
export const annotateDesks = (rows: SessionRow[], facts: DeskFacts) => {
  const desks = new Map<string, Desk>()
  for (const row of rows) {
    if (!row.workshopId || desks.has(row.workshopId)) continue
    const labels = facts.labels(row.workshopId)
    if (!isDeskLabels(labels)) continue
    const report = labels?.[REPORT_KEY]
    desks.set(row.workshopId, { routines: 0, ...(report ? { report, reportAt: facts.reportAt(row.workshopId) } : {}) })
  }
  if (desks.size === 0) return
  // A Routine belongs to a clanker; the clanker's Workshop is on screen, or else in the ledger.
  const onScreen = new Map<string, string>()
  for (const row of rows) {
    for (const detail of row.details) if (detail.clankerId && row.workshopId) onScreen.set(detail.clankerId, row.workshopId)
  }
  for (const routine of facts.routines) {
    if (routine.state !== "active") continue
    const workshopId = onScreen.get(routine.clankerId) ?? facts.clankerWorkshop(routine.clankerId)
    const desk = workshopId ? desks.get(workshopId) : undefined
    if (!desk) continue
    desk.routines += 1
    if (routine.nextFireAt !== null && (desk.nextRunAt === undefined || routine.nextFireAt < desk.nextRunAt)) {
      desk.nextRunAt = routine.nextFireAt
      desk.nextRun = [routineRunLabel(routine.nextFireAt, routine.timeZone), routine.name].filter(Boolean).join(" ")
    }
  }
  for (const row of rows) {
    const desk = row.workshopId ? desks.get(row.workshopId) : undefined
    if (desk) row.desk = { ...desk }
  }
}

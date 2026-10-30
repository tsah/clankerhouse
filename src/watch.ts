/**
 * `clankers watch`: one background command that wakes an orchestrator on any child event.
 *
 * Each poll builds a WatchView from the live herd, the Workshop lineage, and the Report
 * store, and the pure core in `orchestration.ts` turns it into events. Each event is
 * written and flushed before the cursor records it, so a crash between the two repeats
 * that event on resume and never loses one.
 */
import { existsSync, realpathSync, writeSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { ClankerApiError, deliverQueuedMessages, listClankers, type ClankerInfo } from "./clanker-api"
import { openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import {
  DEFAULT_STALE_AFTER_MS, OrchestrationStore, advanceWatchCursor, computeWatchEvents, initialWatchCursor, readWatchCursor, settleWatchCursor, writeWatchCursor,
  type WatchCursor, type WatchEvent, type WatchView, type WatchedClanker,
} from "./orchestration"
import { listWorkshopRecords, projectSnapshot, workshopForId, workshopForPath, type WorkshopRecord } from "./workshop"

export type WatchScope =
  | { kind: "children"; workshopId: string; descendants: boolean }
  | { kind: "clankers"; clankerIds: readonly string[] }

export interface WatchLoopOptions {
  /** One poll: the view after `seq`, or with no reports when the watch has no cursor yet. */
  view: (seq: number | undefined) => Promise<WatchView>
  emit: (event: WatchEvent) => void
  cursorFile?: string
  once?: boolean
  timeoutMs?: number
  staleAfterMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  readCursor?: (path: string) => WatchCursor | undefined
  writeCursor?: (path: string, cursor: WatchCursor) => void
}

export const DEFAULT_WATCH_POLL_MS = 2_000

export async function runWatch(options: WatchLoopOptions) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const read = options.readCursor ?? readWatchCursor
  const write = options.writeCursor ?? writeWatchCursor
  const persist = (cursor: WatchCursor) => { if (options.cursorFile) write(options.cursorFile, cursor) }
  const started = now()
  let cursor = options.cursorFile ? read(options.cursorFile) : undefined
  while (true) {
    let view: WatchView | undefined
    try { view = await options.view(cursor?.seq) }
    catch { view = undefined }
    if (view) {
      if (!cursor) {
        // Starting from now: persist the baseline at once so a re-armed watch misses nothing.
        cursor = initialWatchCursor(view)
        persist(cursor)
      }
      const events = computeWatchEvents(cursor, view, { staleAfterMs: options.staleAfterMs })
      for (const event of events) {
        options.emit(event)
        cursor = advanceWatchCursor(cursor, event)
        persist(cursor)
      }
      const settled = settleWatchCursor(cursor, view)
      if (JSON.stringify(settled) !== JSON.stringify(cursor)) persist(settled)
      cursor = settled
      if (options.once && events.length) return
    }
    if (options.timeoutMs !== undefined && now() - started >= options.timeoutMs) {
      throw new ClankerApiError("TIMEOUT", "Timed out watching; no further events, the cursor is unchanged", 124)
    }
    await sleep(options.pollMs ?? DEFAULT_WATCH_POLL_MS)
  }
}

/** Write one JSON line synchronously, so the event is out before the cursor records it. */
export const emitJsonLine = (event: WatchEvent) => { writeSync(1, `${JSON.stringify(event)}\n`) }

const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

const gitTopLevel = (cwd: string) => {
  // A pane whose directory was deleted has no checkout to ask.
  if (!existsSync(cwd)) return resolve(cwd)
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" })
  return realpathSafe(git.exitCode === 0 ? git.stdout.toString().trim() : cwd)
}

/** The Workshop the caller runs in: the launch environment's claim when registered, else the enclosing worktree. */
export const currentWorkshop = (cwd = process.cwd(), env: Record<string, string | undefined> = Bun.env): WorkshopRecord | undefined => {
  const declared = env.CLANKERHOUSE_WORKSHOP_ID?.trim()
  const fromEnv = declared ? workshopForId(declared) : undefined
  return fromEnv ?? workshopForPath(gitTopLevel(cwd))
}

/** Resolve like `clankers spawn --workshop` (id, branch, path, basename), plus `.` for the current Workshop. */
export const resolveWorkshopSelector = (selector: string, cwd = process.cwd()): WorkshopRecord => {
  if (selector === ".") {
    const current = currentWorkshop(cwd)
    if (!current) throw new ClankerApiError("NOT_FOUND", `${cwd} is not inside a registered Workshop`, 3)
    return current
  }
  const byId = workshopForId(selector)
  if (byId) return byId
  // An absolute path names a Workshop of any repository; branches and basenames only reach the current one.
  const byPath = isAbsolute(selector) ? workshopForPath(selector) : undefined
  if (byPath) return byPath
  let workshops: WorkshopRecord[] = []
  try { workshops = projectSnapshot(cwd).workshops } catch {}
  const matches = workshops.filter((row) => row.workshopId === selector || row.branch === selector || row.canonicalPath === selector || row.canonicalPath.endsWith(`/${selector}`))
  if (matches.length === 0) throw new ClankerApiError("NOT_FOUND", `Unknown workshop: ${selector}`, 3)
  if (matches.length > 1) throw new ClankerApiError("AMBIGUOUS", `Ambiguous workshop '${selector}'; use its durable workshop ID`, 3)
  return matches[0]!
}

/** The Workshops whose clankers a `--children-of` watch follows, resolved again on every poll. */
export const watchedWorkshopIds = (workshops: readonly WorkshopRecord[], parentId: string, descendants: boolean) => {
  const byParent = Map.groupBy(workshops, (workshop) => workshop.parentWorkshopId ?? "")
  const watched = new Set<string>()
  let frontier = [parentId]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) for (const child of byParent.get(id) ?? []) {
      if (watched.has(child.workshopId) || child.workshopId === parentId) continue
      watched.add(child.workshopId)
      next.push(child.workshopId)
    }
    frontier = descendants ? next : []
  }
  return watched
}

/** The checkout each clanker runs in, keyed like `WorkshopRecord.canonicalPath`; git lookups are cached per cwd. */
export const clankerWorkshopPaths = () => {
  const topLevels = new Map<string, string>()
  return (clanker: Pick<ClankerInfo, "cwd" | "worktreePath">) => {
    if (clanker.worktreePath) return realpathSafe(clanker.worktreePath)
    if (!topLevels.has(clanker.cwd)) topLevels.set(clanker.cwd, gitTopLevel(clanker.cwd))
    return topLevels.get(clanker.cwd)!
  }
}

export interface LiveWatchDependencies {
  multiplexer?: ManagedMultiplexer
  listClankers?: () => Promise<ClankerInfo[]>
  listWorkshops?: () => WorkshopRecord[]
  openStore?: () => OrchestrationStore
  deliver?: () => Promise<unknown>
  now?: () => number
}

export const liveWatchView = (scope: WatchScope, dependencies: LiveWatchDependencies = {}) => {
  const multiplexer = dependencies.multiplexer ?? openManagedMultiplexer()
  const list = dependencies.listClankers ?? (() => listClankers({ multiplexer, strict: true }))
  const workshopsOf = dependencies.listWorkshops ?? (() => listWorkshopRecords())
  const openStore = dependencies.openStore ?? (() => OrchestrationStore.open())
  const deliver = dependencies.deliver ?? (() => deliverQueuedMessages(multiplexer))
  const now = dependencies.now ?? Date.now
  const pathOf = clankerWorkshopPaths()
  return async (seq: number | undefined): Promise<WatchView> => {
    // Queued Claude messages drain here too, so an orchestrator needs no daemon to be answered.
    await deliver().catch(() => undefined)
    const workshops = workshopsOf()
    const byPath = new Map(workshops.map((workshop) => [workshop.canonicalPath, workshop]))
    const watched = scope.kind === "children" ? watchedWorkshopIds(workshops, scope.workshopId, scope.descendants) : undefined
    const ids = scope.kind === "clankers" ? new Set(scope.clankerIds) : undefined
    const clankers: WatchedClanker[] = (await list()).flatMap((clanker) => {
      const workshop = byPath.get(pathOf(clanker))
      if (watched ? !workshop || !watched.has(workshop.workshopId) : !ids!.has(clanker.id)) return []
      return [{
        clankerId: clanker.id,
        workshopId: workshop?.workshopId ?? "",
        parentWorkshopId: workshop?.parentWorkshopId ?? null,
        state: clanker.state,
        generation: clanker.generation,
        settledGeneration: clanker.settledGeneration,
        lastEventAt: clanker.lastEventAt ?? 0,
      }]
    })
    const store = openStore()
    try {
      const reports = seq === undefined ? [] : scope.kind === "children"
        ? store.reportsAfter(seq, { workshopIds: [...watched!], to: [scope.workshopId] })
        : store.reportsAfter(seq, { clankerIds: [...ids!] })
      return { now: now(), clankers, reports, latestSeq: store.latestSeq() }
    } finally { store.close() }
  }
}

export { DEFAULT_STALE_AFTER_MS }

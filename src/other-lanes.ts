/**
 * Clankers running on another lane: open rows in a sibling instance's clanker ledger whose harness
 * still runs in its systemd scope, but which this lane does not see. They are left over from a
 * Multiplexer switch (the Herdr TUI lane after the cut-over to hc) and stay alive and idle until
 * someone moves them; without this they look like dead Workshops.
 *
 * Sibling ledgers are only read, never migrated or written, except by `moveClankerFromLane` closing
 * the row it moved.
 */
import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { LaunchSpec, LedgerClanker, LedgerHarness } from "./clanker-ledger"
import { instanceSlug, stateHomeDefault } from "./paths"

export interface ForeignClanker {
  /** The instance whose ledger holds the clanker: `herdr` for `clankerhouse-herdr`, `default` for `clankerhouse`. */
  lane: string
  clankerId: string
  harness: LedgerHarness
  workshopId: string
  workshopPath: string
  cwd: string
  harnessSessionId: string | null
  ownerUnit: string
  updatedAt: number
}

/** The lane name of an instance slug: "-herdr" is `herdr`, "" is `default`. */
export const laneName = (slug: string) => slug ? slug.slice(1) : "default"

/** The current lane, as `CLANKERHOUSE_INSTANCE` selects it. */
export const currentLane = (env: Record<string, string | undefined> = Bun.env) => laneName(instanceSlug(env))

export const laneStateDir = (lane: string, stateHome = stateHomeDefault()) => {
  if (lane !== "default" && !/^[A-Za-z0-9._-]+$/.test(lane)) throw new Error(`Invalid lane: ${lane}`)
  if (lane === "." || lane === "..") throw new Error(`Invalid lane: ${lane}`)
  return join(stateHome, lane === "default" ? "clankerhouse" : `clankerhouse-${lane}`)
}

export const laneLedgerPath = (lane: string, stateHome = stateHomeDefault()) => join(laneStateDir(lane, stateHome), "clankers.sqlite3")

/** Every other lane in `stateHome` that has a clanker ledger. */
export const siblingLanes = (stateHome = stateHomeDefault(), env: Record<string, string | undefined> = Bun.env) => {
  const current = currentLane(env)
  let names: string[] = []
  try { names = readdirSync(stateHome) } catch { return [] }
  return names
    .flatMap((name) => name === "clankerhouse" ? ["default"] : /^clankerhouse-[A-Za-z0-9._-]+$/.test(name) ? [name.slice("clankerhouse-".length)] : [])
    .filter((lane) => lane !== current && existsSync(laneLedgerPath(lane, stateHome)))
    .sort()
}

interface LedgerRow {
  clanker_id: string; harness: LedgerHarness; workshop_id: string; workshop_path: string; session_label: string; window_label: string; cwd: string
  harness_session_id: string | null; launch_spec: string; original_task: string; state: "open" | "closed"; closed_reason: string | null
  owner_unit: string | null; server_epoch: string | null; created_at: number; updated_at: number
}

const fromRow = (row: LedgerRow): LedgerClanker => ({
  clankerId: row.clanker_id,
  harness: row.harness,
  workshopId: row.workshop_id,
  workshopPath: row.workshop_path,
  sessionLabel: row.session_label,
  windowLabel: row.window_label,
  cwd: row.cwd,
  harnessSessionId: row.harness_session_id,
  launchSpec: JSON.parse(row.launch_spec) as LaunchSpec,
  originalTask: row.original_task,
  state: row.state,
  closedReason: row.closed_reason,
  ownerUnit: row.owner_unit,
  serverEpoch: row.server_epoch,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/**
 * Another lane's ledger, opened read-only: no schema creation, no import, no permission changes.
 * Empty when the file is missing or holds no clanker ledger.
 */
export const readLaneLedger = (path: string, options: { state?: "open" | "closed"; clankerId?: string } = {}): LedgerClanker[] => {
  if (!existsSync(path)) return []
  let db: Database
  try { db = new Database(path, { readonly: true }) } catch { return [] }
  try {
    db.exec("PRAGMA busy_timeout = 2000")
    const version = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0)
    if (version !== 1) return []
    const rows = db.query("SELECT * FROM clankers WHERE (?1 IS NULL OR state = ?1) AND (?2 IS NULL OR clanker_id = ?2) ORDER BY created_at, clanker_id")
      .all(options.state ?? null, options.clankerId ?? null) as LedgerRow[]
    return rows.map(fromRow)
  } catch { return [] }
  finally { db.close() }
}

export interface UnitProcess { pid: number; name: string; argv: string[] }
export interface UnitState { active: boolean; processes: UnitProcess[] }
/** The state and processes of each systemd user unit named. */
export type UnitProbe = (units: readonly string[]) => Map<string, UnitState>

const readText = (path: string) => { try { return readFileSync(path, "utf8") } catch { return "" } }

export const cgroupProcesses = (controlGroup: string): UnitProcess[] => {
  if (!controlGroup.startsWith("/")) return []
  return readText(join("/sys/fs/cgroup", controlGroup, "cgroup.procs")).split("\n").filter(Boolean).flatMap((value) => {
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0) return []
    const name = readText(`/proc/${pid}/comm`).trim()
    if (!name) return []
    return [{ pid, name, argv: readText(`/proc/${pid}/cmdline`).split("\0").filter(Boolean) }]
  })
}

/** Parses `systemctl show -p Id -p ActiveState -p ControlGroup` output for several units. */
export const parseUnitShow = (output: string) => {
  const units = new Map<string, { active: boolean; controlGroup: string }>()
  for (const block of output.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split("\n").flatMap((line) => {
      const at = line.indexOf("=")
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : []
    }))
    if (fields.Id) units.set(fields.Id, { active: fields.ActiveState === "active", controlGroup: fields.ControlGroup ?? "" })
  }
  return units
}

const unitPattern = /^clankerhouse-[A-Za-z0-9_.-]+\.scope$/

export const systemdUnitProbe: UnitProbe = (units) => {
  const result = new Map<string, UnitState>()
  const named = [...new Set(units)].filter((unit) => unitPattern.test(unit))
  if (!named.length) return result
  const shown = Bun.spawnSync(["systemctl", "--user", "show", "--property=Id", "--property=ActiveState", "--property=ControlGroup", "--", ...named], { stdout: "pipe", stderr: "pipe" })
  if (shown.exitCode !== 0) return result
  for (const [unit, state] of parseUnitShow(shown.stdout.toString())) {
    result.set(unit, { active: state.active, processes: state.active ? cgroupProcesses(state.controlGroup) : [] })
  }
  return result
}

/** A process is the harness when its name, or the program its argv starts, is the harness's. */
export const isHarnessProcess = (process: UnitProcess, harness: string) =>
  process.name === harness || process.argv.slice(0, 2).some((arg) => basename(arg) === harness)

/** Whether `harness` still runs in `unit`; a scope held open only by a leftover child does not count. */
export const harnessRunsIn = (state: UnitState | undefined, harness: string) =>
  !!state?.active && state.processes.some((process) => isHarnessProcess(process, harness))

export interface ForeignClankerOptions {
  stateHome?: string
  env?: Record<string, string | undefined>
  /** Lanes to look in; every sibling lane by default. */
  lanes?: readonly string[]
  /** Clanker ids alive in this lane, which are never foreign. */
  aliveHere?: ReadonlySet<string>
  probe?: UnitProbe
}

/**
 * Open clankers of other lanes whose harness still runs in its scope and that this lane does not
 * see. A clanker listed by more than one lane is reported once, from the most recently updated row.
 */
export const foreignClankers = (options: ForeignClankerOptions = {}): ForeignClanker[] => {
  const stateHome = options.stateHome ?? stateHomeDefault(options.env)
  const lanes = options.lanes ?? siblingLanes(stateHome, options.env)
  const candidates = lanes.flatMap((lane) => readLaneLedger(laneLedgerPath(lane, stateHome), { state: "open" })
    .filter((row) => row.ownerUnit && !options.aliveHere?.has(row.clankerId))
    .map((row) => ({ lane, row })))
  if (!candidates.length) return []
  const states = (options.probe ?? systemdUnitProbe)(candidates.map(({ row }) => row.ownerUnit!))
  const byId = new Map<string, ForeignClanker>()
  for (const { lane, row } of candidates) {
    if (!harnessRunsIn(states.get(row.ownerUnit!), row.harness)) continue
    const previous = byId.get(row.clankerId)
    if (previous && previous.updatedAt >= row.updatedAt) continue
    byId.set(row.clankerId, {
      lane,
      clankerId: row.clankerId,
      harness: row.harness,
      workshopId: row.workshopId,
      workshopPath: row.workshopPath,
      cwd: row.cwd,
      harnessSessionId: row.harnessSessionId,
      ownerUnit: row.ownerUnit!,
      updatedAt: row.updatedAt,
    })
  }
  return [...byId.values()].sort((a, b) => a.workshopPath.localeCompare(b.workshopPath) || a.clankerId.localeCompare(b.clankerId))
}

/** The command that moves a foreign clanker into the current lane. */
export const moveCommand = (clanker: Pick<ForeignClanker, "clankerId" | "lane">) => `clankers resume ${clanker.clankerId} --from-lane ${clanker.lane}`


/** A Workshop's parent in another lane's registry, read-only; undefined when that lane does not know the path. */
export const laneWorkshopParent = (lane: string, workshopPath: string, stateHome = stateHomeDefault()): string | null | undefined => {
  const path = join(laneStateDir(lane, stateHome), "workshops.sqlite3")
  if (!existsSync(path)) return undefined
  let db: Database
  try { db = new Database(path, { readonly: true }) } catch { return undefined }
  try {
    db.exec("PRAGMA busy_timeout = 2000")
    const row = db.query("SELECT parent_id FROM workshops WHERE canonical_path = ?1").get(workshopPath) as { parent_id: string | null } | null
    return row ? row.parent_id : undefined
  } catch { return undefined }
  finally { db.close() }
}

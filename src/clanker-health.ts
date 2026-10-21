import { readdirSync, readFileSync } from "node:fs"
import { basename } from "node:path"
import { safeUnitPart } from "./recovery/process-owner"

/** Resource facts about a clanker's process scope; each field is absent when it cannot be read. */
export interface ClankerHealth {
  /** Bytes, from the scope's memory.current and memory.high; `high` is null when unlimited. */
  memory?: { current: number; high: number | null }
  /** Pids in the scope in uninterruptible sleep (state D). */
  dState?: number[]
  /** The longest-running descendant of the harness; elapsed is in seconds. */
  longestChild?: { pid: number; cmd: string; elapsed: number }
}

export interface HealthRoots {
  /** The cgroup v2 directory holding clanker scopes. */
  slice: string
  proc: string
}

// Linux reports /proc/<pid>/stat start times in clock ticks; USER_HZ is 100 on every supported architecture.
const CLOCK_TICKS = 100
const MAX_CMD = 200

const defaultRoots = (): HealthRoots => {
  const uid = process.getuid?.() ?? 0
  return {
    slice: `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/clankerhouse.slice/clankerhouse-recovery.slice`,
    proc: "/proc",
  }
}

const read = (path: string) => { try { return readFileSync(path, "utf8") } catch { return undefined } }

/** The newest attempt's scope directory for a clanker, matching `recoveryUnitName`. */
const scopeFor = (clankerId: string, slice: string) => {
  const prefix = `clankerhouse-${safeUnitPart(clankerId)}-`
  let entries: string[]
  try { entries = readdirSync(slice) } catch { return undefined }
  const attempts = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".scope") && /^\d+$/.test(name.slice(prefix.length, -".scope".length)))
    .map((name) => ({ name, attempt: Number(name.slice(prefix.length, -".scope".length)) }))
    .sort((a, b) => b.attempt - a.attempt)
  return attempts[0] ? `${slice}/${attempts[0].name}` : undefined
}

interface ProcStat { pid: number; ppid: number; state: string; startTicks: number }

const procStat = (proc: string, pid: number): ProcStat | undefined => {
  const stat = read(`${proc}/${pid}/stat`)
  // The command name may contain spaces and parentheses, so fields count from the last ")".
  const end = stat?.lastIndexOf(")") ?? -1
  if (!stat || end < 0) return undefined
  const fields = stat.slice(end + 2).split(" ")
  const ppid = Number(fields[1])
  const startTicks = Number(fields[19])
  if (!fields[0] || !Number.isFinite(ppid) || !Number.isFinite(startTicks)) return undefined
  return { pid, ppid, state: fields[0], startTicks }
}

const cmdline = (proc: string, pid: number) =>
  (read(`${proc}/${pid}/cmdline`) ?? "").split("\0").filter(Boolean)

/** Health of a clanker's scope. Read-only and Linux-only; elsewhere it is empty. */
export function clankerHealth(clankerId: string, roots: HealthRoots = defaultRoots()): ClankerHealth {
  if (process.platform !== "linux" && roots.proc === "/proc") return {}
  const scope = scopeFor(clankerId, roots.slice)
  if (!scope) return {}
  const health: ClankerHealth = {}

  const current = Number(read(`${scope}/memory.current`)?.trim())
  const high = read(`${scope}/memory.high`)?.trim()
  if (Number.isFinite(current) && high) health.memory = { current, high: high === "max" ? null : Number(high) }

  const procsText = read(`${scope}/cgroup.procs`)
  if (procsText === undefined) return health
  const procs = procsText.split("\n").filter(Boolean).map(Number).map((pid) => procStat(roots.proc, pid)).filter((stat): stat is ProcStat => !!stat)
  health.dState = procs.filter((stat) => stat.state === "D").map((stat) => stat.pid)

  // The scope's root is the lifecycle wrapper when there is one; the harness is then its child.
  const inScope = new Set(procs.map((stat) => stat.pid))
  const root = procs.filter((stat) => !inScope.has(stat.ppid)).sort((a, b) => a.startTicks - b.startTicks)[0]
  if (!root) return health
  const wrapped = cmdline(roots.proc, root.pid).slice(0, 2).some((arg) => basename(arg) === "clankerhouse-harness-lifecycle")
  const harness = wrapped ? procs.filter((stat) => stat.ppid === root.pid).sort((a, b) => a.startTicks - b.startTicks)[0] : root
  if (!harness) return health

  const children = new Map<number, ProcStat[]>()
  for (const stat of procs) children.set(stat.ppid, [...children.get(stat.ppid) ?? [], stat])
  const descendants: ProcStat[] = []
  const pending = [...children.get(harness.pid) ?? []]
  while (pending.length) {
    const next = pending.pop()!
    descendants.push(next)
    pending.push(...children.get(next.pid) ?? [])
  }
  const oldest = descendants.sort((a, b) => a.startTicks - b.startTicks)[0]
  const uptime = Number(read(`${roots.proc}/uptime`)?.split(" ")[0])
  if (oldest && Number.isFinite(uptime)) {
    health.longestChild = {
      pid: oldest.pid,
      cmd: cmdline(roots.proc, oldest.pid).join(" ").slice(0, MAX_CMD),
      elapsed: Math.max(0, Math.round(uptime - oldest.startTicks / CLOCK_TICKS)),
    }
  }
  return health
}

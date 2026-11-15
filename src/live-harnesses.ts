/**
 * Every harness process running on this host, read from /proc, and the worktrees that have more than one.
 *
 * Ledgers and Multiplexers each see only their own lane, so a worktree can end up with a clanker on the old Herdr
 * server, another on hc, and a `claude --resume` typed by hand into a plain terminal, all on the same session or
 * branch. The process table is the one place they all show up. Nothing here stops or touches a process.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import { isHarnessProcess, laneName } from "./other-lanes"
import { instanceSlug } from "./paths"

export const HARNESSES = ["claude", "pi", "opencode"] as const

export interface LiveHarness {
  pid: number
  harness: string
  cwd: string
  /** The Workshop the cwd is in (the longest known Workshop path containing it), else the cwd itself. */
  workshopPath: string
  /** The systemd unit holding the process: a clanker's own `clankerhouse-*.scope`, or e.g. hc's `hc-hold-*.service` for one started in a terminal's shell. */
  unit: string | null
  /** `scope`: its own clanker scope; `terminal`: inside the Multiplexer's terminal holder, started from a shell; `other`: anything else. */
  placement: "scope" | "terminal" | "other"
  /** The lane whose Multiplexer hosts its terminal, null outside any Multiplexer. */
  lane: string | null
  /** hc terminal id or Herdr pane id. */
  terminal: string | null
  /** The clanker id it was launched as (CLANKER_ID), else the one its lane's ledger adopted it under, else null. */
  clankerId: string | null
  /** Its working directory was removed (a deleted worktree); it is then no Workshop's. */
  cwdDeleted: boolean
}

export interface ProcSource {
  pids: () => number[]
  comm: (pid: number) => string
  argv: (pid: number) => string[]
  ppid: (pid: number) => number
  cwd: (pid: number) => string
  cgroup: (pid: number) => string
  environ: (pid: number) => Record<string, string>
}

const read = (path: string) => { try { return readFileSync(path, "utf8") } catch { return "" } }

export const procSource: ProcSource = {
  pids: () => { try { return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number) } catch { return [] } },
  comm: (pid) => read(`/proc/${pid}/comm`).trim(),
  argv: (pid) => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean),
  // The command name in /proc/PID/stat may hold spaces and parentheses; the fields after its closing one do not.
  ppid: (pid) => {
    const stat = read(`/proc/${pid}/stat`)
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0
  },
  cwd: (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return "" } },
  cgroup: (pid) => read(`/proc/${pid}/cgroup`),
  environ: (pid) => Object.fromEntries(read(`/proc/${pid}/environ`).split("\0").flatMap((entry) => {
    const at = entry.indexOf("=")
    return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : []
  })),
}

const harnessOf = (source: ProcSource, pid: number) => {
  const process = { pid, name: source.comm(pid), argv: source.argv(pid) }
  return HARNESSES.find((harness) => isHarnessProcess(process, harness))
}

/** The unit in a cgroup v2 line such as `0::/user.slice/.../app.slice/hc-hold-560dd206.service`. */
export const unitOf = (cgroup: string) => {
  const path = cgroup.split("\n").find((line) => line.startsWith("0::"))?.slice(3) ?? ""
  const unit = path.split("/").filter(Boolean).findLast((part) => /\.(scope|service)$/.test(part))
  return unit ?? null
}

const placementOf = (unit: string | null): LiveHarness["placement"] =>
  unit?.startsWith("clankerhouse-") ? "scope" : unit?.startsWith("hc-hold-") ? "terminal" : "other"

const laneOf = (env: Record<string, string>) => {
  if (!env.HC_TERMINAL_ID && !env.HERDR_PANE_ID) return null
  try { return laneName(instanceSlug(env)) } catch { return null }
}

/** The longest Workshop path that is `path` or contains it. */
export const workshopFor = (path: string, workshopPaths: readonly string[]) =>
  workshopPaths.filter((workshop) => path === workshop || path.startsWith(`${workshop.replace(/\/+$/, "")}/`)).sort((left, right) => right.length - left.length)[0] ?? path

export interface ScanOptions {
  source?: ProcSource
  workshopPaths?: readonly string[]
  /** The clanker a lane's ledger adopted on a terminal, for a harness started by hand there. */
  clankerAt?: (lane: string, terminal: string) => string | undefined
}

/** Every top-level harness process: one started by another harness (a `claude -p` a clanker ran) is part of that one. */
export const scanLiveHarnesses = (options: ScanOptions = {}): LiveHarness[] => {
  const source = options.source ?? procSource
  const harnesses = new Map<number, string>()
  for (const pid of source.pids()) {
    const harness = harnessOf(source, pid)
    if (harness) harnesses.set(pid, harness)
  }
  const nested = (pid: number) => {
    let parent = source.ppid(pid)
    for (let depth = 0; parent > 1 && depth < 64; depth += 1) {
      if (harnesses.has(parent)) return true
      parent = source.ppid(parent)
    }
    return false
  }
  const result: LiveHarness[] = []
  for (const [pid, harness] of harnesses) {
    if (nested(pid)) continue
    const link = source.cwd(pid)
    if (!link) continue
    const cwdDeleted = link.endsWith(" (deleted)")
    const cwd = cwdDeleted ? link.slice(0, -" (deleted)".length) : link
    const env = source.environ(pid)
    const unit = unitOf(source.cgroup(pid))
    const lane = laneOf(env)
    const terminal = env.HC_TERMINAL_ID || env.HERDR_PANE_ID || null
    result.push({
      pid,
      harness,
      cwd,
      workshopPath: cwdDeleted ? cwd : workshopFor(cwd, options.workshopPaths ?? []),
      unit,
      placement: placementOf(unit),
      lane,
      terminal,
      clankerId: env.CLANKER_ID || (lane && terminal ? options.clankerAt?.(lane, terminal) : undefined) || null,
      cwdDeleted,
    })
  }
  return result.sort((left, right) => left.workshopPath.localeCompare(right.workshopPath) || left.pid - right.pid)
}

export interface DuplicateHarnesses {
  workshopPath: string
  /**
   * `lanes`: they run on more than one lane's server, so no lane sees them all; `hand-started`: one was started from
   * a terminal's shell rather than launched; `several`: clankers one lane launched there, as a Workshop with helpers has.
   */
  reason: "lanes" | "hand-started" | "several"
  lanes: string[]
  harnesses: LiveHarness[]
}

/** Worktrees with more than one live harness, each listed with all of them; the suspect ones first. */
export const duplicateHarnesses = (harnesses: readonly LiveHarness[]): DuplicateHarnesses[] => {
  const groups = new Map<string, LiveHarness[]>()
  for (const harness of harnesses) groups.set(harness.workshopPath, [...groups.get(harness.workshopPath) ?? [], harness])
  const rank = { lanes: 0, "hand-started": 1, several: 2 }
  return [...groups].filter(([, group]) => group.length > 1).map(([workshopPath, group]): DuplicateHarnesses => {
    const lanes = [...new Set(group.map((harness) => harness.lane ?? "none"))].sort()
    const reason = lanes.length > 1 ? "lanes" : group.some((harness) => harness.placement !== "scope") ? "hand-started" : "several"
    return { workshopPath, reason, lanes, harnesses: group }
  }).sort((left, right) => rank[left.reason] - rank[right.reason] || left.workshopPath.localeCompare(right.workshopPath))
}

/** Harnesses whose worktree is gone. */
export const orphanedHarnesses = (harnesses: readonly LiveHarness[]) => harnesses.filter((harness) => harness.cwdDeleted)

/** One line for `clankers diagnose`. */
export const describeHarness = (harness: LiveHarness) => {
  const where = harness.lane ? `lane ${harness.lane} ${harness.terminal}` : "outside any Multiplexer"
  const who = harness.clankerId ?? "no clanker"
  const placed = harness.placement === "scope" ? `own scope ${harness.unit}`
    : harness.placement === "terminal" ? `started from a terminal's shell, in ${harness.unit}`
    : harness.unit ?? "no unit"
  return `pid ${harness.pid} ${harness.harness} ${where} ${who} (${placed})${harness.cwdDeleted ? ` in deleted ${harness.cwd}` : harness.cwd === harness.workshopPath ? "" : ` in ${harness.cwd}`}`
}

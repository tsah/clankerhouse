/**
 * Whether a clanker's harness still runs in the systemd scope it was launched in. A second harness on one session
 * corrupts it, so resume refuses while the old one runs.
 */
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

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

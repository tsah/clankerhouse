import type { RecoveryResourceClass } from "./model"

const safeUnitPart = (value: string) => value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "unknown"

export const recoveryUnitName = (clankerId: string, attemptId: string) =>
  `clankerhouse-${safeUnitPart(clankerId)}-${safeUnitPart(attemptId)}.scope`

export const ownedHarnessCommand = (command: string[], clankerId: string, attemptId: string, resourceClass: RecoveryResourceClass = "untrusted") =>
  ownedScopeCommand(command, recoveryUnitName(clankerId, attemptId), resourceClass)

/** Runs a command in its own transient scope under the clanker budget, never in the caller's cgroup. */
export const ownedScopeCommand = (command: string[], unit: string, resourceClass: RecoveryResourceClass = "untrusted") => {
  if (Bun.env.CLANKERHOUSE_PROCESS_OWNER === "disabled") return command
  const budget = resourceClass === "interactive"
    ? { cpuQuota: "200%", ioWeight: 20, memoryHigh: "4G" }
    : resourceClass === "validation-heavy"
      ? { cpuQuota: "200%", ioWeight: 5, memoryHigh: "6G" }
      : { cpuQuota: "300%", ioWeight: 10, memoryHigh: "6G" }
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${unit}`,
    "--property=Slice=clankerhouse-recovery.slice",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10s",
    "--property=SendSIGKILL=yes",
    "--property=CollectMode=inactive-or-failed",
    "--property=CPUWeight=20",
    `--property=CPUQuota=${budget.cpuQuota}`,
    `--property=IOWeight=${budget.ioWeight}`,
    `--property=MemoryHigh=${budget.memoryHigh}`,
    ...(Bun.env.CLANKERHOUSE_IO_READ_BANDWIDTH_MAX ? [`--property=IOReadBandwidthMax=${Bun.env.CLANKERHOUSE_IO_READ_BANDWIDTH_MAX}`] : []),
    "--", ...command,
  ]
}

export const stopOwnedHarness = (unit: string) => {
  if (!/^clankerhouse-[A-Za-z0-9_.-]+\.scope$/.test(unit)) throw new Error("Invalid clanker scope")
  const loaded = Bun.spawnSync(["systemctl", "--user", "show", unit, "--property=LoadState", "--value"], { stdout: "pipe", stderr: "pipe" })
  if (loaded.exitCode !== 0 || loaded.stdout.toString().trim() === "not-found") return
  const stopped = Bun.spawnSync(["systemctl", "--user", "stop", unit], { stdout: "pipe", stderr: "pipe" })
  if (stopped.exitCode !== 0) throw new Error(stopped.stderr.toString().trim() || `Unable to stop ${unit}`)
  const remaining = Bun.spawnSync(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--property=ActiveState"], { stdout: "pipe", stderr: "pipe" })
  if (remaining.exitCode !== 0) return // CollectMode may remove an empty scope immediately.
  const state = remaining.stdout.toString()
  if (!state.includes("ActiveState=inactive") && !state.includes("ActiveState=failed")) throw new Error(`Clanker scope ${unit} still has live descendants`)
}

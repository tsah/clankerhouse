/**
 * Harness launch commands. Each tracked harness runs under the lifecycle wrapper with its
 * clanker identity in the environment, inside its own systemd scope under the clanker budget.
 */
import { binPath, libexecPath } from "./installation"
import { launchModel, launchResourceClass, validateModelName, type LaunchSpec, type LedgerClanker, type LedgerHarness, type ResourceClass } from "./clanker-ledger"

const lifecycleWrapper = binPath("clankerhouse-harness-lifecycle")
const opencode2Launcher = Bun.env.CLANKERHOUSE_OPENCODE_LAUNCHER || binPath("clankerhouse-opencode2")

const plannotatorEnv = () => [
  `BROWSER=${Bun.env.BROWSER || "xdg-open"}`,
  `PLANNOTATOR_BROWSER=${Bun.env.PLANNOTATOR_BROWSER || `${Bun.env.HOME}/.local/bin/xdg-open`}`,
  `PLANNOTATOR_REMOTE=${Bun.env.PLANNOTATOR_REMOTE || "1"}`,
  `PLANNOTATOR_PORT=${Bun.env.PLANNOTATOR_PORT || "19432-19439"}`,
]

export const harnessModelArgs = (harness: LedgerHarness | "codex", model?: string): string[] => {
  if (model === undefined) return []
  validateModelName(model)
  if (harness === "opencode") throw new Error("--model is not supported for OpenCode; configure the model in OpenCode instead")
  return ["--model", model]
}

/** The Workshop a clanker is launched in; the parent is empty for a root Workshop. */
export interface WorkshopLaunchIdentity { workshopId: string; parentWorkshopId: string | null }

export const workshopEnvironment = (workshop: WorkshopLaunchIdentity): Record<string, string> => ({
  CLANKERHOUSE_WORKSHOP_ID: workshop.workshopId,
  CLANKERHOUSE_PARENT_WORKSHOP_ID: workshop.parentWorkshopId ?? "",
})

const trackedEnvironment = (clankerId: string, sessionId: string | null, workshop: WorkshopLaunchIdentity) => [
  ...plannotatorEnv(),
  `CLANKER_ID=${clankerId}`,
  ...Object.entries(workshopEnvironment(workshop)).map(([key, value]) => `${key}=${value}`),
  ...(sessionId ? [`CLANKER_SESSION_ID=${sessionId}`] : []),
]

const piProfileArgs = (cwd: string, profile: string | null, model?: string) => {
  if (!profile) return []
  const helper = libexecPath("pi-agent-config")
  const resolved = Bun.spawnSync([helper, "--cwd", cwd, "--format", "json", profile], { stdout: "pipe", stderr: "pipe" })
  if (resolved.exitCode !== 0) throw new Error(resolved.stderr.toString().trim() || `Unknown pi profile: ${profile}`)
  const config = JSON.parse(resolved.stdout.toString())
  const args: string[] = []
  if (config.model && model === undefined) args.push("--model", config.model)
  if (config.thinking) args.push("--thinking", config.thinking)
  if (config.tools?.length) args.push("--tools", config.tools.join(","))
  const body = Bun.spawnSync([helper, "--cwd", cwd, "--body", profile], { stdout: "pipe" }).stdout.toString()
  if (body.trim()) args.push("--append-system-prompt", body)
  return args
}

export interface HarnessLaunch {
  harness: LedgerHarness
  cwd: string
  clankerId: string
  harnessSessionId: string | null
  launchSpec: LaunchSpec
  workshop: WorkshopLaunchIdentity
  /** The first prompt; a resumed session may start without one. */
  prompt?: string
  /** Continue `harnessSessionId` instead of starting it. */
  resume?: boolean
}

/** The scope a launch runs in; the numeric suffix orders a clanker's launches. */
export const clankerUnitName = (clankerId: string, launchedAt = Date.now()) =>
  `clankerhouse-${safeUnitPart(clankerId)}-${launchedAt}.scope`

/** The harness argv for a launch, wrapped in its own scope named `unit`. */
export const harnessCommand = (input: HarnessLaunch, unit: string) => {
  const { harness, harnessSessionId: session, launchSpec, resume = false } = input
  const env = trackedEnvironment(input.clankerId, session, input.workshop)
  const profile = launchSpec.profile
  const model = launchModel(launchSpec)
  const modelArgs = harnessModelArgs(harness, model)
  const prompt = input.prompt ? [input.prompt] : []
  let command: string[]
  if (harness === "pi") {
    if (!session) throw new Error("Pi requires a session id")
    command = ["env", ...env, lifecycleWrapper, "--", "pi", resume ? "--session" : "--session-id", session, ...piProfileArgs(input.cwd, profile, model), ...modelArgs, ...prompt]
  } else if (harness === "claude") {
    if (!session) throw new Error("Claude requires a session id")
    command = ["env", "-u", "ANTHROPIC_API_KEY", ...env, lifecycleWrapper, "--", "claude", resume ? "--resume" : "--session-id", session, ...(profile ? ["--agent", profile] : []), ...modelArgs, ...prompt]
  } else {
    if (resume && !session) throw new Error("OpenCode resume requires a session id")
    command = ["env", ...env, lifecycleWrapper, "--", opencode2Launcher, ...(profile ? ["--profile", profile] : []), ...(resume ? ["--session", session!] : []), "--", input.cwd, ...prompt]
  }
  return ownedScopeCommand(command, unit, launchResourceClass(launchSpec))
}

/** A ledger clanker's launch that continues its exact session. */
export const resumeLaunch = (clanker: LedgerClanker, workshop: WorkshopLaunchIdentity, prompt?: string): HarnessLaunch => ({
  harness: clanker.harness,
  cwd: clanker.cwd,
  clankerId: clanker.clankerId,
  harnessSessionId: clanker.harnessSessionId,
  launchSpec: clanker.launchSpec,
  workshop,
  prompt,
  resume: true,
})

export const safeUnitPart = (value: string) => value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "unknown"

/**
 * Runs a command in its own transient scope under the clanker budget, never in the caller's
 * cgroup. The slice keeps its historical name so running clankers stay in one budget.
 */
export const ownedScopeCommand = (command: string[], unit: string, resourceClass: ResourceClass = "untrusted") => {
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

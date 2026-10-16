import { validateModelName, type DesiredClankerRecord, type LaunchSpec, type RecoveryHarness } from "./model"
import { binPath, libexecPath } from "../installation"
import { ownedHarnessCommand } from "./process-owner"

export const recoveryPrompt = (attemptId: string) => `Clankerhouse recovery attempt ${attemptId}: the previous host or multiplexer server ended unexpectedly. Inspect existing session and repository state, then autonomously continue from the last settled user request. Never replay an interrupted tool call or assume that a missing result means the operation did not complete. Read-only inspection and local source edits are allowed. Before running tests, lint, builds, indexing, package installation, containers, migrations, or other expensive validation, ask for operator confirmation. Also ask for operator confirmation before commits, pushes, deployments, issue updates, network mutations, or any other externally visible or non-idempotent action.`

const lifecycleWrapper = binPath("clankerhouse-harness-lifecycle")
const opencode2Launcher = Bun.env.CLANKERHOUSE_OPENCODE_LAUNCHER || binPath("clankerhouse-opencode2")

const plannotatorEnv = () => [
  `BROWSER=${Bun.env.BROWSER || "xdg-open"}`,
  `PLANNOTATOR_BROWSER=${Bun.env.PLANNOTATOR_BROWSER || `${Bun.env.HOME}/.local/bin/xdg-open`}`,
  `PLANNOTATOR_REMOTE=${Bun.env.PLANNOTATOR_REMOTE || "1"}`,
  `PLANNOTATOR_PORT=${Bun.env.PLANNOTATOR_PORT || "19432-19439"}`,
]

const resourceClass = (spec: LaunchSpec) => spec.version === 1 ? "untrusted" : spec.resourceClass
const modelOverride = (spec: LaunchSpec) => spec.version === 3 ? spec.model : undefined

export const harnessModelArgs = (harness: RecoveryHarness | "codex", model?: string): string[] => {
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

const workshopEnvironmentArgs = (workshop?: WorkshopLaunchIdentity) =>
  workshop ? Object.entries(workshopEnvironment(workshop)).map(([key, value]) => `${key}=${value}`) : []

const trackedEnvironment = (clankerId: string, sessionId: string | null, attemptId?: string, workshop?: WorkshopLaunchIdentity) => [
  ...plannotatorEnv(),
  `CLANKER_ID=${clankerId}`,
  ...workshopEnvironmentArgs(workshop),
  "CLANKER_RECOVERY_TRACKED=1",
  ...(sessionId ? [`CLANKER_SESSION_ID=${sessionId}`] : []),
  ...(attemptId ? [`CLANKER_RECOVERY_ATTEMPT=${attemptId}`] : []),
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

export interface InitialHarnessCommandInput {
  harness: RecoveryHarness
  cwd: string
  prompt: string
  clankerId: string
  harnessSessionId: string | null
  launchSpec: LaunchSpec
  attemptId?: string
  workshop?: WorkshopLaunchIdentity
}

export const initialHarnessCommand = (input: InitialHarnessCommandInput) => {
  const env = trackedEnvironment(input.clankerId, input.harnessSessionId, input.attemptId, input.workshop)
  const profile = input.launchSpec.profile
  const model = modelOverride(input.launchSpec)
  const modelArgs = harnessModelArgs(input.harness, model)
  let command: string[]
  if (input.harness === "pi") {
    if (!input.harnessSessionId) throw new Error("Pi requires a preallocated session id")
    command = ["env", ...env, lifecycleWrapper, "--", "pi", "--session-id", input.harnessSessionId, ...piProfileArgs(input.cwd, profile, model), ...modelArgs, input.prompt]
  } else if (input.harness === "claude") {
    if (!input.harnessSessionId) throw new Error("Claude requires a preallocated session id")
    command = ["env", "-u", "ANTHROPIC_API_KEY", ...env, lifecycleWrapper, "--", "claude", "--session-id", input.harnessSessionId, ...(profile ? ["--agent", profile] : []), ...modelArgs, input.prompt]
  } else {
    command = ["env", ...env, lifecycleWrapper, "--", opencode2Launcher, ...(profile ? ["--profile", profile] : []), "--", input.cwd, input.prompt]
  }
  return input.attemptId ? ownedHarnessCommand(command, input.clankerId, input.attemptId, resourceClass(input.launchSpec)) : command
}

export const recoveryHarnessCommand = (desired: DesiredClankerRecord, attemptId: string, workshop: WorkshopLaunchIdentity = { workshopId: desired.workshopId, parentWorkshopId: null }) => {
  if (!desired.harnessSessionId) throw new Error(`Clanker ${desired.clankerId} has no exact harness session id`)
  const env = trackedEnvironment(desired.clankerId, desired.harnessSessionId, attemptId, workshop)
  const prompt = recoveryPrompt(attemptId)
  const profile = desired.launchSpec.profile
  const model = modelOverride(desired.launchSpec)
  const modelArgs = harnessModelArgs(desired.harness, model)
  const command = desired.harness === "pi"
    ? ["env", ...env, lifecycleWrapper, "--", "pi", "--session", desired.harnessSessionId, ...piProfileArgs(desired.cwd, profile, model), ...modelArgs, prompt]
    : desired.harness === "claude"
      ? ["env", "-u", "ANTHROPIC_API_KEY", ...env, lifecycleWrapper, "--", "claude", "--resume", desired.harnessSessionId, ...(profile ? ["--agent", profile] : []), ...modelArgs, prompt]
      : ["env", ...env, lifecycleWrapper, "--", opencode2Launcher, "--session", desired.harnessSessionId, "--", desired.cwd, prompt]
  return ownedHarnessCommand(command, desired.clankerId, attemptId, resourceClass(desired.launchSpec))
}

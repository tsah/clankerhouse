import type { DesiredClankerRecord, LaunchSpec, RecoveryHarness } from "./model"
import { binPath, libexecPath } from "../installation"

export const recoveryPrompt = (attemptId: string) => `Clankerhouse recovery attempt ${attemptId}: the previous host or tmux server ended unexpectedly. Resume the existing session and autonomously continue the most recent unfinished user request. Inspect the repository, Git diff and status, test artifacts, and relevant external state before acting. Do not repeat completed or externally visible work solely because this recovery message may have been delivered more than once. Do not wait for a user unless a configured harness permission policy requires it.`

const lifecycleWrapper = binPath("clankerhouse-harness-lifecycle")
const opencode2Launcher = Bun.env.CLANKERHOUSE_OPENCODE_LAUNCHER || binPath("clankerhouse-opencode2")

const plannotatorEnv = () => [
  `BROWSER=${Bun.env.BROWSER || "xdg-open"}`,
  `PLANNOTATOR_BROWSER=${Bun.env.PLANNOTATOR_BROWSER || `${Bun.env.HOME}/.local/bin/xdg-open`}`,
  `PLANNOTATOR_REMOTE=${Bun.env.PLANNOTATOR_REMOTE || "1"}`,
  `PLANNOTATOR_PORT=${Bun.env.PLANNOTATOR_PORT || "19432-19439"}`,
]

const trackedEnvironment = (clankerId: string, sessionId: string | null, attemptId?: string) => [
  ...plannotatorEnv(),
  `CLANKER_ID=${clankerId}`,
  "CLANKER_RECOVERY_TRACKED=1",
  ...(sessionId ? [`CLANKER_SESSION_ID=${sessionId}`] : []),
  ...(attemptId ? [`CLANKER_RECOVERY_ATTEMPT=${attemptId}`] : []),
]

const piProfileArgs = (cwd: string, profile: string | null) => {
  if (!profile) return []
  const helper = libexecPath("pi-agent-config")
  const resolved = Bun.spawnSync([helper, "--cwd", cwd, "--format", "json", profile], { stdout: "pipe", stderr: "pipe" })
  if (resolved.exitCode !== 0) throw new Error(resolved.stderr.toString().trim() || `Unknown pi profile: ${profile}`)
  const config = JSON.parse(resolved.stdout.toString())
  const args: string[] = []
  if (config.model) args.push("--model", config.model)
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
}

export const initialHarnessCommand = (input: InitialHarnessCommandInput) => {
  const env = trackedEnvironment(input.clankerId, input.harnessSessionId, input.attemptId)
  const profile = input.launchSpec.profile
  if (input.harness === "pi") {
    if (!input.harnessSessionId) throw new Error("Pi requires a preallocated session id")
    return ["env", ...env, lifecycleWrapper, "--", "pi", "--session-id", input.harnessSessionId, ...piProfileArgs(input.cwd, profile), input.prompt]
  }
  if (input.harness === "claude") {
    if (!input.harnessSessionId) throw new Error("Claude requires a preallocated session id")
    return ["env", "-u", "ANTHROPIC_API_KEY", ...env, lifecycleWrapper, "--", "claude", "--session-id", input.harnessSessionId, ...(profile ? ["--agent", profile] : []), input.prompt]
  }
  return ["env", ...env, lifecycleWrapper, "--", opencode2Launcher, ...(profile ? ["--profile", profile] : []), "--", input.cwd, input.prompt]
}

export const recoveryHarnessCommand = (desired: DesiredClankerRecord, attemptId: string) => {
  if (!desired.harnessSessionId) throw new Error(`Clanker ${desired.clankerId} has no exact harness session id`)
  const env = trackedEnvironment(desired.clankerId, desired.harnessSessionId, attemptId)
  const prompt = recoveryPrompt(attemptId)
  const profile = desired.launchSpec.profile
  if (desired.harness === "pi") return ["env", ...env, lifecycleWrapper, "--", "pi", "--session", desired.harnessSessionId, ...piProfileArgs(desired.cwd, profile), prompt]
  if (desired.harness === "claude") return ["env", "-u", "ANTHROPIC_API_KEY", ...env, lifecycleWrapper, "--", "claude", "--resume", desired.harnessSessionId, ...(profile ? ["--agent", profile] : []), prompt]
  return ["env", ...env, lifecycleWrapper, "--", opencode2Launcher, "--session", desired.harnessSessionId, "--", desired.cwd, prompt]
}

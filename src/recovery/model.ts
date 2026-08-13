export const RECOVERY_SCHEMA_VERSION = 1 as const
export const RECOVERY_POLICY = Object.freeze({
  version: 1 as const,
  maxAttempts: 5,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
})

export type RecoveryHarness = "pi" | "claude" | "opencode"
export type DesiredClankerState = "running" | "stopped" | "suspended_resource_pressure" | "tombstoned"
export type LeaseScope = { kind: "global" } | { kind: "clanker"; clankerId: string }
export type RecoveryAttemptStatus = "running" | "succeeded" | "failed" | "abandoned"

/** Declarative launch data only. Commands, environment, and credentials are deliberately not representable. */
export interface LaunchSpec {
  version: 1
  profile: string | null
}

export interface DesiredClankerInput {
  clankerId: string
  harness: RecoveryHarness
  workshopId: string
  workshopPath: string
  tmuxSessionName: string
  tmuxWindowName: string
  cwd: string
  harnessSessionId: string | null
  launchSpec: LaunchSpec
  originalTask: string
  desiredState?: Exclude<DesiredClankerState, "tombstoned">
}

export interface DesiredClankerRecord extends Omit<DesiredClankerInput, "desiredState"> {
  desiredState: DesiredClankerState
  recoveryPolicyVersion: typeof RECOVERY_POLICY.version
  revision: number
  createdAt: number
  updatedAt: number
}

export interface RecoveryJournalEntry {
  id: number
  clankerId: string | null
  event: string
  revision: number | null
  payload: Readonly<Record<string, unknown>>
  createdAt: number
}

export interface ProcessIdentity {
  bootId: string
  pid: number
  processStartTicks: number
}

export interface RecoveryLease extends ProcessIdentity {
  scope: LeaseScope
  ownerToken: string
  acquiredAt: number
  renewedAt: number
  expiresAt: number
}

export interface RecoveryAttempt {
  id: number
  clankerId: string
  attempt: number
  trigger: string
  status: RecoveryAttemptStatus
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface RuntimeEpochs {
  bootId: string | null
  bootEpoch: number
  tmuxEpoch: number
  updatedAt: number | null
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function assertText(value: unknown, field: string, options: { absolute?: boolean; max?: number } = {}): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${field}`)
  if (options.max && value.length > options.max) throw new Error(`Invalid ${field}`)
  if (options.absolute && !value.startsWith("/")) throw new Error(`${field} must be an absolute path`)
}

export const validateLaunchSpec = (value: unknown): LaunchSpec => {
  if (!plainObject(value)) throw new Error("Invalid launch spec")
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== "profile" || keys[1] !== "version" || value.version !== 1) throw new Error("Invalid launch spec")
  if (value.profile !== null) assertText(value.profile, "launch profile", { max: 128 })
  return Object.freeze({ version: 1, profile: value.profile as string | null })
}

export const validateDesiredClankerInput = (value: DesiredClankerInput): DesiredClankerInput => {
  if (!plainObject(value)) throw new Error("Invalid desired clanker")
  assertText(value.clankerId, "clanker id", { max: 256 })
  if (value.harness !== "pi" && value.harness !== "claude" && value.harness !== "opencode") throw new Error("Invalid recovery harness")
  assertText(value.workshopId, "workshop id", { max: 256 })
  assertText(value.workshopPath, "workshop path", { absolute: true })
  assertText(value.tmuxSessionName, "tmux session name", { max: 256 })
  assertText(value.tmuxWindowName, "tmux window name", { max: 256 })
  assertText(value.cwd, "cwd", { absolute: true })
  if (value.harnessSessionId !== null) assertText(value.harnessSessionId, "harness session id", { max: 512 })
  if (typeof value.originalTask !== "string" || value.originalTask.trim().length === 0 || value.originalTask.includes("\0")) throw new Error("Invalid original task")
  if (value.desiredState !== undefined && value.desiredState !== "running" && value.desiredState !== "stopped" && value.desiredState !== "suspended_resource_pressure") throw new Error("Invalid initial desired state")
  return { ...value, launchSpec: validateLaunchSpec(value.launchSpec), desiredState: value.desiredState ?? "running" }
}

export const validateProcessIdentity = (value: ProcessIdentity): ProcessIdentity => {
  assertText(value.bootId, "boot id", { max: 256 })
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid process pid")
  if (!Number.isSafeInteger(value.processStartTicks) || value.processStartTicks < 0) throw new Error("Invalid process start ticks")
  return value
}

export const leaseScopeKey = (scope: LeaseScope) => {
  if (scope.kind === "global") return "global"
  assertText(scope.clankerId, "clanker id", { max: 256 })
  return `clanker:${scope.clankerId}`
}

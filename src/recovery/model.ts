export const RECOVERY_SCHEMA_VERSION = 4 as const
export const RECOVERY_POLICY = Object.freeze({
  version: 2 as const,
  automaticRecovery: true,
  maxAutomaticAttemptsPerBoot: 1,
  maxAutomaticAttempts24h: 2,
  maxConsecutiveFailures: 3,
  bootQuietPeriodMs: 120_000,
  healthyWindowMs: 30_000,
  minimumAdmissionIntervalMs: 60_000,
  maxActiveRecoveries: 1,
  stableSettlementMs: 300_000,
  initialBackoffMs: 30_000,
  maxBackoffMs: 15 * 60_000,
})

export type RecoveryHarness = "pi" | "claude" | "opencode"
export type DesiredClankerState = "running" | "stopped" | "suspended_resource_pressure" | "tombstoned"
export type RecoveryCondition = "healthy" | "pending" | "recovering" | "interrupted_unknown" | "quarantined" | "suspended"
export type LeaseScope = { kind: "global" } | { kind: "clanker"; clankerId: string }
export type RecoveryAttemptStatus = "running" | "succeeded" | "failed" | "abandoned"

/** Declarative launch data only. Commands, environment, and credentials are deliberately not representable. */
export type RecoveryResourceClass = "interactive" | "validation-heavy" | "untrusted"
export type LaunchSpec =
  | { version: 1; profile: string | null }
  | { version: 2; profile: string | null; resourceClass: RecoveryResourceClass }
  | { version: 3; profile: string | null; resourceClass: RecoveryResourceClass; model: string }

export interface DesiredClankerInput {
  clankerId: string
  harness: RecoveryHarness
  workshopId: string
  workshopPath: string
  preferredSessionLabel: string
  preferredWindowLabel: string
  cwd: string
  harnessSessionId: string | null
  launchSpec: LaunchSpec
  originalTask: string
  desiredState?: Exclude<DesiredClankerState, "tombstoned">
}

export interface DesiredClankerRecord extends Omit<DesiredClankerInput, "desiredState"> {
  desiredState: DesiredClankerState
  recoveryPolicyVersion: number
  recoveryCondition: RecoveryCondition
  quarantineReason: string | null
  consecutiveFailures: number
  ownerUnit: string | null
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
  automatic: boolean
  bootEpoch: number | null
}

export interface RuntimeEpochs {
  bootId: string | null
  bootEpoch: number
  multiplexerEpoch: number
  updatedAt: number | null
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function assertText(value: unknown, field: string, options: { absolute?: boolean; max?: number } = {}): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${field}`)
  if (options.max && value.length > options.max) throw new Error(`Invalid ${field}`)
  if (options.absolute && !value.startsWith("/")) throw new Error(`${field} must be an absolute path`)
}

export const validateModelName = (value: unknown): string => {
  assertText(value, "model", { max: 512 })
  if (value.startsWith("-")) throw new Error("Invalid model")
  return value
}

export const validateLaunchSpec = (value: unknown): LaunchSpec => {
  if (!plainObject(value)) throw new Error("Invalid launch spec")
  const keys = Object.keys(value).sort()
  if (value.profile !== null) assertText(value.profile, "launch profile", { max: 128 })
  if (value.version === 1 && keys.length === 2 && keys[0] === "profile" && keys[1] === "version") {
    return Object.freeze({ version: 1, profile: value.profile as string | null })
  }
  if (value.version === 2 && keys.length === 3 && keys[0] === "profile" && keys[1] === "resourceClass" && keys[2] === "version" && ["interactive", "validation-heavy", "untrusted"].includes(String(value.resourceClass))) {
    return Object.freeze({ version: 2, profile: value.profile as string | null, resourceClass: value.resourceClass as RecoveryResourceClass })
  }
  if (value.version === 3 && keys.join(",") === "model,profile,resourceClass,version" && ["interactive", "validation-heavy", "untrusted"].includes(String(value.resourceClass))) {
    return Object.freeze({ version: 3, profile: value.profile as string | null, resourceClass: value.resourceClass as RecoveryResourceClass, model: validateModelName(value.model) })
  }
  throw new Error("Invalid launch spec")
}

export const validateDesiredClankerInput = (value: DesiredClankerInput): DesiredClankerInput => {
  if (!plainObject(value)) throw new Error("Invalid desired clanker")
  assertText(value.clankerId, "clanker id", { max: 256 })
  if (value.harness !== "pi" && value.harness !== "claude" && value.harness !== "opencode") throw new Error("Invalid recovery harness")
  assertText(value.workshopId, "workshop id", { max: 256 })
  assertText(value.workshopPath, "workshop path", { absolute: true })
  assertText(value.preferredSessionLabel, "preferred session label", { max: 256 })
  assertText(value.preferredWindowLabel, "preferred window label", { max: 256 })
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

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RECOVERY_POLICY } from "./model"

export interface RecoveryHostState {
  now: number
  bootObservedAt: number
  healthySince: number | null
  lastAdmissionAt: number | null
  activeRecoveries: number
  memoryAvailablePercent: number
  memoryPsiSome: number
  ioPsiSome: number
  ioPsiFull: number
  cpuPsiSome: number
  rootReadBytesPerSecond: number
  configuredReadLimitBytesPerSecond: number | null
}

export type RecoveryAdmissionDecision = { admit: true } | { admit: false; reason: string; retryAfterMs?: number }

export const readRecoveryHostState = (stateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state")): RecoveryHostState | undefined => {
  try {
    const value = JSON.parse(readFileSync(join(stateHome, "clankerhouse", "recovery-admission.json"), "utf8")) as RecoveryHostState
    return Number.isFinite(value.now) && Number.isFinite(value.bootObservedAt) ? value : undefined
  } catch { return undefined }
}

export const recoveryAdmissionDecision = (state: RecoveryHostState): RecoveryAdmissionDecision => {
  const bootAge = state.now - state.bootObservedAt
  if (bootAge < RECOVERY_POLICY.bootQuietPeriodMs) return { admit: false, reason: "boot quiet period", retryAfterMs: RECOVERY_POLICY.bootQuietPeriodMs - bootAge }
  if (state.activeRecoveries >= RECOVERY_POLICY.maxActiveRecoveries) return { admit: false, reason: "active recovery limit" }
  if (state.lastAdmissionAt !== null && state.now - state.lastAdmissionAt < RECOVERY_POLICY.minimumAdmissionIntervalMs) {
    return { admit: false, reason: "recovery stagger interval", retryAfterMs: RECOVERY_POLICY.minimumAdmissionIntervalMs - (state.now - state.lastAdmissionAt) }
  }
  if (state.healthySince === null || state.now - state.healthySince < RECOVERY_POLICY.healthyWindowMs) return { admit: false, reason: "host has not remained healthy" }
  if (state.memoryAvailablePercent < 20 || state.memoryPsiSome >= 10) return { admit: false, reason: "memory reserve" }
  if (state.ioPsiSome >= 10 || state.ioPsiFull >= 1) return { admit: false, reason: "I/O pressure" }
  if (state.cpuPsiSome >= 25) return { admit: false, reason: "CPU pressure" }
  if (state.configuredReadLimitBytesPerSecond && state.rootReadBytesPerSecond >= state.configuredReadLimitBytesPerSecond * 0.5) {
    return { admit: false, reason: "storage throughput reserve" }
  }
  return { admit: true }
}

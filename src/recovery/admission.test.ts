import { describe, expect, test } from "bun:test"
import { recoveryAdmissionDecision, type RecoveryHostState } from "./admission"

const healthy = (overrides: Partial<RecoveryHostState> = {}): RecoveryHostState => ({
  now: 200_000,
  bootObservedAt: 1_000,
  healthySince: 100_000,
  lastAdmissionAt: null,
  activeRecoveries: 0,
  memoryAvailablePercent: 80,
  memoryPsiSome: 0,
  ioPsiSome: 0,
  ioPsiFull: 0,
  cpuPsiSome: 0,
  rootReadBytesPerSecond: 0,
  configuredReadLimitBytesPerSecond: 125 * 1024 * 1024,
  ...overrides,
})

describe("recovery admission", () => {
  test("reserves storage throughput even when memory is healthy", () => {
    expect(recoveryAdmissionDecision(healthy({ rootReadBytesPerSecond: 70 * 1024 * 1024 }))).toMatchObject({ admit: false, reason: "storage throughput reserve" })
    expect(recoveryAdmissionDecision(healthy({ ioPsiFull: 1.1 }))).toMatchObject({ admit: false, reason: "I/O pressure" })
  })

  test("requires a quiet healthy boot and admits only one recovery", () => {
    expect(recoveryAdmissionDecision(healthy({ now: 100_000 }))).toMatchObject({ admit: false, reason: "boot quiet period" })
    expect(recoveryAdmissionDecision(healthy({ activeRecoveries: 1 }))).toMatchObject({ admit: false, reason: "active recovery limit" })
    expect(recoveryAdmissionDecision(healthy())).toEqual({ admit: true })
  })
})

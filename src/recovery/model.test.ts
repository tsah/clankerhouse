import { describe, expect, test } from "bun:test"
import { validateDesiredClankerInput, validateLaunchSpec, validateProcessIdentity, type DesiredClankerInput } from "./model"

const input = (): DesiredClankerInput => ({
  clankerId: "clanker-stable-1",
  harness: "pi",
  workshopId: "workshop-1",
  workshopPath: "/tmp/workshop",
  preferredSessionLabel: "repo@branch",
  preferredWindowLabel: "pi",
  cwd: "/tmp/workshop",
  harnessSessionId: null,
  launchSpec: { version: 1, profile: "reviewer" },
  originalTask: "Review the recovery implementation",
})

describe("recovery model validation", () => {
  test("accepts only declarative versioned launch profiles", () => {
    expect(validateLaunchSpec({ version: 1, profile: null })).toEqual({ version: 1, profile: null })
    expect(validateLaunchSpec({ version: 1, profile: "reviewer" })).toEqual({ version: 1, profile: "reviewer" })
    expect(validateLaunchSpec({ version: 2, profile: "worker", resourceClass: "validation-heavy" })).toEqual({ version: 2, profile: "worker", resourceClass: "validation-heavy" })
    expect(() => validateLaunchSpec({ version: 1, profile: "reviewer", command: "rm -rf /" })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ version: 1, profile: null, env: { API_KEY: "secret" } })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ version: 2, profile: null })).toThrow(/launch spec/)
  })

  test("accepts arbitrary model names in v3 while preserving strict declarative validation", () => {
    const spec = { version: 3, profile: "worker", model: "provider/new-model:high", resourceClass: "interactive" } as const
    expect(validateLaunchSpec(spec)).toEqual(spec)
    for (const model of [null, undefined, 42, "", "  ", " model", "model\nother", "model\0other", "--flag", "x".repeat(513)]) {
      expect(() => validateLaunchSpec({ ...spec, model })).toThrow(/model/)
    }
    expect(() => validateLaunchSpec({ ...spec, command: "shell" })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ ...spec, resourceClass: "unknown" })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ version: 1, profile: null, model: "new-model" })).toThrow(/launch spec/)
  })

  test("validates durable identity, harness, paths, and original task", () => {
    expect(validateDesiredClankerInput(input()).desiredState).toBe("running")
    expect(() => validateDesiredClankerInput({ ...input(), harness: "codex" } as never)).toThrow(/harness/)
    expect(() => validateDesiredClankerInput({ ...input(), cwd: "relative" })).toThrow(/absolute/)
    expect(() => validateDesiredClankerInput({ ...input(), originalTask: "" })).toThrow(/original task/)
    expect(() => validateDesiredClankerInput({ ...input(), desiredState: "tombstoned" } as never)).toThrow(/initial desired state/)
  })

  test("requires complete process identities", () => {
    expect(validateProcessIdentity({ bootId: "boot-a", pid: 42, processStartTicks: 900 })).toEqual({ bootId: "boot-a", pid: 42, processStartTicks: 900 })
    expect(() => validateProcessIdentity({ bootId: "", pid: 42, processStartTicks: 900 })).toThrow(/boot id/)
    expect(() => validateProcessIdentity({ bootId: "boot-a", pid: 0, processStartTicks: 900 })).toThrow(/pid/)
    expect(() => validateProcessIdentity({ bootId: "boot-a", pid: 42, processStartTicks: -1 })).toThrow(/ticks/)
  })
})

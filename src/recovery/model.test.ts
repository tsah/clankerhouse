import { describe, expect, test } from "bun:test"
import { validateDesiredClankerInput, validateLaunchSpec, validateProcessIdentity, type DesiredClankerInput } from "./model"

const input = (): DesiredClankerInput => ({
  clankerId: "clanker-stable-1",
  harness: "pi",
  workshopId: "workshop-1",
  workshopPath: "/tmp/workshop",
  tmuxSessionName: "repo@branch",
  tmuxWindowName: "pi",
  cwd: "/tmp/workshop",
  harnessSessionId: null,
  launchSpec: { version: 1, profile: "reviewer" },
  originalTask: "Review the recovery implementation",
})

describe("recovery model validation", () => {
  test("accepts only declarative versioned launch profiles", () => {
    expect(validateLaunchSpec({ version: 1, profile: null })).toEqual({ version: 1, profile: null })
    expect(validateLaunchSpec({ version: 1, profile: "reviewer" })).toEqual({ version: 1, profile: "reviewer" })
    expect(() => validateLaunchSpec({ version: 1, profile: "reviewer", command: "rm -rf /" })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ version: 1, profile: null, env: { API_KEY: "secret" } })).toThrow(/launch spec/)
    expect(() => validateLaunchSpec({ version: 2, profile: null })).toThrow(/launch spec/)
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

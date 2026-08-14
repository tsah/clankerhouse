import { describe, expect, test } from "bun:test"
import { initialHarnessCommand, recoveryHarnessCommand, recoveryPrompt } from "./harness"
import type { DesiredClankerRecord } from "./model"

const desired = (harness: DesiredClankerRecord["harness"]): DesiredClankerRecord => ({
  clankerId: "clanker-test",
  harness,
  workshopId: "workshop-test",
  workshopPath: "/tmp/workshop",
  tmuxSessionName: "repo@branch",
  tmuxWindowName: harness,
  cwd: "/tmp/workshop",
  harnessSessionId: harness === "opencode" ? "ses_exact" : "00000000-0000-4000-8000-000000000001",
  launchSpec: { version: 1, profile: null },
  originalTask: "finish the task",
  desiredState: "running",
  recoveryPolicyVersion: 2,
  recoveryCondition: "pending",
  quarantineReason: null,
  consecutiveFailures: 0,
  ownerUnit: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
})

describe("harness recovery commands", () => {
  test("preallocates exact Pi and Claude sessions", () => {
    const pi = initialHarnessCommand({ harness: "pi", cwd: "/tmp/workshop", prompt: "task", clankerId: "clanker-test", harnessSessionId: "pi-id", launchSpec: { version: 1, profile: null } })
    const claude = initialHarnessCommand({ harness: "claude", cwd: "/tmp/workshop", prompt: "task", clankerId: "clanker-test", harnessSessionId: "claude-id", launchSpec: { version: 1, profile: null } })
    expect(pi.some((part) => part.endsWith("/clankerhouse-harness-lifecycle"))).toBe(true)
    expect(pi).toContain("--session-id")
    expect(pi[pi.indexOf("--session-id") + 1]).toBe("pi-id")
    expect(claude.some((part) => part.endsWith("/clankerhouse-harness-lifecycle"))).toBe(true)
    expect(claude).toContain("--session-id")
    expect(claude[claude.indexOf("--session-id") + 1]).toBe("claude-id")
  })

  test("resumes exact IDs automatically without replaying expensive or external tools", () => {
    for (const harness of ["pi", "claude", "opencode"] as const) {
      const command = recoveryHarnessCommand(desired(harness), "attempt-7")
      expect(command.some((part) => part.endsWith("/clankerhouse-harness-lifecycle"))).toBe(true)
      expect(command).toContain(desired(harness).harnessSessionId!)
      expect(command.join(" ")).toContain("CLANKER_RECOVERY_ATTEMPT=attempt-7")
      expect(command.at(-1)).toContain("Never replay an interrupted tool call")
      expect(command.at(-1)).toContain("continue from the last settled user request")
      expect(command.at(-1)).toContain("tests, lint, builds")
      expect(command.at(-1)).toContain("ask for operator confirmation")
      if (harness === "opencode") expect(command.some((part) => part.endsWith("/clankerhouse-opencode2"))).toBe(true)
    }
  })

  test("refuses recovery without an exact native session", () => {
    expect(() => recoveryHarnessCommand({ ...desired("opencode"), harnessSessionId: null }, "attempt-1")).toThrow(/no exact harness session id/)
  })

  test("recovery prompt carries a stable attempt id", () => {
    expect(recoveryPrompt("attempt-42")).toContain("attempt-42")
  })
})

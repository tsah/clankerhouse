import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { harnessModelArgs, initialHarnessCommand, recoveryHarnessCommand, recoveryPrompt } from "./harness"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
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

  test("passes an arbitrary model override unchanged on launch and exact-session recovery", () => {
    for (const harness of ["pi", "claude"] as const) {
      const record = desired(harness)
      record.launchSpec = { version: 3, profile: null, model: "provider/future-model:high", resourceClass: "validation-heavy" }
      const initial = initialHarnessCommand({ ...record, prompt: "task" })
      const recovery = recoveryHarnessCommand(record, "attempt-model")
      for (const argv of [initial, recovery]) {
        expect(argv.filter((arg) => arg === "--model")).toHaveLength(1)
        expect(argv[argv.indexOf("--model") + 1]).toBe("provider/future-model:high")
        expect(argv).toContain(record.harnessSessionId!)
      }
      expect(initial.at(-1)).toBe("task")
      if (recovery[0] === "systemd-run") expect(recovery).toContain("--property=IOWeight=5")
    }
    expect(harnessModelArgs("codex", "new-codex-model")).toEqual(["--model", "new-codex-model"])
    expect(() => harnessModelArgs("opencode", "provider/model")).toThrow(/not supported for OpenCode/)
  })

  test("an explicit Pi model wins over the profile without losing its other settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "clankerhouse-model-profile-"))
    roots.push(cwd)
    mkdirSync(join(cwd, ".pi/agents"), { recursive: true })
    writeFileSync(join(cwd, ".pi/agents/model-override-fixture.md"), "---\nmodel: profile-model\nthinking: high\ntools: read\n---\nFixture instructions.\n")
    const record = { ...desired("pi"), cwd }
    record.launchSpec = { version: 3, profile: "model-override-fixture", model: "explicit-model", resourceClass: "untrusted" }
    for (const argv of [initialHarnessCommand({ ...record, prompt: "task" }), recoveryHarnessCommand(record, "attempt-model")]) {
      expect(argv.filter((arg) => arg === "--model")).toHaveLength(1)
      expect(argv[argv.indexOf("--model") + 1]).toBe("explicit-model")
      expect(argv).not.toContain("profile-model")
      expect(argv[argv.indexOf("--thinking") + 1]).toBe("high")
      expect(argv[argv.indexOf("--tools") + 1]).toBe("read")
      expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("Fixture instructions.")
    }
    record.launchSpec = { version: 1, profile: "model-override-fixture" }
    const fallback = initialHarnessCommand({ ...record, prompt: "task" })
    expect(fallback[fallback.indexOf("--model") + 1]).toBe("profile-model")
  })

  test("keeps Claude profile selection alongside the explicit model", () => {
    const record = desired("claude")
    record.launchSpec = { version: 3, profile: "reviewer", model: "custom-claude", resourceClass: "untrusted" }
    for (const argv of [initialHarnessCommand({ ...record, prompt: "task" }), recoveryHarnessCommand(record, "attempt-model")]) {
      expect(argv[argv.indexOf("--agent") + 1]).toBe("reviewer")
      expect(argv[argv.indexOf("--model") + 1]).toBe("custom-claude")
    }
  })

  test("leaves harness defaults alone without a model or profile", () => {
    for (const harness of ["pi", "claude", "opencode"] as const) {
      const record = desired(harness)
      expect(initialHarnessCommand({ ...record, prompt: "task" })).not.toContain("--model")
      expect(recoveryHarnessCommand(record, "attempt-default")).not.toContain("--model")
    }
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

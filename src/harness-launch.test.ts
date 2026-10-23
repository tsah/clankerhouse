import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LedgerClanker } from "./clanker-ledger"
import { clankerUnitName, harnessCommand, harnessModelArgs, ownedScopeCommand, resumeLaunch, type HarnessLaunch } from "./harness-launch"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const root = { workshopId: "workshop-test", parentWorkshopId: null }

const clanker = (harness: LedgerClanker["harness"]): LedgerClanker => ({
  clankerId: "clanker-test",
  harness,
  workshopId: "workshop-test",
  workshopPath: "/tmp/workshop",
  sessionLabel: "repo@branch",
  windowLabel: harness,
  cwd: "/tmp/workshop",
  harnessSessionId: harness === "opencode" ? "ses_exact" : "00000000-0000-4000-8000-000000000001",
  launchSpec: { version: 1, profile: null },
  originalTask: "finish the task",
  state: "open",
  closedReason: null,
  ownerUnit: null,
  serverEpoch: null,
  createdAt: 1,
  updatedAt: 1,
})

const initial = (record: LedgerClanker, prompt = "task"): HarnessLaunch => ({
  harness: record.harness, cwd: record.cwd, clankerId: record.clankerId, harnessSessionId: record.harnessSessionId,
  launchSpec: record.launchSpec, workshop: root, prompt,
})

const command = (launch: HarnessLaunch) => harnessCommand(launch, "clankerhouse-clanker-test-1.scope")

describe("harness launch commands", () => {
  test("preallocates exact Pi and Claude sessions under the lifecycle wrapper", () => {
    for (const harness of ["pi", "claude"] as const) {
      const argv = command({ ...initial(clanker(harness)), harnessSessionId: `${harness}-id` })
      expect(argv.some((part) => part.endsWith("/clankerhouse-harness-lifecycle"))).toBe(true)
      expect(argv[argv.indexOf("--session-id") + 1]).toBe(`${harness}-id`)
      expect(argv.at(-1)).toBe("task")
    }
  })

  test("passes an arbitrary model override unchanged on launch and resume", () => {
    for (const harness of ["pi", "claude"] as const) {
      const record = clanker(harness)
      record.launchSpec = { version: 3, profile: null, model: "provider/future-model:high", resourceClass: "validation-heavy" }
      for (const argv of [command(initial(record)), command(resumeLaunch(record, root))]) {
        expect(argv.filter((arg) => arg === "--model")).toHaveLength(1)
        expect(argv[argv.indexOf("--model") + 1]).toBe("provider/future-model:high")
        expect(argv).toContain(record.harnessSessionId!)
        if (argv[0] === "systemd-run") expect(argv).toContain("--property=IOWeight=5")
      }
    }
    expect(harnessModelArgs("codex", "new-codex-model")).toEqual(["--model", "new-codex-model"])
    expect(() => harnessModelArgs("opencode", "provider/model")).toThrow(/not supported for OpenCode/)
  })

  test("an explicit Pi model wins over the profile without losing its other settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "clankerhouse-model-profile-"))
    roots.push(cwd)
    mkdirSync(join(cwd, ".pi/agents"), { recursive: true })
    writeFileSync(join(cwd, ".pi/agents/model-override-fixture.md"), "---\nmodel: profile-model\nthinking: high\ntools: read\n---\nFixture instructions.\n")
    const record = { ...clanker("pi"), cwd }
    record.launchSpec = { version: 3, profile: "model-override-fixture", model: "explicit-model", resourceClass: "untrusted" }
    for (const argv of [command(initial(record)), command(resumeLaunch(record, root))]) {
      expect(argv.filter((arg) => arg === "--model")).toHaveLength(1)
      expect(argv[argv.indexOf("--model") + 1]).toBe("explicit-model")
      expect(argv).not.toContain("profile-model")
      expect(argv[argv.indexOf("--thinking") + 1]).toBe("high")
      expect(argv[argv.indexOf("--tools") + 1]).toBe("read")
      expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("Fixture instructions.")
    }
    record.launchSpec = { version: 1, profile: "model-override-fixture" }
    const fallback = command(initial(record))
    expect(fallback[fallback.indexOf("--model") + 1]).toBe("profile-model")
  })

  test("keeps Claude profile selection alongside the explicit model", () => {
    const record = clanker("claude")
    record.launchSpec = { version: 3, profile: "reviewer", model: "custom-claude", resourceClass: "untrusted" }
    for (const argv of [command(initial(record)), command(resumeLaunch(record, root))]) {
      expect(argv[argv.indexOf("--agent") + 1]).toBe("reviewer")
      expect(argv[argv.indexOf("--model") + 1]).toBe("custom-claude")
    }
  })

  test("leaves harness defaults alone without a model or profile", () => {
    for (const harness of ["pi", "claude", "opencode"] as const) {
      expect(command(initial(clanker(harness)))).not.toContain("--model")
      expect(command(resumeLaunch(clanker(harness), root))).not.toContain("--model")
    }
  })

  test("resumes the exact session with no prompt unless one is given", () => {
    const flags = { pi: "--session", claude: "--resume", opencode: "--session" } as const
    for (const harness of ["pi", "claude", "opencode"] as const) {
      const record = clanker(harness)
      const argv = command(resumeLaunch(record, root))
      expect(argv[argv.indexOf(flags[harness]) + 1]).toBe(record.harnessSessionId!)
      expect(argv).not.toContain("--session-id")
      expect(argv).not.toContain("finish the task")
      expect(command(resumeLaunch(record, root, "carry on")).at(-1)).toBe("carry on")
      if (harness === "opencode") expect(argv.some((part) => part.endsWith("/clankerhouse-opencode2"))).toBe(true)
    }
    expect(() => command(resumeLaunch({ ...clanker("opencode"), harnessSessionId: null }, root))).toThrow(/requires a session id/)
  })
})

describe("Workshop launch environment", () => {
  const workshopEnv = (argv: string[]) => argv.filter((arg) => arg.startsWith("CLANKERHOUSE_WORKSHOP_ID=") || arg.startsWith("CLANKERHOUSE_PARENT_WORKSHOP_ID="))

  test("launches and resumes carry the Workshop and its parent, empty for a root", () => {
    for (const harness of ["pi", "claude", "opencode"] as const) {
      const record = clanker(harness)
      const child = { workshopId: "workshop-child", parentWorkshopId: "workshop-parent" }
      expect(workshopEnv(command({ ...initial(record), workshop: child }))).toEqual(["CLANKERHOUSE_WORKSHOP_ID=workshop-child", "CLANKERHOUSE_PARENT_WORKSHOP_ID=workshop-parent"])
      expect(workshopEnv(command(resumeLaunch(record, child)))).toEqual(["CLANKERHOUSE_WORKSHOP_ID=workshop-child", "CLANKERHOUSE_PARENT_WORKSHOP_ID=workshop-parent"])
      expect(workshopEnv(command(resumeLaunch(record, root)))).toEqual(["CLANKERHOUSE_WORKSHOP_ID=workshop-test", "CLANKERHOUSE_PARENT_WORKSHOP_ID="])
    }
  })
})

describe("clanker process ownership", () => {
  test("puts every tracked harness in a killable low-priority systemd scope", () => {
    expect(clankerUnitName("clanker-a/b", 17)).toBe("clankerhouse-clanker-a-b-17.scope")
    const argv = ownedScopeCommand(["pi", "--session", "id"], clankerUnitName("clanker-a/b", 17))
    expect(argv.slice(0, 4)).toEqual(["systemd-run", "--user", "--scope", "--quiet"])
    expect(argv).toContain("--unit=clankerhouse-clanker-a-b-17.scope")
    expect(argv).toContain("--property=KillMode=control-group")
    expect(argv).toContain("--property=IOWeight=10")
    expect(argv.at(-3)).toBe("pi")
    const validation = ownedScopeCommand(["pi"], "clankerhouse-clanker-heavy-18.scope", "validation-heavy")
    expect(validation).toContain("--property=IOWeight=5")
    expect(validation).toContain("--property=CPUQuota=200%")
  })
})

import { describe, expect, test } from "bun:test"
import { ownedHarnessCommand, recoveryUnitName } from "./process-owner"

describe("clanker process ownership", () => {
  test("puts every tracked harness in a killable low-priority systemd scope", () => {
    expect(recoveryUnitName("clanker-a/b", "17")).toBe("clankerhouse-clanker-a-b-17.scope")
    const command = ownedHarnessCommand(["pi", "--session", "id"], "clanker-a/b", "17")
    expect(command.slice(0, 4)).toEqual(["systemd-run", "--user", "--scope", "--quiet"])
    expect(command).toContain("--property=KillMode=control-group")
    expect(command).toContain("--property=IOWeight=10")
    expect(command.at(-3)).toBe("pi")
    const validation = ownedHarnessCommand(["pi"], "clanker-heavy", "18", "validation-heavy")
    expect(validation).toContain("--property=IOWeight=5")
    expect(validation).toContain("--property=CPUQuota=200%")
  })
})

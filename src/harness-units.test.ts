import { describe, expect, test } from "bun:test"
import { harnessRunsIn, isHarnessProcess, parseUnitShow, type UnitState } from "./harness-units"

const running = (harness = "claude"): UnitState => ({ active: true, processes: [{ pid: 1, name: harness, argv: [harness] }] })

describe("unit probing", () => {
  test("parses systemctl show for several units", () => {
    const units = parseUnitShow("Id=clankerhouse-a.scope\nActiveState=active\nControlGroup=/user.slice/a\n\nId=clankerhouse-b.scope\nActiveState=inactive\nControlGroup=\n")
    expect(units.get("clankerhouse-a.scope")).toEqual({ active: true, controlGroup: "/user.slice/a" })
    expect(units.get("clankerhouse-b.scope")).toEqual({ active: false, controlGroup: "" })
  })

  test("a scope runs its harness only while a harness process is in it", () => {
    expect(harnessRunsIn(running(), "claude")).toBe(true)
    expect(harnessRunsIn(running("pi"), "claude")).toBe(false)
    // A hung test job keeping the scope open is not the harness.
    expect(harnessRunsIn({ active: true, processes: [{ pid: 1, name: "bun", argv: ["bun", "test"] }] }, "claude")).toBe(false)
    expect(harnessRunsIn({ active: false, processes: [] }, "claude")).toBe(false)
    expect(harnessRunsIn(undefined, "claude")).toBe(false)
    expect(isHarnessProcess({ pid: 1, name: "node", argv: ["node", "/home/u/.npm/_npx/x/node_modules/.bin/claude"] }, "claude")).toBe(true)
  })
})

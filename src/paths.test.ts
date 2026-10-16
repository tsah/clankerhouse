import { describe, expect, test } from "bun:test"
import { instanceSlug, runtimeDirFor, stateDirFor } from "./paths"

describe("instance scoping", () => {
  test("without an explicit instance the Herdr instance paths are used", () => {
    const uid = process.getuid?.() ?? "user"
    expect(instanceSlug({})).toBe("-herdr")
    expect(runtimeDirFor({ XDG_RUNTIME_DIR: "/run/user/x" })).toBe(`/run/user/x/clankerhouse-${uid}-herdr`)
    expect(stateDirFor("/s", {})).toBe("/s/clankerhouse-herdr")
  })

  test("the default instance is unsuffixed", () => {
    expect(instanceSlug({ CLANKERHOUSE_INSTANCE: "default" })).toBe("")
  })

  test("an explicit instance name selects its own paths without escaping the state root", () => {
    expect(instanceSlug({ CLANKERHOUSE_INSTANCE: "staging" })).toBe("-staging")
    expect(() => instanceSlug({ CLANKERHOUSE_INSTANCE: "../other" })).toThrow(/Invalid CLANKERHOUSE_INSTANCE/)
    expect(() => instanceSlug({ CLANKERHOUSE_INSTANCE: "." })).toThrow(/Invalid CLANKERHOUSE_INSTANCE/)
  })
})

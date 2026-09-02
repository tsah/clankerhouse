import { describe, expect, test } from "bun:test"
import { instanceSlug, runtimeDirFor, stateDirFor } from "./paths"

describe("instance scoping", () => {
  test("tmux and unset runtimes use the unsuffixed legacy paths", () => {
    expect(instanceSlug({})).toBe("")
    expect(instanceSlug({ CLANKERHOUSE_MULTIPLEXER: "tmux" })).toBe("")
    expect(instanceSlug({ CLANKERHOUSE_INSTANCE: "tmux" })).toBe("")
    expect(instanceSlug({ CLANKERHOUSE_INSTANCE: "default" })).toBe("")
  })

  test("a non-tmux runtime gets its own suffix so daemons never collide", () => {
    expect(instanceSlug({ CLANKERHOUSE_MULTIPLEXER: "herdr" })).toBe("-herdr")
    const uid = process.getuid?.() ?? "user"
    expect(runtimeDirFor({ XDG_RUNTIME_DIR: "/run/user/x", CLANKERHOUSE_MULTIPLEXER: "herdr" })).toBe(`/run/user/x/clankerhouse-${uid}-herdr`)
    expect(runtimeDirFor({ XDG_RUNTIME_DIR: "/run/user/x" })).toBe(`/run/user/x/clankerhouse-${uid}`)
    expect(stateDirFor("/s", { CLANKERHOUSE_MULTIPLEXER: "herdr" })).toBe("/s/clankerhouse-herdr")
    expect(stateDirFor("/s", {})).toBe("/s/clankerhouse")
  })

  test("a managed Herdr pane uses the Herdr instance paths without an explicit override", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/x", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" }
    const uid = process.getuid?.() ?? "user"
    expect(instanceSlug(env)).toBe("-herdr")
    expect(runtimeDirFor(env)).toBe(`/run/user/x/clankerhouse-${uid}-herdr`)
    expect(stateDirFor("/s", env)).toBe("/s/clankerhouse-herdr")
    expect(instanceSlug({ ...env, CLANKERHOUSE_MULTIPLEXER: "tmux" })).toBe("")
  })

  test("an explicit instance name overrides the runtime kind without escaping the state root", () => {
    expect(instanceSlug({ CLANKERHOUSE_INSTANCE: "staging", CLANKERHOUSE_MULTIPLEXER: "herdr" })).toBe("-staging")
    expect(() => instanceSlug({ CLANKERHOUSE_INSTANCE: "../other" })).toThrow(/Invalid CLANKERHOUSE_INSTANCE/)
    expect(() => instanceSlug({ CLANKERHOUSE_INSTANCE: "." })).toThrow(/Invalid CLANKERHOUSE_INSTANCE/)
  })
})

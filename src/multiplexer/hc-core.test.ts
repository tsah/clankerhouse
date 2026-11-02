import { describe, expect, test } from "bun:test"
import { ensureHcCore, hcCoreEnvironment, hcHealth, restartHcCore, superviseHcCore, type HcHealth } from "./hc-core"

const dirty = { HOME: "/h", PATH: "/bin", LC_ALL: "C", HC_SESSION: "s", CLANKER_ID: "c-1", CLANKERHOUSE_WORKSHOP_ID: "w", HERDR_PANE_ID: "w1:p1", CLAUDE_CODE_CHILD_SESSION: "1", ANTHROPIC_API_KEY: "secret", HC_SCOPE: "x" }

describe("hc core environment", () => {
  test("is an allowlist: no identity and nothing unnamed reaches a core", () => {
    expect(hcCoreEnvironment(dirty)).toEqual({ HOME: "/h", PATH: "/bin", LC_ALL: "C", HC_SESSION: "s" })
  })

  test("the operator can name extra variables", () => {
    expect(hcCoreEnvironment({ ...dirty, CLANKERHOUSE_HC_CORE_ENV: "ANTHROPIC_API_KEY, MISSING" }).ANTHROPIC_API_KEY).toBe("secret")
  })
})

describe("hc core lifecycle", () => {
  const up: HcHealth = { reachable: true, socketPath: "/s", pid: 2 }
  const down: HcHealth = { reachable: false, socketPath: "/s" }

  test("health never starts a core: a missing socket is an answer", async () => {
    expect(await hcHealth({ socketPath: "/tmp/no-such-hc.sock" })).toEqual({ reachable: false, socketPath: "/tmp/no-such-hc.sock" })
  })

  test("health counts holders left over from an upgrade", async () => {
    const health = await hcHealth({ socketPath: "/s", request: async () => ({ version: "0.1.14", pid: -1, live: 2, finished: 1, holders: [{ current: true }, { current: false }] }) })
    expect(health).toMatchObject({ reachable: true, version: "0.1.14", live: 2, staleHolders: 1, polluted: [] })
  })

  test("ensure leaves a running core alone and starts a stopped one in the clean environment", async () => {
    const commands: Array<[string[], Record<string, string>]> = []
    const command = (args: string[], env: Record<string, string>) => { commands.push([args, env]); return { exitCode: 0, stderr: "" } }
    await ensureHcCore({ env: dirty, command, health: async () => up })
    expect(commands).toEqual([])
    let answers = [down, up]
    expect(await ensureHcCore({ env: dirty, command, health: async () => answers.shift()! })).toEqual(up)
    expect(commands[0]![0]).toEqual(["server", "start"])
    expect(commands[0]![1].CLANKER_ID).toBeUndefined()
  })

  test("a restart cannot adopt the restarter's identity", () => {
    let seen: Record<string, string> = {}
    restartHcCore({ env: dirty, command: (_, env) => { seen = env; return { exitCode: 0, stderr: "" } } })
    expect(seen.CLANKER_ID).toBeUndefined()
    expect(() => restartHcCore({ env: dirty, command: () => ({ exitCode: 1, stderr: "nope" }) })).toThrow("nope")
  })

  test("the supervisor restarts a dead core, survives failed starts, and says when the core is polluted", async () => {
    const abort = new AbortController()
    const logs: string[] = []
    const healths: HcHealth[] = [down, down, { ...up, polluted: ["CLANKER_ID"] }]
    let ensures = 0
    await superviseHcCore(abort.signal, {
      intervalMs: 1,
      health: async () => healths.shift() ?? (abort.abort(), up),
      ensure: async () => { if (++ensures === 1) throw new Error("boom"); return up },
      log: (message) => logs.push(message),
    })
    expect(ensures).toBe(2)
    expect(logs.join("\n")).toContain("restart failed: boom")
    expect(logs.join("\n")).toContain("restarted as pid 2")
    expect(logs.join("\n")).toContain("carries identity variables: CLANKER_ID")
  })
})

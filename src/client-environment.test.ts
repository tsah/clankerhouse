import { describe, expect, test } from "bun:test"
import { clientEnvironment, DAEMON_INTERNAL_ENV_KEYS, unsetDaemonInternalArgs } from "./client-environment"

describe("client environment", () => {
  test("drops exactly the daemon-internal markers and leaves the input untouched", () => {
    const env = { CLANKERHOUSE_DAEMON_INTERNAL: "1", CLANKERHOUSE_PROGRESS: "1", CLANKERHOUSE_LEGACY_MUTATIONS: "1", CLANKERHOUSE_HOME: "/h", PATH: "/bin" }
    expect(clientEnvironment(env)).toEqual({ CLANKERHOUSE_HOME: "/h", PATH: "/bin" })
    expect(env.CLANKERHOUSE_DAEMON_INTERNAL).toBe("1")
  })

  test("unset arguments name every marker", () => {
    expect(unsetDaemonInternalArgs()).toEqual(DAEMON_INTERNAL_ENV_KEYS.flatMap((key) => ["-u", key]))
  })
})

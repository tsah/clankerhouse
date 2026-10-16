import { describe, expect, test } from "bun:test"
import { ClankerRegistrationError, completeWorkshopRegistration, invokingSessionTarget, resolveWorkshopParent, rollbackCreatedWorkshop, spawnClanker, spawnWorkshop } from "./workflow"
import type { ManagedMultiplexer } from "./multiplexer"

describe("workshop parent resolution", () => {
  const missingParentId = "00000000-0000-4000-8000-000000000001"

  test("uses the invoking pane instead of Herdr's globally focused workspace", async () => {
    let currentLocationCalls = 0
    const multiplexer = {
      kind: "herdr",
      paneAddressEnv: () => "HERDR_PANE_ID",
      observe: async () => ({
        kind: "herdr",
        instanceId: "herdr:test",
        sessions: [
          { id: "w13", nativeName: "focused", path: "/repo/search", recency: 2, attached: true, worktreePath: "/repo/search", directoryPath: "", windows: [{ id: "w13:t1", index: "1", nativeName: "main", active: true, panes: [{ id: "w13:p1", index: "0", pid: "1", command: "pi", title: "", currentPath: "/repo/search", activity: 2, active: true }] }] },
          { id: "w16", nativeName: "invoker", path: "/repo/big", recency: 1, attached: false, worktreePath: "/repo/big", directoryPath: "", windows: [{ id: "w16:t2", index: "2", nativeName: "pi", active: true, panes: [{ id: "w16:p2", index: "0", pid: "2", command: "pi", title: "", currentPath: "/repo/big/src", activity: 1, active: true }] }] },
        ],
      }),
      currentLocation: async () => {
        currentLocationCalls += 1
        return { kind: "herdr", instanceId: "herdr:test", nativeSessionId: "w13", nativeWindowId: "w13:t1", nativePaneId: "w13:p1" }
      },
      adapter: { insideRuntime: () => true },
    } as unknown as ManagedMultiplexer

    expect(await invokingSessionTarget(multiplexer, { HERDR_PANE_ID: "w16:p2" })).toEqual({ nativeSessionId: "w16", panePath: "/repo/big/src" })
    expect(currentLocationCalls).toBe(0)
  })

  test("fails closed when an invoking pane address is no longer observable", async () => {
    const multiplexer = {
      kind: "herdr",
      paneAddressEnv: () => "HERDR_PANE_ID",
      observe: async () => ({ kind: "herdr", instanceId: "herdr:test", sessions: [] }),
      currentLocation: async () => ({ kind: "herdr", instanceId: "herdr:test", nativeSessionId: "w13", nativeWindowId: null, nativePaneId: null }),
      adapter: { insideRuntime: () => true },
    } as unknown as ManagedMultiplexer

    await expect(invokingSessionTarget(multiplexer, { HERDR_PANE_ID: "w16:p2" })).rejects.toThrow(/invoking herdr pane w16:p2/i)
  })

  test("rejects explicit parents when lineage is off", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "off")).rejects.toThrow(/does not support --parent/)
  })

  test("rejects unknown explicit parents in enabled modes", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "best-effort")).rejects.toThrow(/Unknown workshop parent id/)
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "strict")).rejects.toThrow(/Unknown workshop parent id/)
  })
})

describe("spawn model validation", () => {
  test("rejects unsupported and malformed overrides before touching the multiplexer or worktree", async () => {
    const multiplexer = new Proxy({}, { get: () => { throw new Error("multiplexer must not be touched") } }) as ManagedMultiplexer
    for (const [harness, model, error] of [
      ["opencode", "provider/new-model", /--model is not supported for OpenCode/],
      ["pi", " ", /Invalid model/],
      ["claude", "model\nother", /Invalid model/],
      ["codex", "--flag", /Invalid model/],
    ] as const) {
      await expect(spawnClanker(harness, "/not-a-workshop", "task", { model, multiplexer })).rejects.toThrow(error)
      await expect(spawnWorkshop(harness, "must-not-create", "task", { model, multiplexer })).rejects.toThrow(error)
    }
  })
})

describe("workshop spawn rollback", () => {
  test("removes the new multiplexer session, worktree, and branch after registry failure", async () => {
    const created = {
      identity: { path: "/tmp/repo/failed-workshop", commonDir: "/tmp/repo/.git", repo: "repo", branch: "failed-workshop" },
      session: "repo@failed-workshop",
    }
    const commands: string[][] = []
    const killed: string[] = []
    const multiplexer = {
      kind: "herdr",
      observe: async () => ({ kind: "herdr", instanceId: "herdr:test", sessions: [{ id: "$7", nativeName: "repo@failed-workshop", path: "/tmp/repo/failed-workshop", recency: 0, attached: false, worktreePath: "", directoryPath: "", windows: [] }] }),
      kill: async (location: { nativeSessionId: string }) => { killed.push(location.nativeSessionId) },
    } as unknown as ManagedMultiplexer
    const rollback = (workshop: Parameters<typeof rollbackCreatedWorkshop>[0]) => rollbackCreatedWorkshop(workshop, {
      multiplexer,
      run: async (argv) => {
        commands.push(argv)
        return { stdout: "", stderr: "", code: 0 }
      },
    })

    await expect(completeWorkshopRegistration(created, async () => {
      throw new ClankerRegistrationError("CHECK constraint failed: policy_version = 1", { cause: new Error("constraint") })
    }, rollback)).rejects.toThrow(/policy_version = 1/)

    expect(killed).toEqual(["$7"])
    expect(commands).toEqual([
      ["wt", "-C", "/tmp/repo/failed-workshop", "remove", "--foreground", "--force", "--force-delete", "--yes", "/tmp/repo/failed-workshop"],
    ])
  })

  test("rolls back the worktree without touching runtime sessions when the agent was not registered", async () => {
    const created = {
      identity: { path: "/tmp/repo/failed-workshop", commonDir: "/tmp/repo/.git", repo: "repo", branch: "failed-workshop" },
      session: undefined,
    }
    const commands: string[][] = []
    const multiplexer = new Proxy({}, { get: () => { throw new Error("runtime must not be touched") } }) as ManagedMultiplexer
    await expect(completeWorkshopRegistration(created, async () => {
      throw new ClankerRegistrationError("invalid profile", { cause: new Error("profile") })
    }, (workshop) => rollbackCreatedWorkshop(workshop, {
      multiplexer,
      run: async (argv) => { commands.push(argv); return { stdout: "", stderr: "", code: 0 } },
    }))).rejects.toThrow("invalid profile")
    expect(commands).toEqual([["wt", "-C", created.identity.path, "remove", "--foreground", "--force", "--force-delete", "--yes", created.identity.path]])
  })

  test("does not remove a workshop for failures after registration", async () => {
    let rolledBack = false
    const created = {
      identity: { path: "/tmp/repo/workshop", commonDir: "/tmp/repo/.git", repo: "repo", branch: "workshop" },
      session: "repo@workshop",
    }
    await expect(completeWorkshopRegistration(created, async () => { throw new Error("harness exited") }, async () => { rolledBack = true })).rejects.toThrow(/harness exited/)
    expect(rolledBack).toBe(false)
  })
})

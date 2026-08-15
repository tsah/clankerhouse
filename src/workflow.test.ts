import { describe, expect, test } from "bun:test"
import { ClankerRegistrationError, completeWorkshopRegistration, resolveWorkshopParent, rollbackCreatedWorkshop } from "./workflow"

describe("workshop parent resolution", () => {
  const missingParentId = "00000000-0000-4000-8000-000000000001"

  test("rejects explicit parents when lineage is off", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "off")).rejects.toThrow(/does not support --parent/)
  })

  test("rejects unknown explicit parents in enabled modes", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "best-effort")).rejects.toThrow(/Unknown workshop parent id/)
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "strict")).rejects.toThrow(/Unknown workshop parent id/)
  })
})

describe("workshop spawn rollback", () => {
  test("removes the new tmux session, worktree, and branch after registry failure", async () => {
    const created = {
      identity: { path: "/tmp/repo/failed-workshop", commonDir: "/tmp/repo/.git", repo: "repo", branch: "failed-workshop" },
      session: "repo@failed-workshop",
    }
    const commands: string[][] = []
    const rollback = (workshop: typeof created) => rollbackCreatedWorkshop(workshop, async (argv) => {
      commands.push(argv)
      return { stdout: "", stderr: "", code: 0 }
    })

    await expect(completeWorkshopRegistration(created, async () => {
      throw new ClankerRegistrationError("CHECK constraint failed: policy_version = 1", { cause: new Error("constraint") })
    }, rollback)).rejects.toThrow(/policy_version = 1/)

    expect(commands).toEqual([
      ["tmux", "kill-session", "-t", "=repo@failed-workshop"],
      ["wt", "-C", "/tmp/repo/failed-workshop", "remove", "--foreground", "--force", "--force-delete", "--yes", "/tmp/repo/failed-workshop"],
    ])
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

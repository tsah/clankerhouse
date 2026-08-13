import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitStatusPaths, markDirectoryActivity, newestActivity, readDirectoryActivities } from "./activity"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("recovery activity", () => {
  test("persists only newer canonical-path activity", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-activity-"))
    roots.push(root)
    const worktree = join(root, "worktree")
    const ledger = join(root, "state")
    mkdirSync(worktree)

    markDirectoryActivity(worktree, "opened", 1_000, 0, ledger)
    markDirectoryActivity(worktree, "clanker", 900, 0, ledger)
    expect(readDirectoryActivities(ledger).get(worktree)).toEqual({ path: worktree, source: "opened", updatedAt: 1_000 })

    markDirectoryActivity(worktree, "clanker", 2_000, 0, ledger)
    expect(readDirectoryActivities(ledger).get(worktree)).toEqual({ path: worktree, source: "clanker", updatedAt: 2_000 })
  })

  test("extracts modified, untracked, and renamed status paths", () => {
    const status = " M tracked file\0?? untracked\0R  renamed\0original\0"
    expect(gitStatusPaths(status)).toEqual(["tracked file", "untracked", "renamed"])
  })

  test("selects the newest recovery signal", () => {
    expect(newestActivity(
      { path: "/old", source: "commit", updatedAt: 10 },
      { path: "/new", source: "edited", updatedAt: 20 },
    )).toEqual({ path: "/new", source: "edited", updatedAt: 20 })
  })
})

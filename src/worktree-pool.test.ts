import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claimSpareWorktree, isSpareWorktreePath, refillSpareWorktree, worktreePoolEnabled } from "./worktree-pool"

const hasWorktrunk = Bun.spawnSync(["sh", "-c", "command -v wt"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
const savedEnv = { ...Bun.env }
let root = ""

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const repository = (name: string) => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, "init", "--quiet", "--initial-branch", "main")
  writeFileSync(join(path, "tracked"), "one\n")
  git(path, "add", "tracked")
  git(path, "commit", "--quiet", "--message", "init")
  return realpathSync(path)
}

const spares = (repo: string) => {
  const pool = join(repo, ".git", "clankerhouse-pool")
  return existsSync(pool) ? readdirSync(pool).filter((entry) => !entry.endsWith(".json")) : []
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clankerhouse-pool-test-"))
  // Isolate Worktrunk and git from the developer's own configuration.
  Object.assign(process.env, {
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@example.invalid", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@example.invalid",
  })
  mkdirSync(join(root, "home", ".config"), { recursive: true })
})

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

describe("warm worktree pool", () => {
  test("recognises spare paths and the opt-out", () => {
    expect(isSpareWorktreePath("/repo/.git/clankerhouse-pool/spare-1")).toBe(true)
    expect(isSpareWorktreePath("/repo/clankerhouse-pool-notes")).toBe(false)
    expect(worktreePoolEnabled({})).toBe(true)
    expect(worktreePoolEnabled({ CLANKERHOUSE_WORKTREE_POOL: "off" })).toBe(false)
  })

  test.skipIf(!hasWorktrunk)("declines without a spare, then claims a refilled one at Worktrunk's path", async () => {
    const repo = repository("claim")
    expect(claimSpareWorktree(repo, "feature", "^")).toBeUndefined()

    await refillSpareWorktree(repo)
    expect(spares(repo)).toHaveLength(1)
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked clankerhouse warm spare")

    const claimed = claimSpareWorktree(repo, "feature", "^")
    expect(claimed).toBe(join(root, "claim.feature"))
    expect(git(claimed!, "branch", "--show-current")).toBe("feature")
    expect(git(claimed!, "status", "--porcelain")).toBe("")
    expect(git(claimed!, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"))
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("locked")
    expect(spares(repo)).toHaveLength(0)
    expect(claimSpareWorktree(repo, "second")).toBeUndefined()
  })

  test.skipIf(!hasWorktrunk)("a stale spare is brought to the requested base on claim and freshened on refill", async () => {
    const repo = repository("stale")
    await refillSpareWorktree(repo)
    writeFileSync(join(repo, "tracked"), "two\n")
    git(repo, "commit", "--quiet", "--all", "--message", "advance")
    git(repo, "branch", "release")

    await refillSpareWorktree(repo)
    const [spare] = spares(repo)
    expect(spares(repo)).toHaveLength(1)
    expect(git(join(repo, ".git", "clankerhouse-pool", spare!), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"))

    writeFileSync(join(repo, "tracked"), "three\n")
    git(repo, "commit", "--quiet", "--all", "--message", "advance again")
    const claimed = claimSpareWorktree(repo, "from-main")
    expect(claimed).toBeDefined()
    expect(await Bun.file(join(claimed!, "tracked")).text()).toBe("three\n")
  })

  test.skipIf(!hasWorktrunk)("leaves the spare intact when the request is not a plain new branch", async () => {
    const repo = repository("decline")
    await refillSpareWorktree(repo)
    git(repo, "branch", "taken")

    expect(claimSpareWorktree(repo, "taken")).toBeUndefined()
    expect(claimSpareWorktree(repo, "feature", "@")).toBeUndefined()
    expect(claimSpareWorktree(repo, "feature", "origin/main")).toBeUndefined()
    expect(spares(repo)).toHaveLength(1)
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked clankerhouse warm spare")
  })

  test.skipIf(!hasWorktrunk)("restores the spare when Worktrunk cannot relocate the claim", async () => {
    const repo = repository("blocked")
    await refillSpareWorktree(repo)
    mkdirSync(join(root, "blocked.feature"))
    writeFileSync(join(root, "blocked.feature", "in-the-way"), "")

    expect(claimSpareWorktree(repo, "feature")).toBeUndefined()
    expect(git(repo, "branch", "--list", "feature")).toBe("")
    expect(spares(repo)).toHaveLength(1)
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked clankerhouse warm spare")
    expect(claimSpareWorktree(repo, "other")).toBe(join(root, "blocked.other"))
  })

  test.skipIf(!hasWorktrunk)("removes an interrupted refill", async () => {
    const repo = repository("interrupted")
    await refillSpareWorktree(repo)
    const [spare] = spares(repo)
    rmSync(join(repo, ".git", "clankerhouse-pool", `${spare}.json`))

    expect(claimSpareWorktree(repo, "feature")).toBeUndefined()
    await refillSpareWorktree(repo)
    expect(spares(repo)).toHaveLength(1)
    expect(spares(repo)[0]).not.toBe(spare)
  })
})

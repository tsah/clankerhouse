import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repositoryProblem } from "./mutations"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

describe("a repository a Workshop is created from", () => {
  test("is a checkout or the root of a bare repository, never a plain directory", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-repository-"))
    roots.push(root)
    const checkout = join(root, "checkout")
    git(root, "init", "--quiet", checkout)
    // The layout of ~/dev/work/tweezr: a bare repository in <repo>/.git, its worktrees at <repo>/<branch>.
    const bare = join(root, "bare")
    mkdirSync(bare)
    git(bare, "init", "--quiet", "--bare", ".git")
    const plain = join(root, "plain")
    mkdirSync(plain)

    expect(repositoryProblem(checkout)).toBeUndefined()
    expect(repositoryProblem(bare)).toBeUndefined()
    expect(repositoryProblem(join(bare, ".git"))).toBeUndefined()
    expect(repositoryProblem(plain)).toContain("not a git repository")
  })
})

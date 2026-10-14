import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freshDefaultBase, workshopBase } from "./workshop-base"

const hasWorktrunk = Bun.spawnSync(["sh", "-c", "command -v wt"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
const savedEnv = { ...Bun.env }
let root = ""

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

let sequence = 0
/** A clone whose local `trunk` is one commit behind its origin, as a bare repo left alone gets. */
const staleClone = () => {
  const dir = join(root, `case-${++sequence}`)
  mkdirSync(dir, { recursive: true })
  const remote = join(dir, "remote.git")
  const upstream = join(dir, "upstream")
  const clone = join(dir, "clone")
  git(dir, "init", "--quiet", "--bare", "--initial-branch", "trunk", remote)
  git(dir, "clone", "--quiet", remote, upstream)
  git(upstream, "commit", "--quiet", "--allow-empty", "--message", "one")
  git(upstream, "push", "--quiet", "origin", "HEAD:trunk")
  git(dir, "clone", "--quiet", remote, clone)
  git(upstream, "commit", "--quiet", "--allow-empty", "--message", "two")
  git(upstream, "push", "--quiet", "origin", "HEAD:trunk")
  return { remote, clone, stale: git(clone, "rev-parse", "trunk"), tip: git(upstream, "rev-parse", "HEAD") }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "clankerhouse-workshop-base-test-"))
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

describe("workshop base", () => {
  test("fetches the remote default branch instead of trusting the stale local ref", () => {
    const { clone, stale, tip } = staleClone()
    expect(stale).not.toBe(tip)
    expect(freshDefaultBase(clone)).toBe("origin/trunk")
    expect(git(clone, "rev-parse", "origin/trunk")).toBe(tip)
    expect(git(clone, "rev-parse", "trunk")).toBe(stale)
  })

  test("asks the remote for its default branch when origin/HEAD is not recorded", () => {
    const { clone, tip } = staleClone()
    git(clone, "remote", "set-head", "origin", "--delete")
    expect(freshDefaultBase(clone)).toBe("origin/trunk")
    expect(git(clone, "rev-parse", "origin/trunk")).toBe(tip)
  })

  test("fails with the fetch error instead of falling back to the local ref", () => {
    const { clone, remote } = staleClone()
    rmSync(remote, { recursive: true, force: true })
    expect(() => freshDefaultBase(clone)).toThrow(/Unable to fetch origin\/trunk for the new Workshop's base: .*remote\.git/s)
  })

  test("fails when the remote's default branch cannot be resolved", () => {
    const { clone, remote } = staleClone()
    git(clone, "remote", "set-head", "origin", "--delete")
    rmSync(remote, { recursive: true, force: true })
    expect(() => freshDefaultBase(clone)).toThrow(/Unable to resolve origin's default branch/)
  })

  test("leaves a repository without an origin remote to Worktrunk's default", () => {
    const { clone } = staleClone()
    git(clone, "remote", "remove", "origin")
    expect(freshDefaultBase(clone)).toBeUndefined()
  })

  test("keeps an explicit base without touching the remote", () => {
    const untouched = () => { throw new Error("git must not run for an explicit base") }
    expect(workshopBase("/nonexistent", "feature/parent", untouched)).toBe("feature/parent")
  })

  test.skipIf(!hasWorktrunk)("creates the Worktrunk branch at the fetched tip without tracking the default branch", () => {
    const { clone, tip } = staleClone()
    const base = workshopBase(clone)!
    const created = Bun.spawnSync(["wt", "-C", clone, "switch", "--create", "fresh", "--no-cd", "--no-hooks", "--format", "json", "--base", base], { stdout: "pipe", stderr: "pipe" })
    expect(created.exitCode).toBe(0)
    const { path } = JSON.parse(created.stdout.toString()) as { path: string }
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(Bun.spawnSync(["git", "-C", clone, "config", "--get", "branch.fresh.merge"]).exitCode).not.toBe(0)
  })
})

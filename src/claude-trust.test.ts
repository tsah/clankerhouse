import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeGlobalConfigFile, trustFolderForAccount, trustInConfig, trustKeysFor } from "./claude-trust"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankerhouse-claude-trust-")))
  roots.push(root)
  return root
}
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", ...args], { stdout: "ignore", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
/** A repository and a linked worktree beside it, the way Workshops lay them out. */
const repoWithWorktree = (root: string) => {
  const main = join(root, "repo")
  mkdirSync(main)
  git(main, "init", "-q", "-b", "main")
  git(main, "commit", "-q", "--allow-empty", "-m", "fixture")
  const worktree = join(root, "repo.feature")
  git(main, "worktree", "add", "-q", "-b", "feature", worktree)
  return { main, worktree }
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))

describe("which folders Claude looks trust up under", () => {
  test("a linked worktree: the folder itself and the main repository root (the parent of the shared .git)", () => {
    const { main, worktree } = repoWithWorktree(scratch())
    expect(trustKeysFor(worktree)).toEqual([worktree, main])
    mkdirSync(join(worktree, "sub"))
    expect(trustKeysFor(join(worktree, "sub"))).toEqual([join(worktree, "sub"), worktree, main])
  })

  test("a worktree of a repository whose .git holds every worktree inside it (~/dev/work/tweezr)", () => {
    const root = scratch()
    const repo = join(root, "tweezr")
    mkdirSync(repo)
    git(repo, "init", "-q", "--bare", ".git")
    git(join(repo, ".git"), "config", "core.bare", "true")
    const seed = join(root, "seed")
    git(root, "clone", "-q", join(repo, ".git"), seed)
    git(seed, "commit", "-q", "--allow-empty", "-m", "fixture")
    git(seed, "push", "-q", "origin", "HEAD:main")
    git(join(repo, ".git"), "worktree", "add", "-q", join(repo, "task"), "main")
    expect(trustKeysFor(join(repo, "task"))).toEqual([join(repo, "task"), repo])
  })

  test("a folder outside git is just itself", () => {
    const folder = scratch()
    expect(trustKeysFor(folder)).toEqual([folder])
  })
})

describe("trusting in one account's config", () => {
  const config = (root: string, value: unknown = { numStartups: 3, oauthAccount: { emailAddress: "kept@example.invalid" }, projects: { "/elsewhere": { allowedTools: ["Bash"], hasTrustDialogAccepted: false } } }) => {
    const file = join(root, ".claude.json")
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    return file
  }

  test("sets only the trust flag, keeping every other key and entry, the file's mode, and is idempotent", () => {
    const root = scratch()
    const file = config(root)
    const result = trustInConfig(file, ["/work/repo", "/elsewhere"])
    expect(result).toEqual({ configFile: file, trusted: ["/work/repo", "/elsewhere"], already: [] })
    const after = read(file)
    expect(after.numStartups).toBe(3)
    expect(after.oauthAccount).toEqual({ emailAddress: "kept@example.invalid" })
    expect(after.projects["/elsewhere"]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true })
    expect(after.projects["/work/repo"]).toMatchObject({ hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {} })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, "utf8")
    expect(trustInConfig(file, ["/work/repo"])).toEqual({ configFile: file, trusted: [], already: ["/work/repo"] })
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  test("never creates a config, and never rewrites one it cannot read", () => {
    const root = scratch()
    expect(trustInConfig(join(root, ".claude.json"), ["/x"]).skipped).toContain("no Claude config")
    expect(existsSync(join(root, ".claude.json"))).toBe(false)
    writeFileSync(join(root, ".claude.json"), "{ half")
    expect(trustInConfig(join(root, ".claude.json"), ["/x"]).skipped).toContain("not readable JSON")
    expect(readFileSync(join(root, ".claude.json"), "utf8")).toBe("{ half")
  })

  test("waits for Claude's config lock, gives up on a live one, and takes over a stale one", () => {
    const root = scratch()
    const file = config(root)
    mkdirSync(`${file}.lock`)
    expect(trustInConfig(file, ["/x"], { waitMs: 200 }).skipped).toContain("config lock")
    expect(read(file).projects["/x"]).toBeUndefined()
    const old = (Date.now() - 60_000) / 1000
    utimesSync(`${file}.lock`, old, old)
    expect(trustInConfig(file, ["/x"], { waitMs: 200 }).trusted).toEqual(["/x"])
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  test("writes through a linked config to its target", () => {
    const root = scratch()
    const target = config(root)
    const dir = join(root, "acct")
    mkdirSync(dir)
    Bun.spawnSync(["ln", "-s", target, join(dir, ".claude.json")])
    trustInConfig(join(dir, ".claude.json"), ["/x"])
    expect(read(target).projects["/x"].hasTrustDialogAccepted).toBe(true)
  })
})

describe("before a launch on an account", () => {
  test("a named account's directory and Claude's default ~/.claude.json, never the credentials file", () => {
    const home = scratch()
    const { main, worktree } = repoWithWorktree(home)
    const acct = join(home, ".claude-acct", "personal")
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, ".claude.json"), "{}")
    writeFileSync(join(acct, ".credentials.json"), "do-not-touch")
    chmodSync(join(acct, ".credentials.json"), 0o600)
    const before = statSync(join(acct, ".credentials.json")).mtimeMs
    writeFileSync(join(home, ".claude.json"), "{}")
    const accounts = [{ label: "work", configDir: null }, { label: "personal", configDir: acct }]
    const env = { HOME: home }
    expect(trustFolderForAccount("personal", worktree, { accounts, env })?.trusted).toEqual([worktree, main])
    expect(read(join(acct, ".claude.json")).projects[main].hasTrustDialogAccepted).toBe(true)
    expect(readFileSync(join(acct, ".credentials.json"), "utf8")).toBe("do-not-touch")
    expect(statSync(join(acct, ".credentials.json")).mtimeMs).toBe(before)
    expect(trustFolderForAccount("work", worktree, { accounts, env })?.configFile).toBe(join(home, ".claude.json"))
    expect(read(join(home, ".claude.json")).projects[worktree].hasTrustDialogAccepted).toBe(true)
    // An account no longer listed runs on the default config, so that is the one trusted.
    expect(trustFolderForAccount("gone", worktree, { accounts, env })?.already).toEqual([worktree, main])
    expect(trustFolderForAccount(undefined, worktree, { accounts, env })).toBeUndefined()
  })

  test("the legacy .config.json when it is the only config", () => {
    const home = scratch()
    mkdirSync(join(home, ".claude"))
    writeFileSync(join(home, ".claude", ".config.json"), "{}")
    expect(claudeGlobalConfigFile(null, home)).toBe(join(home, ".claude", ".config.json"))
    writeFileSync(join(home, ".claude.json"), "{}")
    expect(claudeGlobalConfigFile(null, home)).toBe(join(home, ".claude.json"))
    expect(claudeGlobalConfigFile("/a/b", home)).toBe("/a/b/.claude.json")
  })
})

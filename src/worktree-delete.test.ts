import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { padding?: number; fault?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-delete-test-"))
  roots.push(root)
  for (const dir of ["bin", "home", "runtime", "state", "data", "config"]) mkdirSync(join(root, dir))
  const repository = join(root, "repository")
  const worktree = join(root, "feature")
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    CLANKERHOUSE_MULTIPLEXER: "herdr",
    CLANKERHOUSE_INSTANCE: "",
    CLANKERHOUSE_CLANKERS: join(root, "bin/clankers"),
    HERDR_SOCKET_PATH: join(root, "no-live-runtime.sock"),
    HERDR_ENV: "",
    HERDR_PANE_ID: "",
    TMUX: "",
    TMUX_PANE: "",
    PATH: `${join(root, "bin")}:${process.env.PATH || ""}`,
    QA_ROOT: root,
    QA_FAULT: options.fault || "",
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git("init", "-q", "-b", "main", repository)
  git("-C", repository, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture", "--allow-empty")
  git("-C", repository, "worktree", "add", "-q", "-b", "feature", worktree)
  const sessions = [
    { id: "worktree-target", worktreePath: worktree },
    { id: "directory-target", directoryPath: `${repository}/../feature` },
    { id: "cwd-target", path: worktree },
    { id: "already-closed", worktreePath: worktree },
    { id: "survivor", worktreePath: repository },
  ]
  writeFileSync(join(root, "before.json"), JSON.stringify({ sessions, padding: "x".repeat(options.padding || 0) }))
  writeFileSync(join(root, "after.json"), JSON.stringify({
    sessions: [...sessions.filter((s) => s.id !== "already-closed"), { id: "new-session", path: worktree }],
    padding: "y".repeat(options.padding || 0),
  }))
  writeFileSync(env.CLANKERHOUSE_CLANKERS, `#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["QA_ROOT"])
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as out: out.write(json.dumps(args) + "\\n")
if args == ["mux", "observe"]:
    after = (root / "observed").exists()
    (root / "observed").touch()
    fault = os.environ.get("QA_FAULT", "")
    prefix = "after" if after else "before"
    if fault == prefix + "-error":
        print("runtime observation failed", file=sys.stderr)
        sys.exit(19)
    if fault == prefix + "-malformed": print("not-json")
    elif fault == prefix + "-missing-sessions": print("{}")
    elif fault == prefix + "-invalid-sessions": print('{"sessions": {}}')
    else: print((root / ("after.json" if after else "before.json")).read_text())
elif len(args) == 4 and args[:3] == ["mux", "kill", "--session"]:
    if os.environ.get("QA_FAULT") == "kill-error": sys.exit(23)
else: sys.exit(99)
`)
  chmodSync(env.CLANKERHOUSE_CLANKERS, 0o755)
  // Use Git only inside this fixture as a narrow Worktrunk double. The standalone
  // scenario exercises the production helper with real Worktrunk and tmux.
  const wt = join(root, "bin/wt")
  writeFileSync(wt, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$QA_ROOT/wt.log"
[[ "$*" == "-C $QA_ROOT/feature -y remove --foreground --force --no-delete-branch" ]]
git -C "$QA_ROOT/repository" worktree remove --force "$QA_ROOT/feature"
`)
  chmodSync(wt, 0o755)
  return {
    root, repository, worktree, git,
    calls: () => readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
    remove: async () => {
      const child = Bun.spawn([join(import.meta.dir, "../libexec/worktree-delete"), "--yes", worktree], { env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code, stdout, stderr }
    },
  }
}

describe("worktree deletion runtime snapshots", () => {
  test.each([0, 512 * 1024])("closes only original linked sessions with %i bytes of snapshot padding", async (padding) => {
    const f = fixture({ padding })
    const result = await f.remove()
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(f.worktree)).toBe(false)
    expect(f.git("-C", f.repository, "show-ref", "--verify", "refs/heads/feature")).toContain("refs/heads/feature")
    expect(f.calls().filter((args) => args[1] === "kill")).toEqual([
      ["mux", "kill", "--session", "worktree-target"],
      ["mux", "kill", "--session", "directory-target"],
      ["mux", "kill", "--session", "cwd-target"],
    ])
    expect(result.stderr).not.toContain("Argument list too long")
  })

  test.each(["before-error", "before-malformed", "before-missing-sessions", "before-invalid-sessions"])("refuses destructive work when initial observation fails: %s", async (fault) => {
    const f = fixture({ fault })
    expect((await f.remove()).code).not.toBe(0)
    expect(existsSync(join(f.worktree, ".git"))).toBe(true)
    expect(existsSync(join(f.root, "wt.log"))).toBe(false)
    expect(f.calls().filter((args) => args[1] === "kill")).toEqual([])
  })

  test.each(["after-error", "after-malformed", "after-missing-sessions", "after-invalid-sessions"])("surfaces post-removal observation failure without arbitrary session kills: %s", async (fault) => {
    const f = fixture({ fault })
    expect((await f.remove()).code).not.toBe(0)
    expect(existsSync(f.worktree)).toBe(false)
    expect(f.calls().filter((args) => args[1] === "kill")).toEqual([])
  })

  test("reports partial cleanup if a linked session cannot be closed", async () => {
    const f = fixture({ fault: "kill-error" })
    const result = await f.remove()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Worktree was removed, but herdr session worktree-target could not be closed")
    expect(f.calls().filter((args) => args[1] === "kill")).toHaveLength(3)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mutationProgressSteps, parseArgs } from "./cli"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("cli argument parsing", () => {
  test("takes flag values without consuming later flags", () => {
    const parsed = parseArgs(["workshop", "spawn", "--parent", "workshop-123", "--name", "branch", "--prompt", "prompt"])
    expect(parsed.shift()).toBe("workshop")
    expect(parsed.shift()).toBe("spawn")
    expect(parsed.take("--parent")).toBe("workshop-123")
    expect(parsed.take("--name")).toBe("branch")
    expect(parsed.take("--prompt")).toBe("prompt")
    expect(parsed.args).toEqual([])
  })

  test("rejects missing values and next-flag values", () => {
    expect(() => parseArgs(["workshop", "ensure", "--cwd"]).take("--cwd")).toThrow(/requires a value/)
    expect(() => parseArgs(["workshop", "spawn", "--parent", "--wait", "--name", "branch"]).take("--parent")).toThrow(/requires a value/)
  })

  test("consumes model overrides without leaking them into the prompt", () => {
    const parsed = parseArgs(["--model", "provider/new-model:high", "Review", "this"])
    expect(parsed.take("--model")).toBe("provider/new-model:high")
    expect(parsed.args.join(" ")).toBe("Review this")
    expect(() => parseArgs(["--model"]).take("--model")).toThrow(/--model requires a value/)
    expect(() => parseArgs(["--model", "--prompt", "task"]).take("--model")).toThrow(/--model requires a value/)
  })

  test("describes durable worktree deletion in effect order", () => {
    expect(mutationProgressSteps({ type: "delete", kind: "worktree", session: "$42", path: "/repo/feature", confirmed: true })).toEqual([
      "Validating worktree identity",
      "Stopping tracked Clankers",
      "Deleting worktree",
      "Deleting tmux session",
      "Refreshing Clankerhouse",
    ])
  })

  test("regular tmux Alt-D forwards a linked worktree as durable worktree scope", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-alt-d-"))
    roots.push(root)
    const origin = join(root, "origin")
    const worktree = join(root, "feature")
    const bin = join(root, "bin")
    const log = join(root, "tmux.log")
    mkdirSync(origin)
    mkdirSync(bin)
    for (const args of [
      ["git", "init", "-q", "-b", "main", origin],
      ["git", "-C", origin, "config", "user.name", "QA"],
      ["git", "-C", origin, "config", "user.email", "qa@example.invalid"],
    ]) expect(Bun.spawnSync(args).exitCode).toBe(0)
    writeFileSync(join(origin, "fixture"), "fixture")
    expect(Bun.spawnSync(["git", "-C", origin, "add", "fixture"]).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "-C", origin, "commit", "-qm", "fixture"]).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "-C", origin, "worktree", "add", "-q", "-b", "feature", worktree]).exitCode).toBe(0)
    writeFileSync(join(bin, "tmux"), `#!/bin/bash\ncase "$*" in\n  *"#{session_name}"*) printf 'feature-session\\n' ;;\n  *"#{@dotfiles_worktree_path}"*) printf '%s\\n' "$WORKTREE" ;;\n  *"#{session_path}"*) printf '%s\\n' "$WORKTREE" ;;\n  display-popup*) printf '%s\\n' "$*" > "$DELETE_LOG" ;;\nesac\n`, { mode: 0o755 })

    const result = Bun.spawnSync([join(import.meta.dir, "../bin/clankerhouse-delete"), "%999999", "$42"], {
      env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}`, HERDR_ENV: "", HERDR_PANE_ID: "", CLANKERHOUSE_MULTIPLEXER: "tmux", WORKTREE: worktree, DELETE_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const invocation = readFileSync(log, "utf8")
    expect(invocation).toContain("CLANKERHOUSE_DELETE_KIND=worktree")
    expect(invocation).toContain(`CLANKERHOUSE_DELETE_PATH=${worktree}`)
  })
})

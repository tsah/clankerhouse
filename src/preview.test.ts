import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeProjectKey, lastAssistantText, parseShortstat, piSessionKey, tailLines, workshopPreview } from "./preview"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const toolUse = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } })
const toolResult = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } })

describe("workshop preview", () => {
  test("session stores are found by each harness's own path key", () => {
    expect(claudeProjectKey("/home/tsah/clankerhouse.retro-on-workshop-retire")).toBe("-home-tsah-clankerhouse-retro-on-workshop-retire")
    expect(piSessionKey("/home/tsah/clankerhouse.simplify")).toBe("--home-tsah-clankerhouse.simplify--")
  })

  test("the last thing said is the newest assistant text, skipping tool traffic and broken lines", () => {
    const transcript = [assistant("first answer"), toolResult, assistant("All tests pass.\n\nReady for review."), toolUse, toolResult, "{not json", ""].join("\n")
    expect(lastAssistantText(transcript)).toBe("All tests pass.\n\nReady for review.")
    expect(lastAssistantText([toolUse, toolResult].join("\n"))).toBeUndefined()
    expect(lastAssistantText(JSON.stringify({ message: { role: "assistant", content: "plain string" } }))).toBe("plain string")
  })

  test("tail lines drop blanks and cut overlong lines", () => {
    expect(tailLines("a\n\nb\n  \nc\nd", 3)).toEqual(["b", "c", "d"])
    expect(tailLines("x".repeat(50), 1, 10)).toEqual([`${"x".repeat(9)}…`])
  })

  test("diff size is read from git's short stat", () => {
    expect(parseShortstat(" 3 files changed, 40 insertions(+), 2 deletions(-)")).toEqual({ files: 3, insertions: 40, deletions: 2 })
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ files: 1, insertions: 1, deletions: 0 })
    expect(parseShortstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  test("a preview combines the newest transcript across harnesses with the diff against the base branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-preview-"))
    roots.push(root)
    const repo = join(root, "repo")
    const worktree = join(root, "feature")
    const run = (...argv: string[]) => {
      const result = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    run("git", "init", "-q", "-b", "main", repo)
    writeFileSync(join(repo, "a.txt"), "one\n")
    run("git", "-C", repo, "add", "a.txt")
    run("git", "-C", repo, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-q", "-m", "Initial")
    run("git", "-C", repo, "worktree", "add", "-q", "-b", "feature", worktree)
    writeFileSync(join(worktree, "a.txt"), "one\ntwo\nthree\n")

    const home = join(root, "home")
    const claudeDir = join(home, ".claude", "projects", claudeProjectKey(worktree))
    const piDir = join(home, ".pi", "agent", "sessions", piSessionKey(worktree))
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(piDir, { recursive: true })
    writeFileSync(join(claudeDir, "old.jsonl"), `${assistant("older claude message")}\n`)
    writeFileSync(join(piDir, "new.jsonl"), `${assistant("line one\nline two\nline three")}\n${toolResult}\n`)
    utimesSync(join(claudeDir, "old.jsonl"), 1_000, 1_000)
    utimesSync(join(piDir, "new.jsonl"), 2_000, 2_000)

    const preview = await workshopPreview(worktree, { home, lines: 2 })
    expect(preview).toMatchObject({ path: worktree, branch: "feature", harness: "pi", lastMessage: ["line two", "line three"], lastMessageAt: 2_000_000, diff: { files: 1, insertions: 2, deletions: 0, base: "main" } })

    const silent = await workshopPreview(repo, { home })
    expect(silent.lastMessage).toEqual([])
    expect(silent.harness).toBeUndefined()
  })
})

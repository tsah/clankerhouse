import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workshopLabels, workshopsWithLabel } from "./workshop"
import { applyWorkshopLabel, completeDone, dispatchLabelsChangedHook, runDoneHook, userHookPath, workshopHookPath } from "./workshop-hooks"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-hooks-"))
  roots.push(root)
  const repo = join(root, "repo")
  const run = (...argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  run("git", "init", "-q", "-b", "main", repo)
  run("git", "-C", repo, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-q", "--allow-empty", "-m", "Initial")
  const worktree = join(root, "feature")
  run("git", "-C", repo, "worktree", "add", "-q", "-b", "feature", worktree)
  return { root, repo, worktree, dbPath: join(root, "state", "workshops.sqlite3") }
}

const writeHook = (repo: string, event: "done" | "labels-changed", body: string, mode = 0o755) => {
  const path = workshopHookPath(repo, event)
  mkdirSync(join(repo, ".clankerhouse", "hooks"), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
}

const waitForFile = async (path: string) => {
  for (let attempt = 0; attempt < 200 && !existsSync(path); attempt += 1) await Bun.sleep(10)
  return readFileSync(path, "utf8")
}

describe("workshop repository hooks", () => {
  test("a labels-changed hook runs in the workshop with the before and after labels", async () => {
    const { root, repo, dbPath } = fixture()
    const output = join(root, "hook.out")
    writeHook(repo, "labels-changed", `printf '%s|%s|%s|%s' "$PWD" "$CLANKERHOUSE_PREVIOUS_LABELS" "$CLANKERHOUSE_LABEL_STAGE" "$CLANKERHOUSE_WORKSHOP_BRANCH" > '${output}'`)

    const applied = applyWorkshopLabel(repo, "stage", "merged", dbPath)
    expect(applied).toMatchObject({ changed: true, previous: {}, labels: { stage: "merged" } })
    expect(workshopLabels(applied.workshop.workshopId, dbPath)).toEqual({ stage: "merged" })
    expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(true)
    expect(await waitForFile(output)).toBe(`${applied.workshop.canonicalPath}|{}|merged|main`)
  })

  test("a missing or non-executable hook is skipped rather than failing the label change", () => {
    const { repo, dbPath } = fixture()
    const applied = applyWorkshopLabel(repo, "stage", "merged", dbPath)
    expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(false)
    writeHook(repo, "labels-changed", "exit 0", 0o644)
    expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(false)
  })

  test("the done hook decides between handling the key and leaving the default action", async () => {
    const { repo, dbPath } = fixture()
    expect(await runDoneHook(repo, dbPath)).toEqual({ handled: false, hook: false })

    writeHook(repo, "done", `[ "\${CLANKERHOUSE_LABEL_STAGE:-}" != retro ]`)
    expect(await runDoneHook(repo, dbPath)).toEqual({ handled: true, hook: true, exitCode: 0 })
    applyWorkshopLabel(repo, "stage", "retro", dbPath)
    expect(await runDoneHook(repo, dbPath)).toEqual({ handled: false, hook: true, exitCode: 1 })
  })

  test("a crashing done hook is an error, never a silent path to the destroy confirmation", async () => {
    const { repo, dbPath } = fixture()
    writeHook(repo, "done", "echo broken >&2; exit 7")
    expect(runDoneHook(repo, dbPath)).rejects.toThrow("Workshop done hook failed with exit 7: broken")
  })

  test("without a done hook the first press marks a linked worktree done and the next is left for destruction", async () => {
    const { root, worktree, dbPath } = fixture()
    const output = join(root, "hook.out")
    writeHook(worktree, "labels-changed", `printf '%s' "$CLANKERHOUSE_LABEL_STATUS" > '${output}'`)

    const before = Date.now()
    expect(await completeDone(worktree, dbPath)).toEqual({ handled: true, hook: false, worktree: true })
    expect(await waitForFile(output)).toBe("done")
    const marked = workshopsWithLabel("status", "done", dbPath)
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ branch: "feature" })
    expect(marked[0]!.labelledAt).toBeGreaterThanOrEqual(before)
    expect(await completeDone(worktree, dbPath)).toEqual({ handled: false, hook: false, worktree: true })
    expect(workshopsWithLabel("status", "archived", dbPath)).toEqual([])
  })

  test("a primary checkout is never marked done by the built-in rule", async () => {
    const { repo, dbPath } = fixture()
    expect(await completeDone(repo, dbPath)).toEqual({ handled: false, hook: false, worktree: false })
    expect(workshopsWithLabel("status", "done", dbPath)).toEqual([])
  })

  test("a repository done hook replaces the built-in rule entirely", async () => {
    const { worktree, dbPath } = fixture()
    writeHook(worktree, "done", "exit 0")
    expect(await completeDone(worktree, dbPath)).toEqual({ handled: true, hook: true, exitCode: 0, worktree: true })
    expect(workshopsWithLabel("status", "done", dbPath)).toEqual([])
  })

  test("the operator's project hook applies to every workshop of the project, and a hook in the workshop wins", async () => {
    const { root, worktree, dbPath } = fixture()
    const previousConfig = Bun.env.XDG_CONFIG_HOME
    Bun.env.XDG_CONFIG_HOME = join(root, "config")
    try {
      const output = join(root, "user-hook.out")
      // The fixture repository's directory is "repo", so that is its project.
      const userHook = userHookPath("repo", "labels-changed")
      expect(userHook).toBe(join(root, "config", "clankerhouse", "hooks", "repo", "labels-changed"))
      mkdirSync(join(root, "config", "clankerhouse", "hooks", "repo"), { recursive: true })
      writeFileSync(userHook, `#!/bin/sh\nprintf 'user|%s|%s' "$CLANKERHOUSE_PROJECT" "$PWD" > '${output}'\n`)
      chmodSync(userHook, 0o755)

      const applied = applyWorkshopLabel(worktree, "stage", "merged", dbPath)
      expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(true)
      expect(await waitForFile(output)).toBe(`user|repo|${applied.workshop.canonicalPath}`)

      const inRepo = join(root, "repo-hook.out")
      writeHook(worktree, "labels-changed", `printf 'repo' > '${inRepo}'`)
      rmSync(output)
      expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(true)
      expect(await waitForFile(inRepo)).toBe("repo")
      await Bun.sleep(100)
      expect(existsSync(output)).toBe(false)
    } finally {
      if (previousConfig === undefined) delete Bun.env.XDG_CONFIG_HOME
      else Bun.env.XDG_CONFIG_HOME = previousConfig
    }
  })

  test("a directory outside Git has no workshop to label and falls through", async () => {
    const { root, dbPath } = fixture()
    const plain = join(root, "plain")
    mkdirSync(plain)
    expect(await runDoneHook(plain, dbPath)).toEqual({ handled: false, hook: false })
    expect(await completeDone(plain, dbPath)).toEqual({ handled: false, hook: false, worktree: false })
    expect(() => applyWorkshopLabel(plain, "stage", "x", dbPath)).toThrow()
  })
})

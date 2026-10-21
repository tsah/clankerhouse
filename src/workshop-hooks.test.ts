import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workshopLabels, workshopsWithLabel } from "./workshop"
import { applyWorkshopLabel, completeDone, dispatchLabelsChangedHook, dispatchPostCreateHook, ensureWorkshopForLabels, postCreateLogPath, runDoneHook, userHookPath, workshopHookPath } from "./workshop-hooks"

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

const writeHook = (repo: string, event: "done" | "labels-changed" | "post-create", body: string, mode = 0o755) => {
  const path = workshopHookPath(repo, event)
  mkdirSync(join(repo, ".clankerhouse", "hooks"), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
}

const waitForFile = async (path: string) => {
  // The hook's shell creates the file before it writes to it.
  for (let attempt = 0; attempt < 200 && !(existsSync(path) && readFileSync(path, "utf8")); attempt += 1) await Bun.sleep(10)
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

  test("a Workshop is labelled by its ID after its worktree is gone, and the project hook runs in the repository", async () => {
    const { root, repo, worktree, dbPath } = fixture()
    const workshop = ensureWorkshopForLabels(worktree, dbPath)
    Bun.spawnSync(["git", "-C", repo, "worktree", "remove", "--force", worktree])
    expect(() => applyWorkshopLabel(worktree, "stage", "merged", dbPath)).toThrow()
    expect(() => applyWorkshopLabel({ workshopId: "ws-unknown" }, "stage", "merged", dbPath)).toThrow("Unknown workshop: ws-unknown")

    const previousConfig = Bun.env.XDG_CONFIG_HOME
    Bun.env.XDG_CONFIG_HOME = join(root, "config")
    try {
      const output = join(root, "hook.out")
      mkdirSync(join(root, "config", "clankerhouse", "hooks", "repo"), { recursive: true })
      writeFileSync(userHookPath("repo", "labels-changed"), `#!/bin/sh\nprintf '%s|%s|%s' "$PWD" "$CLANKERHOUSE_WORKSHOP_ID" "$CLANKERHOUSE_LABEL_STAGE" > '${output}'\n`)
      chmodSync(userHookPath("repo", "labels-changed"), 0o755)

      const applied = applyWorkshopLabel({ workshopId: workshop.workshopId }, "stage", "merged", dbPath)
      expect(applied).toMatchObject({ changed: true, labels: { stage: "merged" } })
      expect(workshopLabels(workshop.workshopId, dbPath)).toEqual({ stage: "merged" })
      expect(dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)).toBe(true)
      expect(await waitForFile(output)).toBe(`${realpathSync(repo)}|${workshop.workshopId}|merged`)
    } finally {
      if (previousConfig === undefined) delete Bun.env.XDG_CONFIG_HOME
      else Bun.env.XDG_CONFIG_HOME = previousConfig
    }
  })

  test("a post-create hook prepares the new workshop in the background and logs its exit status", async () => {
    const { worktree, dbPath } = fixture()
    const previousOwner = Bun.env.CLANKERHOUSE_PROCESS_OWNER
    Bun.env.CLANKERHOUSE_PROCESS_OWNER = "disabled"
    try {
      const workshop = ensureWorkshopForLabels(worktree, dbPath)
      expect(dispatchPostCreateHook(workshop, dbPath)).toBe(false)
      writeHook(worktree, "post-create", `printf '%s|%s|%s\\n' "$PWD" "$CLANKERHOUSE_HOOK_EVENT" "$CLANKERHOUSE_WORKSHOP_BRANCH"; exit 3`)
      expect(dispatchPostCreateHook(workshop, dbPath)).toBe(true)
      const log = postCreateLogPath(workshop)
      for (let attempt = 0; attempt < 200 && !(existsSync(log) && readFileSync(log, "utf8").includes("exited")); attempt += 1) await Bun.sleep(10)
      expect(readFileSync(log, "utf8")).toMatch(new RegExp(`^${workshop.canonicalPath}\\|post-create\\|feature\\n\\S+ post-create exited 3\\n$`))
    } finally {
      if (previousOwner === undefined) delete Bun.env.CLANKERHOUSE_PROCESS_OWNER
      else Bun.env.CLANKERHOUSE_PROCESS_OWNER = previousOwner
    }
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

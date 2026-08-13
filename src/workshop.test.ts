import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { attachWorkshopToParent, attachmentCandidatesForWorkshop, bootstrapRepositoryFromManifests, detachWorkshopFromParent, identifyWorkshopSync, persistWorkshopLineage, projectSnapshot, readLineageSnapshot, reconcileRepositoryWorkshops, registerWorkshop, workshopDetails, workshopTree } from "./workshop"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tempRoot = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

const run = (argv: string[], cwd?: string) => {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `${argv.join(" ")} exited ${result.exitCode}`)
  return result.stdout.toString().trim()
}

const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd)

const createRepo = (root: string, name = "repo") => {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "config", "user.name", "Workshop Lineage QA")
  git(repo, "config", "user.email", "workshop-lineage@example.invalid")
  writeFileSync(join(repo, "fixture.txt"), "fixture\n")
  git(repo, "add", "fixture.txt")
  git(repo, "commit", "-qm", "Initial fixture")
  return repo
}

const addWorktree = (repo: string, branch: string, worktreePath: string) => {
  git(repo, "worktree", "add", "-q", "-b", branch, worktreePath)
  return worktreePath
}

const fixture = () => {
  const root = tempRoot("clankerhouse-lineage")
  const dbPath = join(root, "state", "workshops.sqlite3")
  const repo = createRepo(root)
  const child = addWorktree(repo, "child", join(root, "child"))
  const grandchild = addWorktree(repo, "grandchild", join(root, "grandchild"))
  return {
    root,
    dbPath,
    repo,
    workshops: {
      main: identifyWorkshopSync(repo),
      child: identifyWorkshopSync(child),
      grandchild: identifyWorkshopSync(grandchild),
    },
  }
}

const manifestPath = (path: string) => join(path, ".clankerhouse", "workshop.json")
const excludePath = (path: string) => {
  const resolved = run(["git", "-C", path, "rev-parse", "--git-path", "info/exclude"])
  return resolved.startsWith("/") ? resolved : resolve(path, resolved)
}
const manifest = (path: string) => JSON.parse(readFileSync(manifestPath(path), "utf8")) as { workshopId: string; parentWorkshopId: string | null; revision: number }

describe("workshop lineage store", () => {
  test("initializes the store once and keeps registration idempotent", () => {
    const { dbPath, workshops } = fixture()
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { create: true })
    db.exec("PRAGMA user_version = 0")
    db.close()

    const first = registerWorkshop(workshops.main, { dbPath })
    const second = registerWorkshop(workshops.main, { dbPath })
    const reopened = new Database(dbPath, { create: true })
    expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
    reopened.close()
    expect(second.workshopId).toBe(first.workshopId)
    expect(second.revision).toBe(first.revision)
  })

  test("rejects newer schema versions", () => {
    const { dbPath, workshops } = fixture()
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { create: true })
    db.exec("PRAGMA user_version = 2")
    db.close()

    expect(() => registerWorkshop(workshops.main, { dbPath })).toThrow(/version 2/)
  })

  test("serializes concurrent workshop registrations", async () => {
    const { root, dbPath, workshops } = fixture()
    const parent = registerWorkshop(workshops.main, { dbPath })
    const scriptPath = join(root, "register-workshop.ts")
    writeFileSync(scriptPath, `
      import { registerWorkshop } from ${JSON.stringify(resolve(import.meta.dir, "workshop.ts"))}
      const [identityJson, dbPath, parentWorkshopId] = process.argv.slice(2)
      registerWorkshop(JSON.parse(identityJson!), { dbPath, parentWorkshopId: parentWorkshopId || undefined })
    `)
    const registrations = [workshops.main, workshops.child, workshops.grandchild].map((identity, index) => Bun.spawn([
      process.execPath,
      scriptPath,
      JSON.stringify(identity),
      dbPath,
      index === 0 ? "" : parent.workshopId,
    ], { stdout: "pipe", stderr: "pipe" }))
    const results = await Promise.all(registrations.map(async (process) => ({
      code: await process.exited,
      error: await new Response(process.stderr).text(),
    })))
    expect(results).toEqual([
      { code: 0, error: "" },
      { code: 0, error: "" },
      { code: 0, error: "" },
    ])
    expect(projectSnapshot(workshops.main.path, dbPath).workshops).toHaveLength(3)
  })

  test("builds nested A → B → C lineage", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const grandchild = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })

    const details = workshopDetails(workshops.child.path, { dbPath })!
    expect(details.parent?.workshopId).toBe(main.workshopId)
    expect(details.children.map((workshop) => workshop.workshopId)).toEqual([grandchild.workshopId])
    expect(workshopTree(workshops.main.path, dbPath).map((node) => node.workshopId)).toEqual([main.workshopId])
    expect(workshopTree(workshops.main.path, dbPath)[0]?.children[0]?.workshopId).toBe(child.workshopId)
    expect(workshopTree(workshops.main.path, dbPath)[0]?.children[0]?.children[0]?.workshopId).toBe(grandchild.workshopId)
  })

  test("rejects self cycles, lineage cycles, and cross-repo parents", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const grandchild = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })
    expect(() => registerWorkshop(workshops.main, { dbPath, parentWorkshopId: main.workshopId })).toThrow(/cannot parent itself/)
    expect(() => registerWorkshop(workshops.main, { dbPath, parentWorkshopId: grandchild.workshopId })).toThrow(/cycle/)

    const otherRoot = tempRoot("clankerhouse-other")
    const otherRepo = createRepo(otherRoot, "other")
    const other = registerWorkshop(identifyWorkshopSync(otherRepo), { dbPath })
    expect(() => registerWorkshop(workshops.child, { dbPath, parentWorkshopId: other.workshopId })).toThrow(/another repository/)
  })

  test("reparents a child while keeping one active parent", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const grandchild = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: main.workshopId })

    const reparents = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })
    expect(reparents.parentWorkshopId).toBe(child.workshopId)
    expect(reparents.revision).toBe(grandchild.revision + 1)
    expect(workshopDetails(workshops.main.path, { dbPath })!.children.map((workshop) => workshop.workshopId)).toEqual([child.workshopId])
    expect(workshopDetails(workshops.child.path, { dbPath })!.children.map((workshop) => workshop.workshopId)).toEqual([grandchild.workshopId])
  })

  test("detaches a workshop as a new root while preserving its subtree", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const grandchild = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })

    const detached = detachWorkshopFromParent(child.workshopId, dbPath)
    expect(detached.parentWorkshopId).toBeNull()
    expect(detached.revision).toBe(child.revision + 1)
    expect(manifest(workshops.child.path).parentWorkshopId).toBeNull()
    expect(workshopDetails(workshops.main.path, { dbPath })!.children).toEqual([])
    expect(workshopDetails(workshops.child.path, { dbPath })!.children.map((workshop) => workshop.workshopId)).toEqual([grandchild.workshopId])
    const roots = workshopTree(workshops.main.path, dbPath).map((workshop) => workshop.workshopId)
    expect(roots).toHaveLength(2)
    expect(roots).toEqual(expect.arrayContaining([main.workshopId, child.workshopId]))
    expect(detachWorkshopFromParent(child.workshopId, dbPath).revision).toBe(detached.revision)
    expect(attachmentCandidatesForWorkshop(child.workshopId, dbPath).map((workshop) => workshop.workshopId)).toEqual([main.workshopId])
    expect(() => attachWorkshopToParent(child.workshopId, grandchild.workshopId, dbPath)).toThrow(/cycle/)

    const reattached = attachWorkshopToParent(child.workshopId, main.workshopId, dbPath)
    expect(reattached.parentWorkshopId).toBe(main.workshopId)
    expect(reattached.revision).toBe(detached.revision + 1)
    expect(manifest(workshops.child.path).parentWorkshopId).toBe(main.workshopId)
    expect(attachmentCandidatesForWorkshop(child.workshopId, dbPath)).toEqual([])
    expect(attachWorkshopToParent(child.workshopId, main.workshopId, dbPath).revision).toBe(reattached.revision)
    expect(() => detachWorkshopFromParent("missing-workshop", dbPath)).toThrow(/does not exist/)
    expect(() => attachWorkshopToParent("missing-workshop", main.workshopId, dbPath)).toThrow(/does not exist/)
  })

  test("writes a clean ignored manifest atomically and refuses unsafe conflicts", () => {
    const { dbPath, repo, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    expect(existsSync(manifestPath(workshops.main.path))).toBe(true)
    expect(manifest(workshops.main.path).workshopId).toBe(main.workshopId)
    expect(readFileSync(excludePath(workshops.main.path), "utf8").match(/\/\.clankerhouse\/workshop\.json/g)?.length).toBe(1)
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).not.toContain(".clankerhouse/workshop.json")
    expect(run(["git", "-C", repo, "check-ignore", "-v", ".clankerhouse/workshop.json"])).toContain(".git/info/exclude")

    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const cleared = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: null })
    expect(cleared.revision).toBe(child.revision + 1)
    expect(manifest(workshops.child.path).parentWorkshopId).toBeNull()
    expect(readdirSync(join(workshops.child.path, ".clankerhouse")).filter((entry) => entry.includes(".tmp"))).toEqual([])

    unlinkSync(manifestPath(workshops.child.path))
    writeFileSync(manifestPath(workshops.child.path), "tracked\n")
    git(workshops.child.path, "add", "-f", ".clankerhouse/workshop.json")
    expect(() => registerWorkshop(workshops.child, { dbPath })).toThrow(/tracked/)
    git(workshops.child.path, "reset", "HEAD", ".clankerhouse/workshop.json")

    unlinkSync(manifestPath(workshops.child.path))
    symlinkSync(join(workshops.main.path, ".gitignore"), manifestPath(workshops.child.path))
    expect(() => registerWorkshop(workshops.child, { dbPath })).toThrow(/symlink/)
    unlinkSync(manifestPath(workshops.child.path))

    rmSync(join(workshops.child.path, ".clankerhouse"), { recursive: true, force: true })
    symlinkSync(join(workshops.main.path, ".git"), join(workshops.child.path, ".clankerhouse"))
    expect(() => registerWorkshop(workshops.child, { dbPath })).toThrow(/directory is a symlink/)
    unlinkSync(join(workshops.child.path, ".clankerhouse"))
    mkdirSync(join(workshops.child.path, ".clankerhouse"), { recursive: true })

    writeFileSync(manifestPath(workshops.child.path), "{\n")
    expect(() => registerWorkshop(workshops.child, { dbPath })).toThrow(/Malformed/)

    writeFileSync(manifestPath(workshops.child.path), JSON.stringify({
      version: 1,
      workshopId: child.workshopId,
      repoId: child.repoId,
      canonicalPath: workshops.main.path,
      commonDir: workshops.child.commonDir,
      branch: workshops.child.branch,
      parentWorkshopId: null,
      revision: child.revision,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
    }, null, 2))
    expect(() => registerWorkshop(workshops.child, { dbPath })).toThrow(/conflicts with local identity/)
  })

  test("repairs missing manifests from the database", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    unlinkSync(manifestPath(workshops.child.path))
    expect(existsSync(manifestPath(workshops.child.path))).toBe(false)

    const reconciled = reconcileRepositoryWorkshops(workshops.main.path, dbPath)
    expect(reconciled.rewrittenManifestPaths).toContain(manifestPath(workshops.child.path))
    expect(manifest(workshops.child.path).parentWorkshopId).toBe(child.parentWorkshopId)
  })

  test("bootstraps an empty database from manifests", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    const grandchild = registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })
    const before = projectSnapshot(workshops.main.path, dbPath)
    rmSync(dbPath, { force: true })

    const bootstrapped = bootstrapRepositoryFromManifests(workshops.main.path, dbPath)
    const after = projectSnapshot(workshops.main.path, dbPath)
    expect(bootstrapped.workshops.map((workshop) => workshop.workshopId).sort()).toEqual(before.workshops.map((workshop) => workshop.workshopId).sort())
    expect(workshopTree(workshops.main.path, dbPath)[0]?.children[0]?.children[0]?.workshopId).toBe(grandchild.workshopId)
    expect(after.workshops.find((workshop) => workshop.canonicalPath === workshops.child.path)?.parentWorkshopId).toBe(main.workshopId)
  })

  test("bootstrap rejects inconsistent manifests before mutating the store", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    const child = registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: child.workshopId })
    rmSync(dbPath, { force: true })

    const childManifest = {
      ...manifest(workshops.child.path),
      version: 1,
      workshopId: child.workshopId,
      repoId: `${child.repoId}-other`,
      canonicalPath: workshops.child.path,
      commonDir: workshops.child.commonDir,
      branch: workshops.child.branch,
      parentWorkshopId: main.workshopId,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
    }
    writeFileSync(manifestPath(workshops.child.path), `${JSON.stringify(childManifest, null, 2)}\n`)

    expect(() => bootstrapRepositoryFromManifests(workshops.main.path, dbPath)).toThrow(/disagree on repo id/)
    expect(existsSync(dbPath)).toBe(false)

    childManifest.repoId = child.repoId
    childManifest.commonDir = `${workshops.child.commonDir}-other`
    writeFileSync(manifestPath(workshops.child.path), `${JSON.stringify(childManifest, null, 2)}\n`)
    expect(() => bootstrapRepositoryFromManifests(workshops.main.path, dbPath)).toThrow(/belongs to|conflicts with local identity/)
    expect(existsSync(dbPath)).toBe(false)
  })

  test("supports best-effort and off modes without disrupting callers", () => {
    const { dbPath, workshops } = fixture()
    mkdirSync(join(workshops.main.path, ".clankerhouse"), { recursive: true })
    writeFileSync(manifestPath(workshops.main.path), "{\n")

    expect(persistWorkshopLineage(workshops.main, { dbPath, mode: "best-effort" })).toBeUndefined()
    expect(readLineageSnapshot(dbPath).byPath.size).toBe(0)
    expect(persistWorkshopLineage(workshops.main, { dbPath, mode: "off" })).toBeUndefined()
    expect(readLineageSnapshot(dbPath).byPath.size).toBe(0)
    expect(() => persistWorkshopLineage(workshops.main, { dbPath, mode: "strict" })).toThrow(/Malformed/)
  })

  test("readLineageSnapshot fails open by default and throws in strict mode", () => {
    const root = tempRoot("clankerhouse-lineage-bad-db")
    const dbPath = join(root, "state", "workshops.sqlite3")
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { create: true })
    db.exec("PRAGMA user_version = 2")
    db.close()

    expect(readLineageSnapshot(dbPath).byPath.size).toBe(0)
    expect(() => readLineageSnapshot(dbPath, "strict")).toThrow(/version 2/)
  })

  test("exposes child counts through the lineage snapshot", () => {
    const { dbPath, workshops } = fixture()
    const main = registerWorkshop(workshops.main, { dbPath })
    registerWorkshop(workshops.child, { dbPath, parentWorkshopId: main.workshopId })
    registerWorkshop(workshops.grandchild, { dbPath, parentWorkshopId: main.workshopId })
    expect(readLineageSnapshot(dbPath).byPath.get(workshops.main.path)?.childWorkshopCount).toBe(2)
  })
})

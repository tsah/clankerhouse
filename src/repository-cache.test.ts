import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planRepositoryIdentities, readRepositoryIdentityCache, repositoryIdentityMaxAgeMs, writeRepositoryIdentityCache } from "./repository-cache"

describe("repository identity cache", () => {
  test("uses lineage and fresh cache entries without scheduling Git probes", () => {
    const now = 10_000
    const plan = planRepositoryIdentities(
      ["/work/a", "/work/b", "/work/a"],
      new Map([["/work/a", "/repos/a/.git"]]),
      { version: 1, entries: { "/work/b": { commonDir: "/repos/b/.git", checkedAt: now - 1 } } },
      now,
    )

    expect([...plan.identities]).toEqual([
      ["/work/a", "/repos/a/.git"],
      ["/work/b", "/repos/b/.git"],
    ])
    expect(plan.pathsToProbe).toEqual([])
  })

  test("keeps stale identities for first render and refreshes them in the background", () => {
    const now = repositoryIdentityMaxAgeMs + 10_000
    const plan = planRepositoryIdentities(
      ["/work/repo", "/work/plain"],
      new Map(),
      { version: 1, entries: {
        "/work/repo": { commonDir: "/repos/project/.git", checkedAt: 1 },
        "/work/plain": { commonDir: "", checkedAt: 1 },
      } },
      now,
    )

    expect(plan.identities.get("/work/repo")).toBe("/repos/project/.git")
    expect(plan.identities.has("/work/plain")).toBe(false)
    expect(plan.pathsToProbe).toEqual(["/work/repo", "/work/plain"])
  })

  test("writes atomically and treats cached non-Git paths as resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-repositories-"))
    const path = join(root, "repositories.json")
    writeRepositoryIdentityCache(path, { "/plain": { commonDir: "", checkedAt: 500 } })

    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1)
    const cache = readRepositoryIdentityCache(path)
    expect(planRepositoryIdentities(["/plain"], new Map(), cache, 501).pathsToProbe).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { selectIndependentRepositoryWorktrees } from "./directory-discovery"
import type { DirectoryRow } from "./server/resources"

const worktree = (path: string, branch = "main"): DirectoryRow => ({ path, source: "worktree", branch })

describe("development worktree discovery", () => {
  test("excludes fixture repositories nested inside another repository worktree", () => {
    const product = "/home/test/dev/product"
    const feature = "/home/test/dev/product-feature"
    const fixture = `${product}/temp/cpw-run/popen-gw0/test_builder/repo`
    const utility = "/home/test/dev/utility"

    expect(selectIndependentRepositoryWorktrees([
      { repositoryPath: product, worktrees: [worktree(product), worktree(feature, "feature")] },
      { repositoryPath: fixture, worktrees: [worktree(fixture)] },
      { repositoryPath: utility, worktrees: [worktree(utility)] },
    ])).toEqual([
      worktree(product),
      worktree(feature, "feature"),
      worktree(utility),
    ])
  })
})

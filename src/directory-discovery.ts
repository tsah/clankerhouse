import { isAbsolute, relative, resolve, sep } from "node:path"
import type { DirectoryRow } from "./server/resources"

export interface RepositoryWorktrees {
  repositoryPath: string
  worktrees: readonly DirectoryRow[]
}

const isStrictDescendant = (candidate: string, parent: string) => {
  const path = relative(resolve(parent), resolve(candidate))
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Keep repository authorities rooted independently under the development tree.
 * Embedded repositories are project contents (commonly test fixtures), not
 * sessionless Clankerhouse Workshop candidates.
 */
export const selectIndependentRepositoryWorktrees = (repositories: readonly RepositoryWorktrees[]): DirectoryRow[] =>
  repositories
    .filter((candidate, candidateIndex) => !repositories.some((repository, repositoryIndex) =>
      repositoryIndex !== candidateIndex
      && repository.worktrees.some((worktree) => isStrictDescendant(candidate.repositoryPath, worktree.path))))
    .flatMap((repository) => [...repository.worktrees])

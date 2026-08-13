import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface RepositoryIdentityEntry {
  commonDir: string
  checkedAt: number
}

export interface RepositoryIdentityCache {
  version: 1
  entries: Record<string, RepositoryIdentityEntry>
}

export interface RepositoryIdentityPlan {
  identities: Map<string, string>
  pathsToProbe: string[]
  entries: Record<string, RepositoryIdentityEntry>
}

export const repositoryIdentityMaxAgeMs = 24 * 60 * 60 * 1000

export const readRepositoryIdentityCache = (path: string): RepositoryIdentityCache => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RepositoryIdentityCache>
    if (raw.version !== 1 || !raw.entries || typeof raw.entries !== "object") throw new Error("invalid repository identity cache")
    const entries: Record<string, RepositoryIdentityEntry> = {}
    for (const [repositoryPath, entry] of Object.entries(raw.entries)) {
      if (!entry || typeof entry.commonDir !== "string" || !Number.isFinite(entry.checkedAt)) continue
      entries[repositoryPath] = entry
    }
    return { version: 1, entries }
  } catch {
    return { version: 1, entries: {} }
  }
}

export const writeRepositoryIdentityCache = (path: string, entries: Record<string, RepositoryIdentityEntry>) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify({ version: 1, entries } satisfies RepositoryIdentityCache))
  renameSync(temporaryPath, path)
}

export const planRepositoryIdentities = (
  paths: string[],
  lineageCommonDirs: ReadonlyMap<string, string>,
  cache: RepositoryIdentityCache,
  now = Date.now(),
): RepositoryIdentityPlan => {
  const identities = new Map<string, string>()
  const entries: Record<string, RepositoryIdentityEntry> = {}
  const pathsToProbe: string[] = []

  for (const path of new Set(paths)) {
    const lineageCommonDir = lineageCommonDirs.get(path)
    if (lineageCommonDir) {
      identities.set(path, lineageCommonDir)
      entries[path] = { commonDir: lineageCommonDir, checkedAt: now }
      continue
    }

    const cached = cache.entries[path]
    if (cached && now - cached.checkedAt < repositoryIdentityMaxAgeMs) {
      if (cached.commonDir) identities.set(path, cached.commonDir)
      entries[path] = cached
      continue
    }

    pathsToProbe.push(path)
    if (cached) {
      if (cached.commonDir) identities.set(path, cached.commonDir)
      entries[path] = cached
    }
  }

  return { identities, pathsToProbe, entries }
}

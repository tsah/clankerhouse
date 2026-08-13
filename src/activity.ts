import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export type ActivitySource = "active" | "clanker" | "opened" | "edited" | "reflog" | "commit"
export interface ActivityRecord { path: string; updatedAt: number; source: ActivitySource }
const activitySources = new Set<ActivitySource>(["active", "clanker", "opened", "edited", "reflog", "commit"])

export const activityStateDirectory = `${Bun.env.XDG_STATE_HOME || `${Bun.env.HOME || ""}/.local/state`}/clankerhouse/activity`

export const canonicalActivityPath = (path: string) => {
  const expanded = path === "~" ? Bun.env.HOME || path : path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path
  try { return realpathSync(expanded) }
  catch { return resolve(expanded) }
}

const activityFile = (path: string, source: ActivitySource, directory: string) => `${directory}/${createHash("sha256").update(path).digest("hex")}-${source}.json`

export const readDirectoryActivities = (directory = activityStateDirectory) => {
  const records = new Map<string, ActivityRecord>()
  if (!existsSync(directory)) return records
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue
    try {
      const record = JSON.parse(readFileSync(`${directory}/${entry}`, "utf8")) as Partial<ActivityRecord>
      if (!record.path || !record.source || !activitySources.has(record.source) || !Number.isFinite(record.updatedAt) || record.updatedAt! <= 0) continue
      const path = canonicalActivityPath(record.path)
      const current = records.get(path)
      if (!current || record.updatedAt! > current.updatedAt) records.set(path, { path, source: record.source, updatedAt: record.updatedAt! })
    } catch {}
  }
  return records
}

export const markDirectoryActivity = (path: string, source: ActivitySource, updatedAt = Date.now(), minIntervalMs = 0, directory = activityStateDirectory) => {
  if (!path || updatedAt <= 0) return
  const canonical = canonicalActivityPath(path)
  const target = activityFile(canonical, source, directory)
  try {
    const current = JSON.parse(readFileSync(target, "utf8")) as Partial<ActivityRecord>
    if (Number(current.updatedAt || 0) >= updatedAt || (current.source === source && updatedAt - Number(current.updatedAt || 0) < minIntervalMs)) return
  } catch {}
  mkdirSync(directory, { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ path: canonical, source, updatedAt } satisfies ActivityRecord))
  renameSync(tmp, target)
}

export const newestActivity = (...records: Array<ActivityRecord | undefined>) => records
  .filter((record): record is ActivityRecord => Boolean(record?.updatedAt))
  .sort((a, b) => b.updatedAt - a.updatedAt)[0]

export const gitStatusPaths = (output: string) => {
  const entries = output.split("\0")
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index += 1
  }
  return paths
}

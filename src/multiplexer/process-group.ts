/**
 * The members of a terminal's foreground process group. Rex names one foreground process, the group's leader; for a
 * clanker that is the lifecycle wrapper, and the harness is its child in the same group. Without the rest of the group
 * the harness looks gone. Linux reads descendants from /proc; elsewhere `rex.ts` uses one `ps` per observation.
 */
import { readFileSync, readlinkSync } from "node:fs"

export interface GroupMember { pid: number; name?: string; argv?: string[]; cwd?: string }

/** Reads a /proc file; injectable so the walk can be tested without live processes. */
export type ProcRead = (path: string) => string | undefined
const readProc: ProcRead = (path) => {
  try { return path.endsWith("/cwd") ? readlinkSync(path) : readFileSync(path, "utf8") } catch { return undefined }
}

/** The process group of a /proc/<pid>/stat line: the third field after the command's closing parenthesis. */
const processGroupOf = (stat: string | undefined) => {
  if (!stat) return undefined
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const group = Number(fields[2])
  return Number.isInteger(group) ? group : undefined
}

/** The leader and its descendants in the leader's group; the leader alone when /proc cannot be read. */
export const foregroundGroup = (leader: GroupMember, read: ProcRead = readProc, limit = 64): GroupMember[] => {
  const members: GroupMember[] = [leader]
  const seen = new Set([leader.pid])
  const queue = [leader.pid]
  while (queue.length && members.length < limit) {
    const pid = queue.shift()!
    const tasks = read(`/proc/${pid}/task/${pid}/children`)
    for (const value of (tasks ?? "").split(/\s+/).filter(Boolean)) {
      const child = Number(value)
      if (!Number.isInteger(child) || seen.has(child)) continue
      seen.add(child)
      if (processGroupOf(read(`/proc/${child}/stat`)) !== leader.pid) continue
      const name = read(`/proc/${child}/comm`)?.trim()
      if (!name) continue
      const argv = (read(`/proc/${child}/cmdline`) ?? "").split("\0").filter(Boolean)
      members.push({ pid: child, name, argv, cwd: read(`/proc/${child}/cwd`) })
      queue.push(child)
      if (members.length >= limit) break
    }
  }
  return members
}

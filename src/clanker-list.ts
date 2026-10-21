/**
 * `clankers list`: the herd, optionally scoped to a Workshop's children like `clankers watch`,
 * with what an orchestrator needs to diagnose a worker: its Workshop, whether the harness
 * process still runs, and the clanker's latest assistant text.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { listClankerReportFacts, type ClankerInfo, type ClankerReportFacts } from "./clanker-api"
import { openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import type { ClankerState } from "./model"
import type { MultiplexerSnapshot } from "./multiplexer/interface"
import { clankerWorkshopPaths, watchedWorkshopIds } from "./watch"
import { listWorkshopRecords, type WorkshopRecord } from "./workshop"

export interface ClankerListRow extends ClankerInfo {
  parentWorkshopId: string | null
  workshop: { id: string; path: string; branch: string; exists: boolean } | null
  /** Whether the harness process runs in the pane; null when the Multiplexer gave no process facts. */
  alive: boolean | null
  /** The clanker's latest assistant text, truncated; null when the harness exposes none. */
  lastText: string | null
}

export interface ClankerListOptions {
  cwd?: string
  /** Only clankers in the children (or all descendants) of this Workshop, resolved as `clankers watch` does. */
  childrenOf?: { workshopId: string; descendants: boolean }
  /** Only clankers in one of these lifecycle states. */
  states?: readonly ClankerState[]
}

export const CLANKER_STATES: readonly ClankerState[] = ["working", "blocked", "done", "idle", "unknown"]

/** `--state working,blocked`: a comma-separated list of lifecycle states. */
export const parseStates = (value: string): ClankerState[] => {
  const states = value.split(",").map((state) => state.trim()).filter(Boolean)
  const unknown = states.find((state) => !CLANKER_STATES.includes(state as ClankerState))
  if (unknown !== undefined || !states.length) throw new Error(`--state takes a comma-separated list of ${CLANKER_STATES.join(", ")}${unknown ? `; got ${unknown}` : ""}`)
  return states as ClankerState[]
}

export interface ClankerListDependencies {
  multiplexer?: ManagedMultiplexer
  listFacts?: (cwd: string | undefined) => Promise<ClankerReportFacts[]>
  listWorkshops?: () => WorkshopRecord[]
  /** Pane id to whether its harness runs, or undefined when process facts are unavailable. */
  harnessesAlive?: (rows: readonly ClankerInfo[]) => Promise<Map<string, boolean> | undefined>
  claudeText?: (clanker: ClankerInfo, facts: Pick<ClankerReportFacts, "harnessSessionId" | "transcriptPath">) => string | null
}

export const LAST_TEXT_LIMIT = 500

export const truncateText = (text: string, limit = LAST_TEXT_LIMIT) => {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/** A pane runs its harness when a foreground process carries the harness's name. */
export const harnessAliveIn = (snapshot: MultiplexerSnapshot, rows: readonly ClankerInfo[]) => {
  const panes = new Map(snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.map((pane) => [pane.id, pane] as const))))
  const alive = new Map<string, boolean>()
  for (const row of rows) {
    const info = panes.get(row.pane)?.processInfo
    if (!info) continue
    alive.set(row.pane, info.foregroundProcesses.some((process) =>
      process.name === row.harness || (process.argv?.[0] !== undefined && basename(process.argv[0]) === row.harness)))
  }
  return alive
}

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

const readTail = (path: string, bytes: number) => {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    // A cut first line is partial JSON; drop it.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text
  } finally { closeSync(fd) }
}

/** The newest assistant text in a Claude Code transcript (JSONL), read from its tail. */
export const lastClaudeTranscriptText = (path: string): string | null => {
  let lines: string[]
  try { lines = readTail(path, TRANSCRIPT_TAIL_BYTES).split("\n") }
  catch { return null }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.includes("\"assistant\"")) continue
    let entry: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
    try { entry = JSON.parse(line) } catch { continue }
    // Sidechain entries are subagents' messages, not the clanker's own.
    if (entry.type !== "assistant" || entry.isSidechain === true || !Array.isArray(entry.message?.content)) continue
    const text = entry.message.content
      .flatMap((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string" ? [block.text] : [])
      .join("\n")
      .trim()
    if (text) return text
  }
  return null
}

const claudeProjectSlug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-")

/** Claude Code keeps each session at `<config>/projects/<slug of its start cwd>/<session id>.jsonl`. */
export const claudeTranscriptPath = (sessionId: string, cwds: readonly string[], configDir = Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) => {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined
  const projects = join(configDir, "projects")
  const file = `${sessionId}.jsonl`
  for (const cwd of cwds) {
    const candidate = join(projects, claudeProjectSlug(cwd), file)
    if (existsSync(candidate)) return candidate
  }
  // The session may have started in another directory than the pane is in now.
  let directories: string[] = []
  try { directories = readdirSync(projects) } catch { return undefined }
  for (const directory of directories) {
    const candidate = join(projects, directory, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The hook records the transcript path; hooks that predate it leave only the session id to find it by. */
const liveClaudeText = (clanker: ClankerInfo, facts: Pick<ClankerReportFacts, "harnessSessionId" | "transcriptPath">) => {
  const path = facts.transcriptPath || (facts.harnessSessionId ? claudeTranscriptPath(facts.harnessSessionId, [clanker.cwd, clanker.worktreePath].filter(Boolean)) : undefined)
  return path ? lastClaudeTranscriptText(path) : null
}

export async function listClankerRows(options: ClankerListOptions = {}, dependencies: ClankerListDependencies = {}): Promise<ClankerListRow[]> {
  const multiplexer = dependencies.multiplexer ?? openManagedMultiplexer()
  const listFacts = dependencies.listFacts ?? ((cwd) => listClankerReportFacts({ cwd, multiplexer: dependencies.multiplexer }))
  const workshops = (dependencies.listWorkshops ?? (() => listWorkshopRecords()))()
  const harnessesAlive = dependencies.harnessesAlive
    ?? (async (rows) => rows.length ? harnessAliveIn(await multiplexer.observe({ processInfo: true }), rows) : new Map<string, boolean>())
  const claudeText = dependencies.claudeText ?? liveClaudeText
  const byPath = new Map(workshops.map((workshop) => [workshop.canonicalPath, workshop]))
  const scope = options.childrenOf ? watchedWorkshopIds(workshops, options.childrenOf.workshopId, options.childrenOf.descendants) : undefined
  const pathOf = clankerWorkshopPaths()
  const selected = (await listFacts(options.cwd)).flatMap((facts) => {
    const workshop = byPath.get(pathOf(facts.clanker))
    if (scope && (!workshop || !scope.has(workshop.workshopId))) return []
    if (options.states && !options.states.includes(facts.clanker.state)) return []
    return [{ ...facts, workshop }]
  })
  const alive = await harnessesAlive(selected.map((row) => row.clanker)).catch(() => undefined)
  return selected.map(({ workshop, ...facts }) => {
    const { clanker, latestReply } = facts
    const text = clanker.harness === "claude" ? claudeText(clanker, facts) : latestReply
    return {
      ...clanker,
      parentWorkshopId: workshop?.parentWorkshopId ?? null,
      workshop: workshop ? { id: workshop.workshopId, path: workshop.canonicalPath, branch: workshop.branch, exists: existsSync(workshop.canonicalPath) } : null,
      alive: alive?.get(clanker.pane) ?? null,
      lastText: text ? truncateText(text) : null,
    }
  })
}

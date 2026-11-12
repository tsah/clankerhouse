/**
 * A clanker's last replies: the final assistant message of each of its last turns, as the harness itself stored it.
 *
 * Nothing here reads a pane. Both harnesses append every message to a session log (JSONL) they never rewrite:
 * Claude Code's transcript, and Pi's session file. Compaction, idle compaction included, only appends a boundary, a
 * summary and notices, so the replies before it stay where they were. Pi also records each turn's final reply in its
 * pane report at turn end (integrations/pi), which is read first. These are the harness's own records, written at
 * turn end, so Clankerhouse keeps no second copy.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface LastMessage {
  /** The reply as the agent wrote it, every text block of its final message, untruncated. */
  text: string
  /** When it was written, epoch ms; null when the store does not say. */
  at: number | null
  /** The prompt that started the turn, its first 500 characters; null when unknown. */
  prompt: string | null
  /** The turn's generation, when the store numbers turns (Pi's report); null otherwise. */
  generation: number | null
}

export type LastMessagesSource = "claude-transcript" | "pi-report" | "pi-session"

export interface LastMessages {
  /** Newest first. */
  messages: LastMessage[]
  /** Where they came from, or null when this harness stores none that Clankerhouse can read. */
  source: LastMessagesSource | null
  /** The file read, for a reader who wants more than the last turns. */
  path: string | null
  /** The newest pull request the session linked (Claude's `pr-link` entries), when any. */
  pr: { number: number | null; url: string } | null
}

const PROMPT_LIMIT = 500
const FIRST_TAIL = 1024 * 1024
const MAX_TAIL = 16 * 1024 * 1024

/** The last `bytes` of a file as whole lines, and whether that reached its start. */
const readTail = (path: string, bytes: number) => {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    return { lines: (length < size ? text.slice(text.indexOf("\n") + 1) : text).split("\n"), whole: length >= size }
  } finally { closeSync(fd) }
}

/** What one log line means for the walk: part of an assistant message, a typed prompt, a PR link, or nothing. */
type Classified =
  | { kind: "assistant"; id: unknown; texts: string[]; at: number | null }
  | { kind: "prompt"; text: string }
  | { kind: "pr"; pr: NonNullable<LastMessages["pr"]> }
  | undefined

interface LogFormat {
  /** Cheap substring test before JSON parsing; a line without any of these is skipped. */
  needles: readonly string[]
  classify: (entry: any) => Classified
}

const textBlocks = (content: unknown) => Array.isArray(content)
  ? content.flatMap((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string" && block.text.trim() ? [block.text] : [])
  : []

const isoTime = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN
  return Number.isFinite(at) ? at : null
}

const promptOf = (content: unknown) => {
  if (typeof content === "string") return content
  const texts = textBlocks(content)
  return texts.length ? texts.join("\n") : undefined
}

/**
 * Claude Code's transcript. Subagents' (sidechain) messages are not the clanker's own. A typed prompt starts a turn;
 * tool results, meta lines and compaction summaries do not. A slash command such as /compact is a turn with no reply.
 */
export const claudeFormat: LogFormat = {
  needles: ["\"assistant\"", "\"user\"", "\"pr-link\""],
  classify: (entry) => {
    if (entry?.type === "pr-link") {
      const url = typeof entry.prUrl === "string" ? entry.prUrl : ""
      return url ? { kind: "pr", pr: { number: typeof entry.prNumber === "number" ? entry.prNumber : null, url } } : undefined
    }
    if (entry?.isSidechain === true) return undefined
    if (entry?.type === "assistant") return { kind: "assistant", id: entry.message?.id, texts: textBlocks(entry.message?.content), at: isoTime(entry.timestamp) }
    if (entry?.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) return undefined
    const text = promptOf(entry.message?.content)
    return text === undefined ? undefined : { kind: "prompt", text }
  },
}

/** Pi's session file: `message` entries with a role; each assistant message is one entry. */
export const piFormat: LogFormat = {
  needles: ["\"assistant\"", "\"user\""],
  classify: (entry) => {
    if (entry?.type !== "message") return undefined
    const message = entry.message
    if (message?.role === "assistant") return { kind: "assistant", id: entry.id ?? message.id, texts: textBlocks(message.content), at: isoTime(entry.timestamp) }
    if (message?.role !== "user") return undefined
    const text = promptOf(message.content)
    return text === undefined ? undefined : { kind: "prompt", text }
  },
}

/**
 * The final assistant message of each of the last `count` turns in a session log, newest first. A turn runs from one
 * typed prompt to the next; its final message is the last assistant message with text, every text block of it (one
 * message may span several lines sharing its id). A turn with no text is skipped. The log is read from its end,
 * further back only as needed.
 */
export const lastTurnReplies = (path: string, format: LogFormat, count = 2): Pick<LastMessages, "messages" | "pr"> => {
  for (let bytes = FIRST_TAIL; ; bytes *= 4) {
    let tail: ReturnType<typeof readTail>
    try { tail = readTail(path, bytes) }
    catch { return { messages: [], pr: null } }
    const messages: LastMessage[] = []
    let pr: LastMessages["pr"] = null
    // Walking backwards: the reply of the turn being read (its blocks newest first), and whether it is complete.
    let reply: { id: unknown; blocks: string[]; at: number | null; complete: boolean } | undefined
    const close = (prompt: string | null) => {
      if (reply) messages.push({ text: reply.blocks.toReversed().join("\n\n").trim(), at: reply.at, prompt: prompt === null ? null : prompt.trim().slice(0, PROMPT_LIMIT), generation: null })
      reply = undefined
    }
    for (let index = tail.lines.length - 1; index >= 0 && messages.length < count; index -= 1) {
      const line = tail.lines[index]!
      if (!line || !format.needles.some((needle) => line.includes(needle))) continue
      let classified: Classified
      try { classified = format.classify(JSON.parse(line)) } catch { continue }
      if (!classified) continue
      if (classified.kind === "pr") pr ??= classified.pr
      else if (classified.kind === "prompt") close(classified.text)
      else if (!reply) {
        if (classified.texts.length) reply = { id: classified.id, blocks: classified.texts.toReversed(), at: classified.at, complete: false }
      } else if (!reply.complete && reply.id !== undefined && classified.id === reply.id) {
        reply.blocks.push(...classified.texts.toReversed())
      } else {
        // An earlier message of the same turn: the reply is complete.
        reply.complete = true
      }
    }
    const short = messages.length < count
    // The rest may lie before the tail; read further back, unless this was the whole file.
    if (short && !tail.whole && bytes < MAX_TAIL) continue
    if (short) close(null)
    return { messages: messages.slice(0, count), pr }
  }
}

interface PiResult { generation?: unknown; timestamp?: unknown; reply?: unknown }

/** Pi's turn-end results from its pane report, newest first. */
export const piReportMessages = (report: { results?: unknown; result?: unknown } | undefined, count = 2): LastMessage[] => {
  const results = [...(Array.isArray(report?.results) ? report.results as PiResult[] : []), ...(report?.result ? [report.result as PiResult] : [])]
  const byGeneration = new Map<number, PiResult>()
  for (const result of results) {
    const generation = Number(result?.generation)
    if (Number.isFinite(generation) && generation > 0 && typeof result.reply === "string" && result.reply.trim()) byGeneration.set(generation, result)
  }
  return [...byGeneration.entries()].sort(([left], [right]) => right - left).slice(0, count).map(([generation, result]) => ({
    text: String(result.reply).trim(),
    at: Number.isFinite(Number(result.timestamp)) && Number(result.timestamp) > 0 ? Number(result.timestamp) : null,
    prompt: null,
    generation,
  }))
}

/** Pi keeps each session at `<agent dir>/sessions/<slug of its cwd>/<time>_<session id>.jsonl`. */
export const piSessionPath = (sessionId: string, agentDir = Bun.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) => {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined
  const sessions = join(agentDir, "sessions")
  let directories: string[] = []
  try { directories = readdirSync(sessions) } catch { return undefined }
  for (const directory of directories) {
    let files: string[] = []
    try { files = readdirSync(join(sessions, directory)) } catch { continue }
    const file = files.find((name) => name.endsWith(`_${sessionId}.jsonl`))
    if (file) return join(sessions, directory, file)
  }
  return undefined
}

const none: LastMessages = { messages: [], source: null, path: null, pr: null }

/**
 * A clanker's last replies from what its harness stored, given its pane report: the transcript a Claude hook reported;
 * for Pi, its turn-end results, else its session file (a Pi restarted since its last turn has no results yet).
 */
export const lastMessages = (harness: string | undefined, report: Record<string, unknown> | undefined, count = 2, dependencies: { piSession?: (sessionId: string) => string | undefined } = {}): LastMessages => {
  if (count <= 0) return none
  if (harness === "claude") {
    const path = typeof report?.transcriptPath === "string" ? report.transcriptPath : ""
    if (!path || !existsSync(path)) return none
    return { ...lastTurnReplies(path, claudeFormat, count), source: "claude-transcript", path }
  }
  if (harness === "pi") {
    const reported = piReportMessages(report, count)
    if (reported.length >= count) return { messages: reported, source: "pi-report", path: null, pr: null }
    const sessionId = typeof report?.harnessSessionId === "string" ? report.harnessSessionId : ""
    const path = sessionId ? (dependencies.piSession ?? piSessionPath)(sessionId) : undefined
    if (!path) return reported.length ? { messages: reported, source: "pi-report", path: null, pr: null } : none
    return { ...lastTurnReplies(path, piFormat, count), source: "pi-session", path }
  }
  return none
}

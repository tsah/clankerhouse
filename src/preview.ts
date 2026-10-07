import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export interface DiffSize { files: number; insertions: number; deletions: number; base: string }
export interface WorkshopPreview {
  path: string
  branch: string
  /** The last thing a clanker in this Workshop said, newest lines last. */
  lastMessage: string[]
  lastMessageAt?: number
  harness?: "claude" | "pi"
  diff?: DiffSize
}

/** Claude Code keys its per-project transcript directory by the path with every non-alphanumeric character dashed. */
export const claudeProjectKey = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-")
/** Pi keys its session directory by the path without its leading slash, slashes dashed, wrapped in double dashes. */
export const piSessionKey = (path: string) => `--${path.replace(/^\/+/, "").replace(/\//g, "-")}--`

/** The text of the newest assistant message in a JSONL transcript tail; both Claude and Pi use this shape. */
export const lastAssistantText = (jsonl: string): string | undefined => {
  const lines = jsonl.split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line.startsWith("{")) continue
    let entry: { message?: { role?: unknown; content?: unknown } }
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.message?.role !== "assistant") continue
    const content = entry.message.content
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n")
        : ""
    if (text.trim()) return text.trim()
  }
  return undefined
}

/** The last `count` non-empty lines, each cut to `width` characters. */
export const tailLines = (text: string, count: number, width = 400) =>
  text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(-count).map((line) => line.length > width ? `${line.slice(0, width - 1)}…` : line)

export const parseShortstat = (output: string) => {
  const number = (pattern: RegExp) => Number(output.match(pattern)?.[1] ?? 0)
  return { files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?\(\+\)/), deletions: number(/(\d+) deletions?\(-\)/) }
}

const transcriptTailBytes = 512 * 1024
const readTail = (file: string) => {
  const size = statSync(file).size
  const length = Math.min(size, transcriptTailBytes)
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(file, "r")
  try { readSync(descriptor, buffer, 0, length, size - length) } finally { closeSync(descriptor) }
  const text = buffer.toString("utf8")
  // A tail that starts mid-file begins with a partial line.
  return size > length ? text.slice(text.indexOf("\n") + 1) : text
}

const newestTranscript = (directory: string) => {
  if (!existsSync(directory)) return undefined
  let newest: { file: string; modifiedAt: number } | undefined
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue
    const file = join(directory, name)
    const modifiedAt = statSync(file).mtimeMs
    if (!newest || modifiedAt > newest.modifiedAt) newest = { file, modifiedAt }
  }
  return newest
}

const git = async (path: string, args: string[]) => {
  const proc = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), 5_000)
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    return code === 0 ? stdout.trim() : undefined
  } finally { clearTimeout(timer) }
}

const diffSize = async (path: string): Promise<DiffSize | undefined> => {
  const remoteHead = (await git(path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))
  for (const base of [remoteHead, "origin/main", "origin/master", "main", "master"]) {
    if (!base) continue
    const mergeBase = await git(path, ["merge-base", "HEAD", base])
    if (!mergeBase) continue
    const stat = await git(path, ["diff", "--shortstat", mergeBase])
    return stat === undefined ? undefined : { ...parseShortstat(stat), base }
  }
  return undefined
}

export interface PreviewSources { home?: string; lines?: number }

/** Reads only harness-native session stores and Git; never a terminal pane. */
export const workshopPreview = async (path: string, sources: PreviewSources = {}): Promise<WorkshopPreview> => {
  const home = sources.home ?? Bun.env.HOME ?? ""
  const candidates = [
    { harness: "claude" as const, transcript: newestTranscript(join(home, ".claude", "projects", claudeProjectKey(path))) },
    { harness: "pi" as const, transcript: newestTranscript(join(home, ".pi", "agent", "sessions", piSessionKey(path))) },
  ].flatMap((candidate) => candidate.transcript ? [{ harness: candidate.harness, ...candidate.transcript }] : []).toSorted((left, right) => right.modifiedAt - left.modifiedAt)
  let lastMessage: string[] = []
  let source: typeof candidates[number] | undefined
  for (const candidate of candidates) {
    let text: string | undefined
    try { text = lastAssistantText(readTail(candidate.file)) } catch { continue }
    if (!text) continue
    lastMessage = tailLines(text, sources.lines ?? 12)
    source = candidate
    break
  }
  const [branch, diff] = await Promise.all([git(path, ["branch", "--show-current"]), diffSize(path)])
  return { path, branch: branch ?? "", lastMessage, ...(source ? { lastMessageAt: Math.round(source.modifiedAt), harness: source.harness } : {}), ...(diff ? { diff } : {}) }
}

import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeFormat, lastMessages, lastTurnReplies, piFormat, piReportMessages, piSessionPath } from "./last-messages"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-last-messages-"))
  roots.push(root)
  return root
}
const jsonl = (entries: object[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")

let clock = Date.parse("2026-11-12T10:00:00Z")
const at = () => new Date(clock += 1000).toISOString()
const prompt = (text: string) => ({ type: "user", isSidechain: false, timestamp: at(), message: { role: "user", content: text } })
const toolUse = (id: string) => ({ type: "assistant", isSidechain: false, timestamp: at(), message: { id, role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: {} }] } })
const toolResult = (id: string) => ({ type: "user", isSidechain: false, timestamp: at(), message: { role: "user", content: [{ tool_use_id: `toolu_${id}`, type: "tool_result", content: [{ type: "text", text: "ok" }] }] } })
const said = (id: string, text: string, extra: object = {}) => ({ type: "assistant", isSidechain: false, timestamp: at(), message: { id, role: "assistant", content: [{ type: "text", text }] }, ...extra })
const thinking = (id: string) => ({ type: "assistant", isSidechain: false, timestamp: at(), message: { id, role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }] } })
const turnEnd = () => [{ type: "system", subtype: "stop_hook_summary", timestamp: at() }, { type: "system", subtype: "turn_duration", timestamp: at() }]

/** What Claude Code appended to a real transcript on `/compact` (scratch probe, 2.1.322) and on idle compaction (2.1.300). */
const manualCompaction = () => [
  { type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: at() },
  { type: "user", isCompactSummary: true, timestamp: at(), message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation." } },
  { type: "user", isMeta: true, timestamp: at(), message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request</local-command-caveat>" } },
  { type: "user", timestamp: at(), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } },
  { type: "user", timestamp: at(), message: { role: "user", content: "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>" } },
]
const idleCompaction = () => [
  { type: "system", subtype: "away_summary", content: "We built the spec-first flow; the PR waits on your merge.", timestamp: at() },
  { type: "last-prompt" }, { type: "ai-title" }, { type: "mode" }, { type: "permission-mode" },
  { type: "pr-link", prNumber: 4704, prUrl: "https://github.com/acme/repo/pull/4704", timestamp: at() },
  { type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: at() },
  { type: "user", isCompactSummary: true, timestamp: at(), message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } },
  ...Array.from({ length: 12 }, () => ({ type: "attachment", timestamp: at(), attachment: { type: "file", content: "x".repeat(2000) } })),
  { type: "system", subtype: "informational", content: "Compacted while idle, before the prompt cache expired", level: "notice", timestamp: at() },
]

describe("last replies from a Claude transcript", () => {
  test("the text captured at turn end is returned identically after compaction, manual or idle", () => {
    const path = join(scratch(), "session.jsonl")
    writeFileSync(path, jsonl([
      prompt("Fix the flaky test."),
      thinking("m1"), toolUse("m1"), toolResult("m1"),
      said("m2", "Fixed it: the clock was not frozen."), ...turnEnd(),
      prompt("Open the PR."),
      said("m3", "Opening it now."), toolUse("m3"), toolResult("m3"),
      thinking("m4"), said("m4", "Decision needed: merge PR #12?"), said("m4", "Options:\n- merge\n- hold for review"), ...turnEnd(),
    ]))
    const atTurnEnd = lastTurnReplies(path, claudeFormat, 2)
    expect(atTurnEnd.messages.map((message) => message.text)).toEqual(["Decision needed: merge PR #12?\n\nOptions:\n- merge\n- hold for review", "Fixed it: the clock was not frozen."])
    expect(atTurnEnd.messages.map((message) => message.prompt)).toEqual(["Open the PR.", "Fix the flaky test."])

    appendFileSync(path, jsonl(manualCompaction()))
    expect(lastTurnReplies(path, claudeFormat, 2).messages).toEqual(atTurnEnd.messages)
    appendFileSync(path, jsonl(idleCompaction()))
    const afterIdle = lastTurnReplies(path, claudeFormat, 2)
    expect(afterIdle.messages).toEqual(atTurnEnd.messages)
    expect(afterIdle.pr).toEqual({ number: 4704, url: "https://github.com/acme/repo/pull/4704" })

    // A new turn after compaction is the newest reply; the one before it is the pre-compaction reply, still whole.
    appendFileSync(path, jsonl([prompt("Merge it."), said("m5", "Merged."), ...turnEnd()]))
    expect(lastTurnReplies(path, claudeFormat, 2).messages.map((message) => message.text)).toEqual(["Merged.", atTurnEnd.messages[0]!.text])
  })

  test("subagents' messages and tool results are not the clanker's turns; replies are untruncated", () => {
    const path = join(scratch(), "session.jsonl")
    const long = "y".repeat(5000)
    writeFileSync(path, jsonl([
      prompt("Review it."),
      said("m1", long),
      { ...said("s1", "subagent chatter"), isSidechain: true },
      { ...prompt("subagent prompt"), isSidechain: true },
      toolResult("m1"),
    ]))
    expect(lastTurnReplies(path, claudeFormat, 2).messages).toEqual([{ text: long, at: expect.any(Number), prompt: "Review it.", generation: null }])
  })

  test("reads further back than the first tail when a reply is buried under later lines", () => {
    const path = join(scratch(), "session.jsonl")
    writeFileSync(path, jsonl([
      prompt("First."), said("m1", "Reply one."),
      prompt("Second."), said("m2", "Reply two."),
      ...Array.from({ length: 700 }, () => ({ type: "attachment", attachment: { content: "z".repeat(2000) } })),
    ]))
    expect(lastTurnReplies(path, claudeFormat, 2).messages.map((message) => message.text)).toEqual(["Reply two.", "Reply one."])
  })

  test("a missing or empty transcript has no replies", () => {
    const root = scratch()
    expect(lastTurnReplies(join(root, "missing.jsonl"), claudeFormat).messages).toEqual([])
    writeFileSync(join(root, "empty.jsonl"), jsonl([prompt("/model"), ...manualCompaction()]))
    expect(lastTurnReplies(join(root, "empty.jsonl"), claudeFormat).messages).toEqual([])
    expect(lastMessages("claude", { transcriptPath: join(root, "missing.jsonl") })).toEqual({ messages: [], source: null, path: null, pr: null })
    expect(lastMessages("codex", {})).toEqual({ messages: [], source: null, path: null, pr: null })
  })
})

describe("last replies from Pi", () => {
  const piSession = (dir: string) => {
    const path = join(dir, "sessions", "--w--", "2026-11-12T10-00-00-000Z_pi-session-1.jsonl")
    mkdirSync(join(dir, "sessions", "--w--"), { recursive: true })
    writeFileSync(path, jsonl([
      { type: "session", id: "pi-session-1" },
      { type: "message", id: "a", timestamp: at(), message: { role: "user", content: [{ type: "text", text: "Plan it." }] } },
      { type: "message", id: "b", timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: "Plan: three steps." }] } },
      { type: "message", id: "c", timestamp: at(), message: { role: "user", content: "Go?" } },
      { type: "message", id: "d", timestamp: at(), message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "toolCall", id: "t" }] } },
      { type: "message", id: "e", timestamp: at(), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "f", timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: "Done. Ship it?" }] } },
      { type: "compaction", id: "g", summary: "Earlier work summarised.", timestamp: at() },
    ]))
    return path
  }

  test("turn-end results from the report come first, newest first", () => {
    const report = { results: [{ generation: 1, timestamp: 10, reply: "one" }, { generation: 2, timestamp: 20, reply: "two" }, { generation: 3, timestamp: 30, reply: "" }] }
    expect(piReportMessages(report, 2)).toEqual([{ text: "two", at: 20, prompt: null, generation: 2 }, { text: "one", at: 10, prompt: null, generation: 1 }])
    expect(lastMessages("pi", report, 2).source).toBe("pi-report")
  })

  test("a Pi restarted since its last turn falls back to its session file, which compaction does not rewrite", () => {
    const dir = scratch()
    const path = piSession(dir)
    expect(piSessionPath("pi-session-1", dir)).toBe(path)
    const read = lastMessages("pi", { harnessSessionId: "pi-session-1", results: [] }, 2, { piSession: (id) => piSessionPath(id, dir) })
    expect(read).toMatchObject({ source: "pi-session", path })
    expect(read.messages.map((message) => [message.text, message.prompt])).toEqual([["Done. Ship it?", "Go?"], ["Plan: three steps.", "Plan it."]])
    expect(lastTurnReplies(path, piFormat, 1).messages[0]!.text).toBe("Done. Ship it?")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ClankerInfo, ClankerReportFacts } from "./clanker-api"
import { LAST_TEXT_LIMIT, claudeTranscriptPath, parseStates, harnessAliveIn, lastClaudeTranscriptText, listClankerRows, truncateText } from "./clanker-list"
import type { MultiplexerSnapshot } from "./multiplexer/interface"
import type { WorkshopRecord } from "./workshop"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-list-test-"))
  roots.push(root)
  return root
}

const clanker = (id: string, worktreePath: string, harness = "claude"): ClankerInfo => ({
  id, harness, session: "s", sessionId: "w1", window: "w1:t1", pane: `pane-${id}`, name: id, cwd: worktreePath, worktreePath,
  state: "working", generation: 2, settledGeneration: 1, updatedAt: 5, lastEventAt: 5, socketOnline: false,
  capabilities: { status: true, wait: "reports", send: false, result: false, report: true, deliveryModes: [] },
})

describe("clankers list", () => {
  test("scopes to child or descendant Workshops and carries diagnosis fields", async () => {
    const root = tempRoot()
    const path = (name: string) => { const dir = join(root, name); mkdirSync(dir); return dir }
    const record = (workshopId: string, parentWorkshopId: string | null, canonicalPath: string) => ({ workshopId, parentWorkshopId, canonicalPath, branch: workshopId }) as WorkshopRecord
    const workshops = [
      record("w-p", null, path("parent")),
      record("w-a", "w-p", path("a")),
      record("w-a1", "w-a", path("a1")),
      record("w-gone", "w-p", join(root, "gone")),
      record("w-x", null, path("x")),
    ]
    const facts: ClankerReportFacts[] = [
      { clanker: clanker("parent", workshops[0]!.canonicalPath), harnessSessionId: "s-parent", transcriptPath: "", latestReply: null },
      { clanker: clanker("a", workshops[1]!.canonicalPath), harnessSessionId: "s-a", transcriptPath: "", latestReply: null },
      { clanker: clanker("a1", workshops[2]!.canonicalPath, "pi"), harnessSessionId: "", transcriptPath: "", latestReply: "pi reply" },
      { clanker: clanker("gone", workshops[3]!.canonicalPath), harnessSessionId: "", transcriptPath: "", latestReply: null },
      { clanker: clanker("x", workshops[4]!.canonicalPath), harnessSessionId: "", transcriptPath: "", latestReply: null },
    ]
    const dependencies = {
      listFacts: async () => facts,
      listWorkshops: () => workshops,
      harnessesAlive: async (rows: readonly ClankerInfo[]) => new Map(rows.filter((row) => row.id !== "gone").map((row) => [row.pane, row.id !== "a"])),
      claudeText: (_clanker: ClankerInfo, { harnessSessionId }: { harnessSessionId: string }) => harnessSessionId ? `text of ${harnessSessionId}` : null,
    }
    const children = await listClankerRows({ childrenOf: { workshopId: "w-p", descendants: false } }, dependencies)
    expect(children.map((row) => row.id)).toEqual(["a", "gone"])
    expect(children[0]).toMatchObject({
      id: "a", state: "working", parentWorkshopId: "w-p", alive: false, lastText: "text of s-a", lastEventAt: 5,
      workshop: { id: "w-a", path: workshops[1]!.canonicalPath, branch: "w-a", exists: true },
    })
    expect(children[1]).toMatchObject({ id: "gone", alive: null, lastText: null, workshop: { exists: false } })
    const descendants = await listClankerRows({ childrenOf: { workshopId: "w-p", descendants: true } }, dependencies)
    expect(descendants.map((row) => row.id)).toEqual(["a", "a1", "gone"])
    expect(descendants[1]).toMatchObject({ harness: "pi", parentWorkshopId: "w-a", alive: true, lastText: "pi reply" })
    expect((await listClankerRows({}, dependencies)).map((row) => row.id)).toEqual(["parent", "a", "a1", "gone", "x"])
    facts[1]!.clanker.state = "blocked"
    expect((await listClankerRows({ childrenOf: { workshopId: "w-p", descendants: true }, states: ["blocked", "done"] }, dependencies)).map((row) => row.id)).toEqual(["a"])
  })

  test("reads a Claude transcript's newest assistant text", () => {
    const config = tempRoot()
    const project = join(config, "projects", "-elsewhere")
    mkdirSync(project, { recursive: true })
    const transcript = join(project, "abc-123.jsonl")
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "older" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "newest" }, { type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent" }] } }),
      JSON.stringify({ type: "user", message: { content: "assistant said" } }),
      "",
    ].join("\n"))
    // Found by session id even when the pane's cwd is not the session's start directory.
    expect(claudeTranscriptPath("abc-123", ["/some/other/cwd"], config)).toBe(transcript)
    expect(claudeTranscriptPath("../escape", [], config)).toBeUndefined()
    expect(lastClaudeTranscriptText(transcript)).toBe("newest")
    expect(lastClaudeTranscriptText(join(project, "missing.jsonl"))).toBeNull()
  })

  test("treats a pane as alive while its harness is a foreground process", () => {
    const pane = (id: string, processes: Array<{ pid: number; name?: string; argv?: string[] }> | undefined) => ({ id, processInfo: processes && { foregroundProcesses: processes } })
    const snapshot = { kind: "herdr", instanceId: "i", sessions: [{ windows: [{ panes: [
      pane("pane-a", [{ pid: 1, name: "clankerhouse-ha" }, { pid: 2, name: "claude" }]),
      pane("pane-b", [{ pid: 3, name: "zsh" }]),
      pane("pane-c", [{ pid: 4, name: "node", argv: ["/usr/bin/pi", "--session"] }]),
      pane("pane-d", undefined),
    ] }] }] } as unknown as MultiplexerSnapshot
    const alive = harnessAliveIn(snapshot, [clanker("a", "/a"), clanker("b", "/b"), clanker("c", "/c", "pi"), clanker("d", "/d")])
    expect([...alive]).toEqual([["pane-a", true], ["pane-b", false], ["pane-c", true]])
  })

  test("parses a comma-separated state filter and rejects unknown states", () => {
    expect(parseStates("working, blocked")).toEqual(["working", "blocked"])
    expect(() => parseStates("working,stuck")).toThrow("got stuck")
    expect(() => parseStates(",")).toThrow("--state takes")
  })

  test("truncates long text", () => {
    expect(truncateText("  short  ")).toBe("short")
    const long = truncateText("x".repeat(LAST_TEXT_LIMIT * 2))
    expect(long).toHaveLength(LAST_TEXT_LIMIT)
    expect(long.endsWith("…")).toBe(true)
  })
})

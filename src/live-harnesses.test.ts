import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lastClaudeTranscriptText } from "./clanker-list"
import { claudeFormat, lastTurnReplies } from "./last-messages"
import { describeHarness, duplicateHarnesses, orphanedHarnesses, scanLiveHarnesses, unitOf, workshopFor, type ProcSource } from "./live-harnesses"

interface FakeProcess { comm: string; argv?: string[]; ppid?: number; cwd: string; unit?: string; env?: Record<string, string> }

const fakeProc = (processes: Record<number, FakeProcess>): ProcSource => ({
  pids: () => Object.keys(processes).map(Number),
  comm: (pid) => processes[pid]?.comm ?? "",
  argv: (pid) => processes[pid]?.argv ?? [processes[pid]?.comm ?? ""],
  ppid: (pid) => processes[pid]?.ppid ?? 1,
  cwd: (pid) => processes[pid]?.cwd ?? "",
  cgroup: (pid) => processes[pid]?.unit ? `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${processes[pid]!.unit}\n` : "",
  environ: (pid) => processes[pid]?.env ?? {},
})

const retro = "/work/retro-desk"

// The three harnesses on retro-desk on puffin, 15 Nov: one left on the old Herdr server, one launched on hc in its
// own scope, and one resumed by hand in an hc terminal's shell, which lives in the terminal holder's service.
const puffin = fakeProc({
  119017: { comm: "claude", cwd: retro, unit: "clankerhouse-clanker-67466cfb-1.scope", env: { HERDR_PANE_ID: "w9A:p7", CLANKER_ID: "clanker-67466cfb" } },
  252189: { comm: "claude", cwd: retro, unit: "clankerhouse-clanker-aa3cd1ee-2.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t1fj", CLANKER_ID: "clanker-aa3cd1ee" } },
  1206962: { comm: "claude", argv: ["/opt/node/bin/claude"], cwd: retro, unit: "hc-hold-560dd206.service", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t1cg" }, ppid: 1206695 },
  1206695: { comm: "bash", cwd: retro, unit: "hc-hold-560dd206.service" },
  // A `claude -p` one of them ran is part of it, not another harness.
  1300000: { comm: "claude", argv: ["claude", "-p", "summarize"], cwd: retro, ppid: 1300001, unit: "clankerhouse-clanker-aa3cd1ee-2.scope" },
  1300001: { comm: "bash", cwd: retro, ppid: 252189 },
  // One harness in a subdirectory of its Workshop, alone there.
  2212895: { comm: "claude", cwd: "/work/grounding/experiments/classifier", unit: "hc-hold-560dd206.service", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t2" } },
  // A claude and a pi worker that one lane launched in one Workshop.
  951137: { comm: "claude", cwd: "/work/cobol", unit: "clankerhouse-clanker-4f2b73f8-3.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t35", CLANKER_ID: "clanker-4f2b73f8" } },
  952177: { comm: "node", argv: ["node", "/opt/bin/pi"], cwd: "/work/cobol", unit: "clankerhouse-clanker-42050ec5-4.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t36", CLANKER_ID: "clanker-42050ec5" } },
  // Still running after its worktree was deleted: no Workshop's, even though the main checkout contains the path.
  991502: { comm: "claude", cwd: "/work/main/.git/wt/trash/health-1 (deleted)", unit: "clankerhouse-clanker-fb69a55e-5.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t43", CLANKER_ID: "clanker-fb69a55e" } },
  939613: { comm: "claude", cwd: "/work/main", unit: "clankerhouse-clanker-4439f15c-6.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t2s", CLANKER_ID: "clanker-4439f15c" } },
  // Not a harness.
  5: { comm: "bash", cwd: retro },
})

describe("live harnesses", () => {
  test("the unit is the innermost scope or service of the process's cgroup", () => {
    expect(unitOf("0::/user.slice/user-1001.slice/user@1001.service/app.slice/hc-hold-560dd206.service\n")).toBe("hc-hold-560dd206.service")
    expect(unitOf("0::/user.slice/user-1001.slice/user@1001.service/app.slice/clankerhouse-clanker-x-1.scope")).toBe("clankerhouse-clanker-x-1.scope")
    expect(unitOf("")).toBeNull()
  })

  test("a cwd belongs to the longest Workshop path that contains it", () => {
    expect(workshopFor("/work/grounding/experiments/classifier", ["/work", "/work/grounding", "/work/grounding-other"])).toBe("/work/grounding")
    expect(workshopFor("/elsewhere", ["/work"])).toBe("/elsewhere")
  })

  test("every lane's harnesses and hand-started ones are found on one worktree, nested runs are not", () => {
    const found = scanLiveHarnesses({
      source: puffin,
      workshopPaths: [retro, "/work/grounding", "/work/cobol", "/work/main"],
      clankerAt: (lane, terminal) => lane === "hc" && terminal === "t1cg" ? "clanker-3180842c" : undefined,
    })
    expect(found.map((harness) => [harness.pid, harness.workshopPath, harness.lane, harness.terminal, harness.placement, harness.clankerId])).toEqual([
      [951137, "/work/cobol", "hc", "t35", "scope", "clanker-4f2b73f8"],
      [952177, "/work/cobol", "hc", "t36", "scope", "clanker-42050ec5"],
      [2212895, "/work/grounding", "hc", "t2", "terminal", null],
      [939613, "/work/main", "hc", "t2s", "scope", "clanker-4439f15c"],
      [991502, "/work/main/.git/wt/trash/health-1", "hc", "t43", "scope", "clanker-fb69a55e"],
      [119017, retro, "herdr", "w9A:p7", "scope", "clanker-67466cfb"],
      [252189, retro, "hc", "t1fj", "scope", "clanker-aa3cd1ee"],
      [1206962, retro, "hc", "t1cg", "terminal", "clanker-3180842c"],
    ])
    const duplicates = duplicateHarnesses(found)
    // Across lanes first; one lane's own helpers last, as the normal case.
    expect(duplicates.map((group) => [group.workshopPath, group.reason, group.lanes, group.harnesses.map((harness) => harness.pid)])).toEqual([
      [retro, "lanes", ["hc", "herdr"], [119017, 252189, 1206962]],
      ["/work/cobol", "several", ["hc"], [951137, 952177]],
    ])
    expect(orphanedHarnesses(found).map((harness) => harness.pid)).toEqual([991502])
    expect(describeHarness(orphanedHarnesses(found)[0]!)).toContain("in deleted /work/main/.git/wt/trash/health-1")
    expect(describeHarness(duplicates[0]!.harnesses[2]!)).toBe("pid 1206962 claude lane hc t1cg clanker-3180842c (started from a terminal's shell, in hc-hold-560dd206.service)")
    expect(describeHarness(found[2]!)).toContain("in /work/grounding/experiments/classifier")
  })

  test("a hand-started harness beside a launched one on the same lane is suspect", () => {
    const groups = duplicateHarnesses(scanLiveHarnesses({ source: fakeProc({
      1: { comm: "claude", cwd: "/w", unit: "clankerhouse-clanker-a-1.scope", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t1", CLANKER_ID: "clanker-a" } },
      2: { comm: "claude", cwd: "/w", unit: "hc-hold-1.service", env: { CLANKERHOUSE_INSTANCE: "hc", HC_TERMINAL_ID: "t2" } },
    }) }))
    expect(groups.map((group) => [group.reason, group.lanes])).toEqual([["hand-started", ["hc"]]])
  })

  test("a harness outside any Multiplexer has no lane", () => {
    const [harness] = scanLiveHarnesses({ source: fakeProc({ 7: { comm: "opencode", cwd: "/tmp/x", unit: "session-3.scope" } }) })
    expect(harness).toMatchObject({ lane: null, terminal: null, placement: "other", clankerId: null })
    expect(describeHarness(harness!)).toBe("pid 7 opencode outside any Multiplexer no clanker (session-3.scope)")
  })
})

describe("idle transcripts", () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  // An idle Claude session keeps appending metadata-only lines (artifact-autoreact-ledger about every 30 minutes, and
  // away summaries), so the transcript's mtime moves while nothing happens. Readers look for the last reply only.
  test("metadata-only lines after the last reply are skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-idle-transcript-"))
    roots.push(root)
    const path = join(root, "session.jsonl")
    const lines = [
      { type: "user", message: { role: "user", content: "check it" }, timestamp: "2026-11-13T21:40:00.000Z" },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done checking." }] }, timestamp: "2026-11-13T21:45:26.583Z" },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "system", subtype: "away_summary" },
      ...Array.from({ length: 200 }, () => ({ type: "artifact-autoreact-ledger", v: 1, sessionId: "s", accountUuid: "a", artifacts: [] })),
    ]
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
    expect(lastClaudeTranscriptText(path)).toBe("Done checking.")
    expect(lastTurnReplies(path, claudeFormat, 1).messages.map((message) => message.text)).toEqual(["Done checking."])
  })
})

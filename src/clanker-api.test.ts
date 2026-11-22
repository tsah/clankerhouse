import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { clankerStatus, deliverQueuedMessages, resultForClanker, generatedClankerId, listClankers, requestUnixSocket, sendClanker, sendStatus, waitForMessage } from "./clanker-api"
import { promptSha256 } from "./orchestration"
import { ManagedMultiplexer, type Multiplexer } from "./multiplexer"
import { advanceProjection } from "./projection"
import { FAKE_REX_HOST, fakeRex, writeRexClaims } from "./fixtures/fake-rex"

// Tests that start bin/clankers several times: a cold start on a loaded box takes seconds each, more than bun's 5 s default.
const SPAWNS_CLI_TIMEOUT_MS = 30_000

/** The text a prompt carried, without the `[clankerhouse msg-... from ...]` tag. */
const untagged = (prompt: string) => prompt.replace(/^\[clankerhouse msg-[A-Za-z0-9-]+ from [^\]]+\] /, "")

const roots: string[] = []
const servers: Array<{ stop: (force?: boolean) => void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const runtimeName = `clankerhouse-${process.getuid?.() || 0}-rex`

describe("report generations", () => {
  test("advances and settles a non-Pi lifecycle from native hook reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-report-test-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    mkdirSync(bin)
    mkdirSync(runtime)
    const reporter = join(import.meta.dir, "../bin/clankerhouse-clanker-state-report")
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ""}`,
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: join(root, "state"),
      // The hook writes Rex claims as files and never asks a Rex server.
      REX_BLOCK: "block:p99",
      REX_BIN: join(root, "missing-rex"),
      CLANKERHOUSE_INSTANCE: "",
      CLANKER_ID: "clanker-test",
    }
    const emit = async (state: string, hookEvent: string) => {
      const process = Bun.spawn([reporter, "claude", state], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      process.stdin.write(JSON.stringify({ hook_event_name: hookEvent }))
      process.stdin.end()
      expect(await process.exited).toBe(0)
    }
    await emit("working", "UserPromptSubmit")
    await emit("done", "Stop")
    const report = JSON.parse(readFileSync(join(runtime, runtimeName, "clanker-state", "block_p99.json"), "utf8"))
    expect(report).toMatchObject({ harness: "claude", clankerId: "clanker-test", generation: 1, settledGeneration: 1, state: "done" })
  })

  test("exposes report-only harnesses and rejects unsupported sends", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-cli-test-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const reportDirectory = join(runtime, runtimeName, "clanker-state")
    mkdirSync(bin)
    mkdirSync(reportDirectory, { recursive: true })
    const nested = join(root, "nested")
    mkdirSync(nested)
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0)
    // A Codex pane is report-only; a Pi pane serves results.
    const rex = fakeRex(join(root, "rex"), [{ id: "session:s1", label: "fixture", windows: [
      { id: "window:t2", label: "codexwin", blocks: [{ id: "block:p7", program: "codex", cwd: root }] },
      { id: "window:t3", label: "piwin", blocks: [{ id: "block:p8", program: "pi", cwd: nested }] },
    ] }])
    const stateDir = join(root, "state", "clankerhouse-rex")
    writeRexClaims(stateDir, "block:p7", { clankerId: "clanker-codex", harness: "codex" })
    writeRexClaims(stateDir, "block:p8", { clankerId: "clanker-pi", harness: "pi" })
    writeFileSync(join(reportDirectory, "block_p7.json"), JSON.stringify({ harness: "codex", clankerId: "clanker-codex", pane: "block:p7", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "Stop" }))
    writeFileSync(join(reportDirectory, "block_p8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "block:p8", state: "idle", generation: 0, settledGeneration: 0, updatedAt: Date.now(), hookEvent: "session_start", results: [],
    }))
    const repository = join(import.meta.dir, "..")
    const clankerhouse = join(repository, "bin/clankers")
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"), REX_BIN: rex.bin, REX_BLOCK: "", CLANKERHOUSE_REX_SERVER: "", CLANKERHOUSE_INSTANCE: "" }
    // Await the CLI without blocking the event loop.
    const run = async (args: string[]) => {
      const child = Bun.spawn([clankerhouse, ...args], { env, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, exitCode }
    }
    const list = await run(["list", "--cwd", root])
    expect(list.exitCode, list.stderr).toBe(0)
    const listed = JSON.parse(list.stdout)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ id: "clanker-codex", harness: "codex", state: "done", settledGeneration: 2, capabilities: { wait: "reports", send: false, result: false } })
    expect(listed[1]).toMatchObject({ id: "clanker-pi", generation: 0, settledGeneration: 0 })
    // The fake Rex reports each pane's harness as its foreground process; no Workshop is registered.
    expect(listed[0]).toMatchObject({ alive: true, workshop: null, parentWorkshopId: null, lastText: null })
    const unknownFlag = await run(["list", "--childs-of"])
    expect(unknownFlag.exitCode).toBe(2)
    expect(unknownFlag.stderr).toContain("Unexpected argument: --childs-of")
    const done = await run(["list", "--cwd", root, "--state", "done"])
    expect(done.exitCode, done.stderr).toBe(0)
    expect(JSON.parse(done.stdout).map((row: { id: string }) => row.id)).toEqual(["clanker-codex"])
    expect((await run(["list", "--state", "stuck"])).exitCode).toBe(2)
    writeFileSync(join(reportDirectory, "block_p8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "block:p8", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "agent_settled",
      results: [
        { generation: 1, timestamp: 1, status: 0, stopReason: "stop", errorMessage: "", reply: "first" },
        { generation: 2, timestamp: 2, status: 0, stopReason: "stop", errorMessage: "", reply: "second" },
      ],
    }))
    const result = await run(["result", "--generation", "1", "clanker-pi"])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ clankerId: "clanker-pi", generation: 1, reply: "first" })
    const waiter = Bun.spawn([clankerhouse, "wait", "--after", "2", "--timeout", "2", "clanker-codex"], { env, stdout: "pipe", stderr: "pipe" })
    await Bun.sleep(250)
    writeFileSync(join(reportDirectory, "block_p7.json"), JSON.stringify({ harness: "codex", clankerId: "clanker-codex", pane: "block:p7", state: "done", generation: 3, settledGeneration: 3, updatedAt: Date.now(), hookEvent: "Stop" }))
    const waited = await new Response(waiter.stdout).text()
    expect(await waiter.exited).toBe(0)
    expect(JSON.parse(waited)).toMatchObject({ id: "clanker-codex", generation: 3, settledGeneration: 3 })
    const timeout = await run(["wait", "--after", "3", "--timeout", "0", "clanker-codex"])
    expect(timeout.exitCode).toBe(124)
    expect(JSON.parse(timeout.stderr)).toMatchObject({ apiVersion: 1, error: { code: "TIMEOUT" } })
    const send = Bun.spawn([clankerhouse, "send", "clanker-codex"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    send.stdin.write("hello")
    send.stdin.end()
    const error = await new Response(send.stderr).text()
    expect(await send.exited).toBe(4)
    expect(JSON.parse(error)).toMatchObject({ apiVersion: 1, error: { code: "UNSUPPORTED", message: expect.stringMatching(/does not support send.*no verified native transport/) } })
  }, SPAWNS_CLI_TIMEOUT_MS)
})

describe("Rex semantic prompt transport", () => {
  // The orchestration store and pane reports follow XDG paths; keep them in a private root.
  const isolate = () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-rex-send-"))
    roots.push(root)
    const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, CLANKERHOUSE_INSTANCE: process.env.CLANKERHOUSE_INSTANCE }
    process.env.XDG_STATE_HOME = join(root, "state")
    process.env.XDG_RUNTIME_DIR = join(root, "runtime")
    process.env.CLANKERHOUSE_INSTANCE = "unit"
    const reports = join(root, "runtime", `clankerhouse-${process.getuid?.() ?? "user"}-unit`, "clanker-state")
    mkdirSync(reports, { recursive: true })
    restores.push(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value })
    return reports
  }
  const restores: Array<() => void> = []
  afterEach(() => { for (const restore of restores.splice(0)) restore() })

  const fakeRex = (clankerId: string, paneId: string, prompts: Array<{ pane: string; text: string }>, pane: { focused: boolean; present: boolean } = { focused: false, present: true }) => {
    const adapter = {
      kind: "rex",
      capabilities: () => ({ processInfo: true, agentStatus: true, sessionRefs: true, agentPrompt: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }),
      observe: async () => ({
        kind: "rex",
        instanceId: "rex:test-host",
        sessions: [{
          id: "session:w1", nativeName: "repo@main", path: "/repo", recency: 0, attached: true, worktreePath: "/repo", directoryPath: "", windows: [{
            id: "window:t1", index: "1", nativeName: "claude", active: true, panes: pane.present ? [{
              id: paneId, index: "1", pid: "123", command: "claude", title: "", currentPath: "/repo", activity: 0, active: true, focused: pane.focused,
              claims: { clankerId, harness: "claude" },
            }] : [],
          }],
        }],
      }),
      readClaim: async (_location: unknown, key: string) => key === "clankerId" ? clankerId : undefined,
      promptAgent: async (location: { nativePaneId?: string | null }, text: string) => { prompts.push({ pane: location.nativePaneId || "", text }) },
    } as unknown as Multiplexer
    return new ManagedMultiplexer(adapter)
  }

  test("advertises and dispatches Claude sends to the exact claimed pane", async () => {
    isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = `clanker-claude-rex-${Date.now()}`
    const paneId = `block:p${Date.now()}`
    const multiplexer = fakeRex(clankerId, paneId, prompts)

    const listed = await listClankers({ multiplexer })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: clankerId, harness: "claude", capabilities: { send: "multiplexer-prompt", wait: "reports", result: "transcript", report: true, deliveryModes: ["queued", "followUp"] } })

    const receipt = await sendClanker(clankerId, "review this exact change", {}, multiplexer)
    expect(prompts).toEqual([{ pane: paneId, text: `[clankerhouse ${receipt.messageId} from operator] review this exact change` }])
    expect(receipt.messageId).toMatch(/^msg-/)
    expect(receipt).toMatchObject({ clankerId, afterGeneration: 0, observedGeneration: 0, delivery: "immediate" })
    expect(receipt.acceptedAt).toBeGreaterThan(0)
    expect(await sendStatus(receipt.messageId, multiplexer)).toMatchObject({ messageId: receipt.messageId, clankerId, state: "delivered", startedGeneration: null, stage: "typed", observation: "hook", attempts: 1 })

    await expect(sendClanker(clankerId, "steer this", { delivery: "steer" }, multiplexer)).rejects.toMatchObject({ code: "UNSUPPORTED", exitCode: 4 })
  })

  test("queues a Claude follow-up until the current turn ends", async () => {
    const reports = isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = "clanker-claude-follow-up"
    const multiplexer = fakeRex(clankerId, "block:p9", prompts)
    const report = (state: string, generation: number, settledGeneration: number) => writeFileSync(join(reports, "block_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: "block:p9", state, generation, settledGeneration, updatedAt: Date.now(),
    }))
    report("working", 1, 0)
    const queued = await sendClanker(clankerId, "after this turn", { delivery: "followUp" }, multiplexer)
    expect(queued.delivery).toBe("queued")
    expect(prompts).toEqual([])
    report("done", 1, 1)
    await deliverQueuedMessages(multiplexer)
    expect(prompts.map((prompt) => untagged(prompt.text))).toEqual(["after this turn"])
    expect((await sendClanker(clankerId, "now", { delivery: "followUp" }, multiplexer)).delivery).toBe("queued")
  })

  test("returns each settled Claude generation's final assistant message from the transcript", async () => {
    const reports = isolate()
    const clankerId = "clanker-claude-result"
    const multiplexer = fakeRex(clankerId, "block:p9", [])
    const transcript = join(reports, "..", "session.jsonl")
    const at = (ms: number) => new Date(ms).toISOString()
    const assistant = (ms: number, id: string, content: unknown[], stop: string | null, extra: object = {}) =>
      JSON.stringify({ type: "assistant", timestamp: at(ms), message: { id, role: "assistant", stop_reason: stop, content }, ...extra })
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", timestamp: at(1_000), message: { role: "user", content: "first" } }),
      assistant(1_100, "m1", [{ type: "text", text: "Looking." }], "tool_use"),
      assistant(1_200, "m1", [{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"),
      assistant(1_300, "m2", [{ type: "thinking", thinking: "hm" }], null),
      assistant(1_301, "m2", [{ type: "text", text: "First answer." }], null),
      assistant(1_302, "m2", [{ type: "text", text: "Done." }], "end_turn"),
      assistant(1_350, "side", [{ type: "text", text: "subagent" }], "end_turn", { isSidechain: true }),
      "not json",
      assistant(2_100, "m3", [{ type: "text", text: "Second answer." }], "end_turn"),
      assistant(3_100, "m4", [{ type: "text", text: "still running" }], null),
    ].join("\n"))
    writeFileSync(join(reports, "block_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: "block:p9", state: "working", generation: 3, settledGeneration: 2, updatedAt: Date.now(), transcriptPath: transcript,
      turns: [{ generation: 1, startedAt: 1_000, settledAt: 1_400 }, { generation: 2, startedAt: null, settledAt: 2_200 }],
    }))
    expect(await resultForClanker(clankerId, 1, multiplexer)).toEqual({ clankerId, generation: 1, timestamp: 1_302, status: 0, stopReason: "end_turn", errorMessage: "", reply: "First answer.\n\nDone." })
    expect(await resultForClanker(clankerId, undefined, multiplexer)).toMatchObject({ generation: 2, reply: "Second answer." })
    await expect(resultForClanker(clankerId, 3, multiplexer)).rejects.toThrow(/no result for generation 3/)
  })

  test("drops a clanker whose harness exited while its pane lingers, and a relaunch in the pane restores it", async () => {
    const reports = isolate()
    const clankerId = "clanker-claude-exited"
    const paneId = "block:p31"
    const multiplexer = fakeRex(clankerId, paneId, [])
    const mark = join(reports, "block_p31.exited")
    const lifecycle = (...command: string[]) => Bun.spawnSync([join(import.meta.dir, "../bin/clankerhouse-harness-lifecycle"), "--", ...command], {
      env: { ...process.env, REX_BLOCK: paneId, CLANKER_ID: clankerId }, stdout: "pipe", stderr: "pipe",
    }).exitCode

    expect((await listClankers({ multiplexer })).map((clanker) => clanker.id)).toEqual([clankerId])
    expect(lifecycle("sh", "-c", "exit 3")).toBe(3)
    expect(readFileSync(mark, "utf8")).toBe(`${clankerId}\n`)
    expect(await listClankers({ multiplexer })).toEqual([])
    await expect(clankerStatus(clankerId, multiplexer)).rejects.toMatchObject({ code: "NOT_FOUND" })

    // The relaunched harness runs without the mark; only its exit writes it again.
    expect(lifecycle("sh", "-c", 'test ! -e "$1"', "_", mark)).toBe(0)
    writeFileSync(mark, "clanker-someone-else\n")
    expect((await listClankers({ multiplexer })).map((clanker) => clanker.id)).toEqual([clankerId])
  })

  test("a harness's own runtime status refines blocked without moving generations, and a replaced harness is gone", async () => {
    const reports = isolate()
    const clankerId = "clanker-claude-runtime"
    const paneId = "block:p41"
    let agentStatus: Record<string, unknown> | undefined
    let harnessGone = false
    const adapter = {
      kind: "rex",
      capabilities: () => ({ processInfo: true, agentStatus: true, sessionRefs: true, agentPrompt: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }),
      observe: async () => ({
        kind: "rex", instanceId: "rex:test-host",
        sessions: [{ id: "session:w1", nativeName: "repo@main", path: "/repo", recency: 0, attached: true, worktreePath: "/repo", directoryPath: "", windows: [{
          id: "window:t1", index: "1", nativeName: "claude", active: true, panes: [{
            id: paneId, index: "1", pid: "123", command: "claude", title: "", currentPath: "/repo", activity: 0, active: true,
            claims: { clankerId, harness: "claude" }, agentStatus, ...(harnessGone ? { harnessGone } : {}),
          }],
        }] }],
      }),
      readClaim: async (_location: unknown, key: string) => key === "clankerId" ? clankerId : undefined,
    } as unknown as Multiplexer
    const multiplexer = new ManagedMultiplexer(adapter)
    const hook = (state: string, updatedAt: number) => writeFileSync(join(reports, "block_p41.json"), JSON.stringify({ harness: "claude", clankerId, pane: paneId, state, generation: 3, settledGeneration: 2, updatedAt }))
    const status = () => clankerStatus(clankerId, multiplexer)

    // AskUserQuestion: the hook last saw the tool call start; the harness then reported the question.
    hook("working", 1_000)
    agentStatus = { agent: "claude", status: "blocked", blockedKind: "question", message: "red or blue?", reportedAt: 2_000 }
    expect(await status()).toMatchObject({ state: "blocked", blockedKind: "question", blockedMessage: "red or blue?", generation: 3, settledGeneration: 2 })
    // The harness's own report stands even when a hook event is newer: Rex is the truth for agent status.
    agentStatus = { ...agentStatus, reportedAt: 500 }
    expect(await status()).toMatchObject({ state: "blocked", blockedKind: "question" })
    // A startup silence means nothing once the hook has reported.
    agentStatus = { agent: "claude", status: "blocked", blockedKind: "startup", reportedAt: 5_000 }
    expect((await status()).state).toBe("working")
    // An answered permission prompt: the hook stays blocked until the next tool call, the harness says working.
    hook("blocked", 1_000)
    agentStatus = { agent: "claude", status: "working", reportedAt: 2_000 }
    expect(await status()).toMatchObject({ state: "working", generation: 3, settledGeneration: 2 })
    // A turn that ended with a background shell still running: the harness says done, the hook would say working.
    hook("working", 1_000)
    agentStatus = { agent: "claude", status: "done", reportedAt: 900 }
    expect((await status()).state).toBe("done")
    // Without a status from the harness, the hook's state stands in.
    agentStatus = { agent: "claude", status: "unknown" }
    expect((await status()).state).toBe("working")

    harnessGone = true
    expect(await listClankers({ multiplexer })).toEqual([])
    await expect(status()).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("queues for a busy or focused Claude, delivers in order after it settles, and acknowledges by hook hash", async () => {
    const reports = isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = "clanker-claude-queue"
    const paneId = "block:p9"
    const pane = { focused: false, present: true }
    const multiplexer = fakeRex(clankerId, paneId, prompts, pane)
    const report = (state: string, generation: number, settledGeneration: number, submitted: string[] = []) => writeFileSync(join(reports, "block_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: paneId, state, generation, settledGeneration, updatedAt: Date.now(), hookEvent: state === "done" ? "Stop" : "UserPromptSubmit",
      prompts: submitted.map((text, index) => ({ sha256: promptSha256(text), generation: generation - submitted.length + index + 1 })),
    }))

    report("working", 1, 0)
    const first = await sendClanker(clankerId, "first answer", {}, multiplexer)
    const second = await sendClanker(clankerId, "second answer", {}, multiplexer)
    expect([first.delivery, second.delivery]).toEqual(["queued", "queued"])
    expect(prompts).toEqual([])
    expect((await sendStatus(first.messageId, multiplexer)).state).toBe("queued")

    // Settled but the operator is in the pane: still held.
    report("done", 1, 1)
    pane.focused = true
    await deliverQueuedMessages(multiplexer)
    expect(prompts).toEqual([])

    pane.focused = false
    await deliverQueuedMessages(multiplexer)
    await deliverQueuedMessages(multiplexer)
    expect(prompts.map((prompt) => untagged(prompt.text))).toEqual(["first answer"])
    expect(await sendStatus(first.messageId, multiplexer)).toMatchObject({ state: "delivered", startedGeneration: null })

    report("working", 2, 1, ["first answer"])
    expect(await sendStatus(first.messageId, multiplexer)).toMatchObject({ messageId: first.messageId, clankerId, state: "acked", startedGeneration: 2, stage: "started" })
    expect(prompts).toHaveLength(1)
    await expect(waitForMessage(clankerId, first.messageId, { timeoutMs: 0 }, multiplexer)).rejects.toMatchObject({ code: "TIMEOUT", exitCode: 124 })

    report("done", 2, 2, ["first answer"])
    const settled = await waitForMessage(clankerId, first.messageId, { timeoutMs: 1_000 }, multiplexer)
    expect(settled).toMatchObject({ id: clankerId, settledGeneration: 2, lastReport: null, message: { state: "acked", startedGeneration: 2 } })
    expect(prompts.map((prompt) => untagged(prompt.text))).toEqual(["first answer", "second answer"])

    // The clanker disappears before acknowledging the second message: it is kept, never redirected.
    pane.present = false
    expect((await sendStatus(second.messageId, multiplexer)).state).toBe("orphaned")
    await expect(waitForMessage(clankerId, second.messageId, { timeoutMs: 0 }, multiplexer)).rejects.toMatchObject({ code: "NOT_FOUND", exitCode: 3 })
  })

  test("a Claude whose turn ended with background work still running takes a queued message", async () => {
    const reports = isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = "clanker-claude-background"
    const paneId = "block:p9"
    const pane = { focused: false, present: true }
    const multiplexer = fakeRex(clankerId, paneId, prompts, pane)
    const report = (state: string, hookEvent: string, generation: number, settledGeneration: number, submitted: string[] = []) => writeFileSync(join(reports, "block_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: paneId, state, generation, settledGeneration, updatedAt: Date.now(), hookEvent,
      prompts: submitted.map((text) => ({ sha256: promptSha256(text), generation })),
    }))
    // Mid-turn: the message waits.
    report("working", "PreToolUse", 3, 0)
    const sent = await sendClanker(clankerId, "the ruling", {}, multiplexer)
    expect(sent.delivery).toBe("queued")
    await deliverQueuedMessages(multiplexer)
    expect(prompts).toEqual([])
    // The turn ended at Stop with a background monitor running: still unsettled, but no turn runs, so it goes in.
    report("working", "Stop", 3, 0)
    pane.focused = true
    await deliverQueuedMessages(multiplexer)
    // Typed delivery still leaves the operator's pane alone.
    expect(prompts).toEqual([])
    pane.focused = false
    await deliverQueuedMessages(multiplexer)
    expect(prompts.map((prompt) => untagged(prompt.text))).toEqual(["the ruling"])
    // It started a turn, which ended again with the background work still going: a new send goes in at once.
    report("working", "Stop", 4, 0, ["the ruling"])
    expect((await sendStatus(sent.messageId, multiplexer)).state).toBe("acked")
    const next = await sendClanker(clankerId, "a follow-up", {}, multiplexer)
    expect(next.delivery).not.toBe("queued")
  })
})

describe("Pi native transport", () => {
  test("serves native messages and generation results from the global extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-extension-test-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    mkdirSync(bin)
    mkdirSync(runtime)
    // Claims go through `clankers mux`; reading none makes the extension use CLANKER_ID.
    writeFileSync(join(bin, "clankers"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const extension = join(import.meta.dir, "../integrations/pi/clanker-lifecycle.ts")
    const script = join(root, "extension-test.ts")
    writeFileSync(script, `
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createConnection } from "node:net"
import extension from ${JSON.stringify(extension)}
const handlers = new Map<string, Function>()
const sent: unknown[] = []
const pi = {
  events: { on: () => () => {} },
  on: (name: string, handler: Function) => { handlers.set(name, handler) },
  sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
}
extension(pi as never)
let idle = true
const context = { mode: "tui", isIdle: () => idle, sessionManager: { getSessionId: () => "pi-test-session" } }
await handlers.get("session_start")?.({}, context)
const socketDirectory = \`${runtime}/${runtimeName}/clanker-sockets\`
const socketPath = \`\${socketDirectory}/\${readdirSync(socketDirectory).find((entry) => entry.endsWith(".sock"))}\`
const sendNative = (text: string, delivery?: "steer" | "followUp") => new Promise<Record<string, unknown>>((resolve, reject) => {
  const socket = createConnection(socketPath)
  let response = ""
  socket.setEncoding("utf8")
  socket.on("connect", () => socket.write(JSON.stringify({ version: 1, action: "send", clankerId: "clanker-pi-test", text, delivery }) + "\\n"))
  socket.on("data", (chunk) => { response += chunk; if (response.includes("\\n")) resolve(JSON.parse(response.trim())) })
  socket.on("error", reject)
})
const firstReceipt = await sendNative("native hello")
await handlers.get("agent_start")?.({}, context)
await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "native result" }] }] }, context)
await handlers.get("agent_settled")?.({}, context)
idle = false
const secondReceipt = await sendNative("second turn")
const concurrentReceipt = await sendNative("too soon", "steer")
idle = true
await handlers.get("agent_start")?.({}, context)
await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second result" }] }] }, context)
await handlers.get("agent_settled")?.({}, context)
idle = false
const steerReceipt = await sendNative("steer now", "steer")
idle = true
await handlers.get("agent_start")?.({}, context)
await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "third result" }] }] }, context)
await handlers.get("agent_settled")?.({}, context)
const reportPath = \`${runtime}/${runtimeName}/clanker-state/block_p44.json\`
const report = JSON.parse(readFileSync(reportPath, "utf8"))
const socketMode = (statSync(socketPath).mode & 0o777).toString(8)
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
await Bun.sleep(10)
console.log(JSON.stringify({ firstReceipt, secondReceipt, concurrentReceipt, steerReceipt, sent, report, socketMode, socketRemoved: !existsSync(socketPath) }))
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"), REX_BLOCK: "block:p44", CLANKERHOUSE_INSTANCE: "", CLANKER_ID: "clanker-pi-test", CLANKER_SESSION_ID: "pi-test-session", CLANKERHOUSE_CLANKERS: join(bin, "clankers") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const output = JSON.parse(child.stdout.toString())
    expect(output.firstReceipt).toMatchObject({ ok: true, clankerId: "clanker-pi-test", afterGeneration: 0, delivery: "immediate" })
    expect(output.secondReceipt).toMatchObject({ ok: true, clankerId: "clanker-pi-test", afterGeneration: 1, observedGeneration: 1, delivery: "followUp" })
    expect(output.concurrentReceipt).toMatchObject({ ok: false, error: expect.stringContaining("still awaiting settlement") })
    expect(output.steerReceipt).toMatchObject({ ok: true, clankerId: "clanker-pi-test", afterGeneration: 2, observedGeneration: 2, delivery: "steer" })
    expect(output.sent).toEqual([
      { text: "native hello" },
      { text: "second turn", options: { deliverAs: "followUp" } },
      { text: "steer now", options: { deliverAs: "steer" } },
    ])
    expect(output.report).toMatchObject({ harness: "pi", clankerId: "clanker-pi-test", generation: 3, settledGeneration: 3, state: "done", result: { generation: 3, status: 0, reply: "third result" } })
    expect(output.report.results).toEqual([
      expect.objectContaining({ generation: 1, reply: "native result" }),
      expect.objectContaining({ generation: 2, reply: "second result" }),
      expect.objectContaining({ generation: 3, reply: "third result" }),
    ])
    expect(output.socketMode).toBe("600")
    expect(output.socketRemoved).toBe(true)
  })

  test("in-process SDK workers cannot overwrite their active parent pane", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-sdk-pi-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    mkdirSync(bin)
    mkdirSync(runtime)
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CLAIM_LOG"
case "$*" in "mux read-claim --pane block:p88 clankerId") printf 'clanker-parent\\n' ;; esac
`, { mode: 0o755 })
    const script = join(root, "sdk-workers.ts")
    writeFileSync(script, `
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import extension from ${JSON.stringify(join(import.meta.dir, "../integrations/pi/clanker-lifecycle.ts"))}
const runtime = ${JSON.stringify(join(runtime, runtimeName))}
const reportPath = runtime + "/clanker-state/block_p88.json"
const claimLog = ${JSON.stringify(join(root, "claims.log"))}
function instance(mode: string, sessionId: string) {
  const handlers = new Map<string, Function>()
  const events = new Map<string, Function>()
  const api = {
    events: { on: (name: string, handler: Function) => { events.set(name, handler); return () => events.delete(name) } },
    on: (name: string, handler: Function) => { handlers.set(name, handler) },
    sendUserMessage: () => {},
  }
  extension(api as never)
  const context = { mode, isIdle: () => false, sessionManager: { getSessionId: () => sessionId } }
  return { emit: async (name: string, data = {}) => handlers.get(name)?.(data, context), events }
}
const parent = instance("tui", "parent-session")
await parent.emit("session_start")
await parent.emit("agent_start")
const readReport = () => JSON.parse(readFileSync(reportPath, "utf8"))
assert.equal(readReport().state, "working")
const beforeReport = readFileSync(reportPath, "utf8")
const beforeClaims = readFileSync(claimLog, "utf8")
const beforeSockets = readdirSync(runtime + "/clanker-sockets")
// SDK workers share the parent's PID, argv, environment and loaded module.
// Neither their factory, events nor shutdown may touch the Terminal owner.
for (const mode of ["print", "json", "rpc"]) {
  const child = instance(mode, "worker-" + mode)
  await child.emit("session_start")
  await child.emit("agent_start")
  await child.emit("turn_start")
  await child.emit("tool_execution_start")
  child.events.get("subagents:created")?.({ id: "nested-worker" })
  child.events.get("subagents:completed")?.({ id: "nested-worker" })
  await child.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "worker result" }] }] })
  await child.emit("agent_settled")
  await child.emit("session_shutdown", { reason: "quit" })
  assert.equal(readFileSync(reportPath, "utf8"), beforeReport, mode + " changed the parent report")
  assert.equal(readFileSync(claimLog, "utf8"), beforeClaims, mode + " touched pane claims")
  assert.deepEqual(readdirSync(runtime + "/clanker-sockets"), beforeSockets)
}
// The owner, not a worker's extension instance, aggregates background work.
parent.events.get("subagents:created")?.({ id: "background-worker" })
await parent.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "parent result" }] }] })
await parent.emit("agent_settled")
assert.equal(readReport().state, "working")
parent.events.get("subagents:completed")?.({ id: "background-worker" })
assert.equal(readReport().state, "done")
assert.equal(readReport().harnessSessionId, "parent-session")
assert.equal(readReport().result.reply, "parent result")
await parent.emit("session_shutdown", { reason: "quit" })
console.log("parent ownership preserved")
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: {
        PATH: `${bin}:${process.env.PATH || ""}`, HOME: join(root, "home"),
        XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
        REX_BLOCK: "block:p88", CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
        CLAIM_LOG: join(root, "claims.log"),
      }, stdout: "pipe", stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(child.stdout.toString()).toContain("parent ownership preserved")
  })

  test("does not let a sessionless Pi subprocess claim its parent pane", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-sessionless-pi-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const clankersLog = join(root, "clankers.log")
    mkdirSync(bin)
    mkdirSync(runtime)
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CLANKERS_LOG"
`, { mode: 0o755 })
    const extension = join(import.meta.dir, "../integrations/pi/clanker-lifecycle.ts")
    const script = join(root, "sessionless-test.ts")
    writeFileSync(script, `
import { existsSync, readdirSync } from "node:fs"
import extension from ${JSON.stringify(extension)}
const handlers = new Map<string, Function>()
const pi = {
  events: { on: () => () => {} },
  on: (name: string, handler: Function) => { handlers.set(name, handler) },
  sendUserMessage: () => {},
}
extension(pi as never)
const context = { isIdle: () => true, sessionManager: { getSessionId: () => "ephemeral-subagent-session" } }
await handlers.get("session_start")?.({}, context)
await Bun.sleep(10)
const root = ${JSON.stringify(join(runtime, runtimeName))}
const observed = {
  handlers: [...handlers.keys()],
  reportExists: existsSync(root + "/clanker-state/block_p77.json"),
  sockets: existsSync(root + "/clanker-sockets") ? readdirSync(root + "/clanker-sockets") : [],
}
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
console.log(JSON.stringify(observed))
`)
    const child = Bun.spawnSync([process.execPath, script, "--mode", "json", "-p", "--no-session"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
        XDG_RUNTIME_DIR: runtime,
        XDG_STATE_HOME: join(root, "state"),
        REX_BLOCK: "block:p77",
        CLANKERHOUSE_INSTANCE: "",
        CLANKERS_LOG: clankersLog,
        CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual({ handlers: [], reportExists: false, sockets: [] })
    expect(existsSync(clankersLog) ? readFileSync(clankersLog, "utf8") : "").toBe("")
  })

  test("routes pane claims through clankers mux on the Rex instance", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-rex-pi-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const clankersLog = join(root, "clankers.log")
    mkdirSync(bin)
    mkdirSync(runtime)
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s\n' "$*" >> "$CLANKERS_LOG"
`, { mode: 0o755 })
    const extension = join(import.meta.dir, "../integrations/pi/clanker-lifecycle.ts")
    const script = join(root, "rex-claims-test.ts")
    writeFileSync(script, `
import extension from ${JSON.stringify(extension)}

const handlers = new Map<string, Function>()
const pi = {
  events: { on: () => () => {} },
  on: (name: string, handler: Function) => { handlers.set(name, handler) },
  sendUserMessage: () => {},
}
extension(pi as never)
const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "pi-rex-session" } }
await handlers.get("session_start")?.({}, context)
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
        XDG_RUNTIME_DIR: runtime,
        XDG_STATE_HOME: join(root, "state"),
        REX_BLOCK: "block:p2",
        REX_BIN: join(root, "missing-rex"),
        CLANKERHOUSE_INSTANCE: "",
        CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
        CLANKER_ID: "clanker-rex-test",
        CLANKER_SESSION_ID: "pi-rex-session",
        CLANKERS_LOG: clankersLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const calls = readFileSync(clankersLog, "utf8").trim().split("\n")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls).toContain("mux claim --pane block:p2 harness pi")
    expect(calls.filter((call) => call.startsWith("mux ")).every((call) => call.includes("--pane block:p2"))).toBe(true)
    expect(existsSync(join(root, "state", "clankerhouse-rex", "activity"))).toBe(true)
    expect(existsSync(join(root, "state", "clankerhouse", "activity"))).toBe(false)
  })

  test("uses one newline-delimited request and response", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-clanker-test-"))
    roots.push(root)
    const path = join(root, "pi.sock")
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.once("data", (data) => {
        const request = JSON.parse(String(data).trim())
        socket.end(`${JSON.stringify({ ok: true, echoed: request.text })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    chmodSync(path, 0o600)
    await expect(requestUnixSocket(path, { version: 1, action: "send", text: "hello" })).resolves.toEqual({ ok: true, echoed: "hello" })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

})


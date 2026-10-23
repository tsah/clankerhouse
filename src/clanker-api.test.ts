import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { clankerStatus, deliverQueuedMessages, resultForClanker, generatedClankerId, listClankers, requestUnixSocket, sendClanker, sendStatus, waitForMessage } from "./clanker-api"
import { promptSha256 } from "./orchestration"
import { ManagedMultiplexer, type Multiplexer } from "./multiplexer"
import { advanceProjection } from "./projection"
import { startSnapshotServer } from "./transport"

const roots: string[] = []
const servers: Array<{ stop: (force?: boolean) => void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const runtimeName = `clankerhouse-${process.getuid?.() || 0}-herdr`

interface FakePane { pane_id: string; tab_id: string; label: string; cwd: string; agent: string; tokens: Record<string, string> }

/** Minimal Herdr socket serving one workspace snapshot; one NDJSON request per connection. */
const fakeHerdr = (socketPath: string, cwd: string, panes: FakePane[]) => {
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, chunk) {
        const request = JSON.parse(chunk.toString().trim()) as { id: string; method: string; params: { pane_id?: string } }
        const pane = panes.find((candidate) => candidate.pane_id === request.params.pane_id)
        const result = request.method === "ping" ? { type: "pong", protocol: 22 }
          : request.method === "session.snapshot" ? { snapshot: {
            focused_workspace_id: "w1",
            workspaces: [{ workspace_id: "w1", number: 1, label: "fixture", focused: true, active_tab_id: panes[0]!.tab_id, agent_status: "unknown", tokens: {} }],
            tabs: panes.map((entry, index) => ({ tab_id: entry.tab_id, workspace_id: "w1", number: index + 1, label: entry.label, focused: index === 0, agent_status: "unknown" })),
            panes: panes.map((entry, index) => ({ pane_id: entry.pane_id, terminal_id: `term-${index}`, workspace_id: "w1", tab_id: entry.tab_id, focused: index === 0, cwd: entry.cwd || cwd, foreground_cwd: entry.cwd || cwd, agent: entry.agent, agent_status: "unknown", tokens: entry.tokens, revision: 1 })),
          } }
          : request.method === "pane.process_info" ? { process_info: { pane_id: request.params.pane_id, foreground_processes: [{ pid: 1, name: pane?.agent ?? "zsh" }] } }
          : request.method === "pane.get" ? { pane: pane ?? null }
          : { type: "ok" }
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
      },
    },
  })
  servers.push(server)
}

describe("Clankerhouse clanker metadata", () => {
  test("generates opaque namespaced ids", () => {
    expect(generatedClankerId()).toMatch(/^clanker-[0-9a-f-]{36}$/)
    expect(generatedClankerId()).not.toBe(generatedClankerId())
  })
})

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
      HERDR_PANE_ID: "w1:p99",
      // No Herdr server: claims are best-effort and must not block the report.
      HERDR_SOCKET_PATH: join(root, "missing.sock"),
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
    const report = JSON.parse(readFileSync(join(runtime, runtimeName, "clanker-state", "w1_p99.json"), "utf8"))
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
    const herdrSocket = join(root, "herdr.sock")
    // A Codex pane is report-only; a Pi pane serves results.
    fakeHerdr(herdrSocket, root, [
      { pane_id: "w1:p7", tab_id: "w1:t2", label: "codexwin", cwd: root, agent: "codex", tokens: { ch_clanker_id: "clanker-codex", ch_harness: "codex" } },
      { pane_id: "w1:p8", tab_id: "w1:t3", label: "piwin", cwd: nested, agent: "pi", tokens: { ch_clanker_id: "clanker-pi", ch_harness: "pi" } },
    ])
    writeFileSync(join(reportDirectory, "w1_p7.json"), JSON.stringify({ harness: "codex", clankerId: "clanker-codex", pane: "w1:p7", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "Stop" }))
    writeFileSync(join(reportDirectory, "w1_p8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "w1:p8", state: "idle", generation: 0, settledGeneration: 0, updatedAt: Date.now(), hookEvent: "session_start", results: [],
    }))
    const repository = join(import.meta.dir, "..")
    const clankerhouse = join(repository, "bin/clankers")
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: herdrSocket, CLANKERHOUSE_INSTANCE: "" }
    // The fake Herdr server runs in this process, so the CLI must never block the event loop.
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
    // The fake Herdr reports each pane's harness as its foreground process; no Workshop is registered.
    expect(listed[0]).toMatchObject({ alive: true, workshop: null, parentWorkshopId: null, lastText: null })
    const unknownFlag = await run(["list", "--childs-of"])
    expect(unknownFlag.exitCode).toBe(2)
    expect(unknownFlag.stderr).toContain("Unexpected argument: --childs-of")
    const done = await run(["list", "--cwd", root, "--state", "done"])
    expect(done.exitCode, done.stderr).toBe(0)
    expect(JSON.parse(done.stdout).map((row: { id: string }) => row.id)).toEqual(["clanker-codex"])
    expect((await run(["list", "--state", "stuck"])).exitCode).toBe(2)
    writeFileSync(join(reportDirectory, "w1_p8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "w1:p8", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "agent_settled",
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
    writeFileSync(join(reportDirectory, "w1_p7.json"), JSON.stringify({ harness: "codex", clankerId: "clanker-codex", pane: "w1:p7", state: "done", generation: 3, settledGeneration: 3, updatedAt: Date.now(), hookEvent: "Stop" }))
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
  })
})

describe("Herdr semantic prompt transport", () => {
  // The orchestration store and pane reports follow XDG paths; keep them in a private root.
  const isolate = () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-herdr-send-"))
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

  const fakeHerdr = (clankerId: string, paneId: string, prompts: Array<{ pane: string; text: string }>, pane: { focused: boolean; present: boolean } = { focused: false, present: true }) => {
    const adapter = {
      kind: "herdr",
      capabilities: () => ({ processInfo: true, agentStatus: true, sessionRefs: true, agentPrompt: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }),
      observe: async () => ({
        kind: "herdr",
        instanceId: "herdr:/tmp/test.sock",
        sessions: [{
          id: "w1", nativeName: "repo@main", path: "/repo", recency: 0, attached: true, worktreePath: "/repo", directoryPath: "", windows: [{
            id: "w1:t1", index: "1", nativeName: "claude", active: true, panes: pane.present ? [{
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
    const clankerId = `clanker-claude-herdr-${Date.now()}`
    const paneId = `w1:p${Date.now()}`
    const multiplexer = fakeHerdr(clankerId, paneId, prompts)

    const listed = await listClankers({ multiplexer })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: clankerId, harness: "claude", capabilities: { send: "multiplexer-prompt", wait: "reports", result: "transcript", report: true, deliveryModes: ["queued", "followUp"] } })

    const receipt = await sendClanker(clankerId, "review this exact change", {}, multiplexer)
    expect(prompts).toEqual([{ pane: paneId, text: "review this exact change" }])
    expect(receipt.messageId).toMatch(/^msg-/)
    expect(receipt).toMatchObject({ clankerId, afterGeneration: 0, observedGeneration: 0, delivery: "immediate" })
    expect(receipt.acceptedAt).toBeGreaterThan(0)
    expect(await sendStatus(receipt.messageId, multiplexer)).toEqual({ messageId: receipt.messageId, clankerId, state: "delivered", startedGeneration: null })

    await expect(sendClanker(clankerId, "steer this", { delivery: "steer" }, multiplexer)).rejects.toMatchObject({ code: "UNSUPPORTED", exitCode: 4 })
  })

  test("queues a Claude follow-up until the current turn ends", async () => {
    const reports = isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = "clanker-claude-follow-up"
    const multiplexer = fakeHerdr(clankerId, "w1:p9", prompts)
    const report = (state: string, generation: number, settledGeneration: number) => writeFileSync(join(reports, "w1_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: "w1:p9", state, generation, settledGeneration, updatedAt: Date.now(),
    }))
    report("working", 1, 0)
    const queued = await sendClanker(clankerId, "after this turn", { delivery: "followUp" }, multiplexer)
    expect(queued.delivery).toBe("queued")
    expect(prompts).toEqual([])
    report("done", 1, 1)
    await deliverQueuedMessages(multiplexer)
    expect(prompts.map((prompt) => prompt.text)).toEqual(["after this turn"])
    expect((await sendClanker(clankerId, "now", { delivery: "followUp" }, multiplexer)).delivery).toBe("queued")
  })

  test("returns each settled Claude generation's final assistant message from the transcript", async () => {
    const reports = isolate()
    const clankerId = "clanker-claude-result"
    const multiplexer = fakeHerdr(clankerId, "w1:p9", [])
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
    writeFileSync(join(reports, "w1_p9.json"), JSON.stringify({
      harness: "claude", clankerId, pane: "w1:p9", state: "working", generation: 3, settledGeneration: 2, updatedAt: Date.now(), transcriptPath: transcript,
      turns: [{ generation: 1, startedAt: 1_000, settledAt: 1_400 }, { generation: 2, startedAt: null, settledAt: 2_200 }],
    }))
    expect(await resultForClanker(clankerId, 1, multiplexer)).toEqual({ clankerId, generation: 1, timestamp: 1_302, status: 0, stopReason: "end_turn", errorMessage: "", reply: "First answer.\n\nDone." })
    expect(await resultForClanker(clankerId, undefined, multiplexer)).toMatchObject({ generation: 2, reply: "Second answer." })
    await expect(resultForClanker(clankerId, 3, multiplexer)).rejects.toThrow(/no result for generation 3/)
  })

  test("drops a clanker whose harness exited while its pane lingers, and a relaunch in the pane restores it", async () => {
    const reports = isolate()
    const clankerId = "clanker-claude-exited"
    const paneId = "w1:p31"
    const multiplexer = fakeHerdr(clankerId, paneId, [])
    const mark = join(reports, "w1_p31.exited")
    const lifecycle = (...command: string[]) => Bun.spawnSync([join(import.meta.dir, "../bin/clankerhouse-harness-lifecycle"), "--", ...command], {
      env: { ...process.env, HERDR_PANE_ID: paneId, CLANKER_ID: clankerId }, stdout: "pipe", stderr: "pipe",
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

  test("queues for a busy or focused Claude, delivers in order after it settles, and acknowledges by hook hash", async () => {
    const reports = isolate()
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = "clanker-claude-queue"
    const paneId = "w1:p9"
    const pane = { focused: false, present: true }
    const multiplexer = fakeHerdr(clankerId, paneId, prompts, pane)
    const report = (state: string, generation: number, settledGeneration: number, submitted: string[] = []) => writeFileSync(join(reports, "w1_p9.json"), JSON.stringify({
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
    expect(prompts.map((prompt) => prompt.text)).toEqual(["first answer"])
    expect(await sendStatus(first.messageId, multiplexer)).toMatchObject({ state: "delivered", startedGeneration: null })

    report("working", 2, 1, ["first answer"])
    expect(await sendStatus(first.messageId, multiplexer)).toEqual({ messageId: first.messageId, clankerId, state: "acked", startedGeneration: 2 })
    expect(prompts).toHaveLength(1)
    await expect(waitForMessage(clankerId, first.messageId, { timeoutMs: 0 }, multiplexer)).rejects.toMatchObject({ code: "TIMEOUT", exitCode: 124 })

    report("done", 2, 2, ["first answer"])
    const settled = await waitForMessage(clankerId, first.messageId, { timeoutMs: 1_000 }, multiplexer)
    expect(settled).toMatchObject({ id: clankerId, settledGeneration: 2, lastReport: null, message: { state: "acked", startedGeneration: 2 } })
    expect(prompts.map((prompt) => prompt.text)).toEqual(["first answer", "second answer"])

    // The clanker disappears before acknowledging the second message: it is kept, never redirected.
    pane.present = false
    expect((await sendStatus(second.messageId, multiplexer)).state).toBe("orphaned")
    await expect(waitForMessage(clankerId, second.messageId, { timeoutMs: 0 }, multiplexer)).rejects.toMatchObject({ code: "NOT_FOUND", exitCode: 3 })
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
const reportPath = \`${runtime}/${runtimeName}/clanker-state/w1_p44.json\`
const report = JSON.parse(readFileSync(reportPath, "utf8"))
const socketMode = (statSync(socketPath).mode & 0o777).toString(8)
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
await Bun.sleep(10)
console.log(JSON.stringify({ firstReceipt, secondReceipt, concurrentReceipt, steerReceipt, sent, report, socketMode, socketRemoved: !existsSync(socketPath) }))
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"), HERDR_PANE_ID: "w1:p44", CLANKERHOUSE_INSTANCE: "", CLANKER_ID: "clanker-pi-test", CLANKER_SESSION_ID: "pi-test-session", CLANKERHOUSE_CLANKERS: join(bin, "clankers") },
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
case "$*" in "mux read-claim --pane w1:p88 clankerId") printf 'clanker-parent\\n' ;; esac
`, { mode: 0o755 })
    const script = join(root, "sdk-workers.ts")
    writeFileSync(script, `
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import extension from ${JSON.stringify(join(import.meta.dir, "../integrations/pi/clanker-lifecycle.ts"))}
const runtime = ${JSON.stringify(join(runtime, runtimeName))}
const reportPath = runtime + "/clanker-state/w1_p88.json"
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
        HERDR_PANE_ID: "w1:p88", CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
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
  reportExists: existsSync(root + "/clanker-state/w1_p77.json"),
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
        HERDR_PANE_ID: "w1:p77",
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

  test("routes pane claims through clankers mux on the Herdr instance", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-herdr-pi-"))
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
    const script = join(root, "herdr-claims-test.ts")
    writeFileSync(script, `
import extension from ${JSON.stringify(extension)}
const handlers = new Map<string, Function>()
const pi = {
  events: { on: () => () => {} },
  on: (name: string, handler: Function) => { handlers.set(name, handler) },
  sendUserMessage: () => {},
}
extension(pi as never)
const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "pi-herdr-session" } }
await handlers.get("session_start")?.({}, context)
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
        XDG_RUNTIME_DIR: runtime,
        XDG_STATE_HOME: join(root, "state"),
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        HERDR_SOCKET_PATH: join(root, "herdr.sock"),
        CLANKERHOUSE_INSTANCE: "",
        CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
        CLANKER_ID: "clanker-herdr-test",
        CLANKER_SESSION_ID: "pi-herdr-session",
        CLANKERS_LOG: clankersLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const calls = readFileSync(clankersLog, "utf8").trim().split("\n")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls).toContain("mux claim --pane w1:p2 harness pi")
    expect(calls.filter((call) => call.startsWith("mux ")).every((call) => call.includes("--pane w1:p2"))).toBe(true)
    expect(existsSync(join(root, "state", "clankerhouse-herdr", "activity"))).toBe(true)
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

describe("clanker discovery through the daemon's herd", () => {
  const restores: Array<() => void> = []
  afterEach(() => { for (const restore of restores.splice(0)) restore() })

  // A herdr server that counts requests and knows one workspace with one Claude pane.
  const fakeHerdrServer = async (path: string, clankerId: string, paneId: string) => {
    const methods: string[] = []
    const snapshot = {
      focused_workspace_id: "w1",
      workspaces: [{ workspace_id: "w1", number: 1, label: "repo@main", focused: true, active_tab_id: "w1:t1", agent_status: "idle", tokens: { ch_worktree_path: "/repo" } }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "claude", focused: true, agent_status: "idle" }],
      panes: [{ pane_id: paneId, terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/repo", agent_status: "idle", revision: 1, tokens: { ch_clanker_id: clankerId, ch_harness: "claude" } }],
    }
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString().split("\n")[0]!) as { id: string; method: string }
        methods.push(request.method)
        socket.end(`${JSON.stringify({ id: request.id, result: request.method === "session.snapshot" ? { snapshot } : {} })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    restores.push(() => server.close())
    return methods
  }

  const isolate = async (herdPanes: unknown[]) => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-herd-"))
    roots.push(root)
    const herdrSocket = join(root, "herdr.sock")
    const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, CLANKERHOUSE_INSTANCE: process.env.CLANKERHOUSE_INSTANCE, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH }
    process.env.XDG_STATE_HOME = join(root, "state")
    process.env.XDG_RUNTIME_DIR = join(root, "runtime")
    process.env.CLANKERHOUSE_INSTANCE = "unit"
    process.env.HERDR_SOCKET_PATH = herdrSocket
    restores.push(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value })
    const runtime = join(root, "runtime", `clankerhouse-${process.getuid?.() ?? "user"}-unit`)
    mkdirSync(join(runtime, "clanker-state"), { recursive: true })
    const daemon = await startSnapshotServer({
      socketPath: join(runtime, "daemon.sock"),
      initialSnapshot: advanceProjection(undefined, [], 10, "test", Date.now()),
      herd: () => ({ instanceId: `herdr:${herdrSocket}`, observedAt: Date.now(), panes: herdPanes }),
    })
    restores.push(() => { void daemon.close() })
    return herdrSocket
  }

  const herdPane = (id: string, pane: string) => ({ harness: "claude", id, socketPath: "", sessionId: "w1", session: "repo@main", window: "w1:t1", name: "claude", pane, cwd: "/repo", worktreePath: "/repo", focused: false })

  test("lists and polls clankers from the daemon without asking the Multiplexer", async () => {
    const herdrSocket = await isolate([herdPane("clanker-herd", "w1:p1")])
    const methods = await fakeHerdrServer(herdrSocket, "clanker-herd", "w1:p1")

    expect((await listClankers()).map((clanker) => clanker.id)).toEqual(["clanker-herd"])
    expect(await clankerStatus("clanker-herd")).toMatchObject({ id: "clanker-herd", pane: "w1:p1", harness: "claude" })
    expect(methods).toEqual([])
  })

  test("observes the Multiplexer, without process facts, for a clanker the daemon has not seen yet", async () => {
    const herdrSocket = await isolate([])
    const methods = await fakeHerdrServer(herdrSocket, "clanker-new", "w1:p2")

    expect(await clankerStatus("clanker-new")).toMatchObject({ id: "clanker-new", pane: "w1:p2" })
    expect(methods).toEqual(["session.snapshot"])
  })
})

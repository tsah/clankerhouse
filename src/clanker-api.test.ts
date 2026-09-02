import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generatedClankerId, listClankers, parsePaneMetadata, requestUnixSocket, sendClanker } from "./clanker-api"
import { ManagedMultiplexer, type Multiplexer } from "./multiplexer"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Clankerhouse clanker metadata", () => {
  test("parses tmux discovery metadata without using pane contents", () => {
    const rows = parsePaneMetadata("pi\tclanker-123\t/tmp/pi.sock\t$1\trepo@branch\t@2\tpi\t%3\t/repo\t/repo")
    expect(rows).toEqual([{
      harness: "pi",
      id: "clanker-123",
      socketPath: "/tmp/pi.sock",
      sessionId: "$1",
      session: "repo@branch",
      window: "@2",
      name: "pi",
      pane: "%3",
      cwd: "/repo",
      worktreePath: "/repo",
    }])
  })

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
    const tmux = join(bin, "tmux")
    writeFileSync(tmux, "#!/bin/sh\ncase \"$1\" in show-option) exit 1 ;; set-option) exit 0 ;; display-message) pwd -P ;; esac\n")
    chmodSync(tmux, 0o755)
    const reporter = join(import.meta.dir, "../bin/clankerhouse-clanker-state-report")
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ""}`,
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: join(root, "state"),
      TMUX_PANE: "%99",
      HERDR_PANE_ID: "",
      CLANKERHOUSE_MULTIPLEXER: "tmux",
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
    const report = JSON.parse(readFileSync(join(runtime, `clankerhouse-${process.getuid?.() || 0}`, "clanker-state", "%99.json"), "utf8"))
    expect(report).toMatchObject({ harness: "claude", clankerId: "clanker-test", generation: 1, settledGeneration: 1, state: "done" })
  })

  test("exposes report-only harnesses and rejects unsupported sends", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-cli-test-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const reportDirectory = join(runtime, `clankerhouse-${process.getuid?.() || 0}`, "clanker-state")
    mkdirSync(bin)
    mkdirSync(reportDirectory, { recursive: true })
    const nested = join(root, "nested")
    mkdirSync(nested)
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0)
    const tmux = join(bin, "tmux")
    // Observe-compatible tmux double: one session with a claude pane and a pi pane, in the
    // multiplexer snapshot field order the interface adapter parses.
    writeFileSync(tmux, [
      "#!/bin/sh",
      'case "$1" in',
      "  display-message) printf '/tmp/clankerhouse-fixture.sock\\n' ;;",
      "  show-options|show-option) printf 'epoch-1\\n' ;;",
      "  set-option) : ;;",
      `  list-sessions) printf 's1\\tfixture\\t0\\t100\\t0\\t${root}\\t\\t${root}\\t0\\t\\t\\t\\t\\t\\t\\n' ;;`,
      `  list-panes) printf 's1\\t@2\\t0\\tclaudewin\\t1\\t%%7\\t0\\t111\\tclaude\\ttitle\\t${root}\\t100\\t1\\t\\t\\t\\t\\tclanker-claude\\tclaude\\t\\t\\t\\t\\t\\n'; printf 's1\\t@3\\t1\\tpiwin\\t0\\t%%8\\t0\\t222\\tpi\\ttitle\\t${nested}\\t100\\t0\\t\\t\\t\\t\\tclanker-pi\\tpi\\t\\t\\t\\t\\t\\n' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"))
    chmodSync(tmux, 0o755)
    writeFileSync(join(reportDirectory, "%7.json"), JSON.stringify({ harness: "claude", clankerId: "clanker-claude", pane: "%7", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "Stop" }))
    writeFileSync(join(reportDirectory, "%8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "%8", state: "idle", generation: 0, settledGeneration: 0, updatedAt: Date.now(), hookEvent: "session_start", results: [],
    }))
    const repository = join(import.meta.dir, "..")
    const clankerhouse = join(repository, "bin/clankers")
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, HERDR_ENV: "", HERDR_PANE_ID: "", CLANKERHOUSE_MULTIPLEXER: "tmux" }
    const list = Bun.spawnSync([clankerhouse, "list", "--cwd", root], { env, stdout: "pipe", stderr: "pipe" })
    expect(list.exitCode).toBe(0)
    const listed = JSON.parse(list.stdout.toString())
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ id: "clanker-claude", harness: "claude", state: "done", settledGeneration: 2, capabilities: { wait: "reports", send: false, result: false } })
    expect(listed[1]).toMatchObject({ id: "clanker-pi", generation: 0, settledGeneration: 0 })
    writeFileSync(join(reportDirectory, "%8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "%8", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "agent_settled",
      results: [
        { generation: 1, timestamp: 1, status: 0, stopReason: "stop", errorMessage: "", reply: "first" },
        { generation: 2, timestamp: 2, status: 0, stopReason: "stop", errorMessage: "", reply: "second" },
      ],
    }))
    const result = Bun.spawnSync([clankerhouse, "result", "--generation", "1", "clanker-pi"], { env, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ clankerId: "clanker-pi", generation: 1, reply: "first" })
    const waiter = Bun.spawn([clankerhouse, "wait", "--after", "2", "--timeout", "2", "clanker-claude"], { env, stdout: "pipe", stderr: "pipe" })
    await Bun.sleep(250)
    writeFileSync(join(reportDirectory, "%7.json"), JSON.stringify({ harness: "claude", clankerId: "clanker-claude", pane: "%7", state: "done", generation: 3, settledGeneration: 3, updatedAt: Date.now(), hookEvent: "Stop" }))
    const waited = await new Response(waiter.stdout).text()
    expect(await waiter.exited).toBe(0)
    expect(JSON.parse(waited)).toMatchObject({ id: "clanker-claude", generation: 3, settledGeneration: 3 })
    const timeout = Bun.spawnSync([clankerhouse, "wait", "--after", "3", "--timeout", "0", "clanker-claude"], { env, stdout: "pipe", stderr: "pipe" })
    expect(timeout.exitCode).toBe(124)
    expect(JSON.parse(timeout.stderr.toString())).toMatchObject({ apiVersion: 1, error: { code: "TIMEOUT" } })
    const send = Bun.spawn([clankerhouse, "send", "clanker-claude"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    send.stdin.write("hello")
    send.stdin.end()
    const error = await new Response(send.stderr).text()
    expect(await send.exited).toBe(4)
    expect(JSON.parse(error)).toMatchObject({ apiVersion: 1, error: { code: "UNSUPPORTED", message: expect.stringMatching(/does not support send.*no verified native transport/) } })
  })
})

describe("Herdr semantic prompt transport", () => {
  test("advertises and dispatches Claude sends to the exact claimed pane", async () => {
    const prompts: Array<{ pane: string; text: string }> = []
    const clankerId = `clanker-claude-herdr-${Date.now()}`
    const paneId = `w1:p${Date.now()}`
    const adapter = {
      kind: "herdr",
      capabilities: () => ({ processInfo: true, agentStatus: true, sessionRefs: true, agentPrompt: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, clientRouting: false, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }),
      observe: async () => ({
        kind: "herdr",
        instanceId: "herdr:/tmp/test.sock",
        sessions: [{
          id: "w1", nativeName: "repo@main", path: "/repo", recency: 0, attached: true, worktreePath: "/repo", directoryPath: "", windows: [{
            id: "w1:t1", index: "1", nativeName: "claude", active: true, panes: [{
              id: paneId, index: "1", pid: "123", command: "claude", title: "", currentPath: "/repo", activity: 0, active: true,
              claims: { clankerId, harness: "claude" },
            }],
          }],
        }],
      }),
      readClaim: async (_location: unknown, key: string) => key === "clankerId" ? clankerId : undefined,
      promptAgent: async (location: { nativePaneId?: string | null }, text: string) => { prompts.push({ pane: location.nativePaneId || "", text }) },
    } as unknown as Multiplexer
    const multiplexer = new ManagedMultiplexer(adapter)

    const listed = await listClankers({ multiplexer })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: clankerId, harness: "claude", capabilities: { send: "multiplexer-prompt", wait: "reports", result: false, deliveryModes: [] } })

    const receipt = await sendClanker(clankerId, "review this exact change", {}, multiplexer)
    expect(prompts).toEqual([{ pane: paneId, text: "review this exact change" }])
    expect(receipt).toMatchObject({ clankerId, afterGeneration: 0, observedGeneration: 0, delivery: "immediate" })
    expect(receipt.acceptedAt).toBeGreaterThan(0)

    await expect(sendClanker(clankerId, "queue this", { delivery: "followUp" }, multiplexer)).rejects.toMatchObject({ code: "UNSUPPORTED", exitCode: 4 })
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
    const tmux = join(bin, "tmux")
    writeFileSync(tmux, "#!/bin/sh\ncase \"$1\" in show-option) exit 1 ;; set-option) exit 0 ;; esac\n")
    chmodSync(tmux, 0o755)
    const extension = join(import.meta.dir, "../integrations/pi/tmux-clanker-lifecycle.ts")
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
const context = { isIdle: () => idle, sessionManager: { getSessionId: () => "pi-test-session" } }
await handlers.get("session_start")?.({}, context)
const socketDirectory = \`${runtime}/clankerhouse-\${process.getuid?.() || 0}/clanker-sockets\`
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
const reportPath = \`${runtime}/clankerhouse-\${process.getuid?.() || 0}/clanker-state/%44.json\`
const report = JSON.parse(readFileSync(reportPath, "utf8"))
const socketMode = (statSync(socketPath).mode & 0o777).toString(8)
await handlers.get("session_shutdown")?.({ reason: "quit" }, context)
await Bun.sleep(10)
console.log(JSON.stringify({ firstReceipt, secondReceipt, concurrentReceipt, steerReceipt, sent, report, socketMode, socketRemoved: !existsSync(socketPath) }))
`)
    const child = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"), TMUX_PANE: "%44", HERDR_PANE_ID: "", CLANKERHOUSE_MULTIPLEXER: "tmux", CLANKER_ID: "clanker-pi-test", CLANKER_SESSION_ID: "pi-test-session", CLANKER_RECOVERY_ATTEMPT: "", CLANKERHOUSE_CLANKERS: "/bin/true" },
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

  test("does not let a sessionless Pi subprocess claim its parent pane", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-sessionless-pi-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const tmuxLog = join(root, "tmux.log")
    const clankersLog = join(root, "clankers.log")
    mkdirSync(bin)
    mkdirSync(runtime)
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$*" in
  *"show-option"*"@clankerhouse_clanker_id"*) printf 'clanker-parent\\n' ;;
  *"show-option"*"@dotfiles_harness"*) printf 'pi\\n' ;;
  *"show-option"*"@clankerhouse_harness_session_id"*) printf 'parent-session\\n' ;;
esac
`, { mode: 0o755 })
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CLANKERS_LOG"
`, { mode: 0o755 })
    const extension = join(import.meta.dir, "../integrations/pi/tmux-clanker-lifecycle.ts")
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
const root = ${JSON.stringify(runtime)} + "/clankerhouse-" + (process.getuid?.() || 0)
const observed = {
  handlers: [...handlers.keys()],
  reportExists: existsSync(root + "/clanker-state/%77.json"),
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
        TMUX_PANE: "%77",
        HERDR_PANE_ID: "",
        CLANKERHOUSE_MULTIPLEXER: "tmux",
        TMUX_LOG: tmuxLog,
        CLANKERS_LOG: clankersLog,
        CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual({ handlers: [], reportExists: false, sockets: [] })
    expect(existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "").toBe("")
    expect(existsSync(clankersLog) ? readFileSync(clankersLog, "utf8") : "").toBe("")
  })

  test("routes inferred Herdr pane claims through the Herdr Clankerhouse instance", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-herdr-pi-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const clankersLog = join(root, "clankers.log")
    mkdirSync(bin)
    mkdirSync(runtime)
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s|%s\n' "\${CLANKERHOUSE_MULTIPLEXER-unset}" "$*" >> "$CLANKERS_LOG"
`, { mode: 0o755 })
    const extension = join(import.meta.dir, "../integrations/pi/tmux-clanker-lifecycle.ts")
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
const context = { isIdle: () => true, sessionManager: { getSessionId: () => "pi-herdr-session" } }
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
        TMUX_PANE: "%77",
        CLANKERHOUSE_MULTIPLEXER: "",
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
    expect(calls.every((call) => call.startsWith("herdr|"))).toBe(true)
    expect(calls).toContain("herdr|mux claim --pane w1:p2 harness pi")
    expect(calls.some((call) => call.includes("--pane %77"))).toBe(false)
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

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generatedClankerId, parsePaneMetadata, requestUnixSocket } from "./clanker-api"

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
    writeFileSync(tmux, `#!/bin/sh\ncase "$1" in\n  list-panes) printf '%b\\n' 'claude\\tclanker-claude\\t\\t$1\\tfixture\\t@2\\tclaude\\t%7\\t${root}\\t${root}' 'pi\\tclanker-pi\\t\\t$1\\tfixture\\t@3\\tpi\\t%8\\t${nested}\\t' ;;\n  *) exit 1 ;;\nesac\n`)
    chmodSync(tmux, 0o755)
    writeFileSync(join(reportDirectory, "%7.json"), JSON.stringify({ harness: "claude", clankerId: "clanker-claude", pane: "%7", state: "done", generation: 2, settledGeneration: 2, updatedAt: Date.now(), hookEvent: "Stop" }))
    writeFileSync(join(reportDirectory, "%8.json"), JSON.stringify({
      harness: "pi", clankerId: "clanker-pi", pane: "%8", state: "idle", generation: 0, settledGeneration: 0, updatedAt: Date.now(), hookEvent: "session_start", results: [],
    }))
    const repository = join(import.meta.dir, "..")
    const clankerhouse = join(repository, "bin/clankers")
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime }
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, "state"), TMUX_PANE: "%44", CLANKER_ID: "clanker-pi-test", CLANKER_SESSION_ID: "pi-test-session", CLANKER_RECOVERY_ATTEMPT: "", CLANKERHOUSE_CLANKERS: "/bin/true" },
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

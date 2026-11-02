#!/usr/bin/env bun
/**
 * Minimal ACP v1 client for the messaging spike. Line-delimited JSON-RPC over the adapter's stdio.
 * Prints one JSON event per line with a millisecond timestamp, then follows a FIFO of commands:
 *   prompt <text> | load <sessionId> | resume <sessionId> | quit
 * Usage: acp-client.ts <cwd> <fifo> [--load <sessionId>] -- <adapter argv...>
 */
const args = Bun.argv.slice(2)
const split = args.indexOf("--")
const [cwd, fifo] = args
const argv = args.slice(split + 1)
const log = (event: string, data: unknown = {}) => console.log(JSON.stringify({ at: Date.now(), event, data }))
const child = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" })
let nextId = 1
const waiting = new Map<number, (message: any) => void>()
const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush() }
const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
  const id = nextId++
  waiting.set(id, resolve)
  log("request", { id, method })
  send({ jsonrpc: "2.0", id, method, params })
})
;(async () => {
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk)
    for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
      const line = buffer.slice(0, at).trim()
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method === "session/update") {
        const u = message.params.update
        log("update", { kind: u.sessionUpdate, messageId: u.messageId, text: u.content?.text?.slice(0, 120) })
      } else if (message.method) {
        log("agent-request", { method: message.method })
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } })
      } else {
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      }
    }
  }
  log("adapter-exit", { code: await child.exited })
  process.exit(0)
})()

const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "clankerhouse-spike", version: "0" } })
log("initialized", { protocolVersion: init.result?.protocolVersion, agentInfo: init.result?.agentInfo, agentCapabilities: init.result?.agentCapabilities })
const loadAt = args.indexOf("--load")
let sessionId: string
if (loadAt >= 0 && loadAt < split) {
  sessionId = args[loadAt + 1]!
  log("load-result", await request("session/load", { sessionId, cwd, mcpServers: [] }))
} else {
  const created = await request("session/new", { cwd, mcpServers: [] })
  sessionId = created.result?.sessionId
  log("session-new", created.error ?? { sessionId })
}
const decoder = new TextDecoder()
while (true) {
  const lines = decoder.decode(await Bun.file(fifo!).bytes()).split("\n").filter(Boolean)
  for (const line of lines) {
    const [verb, ...rest] = line.split(" ")
    if (verb === "quit") { child.kill(); await child.exited; process.exit(0) }
    if (verb === "prompt") {
      const response = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: rest.join(" ") }] })
      log("prompt-response", response.result ?? response.error)
    }
  }
}

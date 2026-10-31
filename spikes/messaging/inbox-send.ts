#!/usr/bin/env bun
/**
 * Write one user message to a Claude Code session's cross-session inbox socket and print
 * whatever the socket answers. Usage: inbox-send.ts <socket> <uuid> <text>
 * The socket path comes from ~/.claude/sessions/<pid>.json (`messagingSocketPath`).
 */
import { createConnection } from "node:net"
const [path, uuid, text] = Bun.argv.slice(2)
const started = Date.now()
const line = JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } })
const socket = createConnection(path!)
socket.on("connect", () => { console.log(JSON.stringify({ ms: Date.now() - started, event: "connected" })); socket.write(`${line}\n`) })
socket.on("data", (data) => console.log(JSON.stringify({ ms: Date.now() - started, event: "data", text: data.toString() })))
socket.on("error", (error) => { console.log(JSON.stringify({ ms: Date.now() - started, event: "error", error: String(error) })); process.exit(1) })
socket.on("close", () => { console.log(JSON.stringify({ ms: Date.now() - started, event: "closed" })); process.exit(0) })
setTimeout(() => { console.log(JSON.stringify({ ms: Date.now() - started, event: "timeout-end" })); socket.end() }, 3000)

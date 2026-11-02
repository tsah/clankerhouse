#!/usr/bin/env bun
/**
 * At-least-once delivery to a live Claude Code session through its inbox socket.
 *
 * Every message carries a marker. The session's own hooks are the receipts: UserPromptSubmit
 * containing the marker is the ack and names a prompt_id; Stop with that prompt_id is the
 * turn end. Each wait is bounded, so a message always reaches a terminal state.
 *
 * A write that fails, or a session that restarts before acking, is retried; a message written
 * to a live inbox is never resent, because the harness delivers duplicates.
 *
 * Usage: deliver.ts <socket> <hook-events.tsv> <text> [ackTimeoutMs] [turnTimeoutMs] [maxAttempts]
 * Events file: one `<ms>\t<hook JSON>` line per hook call.
 * Exit: 0 turn_ended, 3 unacked, 4 turn_timeout.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createConnection } from "node:net"

const [socketPath, eventsPath, text, ackArg, turnArg, attemptsArg] = Bun.argv.slice(2)
const ackTimeoutMs = Number(ackArg ?? 20_000)
const turnTimeoutMs = Number(turnArg ?? 120_000)
const maxAttempts = Number(attemptsArg ?? 3)
const messageId = `msg-${randomUUID()}`
const marker = `[clankerhouse-message ${messageId}]`
const started = Date.now()
const log = (state: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ ms: Date.now() - started, messageId, state, ...data }))

const write = (path: string, line: string) => new Promise<void>((resolve, reject) => {
  const socket = createConnection(path)
  socket.once("error", reject)
  socket.once("connect", () => socket.end(`${line}\n`, () => resolve()))
})

const parseHook = (row: string) => {
  // A row still being appended is simply not an event yet.
  try { return [JSON.parse(row.slice(row.indexOf("\t") + 1))] } catch { return [] }
}
const hooks = () => existsSync(eventsPath!) ? readFileSync(eventsPath!, "utf8").split("\n").filter(Boolean).flatMap(parseHook) : []

const until = async <T>(timeoutMs: number, look: () => T | undefined): Promise<T | undefined> => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(100)) {
    const found = look()
    if (found !== undefined) return found
  }
  return undefined
}

/** Inbox socket identity: a restarted session binds a new inode, and only then has a written message been lost. */
const socketIdentity = () => { try { return statSync(socketPath!).ino } catch { return undefined } }

const line = JSON.stringify({ type: "user", uuid: randomUUID(), message: { role: "user", content: `${text}\n\n${marker}` } })
let ack: { prompt_id?: string; session_id?: string } | undefined
log("accepted")
const findAck = () => hooks().find((hook) => hook.hook_event_name === "UserPromptSubmit" && String(hook.prompt ?? "").includes(marker))
// The harness does not deduplicate, so resend only when the first write cannot have landed.
for (let attempt = 1; attempt <= maxAttempts && !ack; attempt += 1) {
  const identity = socketIdentity()
  try { await write(socketPath!, line); log("written", { attempt }) }
  catch (error) { log("write_failed", { attempt, error: String(error) }); await Bun.sleep(ackTimeoutMs / maxAttempts); continue }
  let lost = false
  ack = await until(ackTimeoutMs, () => { lost = socketIdentity() !== identity; return findAck() ?? (lost ? null : undefined) }) ?? undefined
  if (!ack && !lost) break
}
if (!ack) { log("unacked"); process.exit(3) }
log("acked", { promptId: ack.prompt_id, sessionId: ack.session_id })
const stop = await until(turnTimeoutMs, () => hooks().find((hook) => hook.hook_event_name === "Stop" && hook.prompt_id === ack!.prompt_id))
if (!stop) { log("turn_timeout"); process.exit(4) }
log("turn_ended", { promptId: stop.prompt_id, reply: String(stop.last_assistant_message ?? "").slice(0, 120) })

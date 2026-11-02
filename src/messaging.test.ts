/**
 * Clanker messaging (docs/messaging-study-t3code-orca.md): delivery through Claude's messaging
 * socket, id-tagged prompts acknowledged by id, pointer prompts for typed long bodies with an
 * inbox, idempotent request ids, staged receipts, incarnation fencing, restart through the
 * Multiplexer's interrupt, the hook's redelivery guard, and the event log.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deliverQueuedMessages, inboxAck, inboxList, inboxRead, messageEvents, sendClanker, sendStatus } from "./clanker-api"
import { ManagedMultiplexer, type Multiplexer } from "./multiplexer"
import type { AgentInterruptOutcome } from "./multiplexer/interface"
import { OrchestrationStore, orchestrationStatePath, promptFor, promptSha256 } from "./orchestration"

const roots: string[] = []
const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const isolate = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-messaging-"))
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

interface Pane {
  prompts: string[]
  interrupts: number
  /** What the Multiplexer's interrupt reports; undefined: it cannot interrupt. */
  interruptOutcome: AgentInterruptOutcome | undefined
  focused: boolean
  /** Make the next prompt hand-offs fail with this message. */
  failWith: string[]
}

const CLANKER = "clanker-msg"
const PANE = "w1:p7"

const fakeHerdr = (pane: Pane) => new ManagedMultiplexer(Object.assign({
  kind: "herdr",
  capabilities: () => ({ processInfo: true, agentStatus: true, sessionRefs: true, agentPrompt: true, persistentLabels: true, durableIds: true, popup: true, worktrees: true, nativeChanges: true, argvLaunch: true, claimScopes: ["session", "pane"] }),
  observe: async () => ({
    kind: "herdr",
    instanceId: "herdr:/tmp/test.sock",
    sessions: [{
      id: "w1", nativeName: "repo@main", path: "/repo", recency: 0, attached: true, worktreePath: "/repo", directoryPath: "", windows: [{
        id: "w1:t1", index: "1", nativeName: "claude", active: true, panes: [{
          id: PANE, index: "1", pid: "123", command: "claude", title: "", currentPath: "/repo", activity: 0, active: true, focused: pane.focused,
          claims: { clankerId: CLANKER, harness: "claude" },
        }],
      }],
    }],
  }),
  readClaim: async (_location: unknown, key: string) => key === "clankerId" ? CLANKER : undefined,
  promptAgent: async (_location: unknown, text: string) => {
    const failure = pane.failWith.shift()
    pane.prompts.push(text)
    if (failure) throw new Error(failure)
  },
}, pane.interruptOutcome === undefined ? {} : {
  interruptAgent: async () => { pane.interrupts += 1; return pane.interruptOutcome },
}) as unknown as Multiplexer)

const setup = (options: { interruptOutcome?: AgentInterruptOutcome; focused?: boolean } = {}) => {
  const reports = isolate()
  const pane: Pane = { prompts: [], interrupts: 0, interruptOutcome: options.interruptOutcome, focused: options.focused ?? false, failWith: [] }
  const multiplexer = fakeHerdr(pane)
  const report = (state: string, generation: number, settledGeneration: number, extra: Record<string, unknown> = {}) =>
    writeFileSync(join(reports, "w1_p7.json"), JSON.stringify({ harness: "claude", clankerId: CLANKER, pane: PANE, state, generation, settledGeneration, updatedAt: Date.now(), ...extra }))
  /** The hook's record of a submitted prompt, as the native hook writes it. */
  const submitted = (prompt: string, generation: number) => {
    const ids = [...prompt.matchAll(/\[clankerhouse (msg-[A-Za-z0-9-]+)/g)].map((match) => match[1])
    return { sha256: promptSha256(prompt), generation, ...(ids.length ? { messageIds: ids } : {}) }
  }
  report("idle", 0, 0)
  return { pane, multiplexer, report, submitted }
}

const ageDelivered = (messageId: string, byMs: number) => {
  const store = OrchestrationStore.open(orchestrationStatePath())
  store.db.query("UPDATE messages SET delivered_at = delivered_at - ?2 WHERE message_id = ?1").run(messageId, byMs)
  store.close()
}

describe("id-tagged prompts", () => {
  test("a short message goes inline behind its tag and is acknowledged by id even inside <pasted_content>", async () => {
    const { pane, multiplexer, report, submitted } = setup()
    const receipt = await sendClanker(CLANKER, "reply PONG", { sender: "clanker-parent" }, multiplexer)
    expect(receipt).toMatchObject({ delivery: "immediate", appliedMode: "immediate", requestedMode: "auto", transport: "inline", replayed: false, confirmed: true })
    expect(pane.prompts).toEqual([`[clankerhouse ${receipt.messageId} from clanker-parent] reply PONG`])

    // Claude wraps the prompt and pads it; the hash would no longer match, the id still does.
    const wrapped = `\n\n<pasted_content id="9">\n${pane.prompts[0]}\n</pasted_content id="9">\n`
    report("working", 1, 0, { prompts: [submitted(wrapped, 1)] })
    expect(await sendStatus(receipt.messageId, multiplexer)).toMatchObject({ state: "acked", stage: "started", startedGeneration: 1, sender: "clanker-parent", observation: "hook" })
    report("done", 1, 1, { prompts: [submitted(wrapped, 1)] })
    expect((await sendStatus(receipt.messageId, multiplexer)).stage).toBe("settled")
  })

  test("a long message is typed as a one-line pointer; the recipient reads it from the inbox and acks it", async () => {
    const { pane, multiplexer } = setup()
    const body = Array.from({ length: 60 }, (_, index) => `line ${index} with </pasted_content> inside`).join("\n")
    const receipt = await sendClanker(CLANKER, body, {}, multiplexer)
    expect(receipt.transport).toBe("pointer")
    expect(pane.prompts[0]).toBe(`[clankerhouse ${receipt.messageId} from operator] New 60-line message. Read it with \`clankers inbox read ${receipt.messageId}\`, act on it, then run \`clankers inbox ack ${receipt.messageId}\`.`)
    expect(pane.prompts[0]!.split("\n")).toHaveLength(1)

    expect((await inboxList({ clankerId: CLANKER })).messages.map((message) => message.messageId)).toEqual([receipt.messageId])
    expect((await inboxRead(receipt.messageId, { clankerId: CLANKER })).text).toBe(body)
    await expect(inboxRead(receipt.messageId, { clankerId: "clanker-someone-else" })).rejects.toMatchObject({ code: "NOT_FOUND" })
    // Reading and acking proves delivery even before the hook's acknowledgement is seen.
    await inboxAck(receipt.messageId, { clankerId: CLANKER })
    expect(await sendStatus(receipt.messageId, multiplexer)).toMatchObject({ state: "acked", stage: "handled" })
    expect((await inboxList({ clankerId: CLANKER })).messages).toEqual([])
  })

  test("the inline threshold keeps tagged prompts under Claude's paste-wrapping size", () => {
    expect(promptFor({ messageId: "msg-1", sender: "operator", text: "a\nb\nc" }).transport).toBe("inline")
    expect(promptFor({ messageId: "msg-1", sender: "operator", text: "a\nb\nc\nd" }).transport).toBe("pointer")
    expect(promptFor({ messageId: "msg-1", sender: "operator", text: "x".repeat(600) }).transport).toBe("pointer")
  })

  test("an older hook that records only hashes still acknowledges a tagged prompt", async () => {
    const { pane, multiplexer, report } = setup()
    const receipt = await sendClanker(CLANKER, "legacy ack", {}, multiplexer)
    report("working", 1, 0, { prompts: [{ sha256: promptSha256(pane.prompts[0]!), generation: 1 }] })
    expect((await sendStatus(receipt.messageId, multiplexer)).state).toBe("acked")
  })
})

describe("idempotent request ids", () => {
  test("a resend with the same request id returns the first message and types nothing; different text is a conflict", async () => {
    const { pane, multiplexer } = setup()
    const first = await sendClanker(CLANKER, "do the thing", { requestId: "req-1" }, multiplexer)
    const again = await sendClanker(CLANKER, "do the thing", { requestId: "req-1" }, multiplexer)
    expect(again).toMatchObject({ messageId: first.messageId, replayed: true })
    expect(pane.prompts).toHaveLength(1)
    await expect(sendClanker(CLANKER, "something else", { requestId: "req-1" }, multiplexer)).rejects.toMatchObject({ code: "CONFLICT", exitCode: 2 })
    expect((await sendStatus(first.messageId, multiplexer)).requestId).toBe("req-1")
  })
})

describe("ambiguous hand-offs", () => {
  test("a timed-out hand-off is kept, acknowledged later by id, and never retyped", async () => {
    const { pane, multiplexer, report, submitted } = setup()
    pane.failWith.push("herdr agent.prompt failed: timeout")
    const receipt = await sendClanker(CLANKER, "maybe landed", {}, multiplexer)
    expect(receipt).toMatchObject({ delivery: "immediate", confirmed: false })
    ageDelivered(receipt.messageId, 60_000)
    report("working", 1, 0, { prompts: [submitted(pane.prompts[0]!, 1)] })
    report("done", 1, 1, { prompts: [submitted(pane.prompts[0]!, 1)] })
    await deliverQueuedMessages(multiplexer)
    expect(pane.prompts).toHaveLength(1)
    expect((await sendStatus(receipt.messageId, multiplexer)).stage).toBe("settled")
  })

  test("a hand-off with no acknowledgement is retried with the same id, at most three times", async () => {
    const { pane, multiplexer } = setup()
    pane.failWith.push("agent_prompt_stalled")
    const receipt = await sendClanker(CLANKER, "never seen", {}, multiplexer)
    await deliverQueuedMessages(multiplexer)
    expect(pane.prompts).toHaveLength(1)
    for (let round = 0; round < 4; round += 1) {
      ageDelivered(receipt.messageId, 60_000)
      await deliverQueuedMessages(multiplexer)
    }
    expect(pane.prompts).toHaveLength(3)
    expect(new Set(pane.prompts).size).toBe(1)
    expect(await sendStatus(receipt.messageId, multiplexer)).toMatchObject({ stage: "typed", attempts: 3 })
  })
})

/** A stand-in for Claude's messaging socket: one JSON line per connection. */
const inboxServer = () => {
  const dir = mkdtempSync(join(tmpdir(), "chm-"))
  roots.push(dir)
  const path = join(dir, "inbox.sock")
  const lines: Array<{ type: string; uuid: string; message: { role: string; content: string } }> = []
  const server = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open(socket) { socket.data = { buffer: "" } },
      data(socket, data) { socket.data.buffer += data.toString() },
      close(socket) { for (const line of socket.data.buffer.split("\n").filter(Boolean)) lines.push(JSON.parse(line)) },
    },
  })
  restores.push(() => server.stop(true))
  const contents = async () => { await Bun.sleep(30); return lines.map((line) => line.message.content) }
  return { path, lines, contents }
}

describe("messaging socket", () => {
  test("a clanker whose hook reported a messaging socket gets messages there, text intact, never typed", async () => {
    const { pane, multiplexer, report } = setup()
    const inbox = inboxServer()
    report("idle", 0, 0, { messagingSocket: inbox.path })
    const body = Array.from({ length: 60 }, (_, index) => `line ${index} with </pasted_content> inside`).join("\n")
    const receipt = await sendClanker(CLANKER, body, { sender: "clanker-parent" }, multiplexer)
    expect(receipt).toMatchObject({ delivery: "immediate", transport: "inbox", confirmed: true })
    expect(await inbox.contents()).toEqual([`[clankerhouse ${receipt.messageId} from clanker-parent]\n${body}`])
    expect(inbox.lines[0]).toMatchObject({ type: "user", message: { role: "user" } })
    expect(pane.prompts).toEqual([])
  })

  test("a focused clanker still gets inbox mail, since Claude leaves a draft alone; a working one queues", async () => {
    const { multiplexer, report, submitted } = setup({ focused: true })
    const inbox = inboxServer()
    report("idle", 0, 0, { messagingSocket: inbox.path })
    await sendClanker(CLANKER, "first", {}, multiplexer)
    expect(await inbox.contents()).toHaveLength(1)
    const firstPrompt = inbox.lines[0]!.message.content
    report("working", 1, 0, { messagingSocket: inbox.path, prompts: [submitted(firstPrompt, 1)] })
    const queued = await sendClanker(CLANKER, "second", {}, multiplexer)
    expect(queued.delivery).toBe("queued")
    expect(await inbox.contents()).toHaveLength(1)
    report("done", 1, 1, { messagingSocket: inbox.path, prompts: [submitted(firstPrompt, 1)] })
    expect((await deliverQueuedMessages(multiplexer)).delivered).toEqual([queued.messageId])
    expect(await inbox.contents()).toHaveLength(2)
  })

  test("without a live socket the message is typed; a dead socket refuses the send and keeps nothing", async () => {
    const { pane, multiplexer, report, submitted } = setup()
    report("idle", 0, 0, { messagingSocket: "/nonexistent/inbox.sock" })
    expect((await sendClanker(CLANKER, "typed", {}, multiplexer)).transport).toBe("inline")
    expect(pane.prompts).toHaveLength(1)

    // The socket file outlives a crashed Claude: connecting is refused, so nothing was delivered.
    const dir = mkdtempSync(join(tmpdir(), "chm-"))
    roots.push(dir)
    const stale = join(dir, "dead.sock")
    // Bun and Node unlink a socket they close; a process that dies leaves it, as Python does here.
    Bun.spawnSync(["python3", "-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", stale])
    if (!existsSync(stale)) throw new Error("expected the stale socket file to remain")
    report("done", 1, 1, { messagingSocket: stale, prompts: [submitted(pane.prompts[0]!, 1)] })
    await expect(sendClanker(CLANKER, "lost?", {}, multiplexer)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect((await inboxList({ clankerId: CLANKER, all: true })).messages.map((message) => message.text)).toEqual(["typed"])
  })

  test("an unacknowledged inbox message is rewritten with the same id, at most three times", async () => {
    const { multiplexer, report } = setup()
    const inbox = inboxServer()
    report("idle", 0, 0, { messagingSocket: inbox.path })
    const receipt = await sendClanker(CLANKER, "held behind a dialog", {}, multiplexer)
    for (let round = 0; round < 4; round += 1) {
      ageDelivered(receipt.messageId, 60_000)
      await deliverQueuedMessages(multiplexer)
    }
    const contents = await inbox.contents()
    expect(contents).toHaveLength(3)
    expect(new Set(contents).size).toBe(1)
  })
})

describe("incarnation fencing", () => {
  test("mail queued for one harness launch is orphaned, not typed, when the pane hosts a new launch", async () => {
    const { pane, multiplexer, report } = setup()
    report("working", 3, 2, { incarnation: "launch-a" })
    const receipt = await sendClanker(CLANKER, "for launch a", {}, multiplexer)
    expect(receipt.delivery).toBe("queued")
    report("idle", 0, 0, { incarnation: "launch-b" })
    expect((await deliverQueuedMessages(multiplexer)).fenced).toEqual([receipt.messageId])
    expect(pane.prompts).toEqual([])
    expect(await sendStatus(receipt.messageId, multiplexer)).toMatchObject({ stage: "orphaned", orphanReason: "harness-replaced" })
    // Mail sent to the new launch is delivered as usual.
    await sendClanker(CLANKER, "for launch b", {}, multiplexer)
    expect(pane.prompts).toHaveLength(1)
  })
})

describe("dispatch modes", () => {
  test("an interrupt the Multiplexer saw stop delivers at once, though Claude reports no Stop for it", async () => {
    const { pane, multiplexer, report } = setup({ interruptOutcome: "stopped" })
    report("working", 1, 0)
    const receipt = await sendClanker(CLANKER, "change of plan", { delivery: "restart" }, multiplexer)
    expect(receipt).toMatchObject({ requestedMode: "restart", appliedMode: "restart", delivery: "immediate", interrupted: "confirmed" })
    expect(pane.interrupts).toBe(1)
    expect(pane.prompts).toHaveLength(1)
  })

  test("a confirmed interrupt hands over the queue's head first, keeping order", async () => {
    const { pane, multiplexer, report } = setup({ interruptOutcome: "stopped" })
    report("working", 1, 0)
    const earlier = await sendClanker(CLANKER, "earlier", {}, multiplexer)
    const receipt = await sendClanker(CLANKER, "change of plan", { delivery: "restart" }, multiplexer)
    expect(receipt).toMatchObject({ appliedMode: "restart", delivery: "queued", interrupted: "confirmed" })
    expect(pane.prompts).toEqual([`[clankerhouse ${earlier.messageId} from operator] earlier`])
  })

  test("an unconfirmed interrupt queues until the clanker settles; steer and restart-on-dialog are refused", async () => {
    const { pane, multiplexer, report } = setup({ interruptOutcome: "still_working" })
    report("working", 1, 0)
    await expect(sendClanker(CLANKER, "steer", { delivery: "steer" }, multiplexer)).rejects.toMatchObject({ code: "UNSUPPORTED" })
    const receipt = await sendClanker(CLANKER, "change of plan", { delivery: "restart" }, multiplexer)
    expect(receipt).toMatchObject({ requestedMode: "restart", appliedMode: "restart", delivery: "queued", interrupted: "unconfirmed" })
    expect(pane.interrupts).toBe(1)
    expect(pane.prompts).toEqual([])
    report("idle", 1, 1)
    await deliverQueuedMessages(multiplexer)
    expect(pane.prompts).toHaveLength(1)

    report("blocked", 2, 1)
    await expect(sendClanker(CLANKER, "restart", { delivery: "restart" }, multiplexer)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(pane.interrupts).toBe(1)
  })

  test("restart is offered only where the Multiplexer can interrupt, and is a plain delivery on an idle clanker", async () => {
    const plain = setup()
    await expect(sendClanker(CLANKER, "go", { delivery: "restart" }, plain.multiplexer)).rejects.toMatchObject({ code: "UNSUPPORTED" })
    const { pane, multiplexer } = setup({ interruptOutcome: "stopped" })
    const receipt = await sendClanker(CLANKER, "go", { delivery: "restart" }, multiplexer)
    expect(receipt).toMatchObject({ requestedMode: "restart", appliedMode: "immediate" })
    expect(pane.interrupts).toBe(0)
  })
})

describe("message event log", () => {
  test("stage changes carry a seq a caller resumes from", async () => {
    const { pane, multiplexer, report, submitted } = setup()
    report("working", 1, 0)
    const receipt = await sendClanker(CLANKER, "log me", {}, multiplexer)
    const first = messageEvents(0, [CLANKER])
    expect(first.events.map((event) => event.stage)).toEqual(["queued"])
    report("idle", 1, 1)
    await deliverQueuedMessages(multiplexer)
    report("working", 2, 1, { prompts: [submitted(pane.prompts[0]!, 2)] })
    await sendStatus(receipt.messageId, multiplexer)
    const next = messageEvents(first.nextSeq, [CLANKER])
    expect(next.events.map((event) => event.stage)).toEqual(["typed", "acked"])
    expect(messageEvents(next.nextSeq).events).toEqual([])
  })
})

describe("native hook", () => {
  const hookRunner = (env: Record<string, string>) => {
    const reports = isolate()
    const hook = join(import.meta.dir, "../native-client/target/release/clankerhouse-hook")
    const run = (state: string, payload: object) => {
      const result = Bun.spawnSync([hook, "claude", state], {
        env: { ...process.env, CLANKERHOUSE_MULTIPLEXER: "", HERDR_PANE_ID: PANE, CLANKER_ID: CLANKER, HERDR_SOCKET_PATH: "/nonexistent", CLAUDE_CODE_MESSAGING_SOCKET: "", CLANKERHOUSE_HARNESS_INCARNATION: "", ...env },
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
      })
      return { exitCode: result.exitCode, stdout: result.stdout.toString() }
    }
    const record = () => JSON.parse(readFileSync(join(reports, "w1_p7.json"), "utf8"))
    return { run, record }
  }

  test("records tagged message ids, the harness incarnation and the messaging socket", () => {
    const { run, record } = hookRunner({ CLANKERHOUSE_HARNESS_INCARNATION: "launch-1", CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1/cc-socks/42.sock" })
    expect(run("working", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "\n<pasted_content id=\"1\">\n[clankerhouse msg-abc-1 from operator] hi\n</pasted_content id=\"1\">" }).exitCode).toBe(0)
    expect(record()).toMatchObject({ incarnation: "launch-1", messagingSocket: "/run/user/1/cc-socks/42.sock" })
    expect(record().prompts.at(-1)).toMatchObject({ generation: 1, messageIds: ["msg-abc-1"] })
  })

  test("a Claude started by hand is fenced on its messaging socket, and a redelivered message is blocked", () => {
    const { run, record } = hookRunner({ CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1/cc-socks/43.sock" })
    const prompt = "[clankerhouse msg-dup-1 from operator]\nrun once"
    expect(run("working", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt }).stdout).toBe("")
    expect(record()).toMatchObject({ incarnation: "/run/user/1/cc-socks/43.sock", generation: 1 })
    run("done", { hook_event_name: "Stop", session_id: "s1" })
    const again = run("working", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt })
    expect(JSON.parse(again.stdout)).toMatchObject({ decision: "block" })
    expect(record()).toMatchObject({ state: "done", generation: 1 })
  })
})

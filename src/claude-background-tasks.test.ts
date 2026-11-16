import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const claimKeys = ["clankerId", "harness", "harnessSessionId"]

/** Each Rex claim file the hook holds for the pane, with its value and the inode its last write produced. */
const claimFiles = (dir: string) => claimKeys.flatMap((key) => {
  const path = join(dir, key)
  if (!existsSync(path)) return []
  const stat = statSync(path, { bigint: true })
  return [{ key, value: readFileSync(path, "utf8"), inode: stat.ino, mtimeNs: stat.mtimeNs }]
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-claude-background-"))
  roots.push(root)
  for (const dir of ["bin", "home", "runtime", "state", "config", "data"]) mkdirSync(join(root, dir))
  // The hook must never start an interpreter; these stubs record any attempt.
  for (const interpreter of ["python3", "python", "bun", "node"]) {
    writeFileSync(join(root, "bin", interpreter), `#!/bin/sh\nprintf "%s\\n" ${interpreter} >> "$SPAWN_LOG"\nexit 1\n`)
    chmodSync(join(root, "bin", interpreter), 0o755)
  }
  const spawns = join(root, "spawns")
  const runtime = join(root, "runtime", `clankerhouse-${process.getuid?.() || 0}-rex`)
  const report = join(runtime, "clanker-state/block_p9.json")
  const attestation = join(runtime, "hook-events/block_p9.json")
  // Rex claims are plain files the hook writes itself; no Multiplexer is asked.
  const claimDir = join(root, "state", "clankerhouse-rex", "rex-claims", "block:p9")
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH || ""}`,
    HOME: join(root, "home"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    CLANKERHOUSE_INSTANCE: "",
    CLANKER_ID: "clanker-background-test",
    CLANKER_SESSION_ID: "claude-test-session",
    REX_BLOCK: "block:p9",
    SPAWN_LOG: spawns,
  }
  const hook = join(import.meta.dir, "../native-client/target/release/clankerhouse-hook")
  return {
    attestation: () => JSON.parse(readFileSync(attestation, "utf8")),
    spawned: () => existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n").filter(Boolean) : [],
    report: () => report,
    emitTimed: (state: string, payload: Record<string, unknown>) => {
      const started = Bun.nanoseconds()
      const result = Bun.spawnSync([hook, "claude", state], { env, stdin: Buffer.from(JSON.stringify({ session_id: "claude-test-session", ...payload })) })
      expect(result.exitCode).toBe(0)
      return (Bun.nanoseconds() - started) / 1e6
    },
    claims: () => claimFiles(claimDir),
    emit: async (state: string, payload: Record<string, unknown>, harness = "claude") => {
      const child = Bun.spawn([join(import.meta.dir, "../bin/clankerhouse-clanker-state-report"), harness, state], {
        env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      })
      // Claude names its working directory in every hook payload.
      child.stdin.write(JSON.stringify({ session_id: "claude-test-session", cwd: root, ...payload }))
      child.stdin.end()
      const stderr = new Response(child.stderr).text()
      expect(await child.exited, await stderr).toBe(0)
      expect(await new Response(child.stdout).text()).toBe("")
      return JSON.parse(readFileSync(report, "utf8"))
    },
  }
}

const shell = { id: "background-shell", type: "shell", status: "running", command: "private command text" }
const subagent = { id: "background-agent", type: "subagent", status: "running" }

describe("Claude background-task lifecycle", () => {
  test("a steady-state hook stays within a 5ms budget", async () => {
    const f = fixture()
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    const samples = Array.from({ length: 51 }, () => f.emitTimed("working", { hook_event_name: "PreToolUse", cwd: "/" })).sort((a, b) => a - b)
    expect(samples[25]!).toBeLessThan(5)
  })

  test("claims follow the durable state record and are written once per session", async () => {
    const f = fixture()
    await f.emit("idle", { hook_event_name: "SessionStart" })
    const reportWritten = statSync(f.report(), { bigint: true }).mtimeNs
    const first = f.claims()
    expect(first.map(({ key, value }) => [key, value])).toEqual([
      ["clankerId", "clanker-background-test"],
      ["harness", "claude"],
      ["harnessSessionId", "claude-test-session"],
    ])
    // The durable state record is on disk before any claim names the clanker.
    for (const claim of first) expect(claim.mtimeNs).toBeGreaterThanOrEqual(reportWritten)
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    // Every write replaces the file, so an unchanged inode means it was not written again.
    expect(f.claims()).toEqual(first)
  })

  test("steady-state reports start no processes and spool Recovery attestation only on change", async () => {
    const f = fixture()
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    const claims = f.claims()
    const requested = f.attestation()
    for (let call = 0; call < 5; call++) await f.emit("working", { hook_event_name: "PreToolUse" })
    expect(claims).toHaveLength(3)
    expect(f.claims()).toEqual(claims)
    expect(f.spawned()).toEqual([])
    expect(f.attestation()).toEqual(requested)
    expect(f.attestation()).toMatchObject({ pane: "block:p9", clankerId: "clanker-background-test", harnessSessionId: "claude-test-session", state: "working" })
  })

  test("Stop defers completion and Recovery settlement until background work has finished", async () => {
    const f = fixture()
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    for (const background_tasks of [[shell, subagent], [shell], [subagent]]) {
      const report = await f.emit("done", { hook_event_name: "Stop", background_tasks })
      expect(report).toMatchObject({
        harness: "claude", clankerId: "clanker-background-test", harnessSessionId: "claude-test-session",
        hookEvent: "Stop", state: "working", generation: 2, settledGeneration: 1,
      })
      expect(JSON.stringify(report)).not.toContain("private command text")
      expect(f.attestation()).toMatchObject({ clankerId: "clanker-background-test", harnessSessionId: "claude-test-session", state: "working" })
    }
    const settled = await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    expect(settled).toMatchObject({ state: "done", generation: 2, settledGeneration: 2 })
    expect(f.attestation()).toMatchObject({ state: "done" })
  })

  test.each([
    ["older Claude without task metadata", {}],
    ["no active tasks", { background_tasks: [] }],
    ["completed or cancelled tasks", { background_tasks: [{ ...shell, status: "completed" }, { ...shell, status: "killed" }] }],
    ["scheduled future wakeups only", { background_tasks: [], session_crons: [{ id: "cron", schedule: "0 9 * * *", recurring: true }] }],
    ["malformed task list", { background_tasks: "running" }],
    ["malformed entries", { background_tasks: [null, "running", {}] }],
  ])("preserves completion for %s", async (_label, payload) => {
    const f = fixture()
    expect(await f.emit("done", { hook_event_name: "Stop", ...payload })).toMatchObject({ state: "done", generation: 1, settledGeneration: 1 })
  })

  test.each(["running", "pending"])("recognizes %s tasks without a task-type allowlist", async (status) => {
    const f = fixture()
    expect(await f.emit("done", { hook_event_name: "Stop", background_tasks: [null, { ...shell, type: "future-task-kind", status }] }))
      .toMatchObject({ state: "working", generation: 1, settledGeneration: 0 })
  })

  test.each(["pi", "codex", "opencode"])("does not reinterpret %s reports", async (harness) => {
    const f = fixture()
    expect(await f.emit("done", { hook_event_name: "Stop", background_tasks: [shell] }, harness))
      .toMatchObject({ state: "done", generation: 1, settledGeneration: 1 })
  })

  test.each([
    ["blocked", "PermissionRequest"],
    ["unknown", "SessionEnd"],
    ["done", "SubagentStop"],
  ])("does not override %s on %s", async (state, hook_event_name) => {
    const f = fixture()
    expect(await f.emit(state, { hook_event_name, background_tasks: [shell] })).toMatchObject({ state })
  })
})

describe("Claude prompt acknowledgement and event recency", () => {
  test("records the transcript path and each settled turn's time window for results", async () => {
    const f = fixture()
    const transcript_path = "/home/claude/projects/repo/session.jsonl"
    const before = Date.now()
    const started = await f.emit("working", { hook_event_name: "UserPromptSubmit", transcript_path })
    expect(started.generationStartedAt).toBeGreaterThanOrEqual(before)
    expect(await f.emit("working", { hook_event_name: "PreToolUse" })).toMatchObject({ transcriptPath: transcript_path, generationStartedAt: started.generationStartedAt, turns: [] })
    const first = await f.emit("done", { hook_event_name: "Stop", background_tasks: [], transcript_path })
    expect(first.turns).toEqual([{ generation: 1, startedAt: started.generationStartedAt, settledAt: expect.any(Number) }])
    expect(first.turns[0].settledAt).toBeGreaterThanOrEqual(started.generationStartedAt)
    // A repeated Stop for the same generation moves its settle time instead of adding a turn.
    expect((await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })).turns).toHaveLength(1)
    for (let turn = 0; turn < 9; turn++) {
      await f.emit("working", { hook_event_name: "UserPromptSubmit" })
      await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    }
    const kept = await f.emit("idle", { hook_event_name: "SessionStart" })
    expect(kept.turns.map((turn: { generation: number }) => turn.generation)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
  })

  test("records each submitted prompt's hash with the generation it started, across later hooks", async () => {
    const f = fixture()
    const { promptSha256 } = await import("./orchestration")
    await f.emit("idle", { hook_event_name: "SessionStart" })
    const submitted = await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt: "first answer\r\n" })
    expect(submitted).toMatchObject({ generation: 1, promptSha256: promptSha256("first answer"), promptGeneration: 1, prompts: [{ sha256: promptSha256("first answer"), generation: 1 }] })
    const tool = await f.emit("working", { hook_event_name: "PreToolUse" })
    expect(tool.prompts).toEqual(submitted.prompts)
    await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    for (let index = 0; index < 9; index += 1) await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt: `prompt ${index}` })
    const latest = await f.emit("working", { hook_event_name: "PreToolUse" })
    expect(latest.prompts).toHaveLength(8)
    expect(latest.prompts.at(-1)).toEqual({ sha256: promptSha256("prompt 8"), generation: 10 })
    expect(latest).toMatchObject({ promptSha256: promptSha256("prompt 8"), promptGeneration: 10 })
  })

  test("a prompt absorbed mid-turn joins the running generation; a new prompt id starts one", async () => {
    const f = fixture()
    const started = await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "do the task" })
    expect(started).toMatchObject({ generation: 1, promptId: "p1" })
    await f.emit("working", { hook_event_name: "PreToolUse" })
    // A steer through the messaging socket and an hc note pasted while it works both take the turn's id.
    const steered = await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "[clankerhouse msg-steer from operator] also check y" })
    expect(steered).toMatchObject({ generation: 1, generationStartedAt: started.generationStartedAt })
    expect(steered.prompts.at(-1)).toMatchObject({ generation: 1, messageIds: ["msg-steer"] })
    const noted = await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: '<hc from="t7 helper">tests pass</hc>' })
    expect(noted).toMatchObject({ generation: 1, generationStartedAt: started.generationStartedAt })
    const settled = await f.emit("done", { hook_event_name: "Stop", background_tasks: [], prompt_id: "p1" })
    expect(settled).toMatchObject({ generation: 1, settledGeneration: 1 })
    expect(settled.turns).toEqual([{ generation: 1, startedAt: started.generationStartedAt, settledAt: expect.any(Number) }])
    // An idle clanker's next prompt is a new turn, whatever sent it.
    expect(await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: '<hc from="t7 helper">done</hc>' })).toMatchObject({ generation: 2, promptId: "p2" })
    // After an Escape Claude fires no Stop, so the record still says working; the next prompt's new id starts a turn.
    expect(await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt_id: "p3" })).toMatchObject({ generation: 3, promptId: "p3" })
    // A Claude that names no prompt id keeps the old rule: every submitted prompt starts a generation.
    expect(await f.emit("working", { hook_event_name: "UserPromptSubmit" })).toMatchObject({ generation: 4, promptId: null })
  })

  test("every hook event, including each tool call, advances the event time", async () => {
    const f = fixture()
    const times: number[] = []
    times.push((await f.emit("working", { hook_event_name: "UserPromptSubmit", prompt: "go" })).updatedAt)
    for (let index = 0; index < 3; index += 1) {
      await Bun.sleep(3)
      times.push((await f.emit("working", { hook_event_name: "PreToolUse" })).updatedAt)
    }
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(new Set(times).size).toBe(times.length)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-claude-background-"))
  roots.push(root)
  for (const dir of ["bin", "home", "runtime", "state", "config", "data"]) mkdirSync(join(root, dir))
  const tmux = join(root, "bin/tmux")
  writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SPAWN_LOG"\ncase "$1" in show-option) exit 1 ;; set-option) printf "%s %s\\n" "$5" "$(grep -o "\\"state\\": *\\"[a-z]*\\"" "$REPORT_FILE" 2>/dev/null)" >> "$CLAIM_LOG"; exit 0 ;; display-message) printf "%s\\n" "$FIXTURE_CWD" ;; *) exit 1 ;; esac\n')
  chmodSync(tmux, 0o755)
  // The hook must never start an interpreter; these stubs record any attempt.
  for (const interpreter of ["python3", "python", "bun", "node"]) {
    writeFileSync(join(root, "bin", interpreter), `#!/bin/sh\nprintf "%s\\n" ${interpreter} >> "$SPAWN_LOG"\nexit 1\n`)
    chmodSync(join(root, "bin", interpreter), 0o755)
  }
  const spawns = join(root, "spawns")
  const claims = join(root, "claims")
  const runtime = join(root, "runtime", `clankerhouse-${process.getuid?.() || 0}`)
  const report = join(runtime, "clanker-state/%99.json")
  const attestation = join(runtime, "hook-events/%99.json")
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH || ""}`,
    HOME: join(root, "home"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    CLANKERHOUSE_MULTIPLEXER: "tmux",
    CLANKERHOUSE_INSTANCE: "",
    CLANKER_ID: "clanker-background-test",
    CLANKER_SESSION_ID: "claude-test-session",
    CLANKER_RECOVERY_ATTEMPT: "",
    HERDR_ENV: "",
    HERDR_PANE_ID: "",
    HERDR_SOCKET_PATH: "",
    TMUX: "",
    TMUX_PANE: "%99",
    FIXTURE_CWD: root,
    SPAWN_LOG: spawns,
    CLAIM_LOG: claims,
    REPORT_FILE: report,
  }
  const hook = join(import.meta.dir, "../native-client/target/release/clankerhouse-hook")
  return {
    attestation: () => JSON.parse(readFileSync(attestation, "utf8")),
    spawned: () => readFileSync(spawns, "utf8").trim().split("\n").filter(Boolean),
    emitTimed: (state: string, payload: Record<string, unknown>) => {
      const started = Bun.nanoseconds()
      const result = Bun.spawnSync([hook, "claude", state], { env, stdin: Buffer.from(JSON.stringify({ session_id: "claude-test-session", ...payload })) })
      expect(result.exitCode).toBe(0)
      return (Bun.nanoseconds() - started) / 1e6
    },
    claims: () => readFileSync(claims, "utf8").trim().split("\n"),
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
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    expect(f.claims().sort()).toEqual([
      '@clankerhouse_clanker_id "state":"idle"',
      '@clankerhouse_harness_session_id "state":"idle"',
      '@dotfiles_harness "state":"idle"',
    ])
  })

  test("steady-state reports start no processes and spool Recovery attestation only on change", async () => {
    const f = fixture()
    await f.emit("working", { hook_event_name: "UserPromptSubmit" })
    const spawned = f.spawned()
    const requested = f.attestation()
    for (let call = 0; call < 5; call++) await f.emit("working", { hook_event_name: "PreToolUse" })
    expect(f.spawned()).toEqual(spawned)
    expect(spawned).toEqual(["show-option", "set-option", "set-option", "set-option"])
    expect(f.attestation()).toEqual(requested)
    expect(f.attestation()).toMatchObject({ pane: "%99", clankerId: "clanker-background-test", harnessSessionId: "claude-test-session", state: "working", recoveryAttemptId: null })
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

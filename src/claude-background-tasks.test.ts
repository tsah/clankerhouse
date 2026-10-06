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
  writeFileSync(tmux, '#!/bin/sh\ncase "$1" in show-option) exit 1 ;; set-option) exit 0 ;; display-message) printf "%s\\n" "$FIXTURE_CWD" ;; *) exit 1 ;; esac\n')
  chmodSync(tmux, 0o755)
  const clankers = join(root, "bin/clankers")
  writeFileSync(clankers, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ATTESTATION_LOG"\n')
  chmodSync(clankers, 0o755)
  const attestations = join(root, "attestations")
  const report = join(root, "runtime", `clankerhouse-${process.getuid?.() || 0}`, "clanker-state/%99.json")
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
    CLANKERHOUSE_CLANKERS: clankers,
    CLANKER_ID: "clanker-background-test",
    CLANKER_SESSION_ID: "claude-test-session",
    CLANKER_RECOVERY_ATTEMPT: "",
    HERDR_ENV: "",
    HERDR_PANE_ID: "",
    HERDR_SOCKET_PATH: "",
    TMUX: "",
    TMUX_PANE: "%99",
    FIXTURE_CWD: root,
    ATTESTATION_LOG: attestations,
  }
  return {
    attestations: () => readFileSync(attestations, "utf8").trim().split("\n"),
    emit: async (state: string, payload: Record<string, unknown>, harness = "claude") => {
      const child = Bun.spawn([join(import.meta.dir, "../bin/clankerhouse-clanker-state-report"), harness, state], {
        env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      })
      child.stdin.write(JSON.stringify({ session_id: "claude-test-session", ...payload }))
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
      expect(f.attestations().at(-1)).toBe("recovery attest clanker-background-test --session-id claude-test-session --state working")
    }
    const settled = await f.emit("done", { hook_event_name: "Stop", background_tasks: [] })
    expect(settled).toMatchObject({ state: "done", generation: 2, settledGeneration: 2 })
    expect(f.attestations().at(-1)).toEndWith("--state done")
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

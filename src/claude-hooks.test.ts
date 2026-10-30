import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

type Hook = { type: string; command: string; timeout?: number }
type Settings = { model?: string; hooks: Record<string, { matcher?: string; hooks: Hook[] }[]> }
const command = (value: string): Hook => ({ type: "command", command: value, timeout: 10 })

function fixture(customConfig = false, binName = "bin") {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-claude-hooks-"))
  roots.push(root)
  const home = join(root, "home")
  const config = join(home, customConfig ? "custom claude" : ".claude")
  mkdirSync(config, { recursive: true })
  const settings = join(config, "settings.json")
  const legacy = join(config, "hooks/herdr-agent-state.sh")
  const bin = join(root, binName)
  const env = {
    PATH: Bun.env.PATH!, HOME: home, CLAUDE_CONFIG_DIR: config, CLANKERHOUSE_BIN_DIR: bin, CLANKERHOUSE_HOOK: join(bin, "clankerhouse-hook"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"),
  }
  const install = () => {
    const result = Bun.spawnSync(["bash", join(import.meta.dir, "../bin/clankerhouse-install-claude-hooks")], { env })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return JSON.parse(readFileSync(settings, "utf8")) as Settings
  }
  return { root, config, settings, legacy, bin, env, install }
}

const commands = (settings: Settings, event: string) => settings.hooks[event]?.flatMap(entry => entry.hooks.map(hook => hook.command)) ?? []

describe("Claude hook installation", () => {
  test("migrates the missing Herdr startup hook, preserving other hooks and settings", () => {
    const f = fixture()
    const original: Settings = { model: "keep-this", hooks: {
      SessionStart: [{ matcher: "*", hooks: [command(`bash '${f.legacy}' session`), command("echo custom-start")] }],
      Stop: [{ matcher: "*", hooks: [command("echo custom-stop")] }],
    } }
    const before = JSON.stringify(original, null, 2) + "\n"
    writeFileSync(f.settings, before, { mode: 0o600 })
    const installed = f.install()
    expect(installed.model).toBe("keep-this")
    expect(commands(installed, "SessionStart")).toHaveLength(2)
    expect(commands(installed, "SessionStart")[0]).toBe("echo custom-start")
    expect(commands(installed, "SessionStart")[1]).toContain(`${f.bin}/clankerhouse-hook`)
    expect(commands(installed, "Stop")).toContain("echo custom-stop")
    expect(readFileSync(`${f.settings}.pre-clankerhouse-migration`, "utf8")).toBe(before)
    expect(statSync(`${f.settings}.pre-clankerhouse-migration`).mode & 0o777).toBe(0o600)
    const first = statSync(f.settings).mtimeMs
    expect(f.install()).toEqual(installed)
    expect(statSync(f.settings).mtimeMs).toBe(first)
    expect(readFileSync(`${f.settings}.pre-clankerhouse-migration`, "utf8")).toBe(before)
  })

  test("preserves existing Herdr hooks and similarly named or composed custom commands", () => {
    const f = fixture()
    mkdirSync(join(f.config, "hooks"))
    writeFileSync(f.legacy, "# intentionally installed hook\n")
    const keep = [
      `bash '${f.legacy}' session`,
      `bash '${f.root}/custom/herdr-agent-state.sh' session`,
      `bash '${f.legacy}' session && echo custom`,
      "echo herdr-agent-state.sh",
    ]
    writeFileSync(f.settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: keep.map(command) }] } }))
    const installed = f.install()
    for (const value of keep) expect(commands(installed, "SessionStart")).toContain(value)
    expect(existsSync(`${f.settings}.pre-clankerhouse-migration`)).toBe(false)
  })

  test("honors a custom Claude config directory and prunes empty migrated entries", () => {
    const f = fixture(true)
    writeFileSync(f.settings, JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup", hooks: [command(`bash '${f.legacy}' session`)] }],
      PreToolUse: [{ matcher: "*", hooks: [command(`bash '${f.legacy}' working`)] }],
    } }))
    const installed = f.install()
    expect(installed.hooks.SessionStart).toHaveLength(1)
    expect(installed.hooks.SessionStart![0]!.matcher).toBe("*")
    expect(commands(installed, "PreToolUse")).toHaveLength(1)
    expect(commands(installed, "PreToolUse")[0]).toContain(`${f.bin}/clankerhouse-hook`)
  })

  test("moves earlier guarded reporter hooks onto the native hook with its 2s budget, leaving custom hooks alone", () => {
    const f = fixture()
    const states = { SessionStart: "idle", PermissionRequest: "blocked", PreToolUse: "working", UserPromptSubmit: "working", Stop: "done", SessionEnd: "unknown" }
    const reporter = `${f.root}/old prefix/bin/clankerhouse-clanker-state-report`
    const guarded = (state: string) => `if [ -n "\${HERDR_PANE_ID:-}" ] && [ -r '${reporter}' ]; then bash '${reporter}' claude ${state}; fi`
    writeFileSync(f.settings, JSON.stringify({ hooks: Object.fromEntries(Object.entries(states).map(([event, state]) => [event, [{ matcher: "*", hooks: [
      { type: "command", command: guarded(state), timeout: 10 },
      ...(event === "Stop" ? [{ type: "command", command: "echo custom-stop", timeout: 10 }] : []),
    ] }]])) }))
    const upgraded = f.install()
    for (const [event, state] of Object.entries(states)) {
      expect(upgraded.hooks[event]![0]!.hooks[0]).toEqual({ type: "command", timeout: 2,
        command: `if { [ -n "\${HERDR_PANE_ID:-}" ] || [ -n "\${HC_TERMINAL_ID:-}" ]; } && [ -x ${f.bin}/clankerhouse-hook ]; then exec ${f.bin}/clankerhouse-hook claude ${state}; fi` })
    }
    expect(upgraded.hooks.Stop![0]!.hooks).toHaveLength(2)
    expect(upgraded.hooks.Stop![0]!.hooks[1]).toEqual({ type: "command", command: "echo custom-stop", timeout: 10 })
  })

  test("global hooks are silent no-ops outside a Multiplexer, even when the reporter exists", () => {
    const f = fixture()
    const reporter = join(f.bin, "clankerhouse-hook")
    mkdirSync(f.bin)
    writeFileSync(reporter, "#!/bin/sh\necho 'hook must not run outside a pane' >&2\nexit 73\n", { mode: 0o755 })
    const installed = f.install()
    for (const event of Object.keys(installed.hooks)) {
      const hook = commands(installed, event)[0]!
      const result = Bun.spawnSync(["sh", "-c", hook], { env: f.env, stdin: Buffer.from('{"session_id":"outside"}') })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("")
      expect(result.stderr.toString()).toBe("")
    }
  })

  test("missing reporters are silent no-ops both outside and inside Multiplexers", () => {
    const f = fixture()
    const installed = f.install()
    for (const paneEnv of [{}, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }]) {
      for (const event of Object.keys(installed.hooks)) {
        const result = Bun.spawnSync(["sh", "-c", commands(installed, event)[0]!], { env: { ...f.env, ...paneEnv } })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString()).toBe("")
        expect(result.stderr.toString()).toBe("")
      }
    }
  })

  test("pane hooks forward lifecycle arguments and stdin through safely quoted reporter paths", () => {
    const f = fixture(false, "bin with 'quotes'")
    const reporter = join(f.bin, "clankerhouse-hook")
    const output = join(f.root, "report.json")
    mkdirSync(f.bin)
    writeFileSync(reporter, '#!/bin/sh\nprintf "%s\\n%s\\n" "$1" "$2" > "$HOOK_RESULT"\ncat >> "$HOOK_RESULT"\n', { mode: 0o755 })
    const installed = f.install()
    const states = { SessionStart: "idle", PermissionRequest: "blocked", PreToolUse: "working", UserPromptSubmit: "working", Stop: "done", SessionEnd: "unknown" }
    for (const paneEnv of [{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }]) {
      for (const [event, state] of Object.entries(states)) {
        const input = '{"session_id":"test-session","hook_event_name":"' + event + '"}'
        const result = Bun.spawnSync(["sh", "-c", commands(installed, event)[0]!], {
          env: { ...f.env, ...paneEnv, HOOK_RESULT: output }, stdin: Buffer.from(input),
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(readFileSync(output, "utf8")).toBe(`claude\n${state}\n${input}`)
      }
    }
  })

  test("upgrades unguarded Clankerhouse hooks instead of appending beside the broken command", () => {
    const f = fixture()
    const old = `bash '${f.root}/removed-prefix/bin/clankerhouse-clanker-state-report' claude working`
    const keep = ["echo custom-tool-hook", `${old} && echo custom`, `bash '${f.bin}/not-clankerhouse-clanker-state-report' claude working`]
    const before = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [command(old), ...keep.map(command)] }] } })
    writeFileSync(f.settings, before)
    const installed = f.install()
    const hooks = commands(installed, "PreToolUse")
    expect(hooks).toHaveLength(keep.length + 1)
    expect(hooks).not.toContain(old)
    for (const custom of keep) expect(hooks).toContain(custom)
    expect(hooks[0]).toContain(`${f.bin}/clankerhouse-hook`)
    expect(readFileSync(`${f.settings}.pre-clankerhouse-migration`, "utf8")).toBe(before)
    expect(statSync(`${f.settings}.pre-clankerhouse-migration`).mode & 0o777).toBe(0o600)
    const first = statSync(f.settings).mtimeMs
    expect(f.install()).toEqual(installed)
    expect(statSync(f.settings).mtimeMs).toBe(first)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repository = resolve(import.meta.dir, "..")
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ch-herdr-delete-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const prefix = join(root, "prefix")
  const env: Record<string, string> = {
    PATH: `${prefix}/bin:/usr/bin:/bin`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    CLANKERHOUSE_HOME: prefix,
    CLANKERHOUSE_LIBEXEC: join(prefix, "libexec"),
  }
  for (const directory of [env.HOME!, env.XDG_CONFIG_HOME!, env.XDG_STATE_HOME!, env.XDG_CACHE_HOME!, env.XDG_RUNTIME_DIR!, join(prefix, "bin"), env.CLANKERHOUSE_LIBEXEC!]) {
    mkdirSync(directory, { recursive: true })
  }
  const config = join(env.XDG_CONFIG_HOME!, "herdr", "config.toml")
  const install = (...args: string[]) => Bun.spawnSync([join(repository, "bin", "clankerhouse-install-herdr"), ...args], {
    env, stdout: "pipe", stderr: "pipe", timeout: 5_000,
  })
  return { root, prefix, env, config, install }
}

function readConfig(path: string) {
  return Bun.TOML.parse(readFileSync(path, "utf8")) as {
    session: { resume_agents_on_restore: boolean }
    keys: { command: Array<Record<string, string>> }
  }
}

type NativeCall = {
  args: string[]
  current: string
  multiplexer: string
  runtime: string
  cwd: string
}

function launcherFixture(healthy = true) {
  const f = fixture()
  for (const relative of ["bin/clankerhouse-herdr", "libexec/clankerhouse-env", "libexec/clankerhouse-mux"]) {
    copyFileSync(join(repository, relative), join(f.prefix, relative))
  }
  const launcher = join(f.prefix, "bin", "clankerhouse-herdr")
  chmodSync(launcher, 0o755)
  const runtime = join(f.env.XDG_RUNTIME_DIR!, `clankerhouse-${process.getuid!()}-popup-test`)
  const nativeLog = join(f.root, "native.jsonl")
  const daemonLog = join(f.root, "unexpected-daemon-start")
  Object.assign(f.env, {
    CLANKERHOUSE_INSTANCE: "popup-test",
    HERDR_SOCKET_PATH: join(f.root, "herdr.sock"),
    FAKE_NATIVE_LOG: nativeLog,
    FAKE_DAEMON_LOG: daemonLog,
  })
  // The only bun visible to launcher children is this trap, never the real daemon.
  const fakeBun = join(f.prefix, "bin", "bun")
  writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_DAEMON_LOG"\nexit 97\n')
  chmodSync(fakeBun, 0o755)
  const native = join(f.prefix, "native-client", "target", "release", "clankerhouse-native")
  mkdirSync(resolve(native, ".."), { recursive: true })
  writeFileSync(native, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_NATIVE_LOG"], "a") as log:
    log.write(json.dumps({
        "args": sys.argv[1:],
        "current": os.environ.get("CLANKERHOUSE_CURRENT_SESSION", ""),
        "multiplexer": os.environ.get("CLANKERHOUSE_MULTIPLEXER", ""),
        "runtime": os.environ.get("CLANKERHOUSE_RUNTIME_DIR", ""),
        "cwd": os.getcwd(),
    }) + "\\n")
if sys.argv[1:2] == ["--server-health"]:
    sys.exit(0 if sys.argv[2:] == ["herdr:" + os.environ["HERDR_SOCKET_PATH"]] else 1)
`)
  chmodSync(native, 0o755)
  const socket = (path: string) => {
    const listener = Bun.listen({ unix: path, socket: { data() {} } })
    cleanups.push(() => listener.stop(true))
  }
  socket(f.env.HERDR_SOCKET_PATH!)
  if (healthy) {
    mkdirSync(runtime, { recursive: true })
    socket(join(runtime, "daemon.sock"))
  }
  const launch = (...args: string[]) => Bun.spawnSync([launcher, ...args], {
    env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5_000,
  })
  const calls = (): NativeCall[] => existsSync(nativeLog)
    ? readFileSync(nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line))
    : []
  return { ...f, launch, calls, runtime, daemonLog }
}

describe("Herdr popup installer", () => {
  test("rerunning the installer leaves the current config byte-for-byte and inode unchanged", () => {
    const f = fixture()
    expect(f.install().exitCode).toBe(0)
    const original = readFileSync(f.config, "utf8")
    const before = statSync(f.config)
    const result = f.install()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain("already current")
    expect(readFileSync(f.config, "utf8")).toBe(original)
    expect(statSync(f.config).ino).toBe(before.ino)
    expect(statSync(f.config).mtimeMs).toBe(before.mtimeMs)
    expect(readConfig(f.config).keys.command.filter(binding => binding.key === "alt+d")).toHaveLength(1)
  })

  test("preserves dotfile symlinks through install, rerun, and uninstall", () => {
    const f = fixture()
    const target = join(f.root, "dotfiles", "herdr.toml")
    mkdirSync(resolve(target, ".."), { recursive: true })
    mkdirSync(resolve(f.config, ".."), { recursive: true })
    writeFileSync(target, '[session]\nresume_agents_on_restore = true\n')
    symlinkSync(target, f.config)
    expect(f.install(f.config).exitCode).toBe(0)
    expect(lstatSync(f.config).isSymbolicLink()).toBe(true)
    expect(readlinkSync(f.config)).toBe(target)
    expect(readConfig(target).keys.command.some(binding => binding.key === "alt+d")).toBe(true)
    const before = statSync(target)
    expect(f.install(f.config).exitCode).toBe(0)
    expect(statSync(target).ino).toBe(before.ino)
    expect(statSync(target).mtimeMs).toBe(before.mtimeMs)
    expect(f.install("--uninstall", f.config).exitCode).toBe(0)
    expect(lstatSync(f.config).isSymbolicLink()).toBe(true)
    expect(readlinkSync(f.config)).toBe(target)
    expect(readFileSync(target, "utf8")).toBe('[session]\nresume_agents_on_restore = false\n')
  })

  test("refreshes the managed launcher without changing custom bindings or unrelated settings", () => {
    const f = fixture()
    const customBinding = { key: "alt+x", type: "popup", command: "custom-command --flag", description: "My custom popup", width: "60%", height: "40%" }
    const customText = `[[keys.command]]\n${Object.entries(customBinding).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`
    mkdirSync(resolve(f.config, ".."), { recursive: true })
    writeFileSync(f.config, `[session]\nresume_agents_on_restore = true\ncustom_setting = "retained"\n\n${customText}`)
    f.env.CLANKERHOUSE_HERDR_LAUNCHER = join(f.prefix, "bin", "old-launcher")
    expect(f.install().exitCode).toBe(0)
    const launcher = join(f.prefix, "bin", "custom-launcher")
    f.env.CLANKERHOUSE_HERDR_LAUNCHER = launcher
    expect(f.install().exitCode).toBe(0)
    const bindings = readConfig(f.config).keys.command
    expect(bindings).toHaveLength(4)
    expect(bindings[0]).toEqual(customBinding)
    expect(bindings.slice(1).map(binding => binding.command)).toEqual([launcher, `${launcher} --repo`, `${launcher} --delete`])
    expect(readFileSync(f.config, "utf8")).toContain('custom_setting = "retained"')
    expect(f.install("--uninstall").exitCode).toBe(0)
    expect(readConfig(f.config).keys.command).toEqual([customBinding])
    expect(readFileSync(f.config, "utf8")).toContain(customText)
    expect(readFileSync(f.config, "utf8")).not.toContain("clankerhouse herdr keybindings (managed)")
  })

  test("installs Alt+D as a native confirmation popup alongside Alt+K and Alt+B", () => {
    const f = fixture()
    const result = f.install()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(existsSync(f.config)).toBe(true)
    const config = readConfig(f.config)
    expect(config.session.resume_agents_on_restore).toBe(false)
    expect(config.keys.command.map(({ key, type, command, width, height }) => ({ key, type, command, width, height }))).toEqual([
      { key: "alt+k", type: "popup", command: join(repository, "bin", "clankerhouse-herdr"), width: "90%", height: "80%" },
      { key: "alt+b", type: "popup", command: `${join(repository, "bin", "clankerhouse-herdr")} --repo`, width: "90%", height: "80%" },
      { key: "alt+d", type: "popup", command: `${join(repository, "bin", "clankerhouse-herdr")} --delete`, width: "90%", height: "80%" },
    ])
  })

  test("keeps a key edited in the managed block across reruns and launcher changes", () => {
    const f = fixture()
    expect(f.install().exitCode).toBe(0)
    writeFileSync(f.config, readFileSync(f.config, "utf8").replace('key = "alt+b"', 'key = "prefix+b"'))
    const launcher = join(f.prefix, "bin", "moved-launcher")
    f.env.CLANKERHOUSE_HERDR_LAUNCHER = launcher
    expect(f.install().exitCode).toBe(0)
    expect(readConfig(f.config).keys.command.map(({ key, command }) => ({ key, command }))).toEqual([
      { key: "alt+k", command: launcher },
      { key: "prefix+b", command: `${launcher} --repo` },
      { key: "alt+d", command: `${launcher} --delete` },
    ])
  })

  test("environment keys override both the defaults and the installed keys", () => {
    const f = fixture()
    f.env.CLANKERHOUSE_HERDR_DELETE_KEY = "prefix+shift+d"
    expect(f.install().exitCode).toBe(0)
    expect(readConfig(f.config).keys.command.map(binding => binding.key)).toEqual(["alt+k", "alt+b", "prefix+shift+d"])
    Object.assign(f.env, { CLANKERHOUSE_HERDR_KEY: "alt+u", CLANKERHOUSE_HERDR_SPAWN_KEY: "alt+n", CLANKERHOUSE_HERDR_DELETE_KEY: "alt+e" })
    expect(f.install().exitCode).toBe(0)
    expect(readConfig(f.config).keys.command.map(binding => binding.key)).toEqual(["alt+u", "alt+n", "alt+e"])
    for (const variable of ["CLANKERHOUSE_HERDR_KEY", "CLANKERHOUSE_HERDR_SPAWN_KEY", "CLANKERHOUSE_HERDR_DELETE_KEY"]) delete f.env[variable]
    expect(f.install().stdout.toString()).toContain("already current")
  })
})

describe("Herdr delete launcher", () => {
  test.each([undefined, ""])("rejects missing popup workspace (%j) before daemon startup", (workspace) => {
    const f = launcherFixture(false)
    Object.assign(f.env, {
      HERDR_PANE_ID: "not-a-workspace-fallback:pane",
      CLANKERHOUSE_CURRENT_SESSION: "not-a-session-fallback",
    })
    if (workspace !== undefined) f.env.HERDR_ACTIVE_WORKSPACE_ID = workspace
    const result = f.launch("--delete")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("HERDR_ACTIVE_WORKSPACE_ID")
    expect(f.calls()).toEqual([])
    expect(existsSync(f.daemonLog)).toBe(false)
    expect(existsSync(f.runtime)).toBe(false)
  })

  test("pins the exact invoking workspace over inherited context and opens native confirmation", () => {
    const f = launcherFixture()
    Object.assign(f.env, {
      HERDR_ACTIVE_WORKSPACE_ID: "workspace:exact-17",
      HERDR_PANE_ID: "unrelated-workspace:pane",
      CLANKERHOUSE_CURRENT_SESSION: "stale-inherited-session",
    })
    const result = f.launch("--delete", "--dump-tree")
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(f.calls()).toEqual([
      { args: ["--server-health", `herdr:${f.env.HERDR_SOCKET_PATH}`], current: "workspace:exact-17", multiplexer: "herdr", runtime: f.runtime, cwd: f.prefix },
      { args: ["--delete-current", "--dump-tree"], current: "workspace:exact-17", multiplexer: "herdr", runtime: f.runtime, cwd: f.prefix },
    ])
    expect(existsSync(f.daemonLog)).toBe(false)
  })
})

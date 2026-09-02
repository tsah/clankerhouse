import { describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const helper = resolve(import.meta.dir, "../../libexec/clankerhouse-mux")
const launcherEnvironment = resolve(import.meta.dir, "../../libexec/clankerhouse-env")
const launcherPath = resolve(import.meta.dir, "../../bin/clankers")
const interactiveLauncher = resolve(import.meta.dir, "../../bin/clankerhouse")
const nativeLauncher = resolve(import.meta.dir, "../../bin/clankerhouse-native")
const pickerLauncher = resolve(import.meta.dir, "../../bin/clankerhouse-picker")
const doctor = resolve(import.meta.dir, "../../bin/clankerhouse-doctor")
const tmuxOnlyCommands = [
  ["clankerhouse-popup", []],
  ["clankerhouse-delete", ["%1", "$1", "client"]],
  ["clankerhouse-stop-current-session", []],
  ["clankerhouse-stop-popup", ["$1", "session"]],
  ["clankerhouse-tui-active", ["%1"]],
] as const

const inspect = (env: Record<string, string>) => {
  const result = Bun.spawnSync(["bash", "-c", `source "$1"; printf '%s|%s|%s' "$(ch_mux_kind)" "$(ch_runtime_dir)" "$(ch_state_dir)"`, "bash", helper], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", XDG_RUNTIME_DIR: "/run/test", XDG_STATE_HOME: "/state", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout.toString()
}

const inspectLauncher = (env: Record<string, string>) => {
  const result = Bun.spawnSync(["bash", "-c", `source "$1"; printf '%s' "\${CLANKERHOUSE_MULTIPLEXER:-}"`, launcherPath, launcherEnvironment], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout.toString()
}

describe("shell multiplexer environment", () => {
  test("a managed Herdr pane uses Herdr operations and instance-scoped paths", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" })).toBe(`herdr|/run/test/clankerhouse-${uid}-herdr|/state/clankerhouse-herdr`)
  })

  test("shell instance names are normalized as one safe path component", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_INSTANCE: " staging " })).toBe(`herdr|/run/test/clankerhouse-${uid}-staging|/state/clankerhouse-staging`)
  })

  test("public launchers normalize inferred Herdr for their child processes", () => {
    expect(inspectLauncher({ HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" })).toBe("herdr")
  })

  test("the public clankers executable resolves an implicit managed Herdr pane", () => {
    const result = Bun.spawnSync([launcherPath, "mux", "kind"], {
      env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_MULTIPLEXER: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString().trim()).toBe("herdr")
  })

  test("shell Adapter helpers propagate inferred Herdr to clankers subprocesses", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-shell-mux-"))
    try {
      const fake = join(root, "clankers")
      writeFileSync(fake, "#!/bin/sh\nprintf '%s' \"${CLANKERHOUSE_MULTIPLEXER:-}\"\n")
      chmodSync(fake, 0o755)
      const result = Bun.spawnSync(["bash", "-c", `source "$1"; ch_mux_pane_read harness`, "bash", helper], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_CLANKERS: fake },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("herdr")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the generic interactive launcher dispatches a managed Herdr pane to its native launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-launcher-"))
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "libexec"))
      copyFileSync(interactiveLauncher, join(root, "bin", "clankerhouse"))
      copyFileSync(launcherEnvironment, join(root, "libexec", "clankerhouse-env"))
      for (const [name, output] of [["clankerhouse-picker", "tmux"], ["clankerhouse-herdr", "herdr"]] as const) {
        const path = join(root, "bin", name)
        writeFileSync(path, `#!/bin/sh\nprintf '%s' '${output}'\n`)
        chmodSync(path, 0o755)
      }
      chmodSync(join(root, "bin", "clankerhouse"), 0o755)
      const result = Bun.spawnSync([join(root, "bin", "clankerhouse")], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("herdr")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the generic native launcher dispatches a managed Herdr pane before probing tmux state", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-native-launcher-"))
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "libexec"))
      copyFileSync(nativeLauncher, join(root, "bin", "clankerhouse-native"))
      copyFileSync(launcherEnvironment, join(root, "libexec", "clankerhouse-env"))
      copyFileSync(helper, join(root, "libexec", "clankerhouse-mux"))
      writeFileSync(join(root, "bin", "clankerhouse-herdr"), "#!/bin/sh\nprintf herdr\n")
      chmodSync(join(root, "bin", "clankerhouse-native"), 0o755)
      chmodSync(join(root, "bin", "clankerhouse-herdr"), 0o755)
      const result = Bun.spawnSync([join(root, "bin", "clankerhouse-native"), "--dump-tree"], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("herdr")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the compatibility daemon-supervisor entry point dispatches a managed Herdr pane", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-picker-launcher-"))
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "libexec"))
      copyFileSync(pickerLauncher, join(root, "bin", "clankerhouse-picker"))
      copyFileSync(launcherEnvironment, join(root, "libexec", "clankerhouse-env"))
      copyFileSync(helper, join(root, "libexec", "clankerhouse-mux"))
      writeFileSync(join(root, "bin", "clankerhouse-herdr"), "#!/bin/sh\nprintf herdr\n")
      chmodSync(join(root, "bin", "clankerhouse-picker"), 0o755)
      chmodSync(join(root, "bin", "clankerhouse-herdr"), 0o755)
      const result = Bun.spawnSync([join(root, "bin", "clankerhouse-picker"), "--dump-tree"], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", XDG_RUNTIME_DIR: root, HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("herdr")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a tmux-only command fails closed in Herdr without invoking tmux", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-tmux-only-"))
    try {
      const log = join(root, "tmux.log")
      const fakeTmux = join(root, "tmux")
      writeFileSync(fakeTmux, `#!/bin/sh\nprintf called >> "$TMUX_LOG"\nexit 99\n`)
      chmodSync(fakeTmux, 0o755)
      for (const [name, args] of tmuxOnlyCommands) {
        const command = resolve(import.meta.dir, "../../bin", name)
        const result = Bun.spawnSync([command, ...args], {
          env: { PATH: `${root}:${process.env.PATH || "/usr/bin:/bin"}`, HOME: "/home/test", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", TMUX_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(result.exitCode, name).toBe(2)
        expect(result.stderr.toString(), name).toContain("tmux-only")
      }
      expect(existsSync(log)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("doctor checks Herdr without probing an inherited outer tmux runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-doctor-herdr-"))
    try {
      const log = join(root, "tmux.log")
      const fakeTmux = join(root, "tmux")
      writeFileSync(fakeTmux, `#!/bin/sh\nprintf called >> "$TMUX_LOG"\nexit 99\n`)
      chmodSync(fakeTmux, 0o755)
      const result = Bun.spawnSync([doctor], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH || "/usr/bin:/bin"}`, HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_MULTIPLEXER: "", TMUX: "/outer/tmux,1,1", TMUX_LOG: log },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.stdout.toString()).toContain("herdr")
      expect(existsSync(log)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an explicit tmux selection overrides Herdr markers", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_MULTIPLEXER: "tmux" })).toBe(`tmux|/run/test/clankerhouse-${uid}|/state/clankerhouse`)
  })
})

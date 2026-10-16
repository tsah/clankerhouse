import { describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const helper = resolve(import.meta.dir, "../../libexec/clankerhouse-mux")
const launcherEnvironment = resolve(import.meta.dir, "../../libexec/clankerhouse-env")
const interactiveLauncher = resolve(import.meta.dir, "../../bin/clankerhouse")
const nativeLauncher = resolve(import.meta.dir, "../../bin/clankerhouse-native")
const doctor = resolve(import.meta.dir, "../../bin/clankerhouse-doctor")

const inspect = (env: Record<string, string>) => {
  const result = Bun.spawnSync(["bash", "-c", `source "$1"; printf '%s|%s|%s' "$(ch_mux_pane)" "$(ch_runtime_dir)" "$(ch_state_dir)"`, "bash", helper], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", XDG_RUNTIME_DIR: "/run/test", XDG_STATE_HOME: "/state", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout.toString()
}

describe("shell multiplexer environment", () => {
  test("shell helpers address the Herdr pane and use the Herdr instance paths by default", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ HERDR_PANE_ID: "w2:p1" })).toBe(`w2:p1|/run/test/clankerhouse-${uid}-herdr|/state/clankerhouse-herdr`)
  })

  test("shell instance names are normalized as one safe path component", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_INSTANCE: " staging " })).toBe(`w2:p1|/run/test/clankerhouse-${uid}-staging|/state/clankerhouse-staging`)
    expect(inspect({ CLANKERHOUSE_INSTANCE: "default" })).toBe(`|/run/test/clankerhouse-${uid}|/state/clankerhouse`)
  })

  test("the public clankers executable reports the Herdr adapter", () => {
    const result = Bun.spawnSync([resolve(import.meta.dir, "../../bin/clankers"), "mux", "kind"], {
      env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString().trim()).toBe("herdr")
  })

  test("shell Adapter helpers route pane claims through clankers mux", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-shell-mux-"))
    try {
      const fake = join(root, "clankers")
      const log = join(root, "clankers.log")
      writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n[ "$2" = read-claim ] && printf claimed\nexit 0\n`)
      chmodSync(fake, 0o755)
      const result = Bun.spawnSync(["bash", "-c", `source "$1"; ch_mux_pane_read harness; ch_mux_pane_claim clankerId c1; ch_mux_pane_unset clankerId; ch_mux_kill session w2`, "bash", helper], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", HERDR_PANE_ID: "w2:p1", CLANKERHOUSE_CLANKERS: fake },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("claimed")
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "mux read-claim --pane w2:p1 harness",
        "mux claim --pane w2:p1 clankerId c1",
        "mux claim --pane w2:p1 clankerId --unset",
        "mux kill --session w2",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pane helpers are no-ops outside a Herdr pane", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-shell-mux-"))
    try {
      const fake = join(root, "clankers")
      const log = join(root, "clankers.log")
      writeFileSync(fake, `#!/bin/sh\nprintf called >> "${log}"\n`)
      chmodSync(fake, 0o755)
      const result = Bun.spawnSync(["bash", "-c", `source "$1"; ch_mux_pane_claim clankerId c1; ch_mux_pane_read harness`, "bash", helper], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", CLANKERHOUSE_CLANKERS: fake },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(() => readFileSync(log)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [name, launcher] of [["clankerhouse", interactiveLauncher], ["clankerhouse-native", nativeLauncher]] as const) {
    test(`${name} dispatches to the Herdr launcher with its arguments`, () => {
      const root = mkdtempSync(join(tmpdir(), "clankerhouse-launcher-"))
      try {
        mkdirSync(join(root, "bin")); mkdirSync(join(root, "libexec"))
        copyFileSync(launcher, join(root, "bin", name))
        copyFileSync(launcherEnvironment, join(root, "libexec", "clankerhouse-env"))
        writeFileSync(join(root, "bin", "clankerhouse-herdr"), `#!/bin/sh\nprintf 'herdr %s' "$*"\n`)
        chmodSync(join(root, "bin", name), 0o755)
        chmodSync(join(root, "bin", "clankerhouse-herdr"), 0o755)
        const result = Bun.spawnSync([join(root, "bin", name), "--dump-tree"], {
          env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test" },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString()).toBe("herdr --dump-tree")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  test("doctor checks Herdr", () => {
    const result = Bun.spawnSync([doctor], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" })
    expect(result.stdout.toString()).toContain("herdr")
  })
})

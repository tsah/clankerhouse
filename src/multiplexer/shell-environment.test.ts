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
  test("shell helpers address the Rex block and use the Rex instance paths by default", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ REX_BLOCK: "block:p1" })).toBe(`block:p1|/run/test/clankerhouse-${uid}-rex|/state/clankerhouse-rex`)
  })

  test("shell instance names are normalized as one safe path component", () => {
    const uid = process.getuid?.() ?? 0
    expect(inspect({ REX_BLOCK: "block:p1", CLANKERHOUSE_INSTANCE: " staging " })).toBe(`block:p1|/run/test/clankerhouse-${uid}-staging|/state/clankerhouse-staging`)
    expect(inspect({ CLANKERHOUSE_INSTANCE: "default" })).toBe(`|/run/test/clankerhouse-${uid}|/state/clankerhouse`)
  })

  test("the public clankers executable reports the Rex adapter", () => {
    const result = Bun.spawnSync([resolve(import.meta.dir, "../../bin/clankers"), "mux", "kind"], {
      env: { ...process.env, REX_BLOCK: "block:p1", REX_BIN: "/nonexistent/rex" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString().trim()).toBe("rex")
  })

  test("shell Adapter helpers route pane claims through clankers mux", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-shell-mux-"))
    try {
      const fake = join(root, "clankers")
      const log = join(root, "clankers.log")
      writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n[ "$2" = read-claim ] && printf claimed\nexit 0\n`)
      chmodSync(fake, 0o755)
      const result = Bun.spawnSync(["bash", "-c", `source "$1"; ch_mux_pane_read harness; ch_mux_pane_claim clankerId c1; ch_mux_pane_unset clankerId; ch_mux_kill session session:s2`, "bash", helper], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test", REX_BLOCK: "block:p1", CLANKERHOUSE_CLANKERS: fake },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toBe("claimed")
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "mux read-claim --pane block:p1 harness",
        "mux claim --pane block:p1 clankerId c1",
        "mux claim --pane block:p1 clankerId --unset",
        "mux kill --session session:s2",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pane helpers are no-ops outside a Rex block", () => {
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
    test(`${name} dispatches to the Rex launcher with its arguments`, () => {
      const root = mkdtempSync(join(tmpdir(), "clankerhouse-launcher-"))
      try {
        mkdirSync(join(root, "bin")); mkdirSync(join(root, "libexec"))
        copyFileSync(launcher, join(root, "bin", name))
        copyFileSync(launcherEnvironment, join(root, "libexec", "clankerhouse-env"))
        writeFileSync(join(root, "bin", "clankerhouse-rex"), `#!/bin/sh\nprintf 'rex %s' "$*"\n`)
        chmodSync(join(root, "bin", name), 0o755)
        chmodSync(join(root, "bin", "clankerhouse-rex"), 0o755)
        const result = Bun.spawnSync([join(root, "bin", name), "--dump-tree"], {
          env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/home/test" },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString()).toBe("rex --dump-tree")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  test("doctor checks Rex", () => {
    const missing = Bun.spawnSync([doctor], { env: { ...process.env, REX_BIN: "/nonexistent/rex" }, stdout: "pipe", stderr: "pipe" })
    expect(missing.stdout.toString()).toContain("broken  /nonexistent/rex is not installed")
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-doctor-"))
    try {
      const rex = join(root, "rex")
      writeFileSync(rex, "#!/bin/sh\nexit 0\n")
      chmodSync(rex, 0o755)
      const found = Bun.spawnSync([doctor], { env: { ...process.env, REX_BIN: rex }, stdout: "pipe", stderr: "pipe" })
      expect(found.stdout.toString()).toContain(`ok      ${rex}: ${rex}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

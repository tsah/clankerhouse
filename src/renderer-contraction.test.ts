import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("renderer contraction", () => {
  test("ships no long-running daemon or interactive Bun renderer, only a runner for timed work", () => {
    for (const gone of ["src/daemon.ts", "src/main.tsx", "src/picker.ts", "src/presentation.ts", "src/transport/server.ts", "src/transport/client.ts"]) expect(existsSync(resolve(root, gone))).toBe(false)
    const runner = read("src/runner.ts")
    expect(runner).not.toContain("@opentui")
    expect(runner).not.toContain("listen(")
    expect(runner).toContain("fireRoutinesThroughSend")
  })

  test("has no renderer dependencies or JSX compiler configuration", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> }
    expect(pkg.dependencies["@opentui/core"]).toBeUndefined()
    expect(pkg.dependencies["@opentui/solid"]).toBeUndefined()
    expect(pkg.dependencies["solid-js"]).toBeUndefined()
    expect(pkg.scripts.start).toBe("bin/clankerhouse")
    expect(pkg.scripts.runner).toContain("runner")

    const tsconfig = JSON.parse(read("tsconfig.json")) as { compilerOptions: Record<string, unknown> }
    expect(tsconfig.compilerOptions.jsx).toBeUndefined()
    expect(tsconfig.compilerOptions.jsxImportSource).toBeUndefined()
    expect(existsSync(resolve(root, "bunfig.toml"))).toBe(false)
  })

  test("routes public interactive launchers to the native client", () => {
    expect(read("bin/clankerhouse")).toContain("clankerhouse-rex")
    expect(read("bin/clankerhouse-native")).toContain("clankerhouse-rex")

    const rex = read("bin/clankerhouse-rex")
    expect(rex).toContain("cli.ts runner")
    expect(rex).toContain("clankerhouse-native")
    expect(rex).not.toContain("daemon.ts")
  })
})

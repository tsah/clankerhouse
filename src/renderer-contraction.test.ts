import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("renderer contraction", () => {
  test("ships a Bun daemon without the obsolete interactive renderer", () => {
    expect(existsSync(resolve(root, "src/daemon.ts"))).toBe(true)
    expect(existsSync(resolve(root, "src/main.tsx"))).toBe(false)
    expect(existsSync(resolve(root, "src/picker.ts"))).toBe(false)
    expect(existsSync(resolve(root, "src/presentation.ts"))).toBe(false)

    const daemon = read("src/daemon.ts")
    expect(daemon).not.toContain("@opentui")
    expect(daemon).not.toContain("solid-js")
    expect(daemon).not.toContain("function App(")
    expect(daemon).toContain("--server")
    expect(daemon).toContain("--dump-state")
    expect(daemon).toContain("--dump-cache")
    expect(daemon).toContain("Rust native client")
  })

  test("has no renderer dependencies or JSX compiler configuration", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> }
    expect(pkg.dependencies["@opentui/core"]).toBeUndefined()
    expect(pkg.dependencies["@opentui/solid"]).toBeUndefined()
    expect(pkg.dependencies["solid-js"]).toBeUndefined()
    expect(pkg.scripts.start).toBe("bin/clankerhouse")
    expect(pkg.scripts.server).toContain("src/daemon.ts")

    const tsconfig = JSON.parse(read("tsconfig.json")) as { compilerOptions: Record<string, unknown> }
    expect(tsconfig.compilerOptions.jsx).toBeUndefined()
    expect(tsconfig.compilerOptions.jsxImportSource).toBeUndefined()
    expect(existsSync(resolve(root, "bunfig.toml"))).toBe(false)
  })

  test("routes public interactive launchers to the native client", () => {
    const launcher = read("bin/clankerhouse")
    expect(launcher).toContain("clankerhouse-native")
    expect(launcher).not.toContain("clankerhouse-picker")

    const picker = read("bin/clankerhouse-picker")
    expect(picker).toContain("src/daemon.ts --server")
    expect(picker).toContain("clankerhouse-native")
    expect(picker).not.toContain("bun src/main.tsx")
  })
})

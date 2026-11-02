import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const keys = (JSON.parse(readFileSync("contrib/herdr-app/keys.clankerhouse.json", "utf8")) as Record<string, Record<string, string>>)["layout:clankerhouse"]!
const installerKeys = readFileSync("bin/clankerhouse-install-herdr", "utf8")

describe("Herdr app config", () => {
  test("mirrors the Herdr TUI's Alt keys, popups included", () => {
    for (const [key] of installerKeys.matchAll(/"alt\+[a-z]"/g)) expect(keys[key.slice(1, -1).replace("+", "-")]).toStartWith("clankerhouse.")
    expect(keys).toMatchObject({ "alt-t": "tab.new", "alt-w": "pane.close", "alt-enter": "pane.split:down", "alt-shift-enter": "pane.split:right", "alt-left": "tab.prev", "alt-right": "tab.next", "alt-up": "space.prev", "alt-down": "space.next", "alt-o": "mod.open:picker", "ctrl-alt-left": "pane.go:left" })
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(keys[`alt-${digit}`]).toBe(`tab.select:${digit}`)
  })

  test("hands back the app's default Alt keys the TUI leaves to programs", () => {
    for (const key of ["alt-h", "alt-j", "alt-l", "alt-shift-h", "alt-shift-j", "alt-shift-k", "alt-shift-l", "alt-[", "alt-]"]) expect(keys[key]).toBe("terminal")
  })

  test("the mod handles every clankerhouse.* key", () => {
    const mod = readFileSync("contrib/herdr-app/mods/clankerhouse/main.js", "utf8")
    for (const action of Object.values(keys).filter((value) => value.startsWith("clankerhouse."))) {
      const command = action.slice("clankerhouse.".length)
      expect(mod.includes(`command === "${command}"`) || new RegExp(`\\b${command}: \\[`).test(mod)).toBe(true)
    }
  })

  test("the installer sets the machine and keeps the person's other keys, and running it twice changes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "ch-herdr-app-"))
    const mine = { global: { "ctrl-shift-t": "tab.new" }, terminal: { "ctrl-v": "terminal.paste_image" } }
    writeFileSync(join(home, "keys.json"), JSON.stringify(mine))
    const install = () => Bun.spawnSync(["python3", "-I", "contrib/herdr-app/install", "--machine", "box", "--launcher", "/opt/clankerhouse-hc"], { env: { ...Bun.env, HERDR_APP_HOME: home } })
    expect(install().exitCode).toBe(0)
    const once = readFileSync(join(home, "keys.json"), "utf8")
    expect(install().exitCode).toBe(0)
    expect(readFileSync(join(home, "keys.json"), "utf8")).toBe(once)
    expect(JSON.parse(once)).toMatchObject({ ...mine, "layout:clankerhouse": keys })
    expect(JSON.parse(readFileSync(join(home, "keys.json.pre-clankerhouse"), "utf8"))).toEqual(mine)
    expect(JSON.parse(readFileSync(join(home, "layouts/clankerhouse.json"), "utf8")).children[0].content.props).toEqual({ machine: "box", launcher: "/opt/clankerhouse-hc" })
  })

  test("the installer refuses a home the app has not started in", () => {
    const home = mkdtempSync(join(tmpdir(), "ch-herdr-app-"))
    const result = Bun.spawnSync(["python3", "-I", "contrib/herdr-app/install"], { env: { ...Bun.env, HERDR_APP_HOME: home } })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("start the Herdr app once")
  })
})

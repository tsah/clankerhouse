import { beforeEach, describe, expect, mock, test } from "bun:test"

// The Herdr app's runtime, faked: the mods under contrib/herdr-app/mods run against it as they do in the app.
type Terminal = { address: string; state?: string; labels?: Record<string, string> }
type Space = { id: string; name: string; machine: string | null; active?: boolean; tabs: unknown[] }
type Call = { command: string; args: string[]; on?: string | null; cwd?: string }

const app = {
  focused: null as null | { terminal?: string; cwd?: string },
  panes: [] as { terminal: string; cwd?: string; focused?: boolean; branch?: string }[],
  terminals: [] as Terminal[],
  spaces: [] as Space[],
  props: {} as Record<string, unknown>,
  shared: new Map<string, unknown>(),
  calls: [] as Call[],
  hcCalls: [] as string[][],
  runs: [] as [string, unknown][],
  overlays: [] as Record<string, unknown>[],
  notes: [] as Record<string, unknown>[],
  commands: [] as ((command: string) => void)[],
  machineList: { machines: [] as unknown[] } as unknown,
  machinesKnown: [] as unknown[],
  rowFor: (on: string | null | undefined, _cwd: string) => ({ name: null, needsMe: on === "puffin" ? 2 : 5, open: on === "puffin" ? 7 : 9 }),
}

const chain = (): unknown => new Proxy(function () {}, { get: () => (..._args: unknown[]) => chain(), apply: () => chain() })
mock.module("gpui-kit", () => ({ View: class {}, div: chain, svg: chain }))
mock.module("gpui-base", () => ({ h_flex: chain, v_flex: chain, Input: { new: chain }, InputState: { new: () => ({ on() {}, focus() {}, value: () => "" }) } }))
mock.module("herdr", () => ({
  focused: () => app.focused,
  panes: () => app.panes,
  terminals: () => app.terminals,
  spaces: () => app.spaces,
  props: () => app.props,
  theme: () => ({}),
  window: () => ({ platform: "linux" }),
  shared: (key: string) => app.shared.get(key),
  setShared: (key: string, value: unknown) => { app.shared.set(key, value); return null },
  machines: () => app.machinesKnown,
  notify: (note: Record<string, unknown>) => { app.notes.push(note) },
  run: (command: string, args: unknown) => { app.runs.push([command, args]); return null },
  openOverlay: (spec: Record<string, unknown>) => { app.overlays.push(spec); return `o${app.overlays.length}` },
  closeOverlay: () => null,
  nextCommand: () => new Promise<string>((resolve) => app.commands.push(resolve)),
  exec: async (command: string, args: string[], options: { on?: string | null; cwd?: string } = {}) => {
    app.calls.push({ command, args, on: options.on, cwd: options.cwd })
    if (args[0] === "--session-row") return { code: 0, stdout: JSON.stringify(app.rowFor(options.on, args[1]!)), stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  },
  hc: async (args: string[]) => {
    app.hcCalls.push(args)
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify(app.machineList), stderr: "" }
    if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ terminal: { address: `${args[2]}/t99` } }), stderr: "" }
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ state: "live" }), stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  },
}))

const { default: Clankerhouse, machineOf, CURRENT_MACHINE } = await import("../contrib/herdr-app/mods/clankerhouse/main.js")
const { default: Machines, machineRows } = await import("../contrib/herdr-app/mods/clankerhouse-machines/main.js")

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const cx = () => ({
  timer: { every() {}, after() {} },
  spawn(task: (cx: unknown) => Promise<unknown>) { void task(this) },
  notify() {},
  focus_handle: () => ({}),
})
const command = async (name: string) => { app.commands.shift()!(name); await settle() }
const focus = (terminal: string | null, cwd = "/home/tsah/repo") => {
  app.focused = terminal ? { terminal, cwd } : null
  app.panes = terminal ? [{ terminal, cwd, focused: true }] : []
}
const start = () => {
  const mod = new Clankerhouse()
  mod.init(app.props, cx())
  return mod
}
const rendered = (mod: { render: (cx: unknown) => unknown }) => { mod.render(cx()); return settle() }
const onMachines = (subcommand: string) => app.calls.filter((call) => call.args[0] === subcommand).map((call) => call.on)
const popupRuns = () => app.hcCalls.filter((args) => args[0] === "run").map((args) => args[2])

beforeEach(() => {
  Object.assign(app, { focused: null, panes: [], terminals: [], spaces: [], props: { machine: "puffin", launcher: "clankerhouse-hc" }, calls: [], hcCalls: [], runs: [], overlays: [], notes: [], commands: [], machinesKnown: [] })
  app.shared = new Map()
  app.machineList = { machines: [] }
})

describe("the Herdr app follows the focused machine", () => {
  test("a terminal address names its machine; a local one names none", () => {
    expect(machineOf("puffin/t7")).toBe("puffin")
    expect(machineOf("t7")).toBeNull()
    expect(machineOf(undefined)).toBeNull()
  })

  test("focus on host A sends A's keys, focus report and counts to A", async () => {
    focus("puffin/t7")
    const mod = start()
    await rendered(mod)
    expect(app.calls).toContainEqual({ command: "clankerhouse-hc", args: ["--report-focus", "t7"], on: "puffin", cwd: undefined })
    expect(onMachines("--session-row")).toEqual(["puffin"])
    expect(mod.counts!.get("puffin")).toEqual({ needsMe: 2, open: 7 })
    await command("jump")
    expect(popupRuns()).toEqual(["puffin"])
    expect(app.hcCalls.find((args) => args[0] === "run")).toContain("t7")
  })

  test("switching focus to host B retargets every action and shows only B's counts", async () => {
    focus("puffin/t7")
    const mod = start()
    await rendered(mod)
    focus("heron/t3", "/home/tsah/other")
    expect(mod.machine()).toBe("heron")
    // Before B answers, A's counts are not B's.
    expect(mod.counts!.get("heron")).toBeUndefined()
    await rendered(mod)
    expect(app.calls).toContainEqual({ command: "clankerhouse-hc", args: ["--report-focus", "t3"], on: "heron", cwd: undefined })
    expect(onMachines("--session-row")).toEqual(["puffin", "heron"])
    expect(mod.counts!.get("heron")).toEqual({ needsMe: 5, open: 9 })
    await command("needs_me")
    expect(popupRuns()).toEqual(["heron"])
    await command("open_pr")
    expect(app.calls.find((call) => call.command === "gh")).toMatchObject({ on: "heron", cwd: "/home/tsah/other" })
  })

  test("leftover popups are cleared on the current machine only", async () => {
    app.terminals = [{ address: "puffin/t50", labels: { ch_popup: "1" } }, { address: "heron/t51", labels: { ch_popup: "1" } }]
    focus("heron/t3")
    const mod = start()
    await command("repo")
    expect(app.hcCalls.filter((args) => args[0] === "kill")).toEqual([["kill", "heron/t51"]])
    expect(popupRuns()).toEqual(["heron"])
    void mod
  })

  test("with no focus it stays on the last machine, else props.machine", async () => {
    const mod = start()
    expect(mod.machine()).toBe("puffin")
    await rendered(mod)
    // No session's folder: the counts still come, for "/".
    expect(app.calls.find((call) => call.args[0] === "--session-row")).toMatchObject({ on: "puffin", args: ["--session-row", "/"] })
    focus("heron/t3")
    expect(mod.machine()).toBe("heron")
    focus(null)
    expect(mod.machine()).toBe("heron")
    focus("t4")
    expect(mod.machine()).toBe("heron")
    await command("scratch")
    expect(popupRuns()).toEqual(["heron"])
    // A second copy (a reload) reads the same shared machine.
    expect(start().machine()).toBe("heron")
  })

  test("space names sync on every machine", () => {
    app.terminals = [
      { address: "puffin/t1", labels: { "herdr.space": "s1", ch_session_name: "Alpha" } },
      { address: "heron/t2", labels: { "herdr.space": "s2", ch_session_name: "Beta" } },
    ]
    app.spaces = [{ id: "puffin/s1", name: "repo", machine: "puffin", tabs: [] }, { id: "heron/s2", name: "other", machine: "heron", tabs: [] }]
    start().syncSpaceNames()
    expect(app.runs).toEqual([["space.rename", { id: "puffin/s1", name: "Alpha" }], ["space.rename", { id: "heron/s2", name: "Beta" }]])
  })
})

describe("Alt-M switches the machine from a list", () => {
  const list = { machines: [{ name: "puffin", state: "connected" }, { name: "heron", state: "connected" }, { name: "egret", state: "unreachable", why: "ssh: timed out" }, { name: "tmp", state: "connected", temporary: true }] }

  test("the list has every added machine, unreachable ones marked, and never crashes on a bad answer", () => {
    expect(machineRows(list.machines, [], "puffin")).toEqual([
      { name: "puffin", state: "connected", why: null },
      { name: "heron", state: "connected", why: null },
      { name: "egret", state: "unreachable", why: "ssh: timed out" },
    ])
    expect(machineRows(undefined, [{ name: "kite", layout: "unavailable" }], "puffin").map((row) => [row.name, row.state])).toEqual([["kite", "unreachable"], ["puffin", "not added"]])
  })

  test("Alt-M opens the list over the current machine", async () => {
    focus("puffin/t7")
    start()
    await command("machines")
    expect(app.overlays.at(-1)).toMatchObject({ mod: "clankerhouse-machines", props: { current: "puffin", over: "puffin/t7", fallback: "puffin" } })
  })

  test("choosing a machine with no pane there makes it current for Alt-K, counts and the rest, until focus moves", async () => {
    app.machineList = list
    focus("puffin/t7")
    const mod = start()
    await command("machines")
    app.props = app.overlays.at(-1)!.props as Record<string, unknown>
    const picker = new Machines()
    picker.init(app.props, cx())
    await settle()
    expect(picker.shown().map((row: { name: string }) => row.name)).toEqual(["puffin", "heron", "egret"])
    picker.choose(picker.shown()[2])
    expect(app.notes.at(-1)).toMatchObject({ title: "egret is unreachable", level: "error" })
    expect(app.shared.get(CURRENT_MACHINE)).toEqual({ machine: "puffin", over: "puffin/t7" })
    picker.choose(picker.shown()[1])
    app.props = { machine: "puffin", launcher: "clankerhouse-hc" }
    expect(mod.machine()).toBe("heron")
    await rendered(mod)
    // Focus is still on puffin's t7: not reported to heron, and heron's counts come for "/".
    expect(app.calls.filter((call) => call.args[0] === "--report-focus" && call.on === "heron")).toEqual([])
    expect(app.calls.find((call) => call.on === "heron" && call.args[0] === "--session-row")?.args).toEqual(["--session-row", "/"])
    await command("jump")
    expect(popupRuns()).toEqual(["heron"])
    expect(app.hcCalls.find((args) => args[0] === "run")).not.toContain("--focus")
    // The popup takes focus and closes; the pick stays.
    app.terminals = [{ address: "heron/t99", state: "live", labels: { ch_popup: "1" } }]
    focus("heron/t99")
    expect(mod.machine()).toBe("heron")
    focus("puffin/t7")
    expect(mod.machine()).toBe("heron")
    focus("puffin/t8")
    expect(mod.machine()).toBe("puffin")
  })

  test("choosing a machine with a space shows that space", async () => {
    app.machineList = list
    app.spaces = [{ id: "puffin/s1", name: "a", machine: "puffin", active: true, tabs: [] }, { id: "heron/s2", name: "b", machine: "heron", tabs: [] }]
    app.props = { current: "puffin", over: "puffin/t7", fallback: "puffin" }
    const picker = new Machines()
    picker.init(app.props, cx())
    await settle()
    picker.choose(picker.shown()[1])
    expect(app.runs).toEqual([["space.select", { id: "heron/s2" }]])
  })
})

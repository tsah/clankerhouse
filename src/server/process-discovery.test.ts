import { describe, expect, test } from "bun:test"
import {
  createProcessDiscoveryProvider,
  identifyAgentProcess,
  normalizeProcess,
  parseProcStat,
  type ProcessDiscoveryAccess,
} from "./process-discovery"

const stat = (pid: number, name: string, ppid: number, group: number, foregroundGroup = group) =>
  `${pid} (${name}) S ${ppid} ${group} 1 34816 ${foregroundGroup} 0 0 0 0 0 0 0 0 0 0 0 0`

const fixture = (files: Record<string, string>, platform = "linux"): ProcessDiscoveryAccess => ({
  platform,
  readDirectory: (path) => {
    if (path !== "/proc") throw new Error("unexpected directory")
    return [...new Set(Object.keys(files).flatMap((file) => file.match(/^\/proc\/(\d+)\//)?.[1] ?? []))]
  },
  readFile: (path) => {
    const value = files[path]
    if (value === undefined) throw new Error(`missing fixture ${path}`)
    return value
  },
})

const processEvidence = (argv: string[]) => normalizeProcess({
  pid: 20,
  ppid: 10,
  processGroupId: 20,
  terminalForegroundProcessGroupId: 20,
  name: "fixture",
}, `${argv.join("\x00")}\x00`)

describe("Linux foreground process discovery", () => {
  test("reads the pane terminal foreground group and returns structured package evidence", () => {
    const access = fixture({
      "/proc/10/stat": stat(10, "zsh", 1, 10, 42),
      "/proc/10/cmdline": "zsh\x00",
      "/proc/42/stat": stat(42, "node", 10, 42),
      "/proc/42/cmdline": "node\x00/home/me/.npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js\x00",
      "/proc/43/stat": stat(43, "helper worker", 42, 42),
      "/proc/43/cmdline": "helper\x00--serve\x00",
      "/proc/90/stat": stat(90, "claude", 10, 90),
      "/proc/90/cmdline": "claude\x00",
    })

    expect(createProcessDiscoveryProvider(access).discover(10)).toEqual({
      harness: "pi",
      paneChildPid: 10,
      foregroundProcessGroupId: 42,
      matchedProcess: {
        pid: 42,
        ppid: 10,
        processGroupId: 42,
        terminalForegroundProcessGroupId: 42,
        name: "node",
        argv: ["node", "/home/me/.npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"],
      },
      match: { kind: "package", value: "/home/me/.npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js" },
      processes: [
        { pid: 42, ppid: 10, processGroupId: 42, terminalForegroundProcessGroupId: 42, name: "node", argv: ["node", "/home/me/.npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"] },
        { pid: 43, ppid: 42, processGroupId: 42, terminalForegroundProcessGroupId: 42, name: "helper", argv: ["helper", "--serve"] },
      ],
      source: "linux-proc",
    })
  })

  test("parses stat command names containing spaces and closing parentheses", () => {
    expect(parseProcStat(stat(27, "node worker) 1", 3, 27, 27))).toMatchObject({
      pid: 27,
      ppid: 3,
      processGroupId: 27,
      terminalForegroundProcessGroupId: 27,
      name: "node worker) 1",
    })
  })

  test.each([
    [["/usr/bin/claude", "--resume"], "claude", "executable"],
    [["node", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"], "claude", "package"],
    [["bun", "/home/me/.opencode/node_modules/@opencode-ai/cli/dist/index.js"], "opencode", "package"],
    [["python3", "-m", "opencode"], "opencode", "executable"],
    [["opencode2", "/work"], "opencode", "executable"],
    [["npx", "@openai/codex", "--quiet"], "codex", "package"],
    [["pnpm", "dlx", "@mariozechner/pi-coding-agent"], "pi", "package"],
    [["npm", "exec", "--", "@anthropic-ai/claude-code"], "claude", "package"],
    [["env", "DEBUG=1", "bash", "-lc", "exec codex --resume"], "codex", "executable"],
  ] as const)("recognizes %j through common runtime and shell wrappers", (argv, harness, kind) => {
    expect(identifyAgentProcess(processEvidence([...argv]))).toMatchObject({ harness, kind })
  })

  test.each([
    [["node", "/work/opencode-dashboard.js", "--agent", "claude"]],
    [["python3", "worker.py", "codex"]],
    [["bash", "-lc", "echo claude"]],
    [["bash", "-lc", "echo ready && codex"]],
    [["npm", "run", "claude"]],
    [["bun", "run", "opencode"]],
    [["node", "app.js", "/node_modules/@openai/codex"]],
    [["pi-helper", "--mode", "agent"]],
  ] as const)("does not identify incidental agent words in argv %j", (argv) => {
    expect(identifyAgentProcess(processEvidence([...argv]))).toBeUndefined()
  })

  test("uses comm only when argv is unavailable", () => {
    const access = fixture({
      "/proc/5/stat": stat(5, "zsh", 1, 5, 30),
      "/proc/30/stat": stat(30, "codex", 5, 30),
    })
    expect(createProcessDiscoveryProvider(access).discover(5)).toMatchObject({
      harness: "codex",
      matchedProcess: { pid: 30, name: "codex", argv: [] },
      match: { kind: "executable", value: "codex" },
    })
  })

  test("returns undefined for conflicting equally strong foreground agents", () => {
    const access = fixture({
      "/proc/5/stat": stat(5, "zsh", 1, 5, 30),
      "/proc/30/stat": stat(30, "claude", 5, 30),
      "/proc/30/cmdline": "claude\x00",
      "/proc/31/stat": stat(31, "codex", 5, 30),
      "/proc/31/cmdline": "codex\x00",
    })
    expect(createProcessDiscoveryProvider(access).discover(5)).toBeUndefined()
  })

  test("ignores malformed, unreadable, and non-foreground proc entries", () => {
    const access = fixture({
      "/proc/5/stat": stat(5, "zsh", 1, 5, 30),
      "/proc/30/stat": stat(30, "ordinary", 5, 30),
      "/proc/30/cmdline": ["sleep", "10", ""].join("\x00"),
      "/proc/31/stat": "not a proc stat",
      "/proc/80/stat": stat(80, "claude", 5, 80),
      "/proc/80/cmdline": "claude\x00",
    })
    expect(createProcessDiscoveryProvider(access).discover(5)).toBeUndefined()
  })

  test("fails closed for unsupported platforms, invalid pids, and unavailable procfs", () => {
    const unavailable: ProcessDiscoveryAccess = {
      platform: "linux",
      readDirectory: () => { throw new Error("procfs unavailable") },
      readFile: () => { throw new Error("procfs unavailable") },
    }
    expect(createProcessDiscoveryProvider(fixture({}, "darwin")).discover(1)).toBeUndefined()
    expect(createProcessDiscoveryProvider(unavailable).discover(1)).toBeUndefined()
    expect(createProcessDiscoveryProvider(unavailable).discover(0)).toBeUndefined()
    expect(createProcessDiscoveryProvider(unavailable).discover(Number.NaN)).toBeUndefined()
  })

  test("returns undefined when the pane has no terminal foreground process group", () => {
    const access = fixture({ "/proc/5/stat": stat(5, "zsh", 1, 5, -1) })
    expect(createProcessDiscoveryProvider(access).discover(5)).toBeUndefined()
  })

  test("shares one proc snapshot across pane discoveries", () => {
    let directoryReads = 0
    const base = fixture({
      "/proc/5/stat": stat(5, "zsh", 1, 5, 30),
      "/proc/30/stat": stat(30, "codex", 5, 30),
      "/proc/30/cmdline": "codex\x00",
      "/proc/6/stat": stat(6, "zsh", 1, 6, 40),
      "/proc/40/stat": stat(40, "claude", 6, 40),
      "/proc/40/cmdline": "claude\x00",
    })
    const access: ProcessDiscoveryAccess = {
      ...base,
      readDirectory(path) {
        directoryReads += 1
        return base.readDirectory(path)
      },
    }
    const provider = createProcessDiscoveryProvider(access)
    expect(provider.discover(5)?.harness).toBe("codex")
    expect(provider.discover(6)?.harness).toBe("claude")
    expect(directoryReads).toBe(1)
  })

  test("uses targeted descendant traversal when procfs exposes child lists", () => {
    let directoryReads = 0
    const files: Record<string, string> = {
      "/proc/10/stat": stat(10, "zsh", 1, 10, 42),
      "/proc/10/task/10/children": "42",
      "/proc/42/stat": stat(42, "node", 10, 42),
      "/proc/42/task/42/children": "43",
      "/proc/42/cmdline": "node\x00/home/me/.npm/node_modules/@mariozechner/pi-coding-agent/dist/cli.js\x00",
      "/proc/43/stat": stat(43, "helper", 42, 42),
      "/proc/43/task/43/children": "",
      "/proc/43/cmdline": "helper\x00--serve\x00",
    }
    const access: ProcessDiscoveryAccess = {
      platform: "linux",
      readDirectory() { directoryReads += 1; return [] },
      readFile(path) {
        const value = files[path]
        if (value === undefined) throw new Error(`unexpected read ${path}`)
        return value
      },
    }
    const discovery = createProcessDiscoveryProvider(access).discover(10)
    expect(discovery?.harness).toBe("pi")
    expect(discovery?.processes.map((process) => process.pid)).toEqual([42, 43])
    expect(directoryReads).toBe(0)
  })

  test("does not abandon targeted traversal when a descendant exits", () => {
    let directoryReads = 0
    const access: ProcessDiscoveryAccess = {
      platform: "linux",
      readDirectory() { directoryReads += 1; return [] },
      readFile(path) {
        if (path === "/proc/10/stat") return stat(10, "zsh", 1, 10, 42)
        if (path === "/proc/10/task/10/children") return "42 99"
        if (path === "/proc/42/stat") return stat(42, "codex", 10, 42)
        if (path === "/proc/42/task/42/children") return ""
        if (path === "/proc/42/cmdline") return "codex\x00"
        throw new Error("process exited")
      },
    }
    expect(createProcessDiscoveryProvider(access).discover(10)?.harness).toBe("codex")
    expect(directoryReads).toBe(0)
  })
})

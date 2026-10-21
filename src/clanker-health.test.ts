import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clankerHealth } from "./clanker-health"

const fakeHost = () => {
  const root = mkdtempSync(join(tmpdir(), "clanker-health-"))
  const slice = join(root, "slice")
  const proc = join(root, "proc")
  mkdirSync(proc, { recursive: true })
  writeFileSync(join(proc, "uptime"), "10000.40 1.00\n")
  const scope = (name: string, files: Record<string, string>) => {
    mkdirSync(join(slice, name), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(slice, name, file), text)
  }
  // Start ticks are hundredths of a second since boot.
  const process = (pid: number, ppid: number, state: string, startSeconds: number, argv: string[]) => {
    mkdirSync(join(proc, String(pid)))
    const fields = [state, String(ppid), ...Array(17).fill("0"), String(startSeconds * 100), "0"]
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (odd) name) ${fields.join(" ")}\n`)
    writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`)
  }
  return { roots: { slice, proc }, scope, process }
}

describe("clanker health", () => {
  test("reads memory, D-state pids, and the harness's longest-running descendant from the newest scope", () => {
    const host = fakeHost()
    host.scope("clankerhouse-clanker-a-9.scope", { "memory.current": "1\n", "memory.high": "max\n", "cgroup.procs": "" })
    host.scope("clankerhouse-clanker-a-10.scope", { "memory.current": "6442000000\n", "memory.high": "6442450944\n", "cgroup.procs": "100\n101\n102\n103\n104\n" })
    host.scope("clankerhouse-clanker-a-b-11.scope", { "memory.current": "7\n", "memory.high": "max\n", "cgroup.procs": "" })
    host.process(100, 1, "S", 1000, ["/bin/bash", "/opt/bin/clankerhouse-harness-lifecycle", "--", "claude"])
    host.process(101, 100, "D", 1001, ["claude", "--session-id", "s"])
    host.process(102, 101, "S", 8000, ["bash", "-c", "bun test"])
    host.process(103, 102, "D", 8400, ["./runaway-test"])
    host.process(104, 101, "S", 9900, ["git", "status"])

    expect(clankerHealth("clanker-a", host.roots)).toEqual({
      memory: { current: 6442000000, high: 6442450944 },
      dState: [101, 103],
      longestChild: { pid: 102, cmd: "bash -c bun test", elapsed: 2000 },
    })
  })

  test("treats an unwrapped scope root as the harness and reports unlimited memory.high as null", () => {
    const host = fakeHost()
    host.scope("clankerhouse-clanker-b-1.scope", { "memory.current": "5\n", "memory.high": "max\n", "cgroup.procs": "200\n" })
    host.process(200, 1, "S", 10, ["pi"])
    expect(clankerHealth("clanker-b", host.roots)).toEqual({ memory: { current: 5, high: null }, dState: [] })
  })

  test("is empty when the clanker has no scope", () => {
    const host = fakeHost()
    expect(clankerHealth("clanker-missing", host.roots)).toEqual({})
    expect(clankerHealth("clanker-missing", { slice: "/nonexistent", proc: host.roots.proc })).toEqual({})
  })
})

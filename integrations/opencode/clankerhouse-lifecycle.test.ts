import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"

const roots: string[] = []
const isolatedEnv = (overrides: Record<string, string> = {}) => ({
  ...process.env,
  CLANKER_ID: "",
  CLANKER_SESSION_ID: "",
  CLANKER_RECOVERY_ATTEMPT: "",
  CLANKER_RECOVERY_TRACKED: "",
  HERDR_PANE_ID: "",
  CLANKERHOUSE_INSTANCE: "",
  ...overrides,
})
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("OpenCode lifecycle reports", () => {
  test("reports exact tracked root state and withdraws registration on deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    const clankersLog = join(root, "clankers.log")
    mkdirSync(bin)
    writeFileSync(join(bin, "clankers"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CLANKERS_LOG"
if [ "$2" = read-claim ]; then printf '%s\\n' "$CLANKER_ID"; fi
`)
    chmodSync(join(bin, "clankers"), 0o755)

    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      import { readFileSync } from "node:fs"
      const info = { id: "session-root", projectID: "project", directory: "/tmp/work", title: "task", version: "1", time: { created: 1, updated: 1 } }
      const report = () => JSON.parse(readFileSync(process.env.REPORT_PATH!, "utf8"))
      await handleLifecycleEvent({ type: "session.created", properties: { info } })
      const created = report()
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-root", status: { type: "busy" } } })
      const working = report()
      await handleLifecycleEvent({ type: "question.asked", properties: { id: "question-1", sessionID: "session-root", questions: [] } })
      const blocked = report()
      await handleLifecycleEvent({ type: "question.replied", properties: { sessionID: "session-root", requestID: "question-1", answers: [] } })
      const resumed = report()
      await handleLifecycleEvent({ type: "session.idle", properties: { sessionID: "session-root" } })
      const done = report()
      await handleLifecycleEvent({ type: "session.updated", properties: { info } })
      const updated = report()
      await handleLifecycleEvent({ type: "session.deleted", properties: { info } })
      console.log(JSON.stringify({ created, working, blocked, resumed, done, updated, deleted: report() }))
    `)
    const reportPath = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`, "clanker-state", "w1_p44.json")
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({
        PATH: `${bin}:${process.env.PATH || ""}`,
        XDG_RUNTIME_DIR: runtime,
        HERDR_PANE_ID: "w1:p44",
        CLANKER_ID: "clanker-opencode",
        CLANKER_SESSION_ID: "session-root",
        CLANKER_RECOVERY_ATTEMPT: "attempt-1",
        CLANKERHOUSE_CLANKERS: join(bin, "clankers"),
        REPORT_PATH: reportPath,
        CLANKERS_LOG: clankersLog,
      }),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const output = JSON.parse(child.stdout.toString())
    expect(output.created).toMatchObject({ harness: "opencode", clankerId: "clanker-opencode", harnessSessionId: "session-root", pane: "w1:p44", state: "idle", generation: 0 })
    expect(output.working).toMatchObject({ state: "working", generation: 1, settledGeneration: 0, hookEvent: "session.status" })
    expect(output.blocked).toMatchObject({ state: "blocked", hookEvent: "question.asked" })
    expect(output.resumed).toMatchObject({ state: "working", hookEvent: "question.replied" })
    expect(output.done).toMatchObject({ state: "done", generation: 1, settledGeneration: 1, hookEvent: "session.idle" })
    expect(output.updated).toEqual(output.done)
    expect(output.deleted).toMatchObject({ state: "unknown", hookEvent: "session.deleted" })
    const calls = readFileSync(clankersLog, "utf8")
    expect(calls).toContain("mux claim --pane w1:p44 harness opencode")
    expect(calls).toContain("mux claim --pane w1:p44 clankerId --unset")
  })

  test("ignores unrelated sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "child-session", status: { type: "busy" } } })
    `)
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({ XDG_RUNTIME_DIR: join(root, "runtime"), HERDR_PANE_ID: "w1:p44", CLANKER_ID: "clanker-opencode", CLANKER_SESSION_ID: "session-root", CLANKERHOUSE_CLANKERS: "/bin/true" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(child.stdout.toString()).toBe("")
  })

  test("reports an untracked root as pane-addressed harness evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const runtime = join(root, "runtime")
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      import { readFileSync } from "node:fs"
      const info = { id: "session-root", projectID: "project", directory: "/tmp/work", title: "task", version: "1", time: { created: 1, updated: 1 } }
      await handleLifecycleEvent({ type: "session.created", properties: { info } })
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-root", status: { type: "busy" } } })
      console.log(readFileSync(process.env.REPORT_PATH!, "utf8"))
    `)
    const reportPath = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`, "clanker-state", "w1_p44.json")
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p44", REPORT_PATH: reportPath }),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      harness: "opencode",
      harnessSessionId: "session-root",
      pane: "w1:p44",
      state: "working",
      hookEvent: "session.status",
    })
    expect(JSON.parse(child.stdout.toString())).not.toHaveProperty("clankerId")
  })

  test("uses direct daemon IPC and deduplicates repeated semantic state", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const runtime = join(root, "runtime")
    const runtimeRoot = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`)
    mkdirSync(runtimeRoot, { recursive: true })
    const requests: unknown[] = []
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.once("data", (input) => {
        requests.push(JSON.parse(String(input).trim()))
        socket.end(JSON.stringify({ version: 1, id: (requests.at(-1) as any).id, ok: true, result: { accepted: true } }) + "\n")
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(join(runtimeRoot, "daemon.sock"), resolve)
    })
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      const info = { id: "session-root", projectID: "project", directory: "/tmp/work", title: "task", version: "1", time: { created: 1, updated: 1 } }
      await handleLifecycleEvent({ type: "session.created", properties: { info } })
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-root", status: { type: "busy" } } })
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-root", status: { type: "busy" } } })
      await Bun.sleep(50)
    `)
    const child = Bun.spawn([process.execPath, script], {
      env: isolatedEnv({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p44" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)
    await new Promise<void>((resolve) => server.close(() => resolve()))

    expect(requests).toHaveLength(2)
    expect(requests.map((request: any) => request.params.state)).toEqual(["idle", "working"])
    expect(requests.every((request: any) => request.method === "observation.report")).toBe(true)
    expect(requests.every((request: any) => request.params.recoveryAttemptId === undefined)).toBe(true)
    expect(existsSync(join(runtimeRoot, "clanker-state", "w1_p44.json"))).toBe(false)
  })

  test("recovers an untracked root from a status event after plugin reload", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const runtime = join(root, "runtime")
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      import { readFileSync } from "node:fs"
      await handleLifecycleEvent(
        { type: "session.status", data: { sessionID: "session-root", status: { type: "busy" } } },
        async (id) => ({ id }),
      )
      console.log(readFileSync(process.env.REPORT_PATH!, "utf8"))
    `)
    const reportPath = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`, "clanker-state", "w1_p44.json")
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p44", REPORT_PATH: reportPath }),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ harnessSessionId: "session-root", state: "working", hookEvent: "session.status" })
  })

  test("does not let a child replace an attested root when discovery is unpinned", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    mkdirSync(bin)
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      import { readFileSync } from "node:fs"
      const info = (id: string) => ({ id, projectID: "project", directory: "/tmp/work", title: id, version: "1", time: { created: 1, updated: 1 } })
      await handleLifecycleEvent({ type: "session.created", properties: { info: info("session-root") } })
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-child", status: { type: "busy" } } })
      console.log(readFileSync(process.env.REPORT_PATH!, "utf8"))
    `)
    const reportPath = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`, "clanker-state", "w1_p44.json")
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({ PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p44", CLANKER_ID: "clanker-opencode", CLANKERHOUSE_CLANKERS: "/bin/true", REPORT_PATH: reportPath }),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ harnessSessionId: "session-root", state: "idle", generation: 0 })
  })

  test("does not attest a child observed before an unpinned root", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-opencode-lifecycle-"))
    roots.push(root)
    const bin = join(root, "bin")
    const runtime = join(root, "runtime")
    mkdirSync(bin)
    const script = join(root, "exercise.ts")
    const pluginPath = new URL("./clankerhouse-lifecycle.ts", import.meta.url).pathname
    writeFileSync(script, `
      import { handleLifecycleEvent } from ${JSON.stringify(pluginPath)}
      import { readFileSync } from "node:fs"
      const info = (id: string, parentID?: string) => ({ id, parentID, projectID: "project", directory: "/tmp/work", title: id, version: "1", time: { created: 1, updated: 1 } })
      await handleLifecycleEvent({ type: "session.created", properties: { info: info("session-child", "session-root") } })
      await handleLifecycleEvent({ type: "session.status", data: { sessionID: "session-child", status: { type: "busy" } } })
      await handleLifecycleEvent({ type: "session.created", properties: { info: info("session-root") } })
      console.log(readFileSync(process.env.REPORT_PATH!, "utf8"))
    `)
    const reportPath = join(runtime, `clankerhouse-${process.getuid?.() || 0}-herdr`, "clanker-state", "w1_p44.json")
    const child = Bun.spawnSync([process.execPath, script], {
      env: isolatedEnv({ PATH: `${bin}:${process.env.PATH || ""}`, XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p44", CLANKER_ID: "clanker-opencode", CLANKERHOUSE_CLANKERS: "/bin/true", REPORT_PATH: reportPath }),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ harnessSessionId: "session-root", state: "idle", generation: 0 })
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleEvent } from "./status-hooks"
import { DEFAULT_MARKERS, HooksConfigError, hooksConfigPath, openSink, parseHooksConfig, readHooksConfig, redactedSink, retryDelayMs, sinkWants, type SinkConfig } from "./status-sinks"

const roots: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tempDir = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-sinks-"))
  roots.push(root)
  return root
}
const serve = (fetch: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return `http://127.0.0.1:${server.port}/hook/secret-token`
}
const webhook = (url: string, headers: Record<string, string> = {}): SinkConfig => ({ kind: "webhook", name: "groky", url, headers })

const SAMPLE = `
[detect]
debounce_seconds = 2

[[sinks]]
name = "groky"
url = "https://example.invalid/hook"
events = ["clanker.*", "report.done"]
[sinks.headers]
X-Sender-Key = "sekret"

[[sinks]]
name = "log"
kind = "exec"
argv = ["/usr/local/bin/hook", "--flag"]
`

describe("hooks config", () => {
  test("parses sinks and fills in defaults", () => {
    const config = parseHooksConfig(SAMPLE)
    expect(config.sinks).toEqual([
      { kind: "webhook", name: "groky", events: ["clanker.*", "report.done"], url: "https://example.invalid/hook", headers: { "X-Sender-Key": "sekret" } },
      { kind: "exec", name: "log", argv: ["/usr/local/bin/hook", "--flag"] },
    ])
    expect(config.detect).toEqual({ debounceMs: 2_000, exitGraceMs: 20_000, stuckMessageMs: 180_000, markers: { ...DEFAULT_MARKERS } })
    expect(config.delivery).toEqual({ timeoutMs: 10_000, retryBaseMs: 5_000, retryMaxMs: 900_000, giveUpMs: 86_400_000 })
  })

  test.each([
    ["[[sinks]]\nname = \"a\"\nurl = \"http://example.com/x\"", /must be https/],
    ["[[sinks]]\nname = \"a\"\nurl = \"nonsense\"", /not a valid URL/],
    ["[[sinks]]\nname = \"a b\"\nurl = \"https://x.invalid\"", /name must/],
    ["[[sinks]]\nname = \"a\"\nkind = \"carrier-pigeon\"", /kind must be/],
    ["[[sinks]]\nname = \"a\"\nkind = \"exec\"", /argv must be/],
    ["[[sinks]]\nname = \"a\"\nkind = \"exec\"\nargv = [\"x\"]\n[[sinks]]\nname = \"a\"\nkind = \"exec\"\nargv = [\"y\"]", /Duplicate sink/],
    ["[detect]\ndebounce_seconds = -1", /non-negative/],
    ["[detect.markers]\nescape = \"../../etc/passwd\"", /inside the worktree/],
    ["[detect.markers]\nabsolute = \"/etc/passwd\"", /inside the worktree/],
  ])("rejects %s", (text, message) => {
    expect(() => parseHooksConfig(text)).toThrow(message)
  })

  test("a header injection is rejected without echoing the value", () => {
    let error: unknown
    try { parseHooksConfig(`[[sinks]]\nname = "a"\nurl = "https://x.invalid"\n[sinks.headers]\nX-Key = "sekret\\r\\nEvil: 1"`) }
    catch (caught) { error = caught }
    expect(error).toBeInstanceOf(HooksConfigError)
    expect(String(error)).not.toContain("sekret")
  })

  test("invalid TOML never quotes the file", () => {
    let error: unknown
    try { parseHooksConfig(`x = "sekret`) } catch (caught) { error = caught }
    expect(String(error)).toContain("not valid TOML")
    expect(String(error)).not.toContain("sekret")
  })

  test("a config another user can read is refused", () => {
    const path = join(tempDir(), "hooks.toml")
    writeFileSync(path, SAMPLE)
    chmodSync(path, 0o644)
    expect(() => readHooksConfig(path)).toThrow(/chmod 600/)
    chmodSync(path, 0o600)
    expect(readHooksConfig(path).sinks).toHaveLength(2)
  })

  test("each instance has its own config path", () => {
    expect(hooksConfigPath({ HOME: "/h" })).toBe("/h/.config/clankerhouse/hooks.toml")
    expect(hooksConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/clankerhouse/hooks.toml")
    expect(hooksConfigPath({ HOME: "/h", CLANKERHOUSE_INSTANCE: "soak" })).toBe("/h/.config/clankerhouse/hooks-soak.toml")
    expect(hooksConfigPath({ CLANKERHOUSE_HOOKS_CONFIG: "/y/z.toml", CLANKERHOUSE_INSTANCE: "soak" })).toBe("/y/z.toml")
  })

  test("event filters match exactly, by prefix, or everything", () => {
    expect(sinkWants({}, "anything")).toBe(true)
    expect(sinkWants({ events: ["*"] }, "anything")).toBe(true)
    expect(sinkWants({ events: ["clanker.*"] }, "clanker.blocked")).toBe(true)
    expect(sinkWants({ events: ["clanker.*"] }, "clankers.blocked")).toBe(false)
    expect(sinkWants({ events: ["report.done"] }, "report.failed")).toBe(false)
  })

  test("redaction shows the host and header names only", () => {
    const shown = JSON.stringify(redactedSink(webhook("https://example.invalid/hook/secret-token?key=sekret", { "X-Sender-Key": "sekret" })))
    expect(shown).toContain("example.invalid")
    expect(shown).toContain("X-Sender-Key")
    expect(shown).not.toContain("sekret")
    expect(shown).not.toContain("secret-token")
  })
})

describe("webhook sink", () => {
  test("posts the event as JSON with the configured headers", async () => {
    let seen: { headers: Headers; body: unknown } | undefined
    const url = serve(async (request) => {
      seen = { headers: request.headers, body: await request.json() }
      return new Response("ok")
    })
    const event = sampleEvent(1_000)
    expect(await openSink(webhook(url, { "X-Sender-Key": "sekret" })).send(event, 1_000)).toEqual({ ok: true, status: 200 })
    expect(seen!.body).toEqual(JSON.parse(JSON.stringify(event)))
    expect(seen!.headers.get("x-sender-key")).toBe("sekret")
    expect(seen!.headers.get("content-type")).toBe("application/json")
    expect(seen!.headers.get("x-clankerhouse-event")).toBe("hooks.test")
    expect(seen!.headers.get("x-clankerhouse-dedupe-key")).toBe(event.dedupeKey)
  })

  test.each([[500, true], [503, true], [429, true], [408, true], [401, false], [404, false], [422, false]])("HTTP %i retryable=%s", async (status, retryable) => {
    const url = serve(() => new Response("sekret-body", { status }))
    const result = await openSink(webhook(url)).send(sampleEvent(), 1_000)
    expect(result).toMatchObject({ ok: false, retryable, status, error: `HTTP ${status}` })
  })

  test("Retry-After is honoured", async () => {
    const url = serve(() => new Response("", { status: 429, headers: { "retry-after": "7" } }))
    expect(await openSink(webhook(url)).send(sampleEvent(), 1_000)).toMatchObject({ retryAfterMs: 7_000 })
  })

  test("a redirect is not followed, so the key never reaches another host", async () => {
    let leaked = false
    const elsewhere = serve(() => { leaked = true; return new Response("ok") })
    const url = serve(() => new Response("", { status: 302, headers: { location: elsewhere } }))
    expect(await openSink(webhook(url, { "X-Sender-Key": "sekret" })).send(sampleEvent(), 1_000)).toMatchObject({ ok: false, retryable: false, status: 302 })
    expect(leaked).toBe(false)
  })

  test("a timeout is retryable and quotes no URL", async () => {
    const url = serve(() => new Promise(() => {}))
    const result = await openSink(webhook(url)).send(sampleEvent(), 50)
    expect(result).toMatchObject({ ok: false, retryable: true, error: "no response within 50ms" })
  })

  test("a refused connection is retryable and quotes no URL", async () => {
    const result = await openSink(webhook("http://127.0.0.1:9/hook/secret-token")).send(sampleEvent(), 1_000)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(JSON.stringify(result)).not.toContain("secret-token")
  })
})

describe("exec sink", () => {
  const script = (body: string) => {
    const path = join(tempDir(), "sink")
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  test("runs with the event on stdin and its type in the environment", async () => {
    const output = join(tempDir(), "out")
    const event = sampleEvent()
    const sink = openSink({ kind: "exec", name: "x", argv: [script(`printf '%s\\n' "$CLANKERHOUSE_EVENT_TYPE:$CLANKERHOUSE_EVENT_DEDUPE_KEY" > '${output}'; cat >> '${output}'`)] })
    expect(await sink.send(event, 2_000)).toEqual({ ok: true })
    const [first, body] = readFileSync(output, "utf8").split("\n")
    expect(first).toBe(`hooks.test:${event.dedupeKey}`)
    expect(JSON.parse(body!).id).toBe(event.id)
  })

  test("a nonzero exit retries", async () => {
    expect(await openSink({ kind: "exec", name: "x", argv: [script("exit 3")] }).send(sampleEvent(), 2_000)).toEqual({ ok: false, retryable: true, error: "exit 3" })
  })

  test("a missing command retries", async () => {
    expect(await openSink({ kind: "exec", name: "x", argv: ["/nonexistent/sink"] }).send(sampleEvent(), 2_000)).toMatchObject({ ok: false, retryable: true })
  })

  test("a hung command is killed at the timeout", async () => {
    expect(await openSink({ kind: "exec", name: "x", argv: [script("exec sleep 30")] }).send(sampleEvent(), 50)).toMatchObject({ ok: false, retryable: true, error: "no exit within 50ms" })
  })
})

describe("retry backoff", () => {
  const delivery = { retryBaseMs: 5_000, retryMaxMs: 60_000 }
  test("doubles to the cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, delivery))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
  })
  test("a receiver's wait lengthens it, within the cap", () => {
    expect(retryDelayMs(1, delivery, 30_000)).toBe(30_000)
    expect(retryDelayMs(3, delivery, 1_000)).toBe(20_000)
    expect(retryDelayMs(1, delivery, 600_000)).toBe(60_000)
  })
})

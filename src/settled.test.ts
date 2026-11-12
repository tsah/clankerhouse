import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DetailRow, SessionRow } from "./model"
import { orderSettled, prInText, settledEntry, settledSessions, ticketOf, type SettledDependencies } from "./settled"

const repo = resolve(import.meta.dir, "..")

const clanker = (state: DetailRow["state"], pane: string, updatedAt: number, clankerId = `c-${pane}`): DetailRow => ({
  kind: "clanker", harness: "claude", status: "", detail: "", title: "main", age: "", state, updatedAt, clankerId,
  target: { type: "window", session: pane, windowId: pane, pane, location: { kind: "hc", instanceId: "hc:x", nativeSessionId: pane, nativeWindowId: pane, nativePaneId: pane } },
})
const session = (name: string, details: DetailRow[], extra: Partial<SessionRow> = {}): SessionRow => ({
  name, path: `/w/${name}`, branch: name, flags: "", markers: [], age: "", recency: 0, searchText: "", details,
  target: { type: "session", session: name, resourceId: `mux-${name}` }, workshopId: `w-${name}`, ...extra,
})

/** Created 1..5 in this order; `asked` needs the operator, `working` is in progress, `shell` has no clanker. */
const rows = [
  session("late-created", [clanker("done", "t5", 500)]),
  session("working", [clanker("working", "t2", 900)], { needsMe: { reason: "asked", since: 800, clankerId: "c-t2" } }),
  session("asked", [clanker("idle", "t3", 300)], { needsMe: { reason: "asked", since: 700, clankerId: "c-t3" } }),
  session("first-created", [clanker("blocked", "t1", 100)], { needsMe: { reason: "blocked", since: 100, clankerId: "c-t1" } }),
  session("shell", [{ ...clanker("unknown", "t4", 0), kind: "window", harness: undefined, clankerId: undefined }]),
  session("unregistered", [clanker("idle", "t6", 50)], { workshopId: undefined }),
  session("closed", [clanker("done", "t7", 50)], { target: { type: "directory", path: "/w/closed" } }),
]
const created: Record<string, number> = { "w-first-created": 1, "w-working": 2, "w-asked": 3, "w-shell": 4, "w-late-created": 5 }
const createdAt = (id: string) => created[id]

describe("sessions with nothing in progress", () => {
  test("are the open sessions none of whose clankers is working, with or without a clanker", () => {
    expect(settledSessions(rows).map((row) => row.name)).toEqual(["late-created", "asked", "first-created", "shell", "unregistered"])
  })

  test("list earliest created first by default, unregistered last; freshest/eldest put the Needs-me rows first; flat keeps the snapshot", () => {
    const settled = settledSessions(rows)
    const names = (order: Parameters<typeof orderSettled>[1]) => orderSettled(settled, order, createdAt).map((row) => row.name)
    expect(names("created")).toEqual(["first-created", "asked", "shell", "late-created", "unregistered"])
    expect(names("freshest")).toEqual(["asked", "first-created", "late-created", "unregistered", "shell"])
    expect(names("eldest")).toEqual(["first-created", "asked", "shell", "unregistered", "late-created"])
    expect(names("flat")).toEqual(["late-created", "asked", "first-created", "shell", "unregistered"])
  })

  test("a row carries what a reader needs to classify it, and the full last replies", () => {
    const dependencies: SettledDependencies = {
      report: (pane) => pane === "t3" ? { generation: 7, settledGeneration: 7, updatedAt: 350, transcriptPath: "/t.jsonl" } : undefined,
      lastMessages: (harness, report) => ({ messages: report ? [{ text: "Merge PR https://github.com/a/b/pull/9?", at: 340, prompt: "ship", generation: null }] : [], source: report ? "claude-transcript" : null, path: report ? "/t.jsonl" : null, pr: null }),
      labels: (id): Record<string, string> => id === "w-asked" ? { stage: "waiting-for-approval", ticket: "TWE-1" } : {},
      createdAt,
    }
    const asked = rows.find((row) => row.name === "asked")!
    expect(settledEntry(asked, 2, dependencies)).toMatchObject({
      key: "mux-asked", position: 2, session: "asked", workshopId: "w-asked", cwd: "/w/asked", branch: "asked",
      pane: "t3", harness: "claude", state: "idle", clankerId: "c-t3", turn: 7, settledTurn: 7, lastStatusAt: 350, createdAt: 3,
      labels: { stage: "waiting-for-approval", ticket: "TWE-1" }, ticket: "TWE-1", stage: "waiting-for-approval",
      pr: { number: 9, url: "https://github.com/a/b/pull/9" },
      needsMe: { reason: "asked", since: 700, detail: null, deferred: false, snoozedUntil: null, waitingOn: null },
      clankers: [{ clankerId: "c-t3", pane: "t3", harness: "claude", state: "idle" }],
      lastMessages: [{ text: "Merge PR https://github.com/a/b/pull/9?", at: 340, prompt: "ship", generation: null }],
      lastMessagesSource: "claude-transcript", lastMessagesPath: "/t.jsonl",
    })
    const shell = settledEntry(rows.find((row) => row.name === "shell")!, 3, dependencies)
    expect(shell).toMatchObject({ pane: null, state: null, clankerId: null, lastMessages: [], lastMessagesSource: null, needsMe: null, pr: null })
    expect(settledEntry(asked, 2, dependencies, false).lastMessages).toEqual([])
  })

  test("ticket and PR fall back sensibly", () => {
    expect(ticketOf({ ticket: "TWE-1" }, "x")).toBe("TWE-1")
    expect(ticketOf({ stage: "planning", other: "TWE-2392" }, "x")).toBe("TWE-2392")
    expect(ticketOf({}, "twe-2131-scope-parse")).toBe("TWE-2131")
    expect(ticketOf({}, "scratch-11-03-09-04")).toBeNull()
    expect(ticketOf({}, "loop-cobol")).toBeNull()
    expect(prInText([{ text: "see https://github.com/o/r/pull/1 then https://github.com/o/r/pull/2", at: null, prompt: null, generation: null }])).toEqual({ number: 2, url: "https://github.com/o/r/pull/2" })
    expect(prInText([])).toBeNull()
  })
})

describe("clankers settled", () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-settled-"))
    roots.push(root)
    const instance = "settled-test"
    const runtime = join(root, "run", `clankerhouse-${process.getuid!()}-${instance}`)
    mkdirSync(join(runtime, "clanker-state"), { recursive: true })
    const state = join(root, "state", `clankerhouse-${instance}`)
    mkdirSync(state, { recursive: true })
    const db = new Database(join(state, "workshops.sqlite3"))
    db.exec(`CREATE TABLE repositories (id TEXT PRIMARY KEY, common_dir TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workshops (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, parent_id TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workshop_labels (workshop_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workshop_id, key));
      PRAGMA user_version = 1; INSERT INTO repositories VALUES ('r', '/r/.git', 1, 1);`)
    for (const [id, at] of Object.entries(created)) db.query("INSERT INTO workshops VALUES (?1, 'r', ?2, 'b', NULL, 1, ?3, 1)").run(id, `/w/${id}`, at)
    db.exec("INSERT INTO workshop_labels VALUES ('w-asked', 'stage', 'waiting-for-approval', 1), ('w-asked', 'ticket', 'TWE-7', 1)")
    db.close()
    // The asked clanker's transcript: its last turn asks for a decision, then the session was compacted while idle.
    const transcript = join(root, "asked.jsonl")
    const line = (entry: object) => `${JSON.stringify(entry)}\n`
    writeFileSync(transcript, [
      line({ type: "user", timestamp: "2026-11-12T10:00:00Z", message: { role: "user", content: "Do the work." } }),
      line({ type: "assistant", timestamp: "2026-11-12T10:01:00Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Work done; tests pass." }] } }),
      line({ type: "user", timestamp: "2026-11-12T10:02:00Z", message: { role: "user", content: "Open the PR." } }),
      line({ type: "assistant", timestamp: "2026-11-12T10:03:00Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Ready for your review: https://github.com/acme/repo/pull/42\n\nMerge, or hold?" }] } }),
    ].join(""))
    writeFileSync(join(runtime, "clanker-state", "t3.json"), JSON.stringify({ harness: "claude", clankerId: "c-t3", pane: "t3", generation: 2, settledGeneration: 2, updatedAt: 350, transcriptPath: transcript }))
    const server = Bun.listen({
      unix: join(runtime, "daemon.sock"),
      socket: {
        data(socket, data) {
          const request = JSON.parse(data.toString().trim())
          socket.write(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { version: 11, revision: { source: "test", sequence: 1 }, generatedAt: 5, sessions: rows } })}\n`)
        },
      },
    })
    const env = { PATH: Bun.env.PATH!, HOME: root, XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state"), CLANKERHOUSE_INSTANCE: instance, CLANKERHOUSE_HOME: repo, CLANKERHOUSE_BIN_DIR: join(repo, "bin"), CLANKERHOUSE_LIBEXEC: join(repo, "libexec") }
    return { env, transcript, stop: () => server.stop(true) }
  }

  // No terminal: stdin ignored, stdout a pipe.
  const run = async (args: string[], env: Record<string, string>) => {
    const child = Bun.spawn([join(repo, "bin/clankers"), "settled", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code, json: () => JSON.parse(stdout) }
  }

  test("lists every session with nothing in progress, earliest created first, with full last replies that survive compaction", async () => {
    const { env, transcript, stop } = setup()
    try {
      const all = (await run(["--json"], env)).json()
      expect(all).toMatchObject({ version: 1, order: "created", generatedAt: 5, total: 5, next: null, counts: { settled: 5 } })
      expect(all.rows.map((row: { name: string }) => row.name)).toEqual(["first-created", "asked", "shell", "late-created", "unregistered"])
      const asked = all.rows[1]
      expect(asked).toMatchObject({ pane: "t3", ticket: "TWE-7", stage: "waiting-for-approval", turn: 2, createdAt: 3, pr: { number: 42, url: "https://github.com/acme/repo/pull/42" }, lastMessagesSource: "claude-transcript" })
      expect(asked.lastMessages.map((message: { text: string }) => message.text)).toEqual(["Ready for your review: https://github.com/acme/repo/pull/42\n\nMerge, or hold?", "Work done; tests pass."])

      // Idle compaction leaves the pane as chrome; the dump returns the very same replies.
      appendFileSync(transcript, [
        { type: "system", subtype: "compact_boundary", content: "Conversation compacted" },
        { type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation." } },
        { type: "system", subtype: "informational", content: "Compacted while idle, before the prompt cache expired" },
      ].map((entry) => `${JSON.stringify(entry)}\n`).join(""))
      const compacted = (await run(["--json", "--key", "mux-asked"], env)).json()
      expect(compacted.rows[0].lastMessages).toEqual(asked.lastMessages)

      const one = (await run(["--json", "--messages", "1", "--order", "eldest"], env)).json()
      expect(one.rows.find((row: { name: string }) => row.name === "asked").lastMessages).toHaveLength(1)
    } finally { stop() }
  })

  test("hands them out one by one", async () => {
    const { env, stop } = setup()
    try {
      const seen: string[] = []
      let after: string | null = null
      do {
        const page = (await run(["--json", "--limit", "1", ...(after ? ["--after", after] : [])], env)).json()
        expect(page.rows).toHaveLength(1)
        seen.push(page.rows[0].name)
        after = page.next
      } while (after)
      expect(seen).toEqual(["first-created", "asked", "shell", "late-created", "unregistered"])
      const missing = await run(["--json", "--after", "mux-gone"], env)
      expect(missing.code).not.toBe(0)
      expect(missing.stderr).toContain("no such session with nothing in progress")
      const text = await run(["--limit", "2"], env)
      expect(text.stdout).toContain("5 with nothing in progress")
      expect(text.stdout).toContain("next: --after mux-asked")
      expect((await run(["--order", "nope"], env)).code).not.toBe(0)
      // The hc launcher's spelling is the same command and starts nothing.
      const launcher = Bun.spawn([join(repo, "bin/clankerhouse-hc"), "--settled", "--json", "--limit", "1"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      expect(JSON.parse(await new Response(launcher.stdout).text()).rows[0].name).toBe("first-created")
    } finally { stop() }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ClankerState, DetailRow, SessionRow } from "./model"
import type { ClankerReportRecord } from "./orchestration"
import { firstLine, needsMe, needsMeCounts, needsMeEntry, needsMeList, parseSnooze, yourMoveLabels, type NeedsMeFacts } from "./needs-me"

const repo = resolve(import.meta.dir, "..")
/** The picker's own order for one snapshot; native-client tests needs_me_sessions against the same file. */
const fixture = JSON.parse(readFileSync(join(repo, "src/fixtures/needs-me-order.json"), "utf8")) as { sessions: SessionRow[]; freshest: string[]; eldest: string[]; flat: string[]; counts: { needsMe: number; open: number } }

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = 100 * DAY

const clanker = (state: ClankerState, updatedAt: number, extra: Partial<DetailRow> = {}): DetailRow => ({
  kind: "clanker", harness: "claude", status: "", detail: "", title: "claude", age: "", state, updatedAt, clankerId: "c1",
  target: { type: "window", session: "s", windowId: "w", pane: "p" }, ...extra,
})

const row = (details: DetailRow[], extra: Partial<SessionRow> = {}): SessionRow => ({
  name: "s", path: "/w", branch: "b", flags: "dirty", markers: [], age: "", recency: Math.floor((now - HOUR) / 1000),
  target: { type: "session", session: "s" }, details, searchText: "", workshopId: "ws", ...extra,
})

const report = (state: ClankerReportRecord["state"], at: number, message: string | null = null): ClankerReportRecord =>
  ({ seq: 1, at, clankerId: "c1", workshopId: "ws", to: null, state, message, payload: null })

const facts = (extra: Partial<NeedsMeFacts> = {}): NeedsMeFacts => ({
  now,
  latestReport: () => undefined,
  turnStartedAt: () => undefined,
  lastText: () => null,
  interrupted: () => [],
  snooze: () => undefined,
  waitingOn: () => undefined,
  yourMoveLabel: () => undefined,
  staleAfterMs: 7 * DAY,
  readyAfterMs: DAY,
  ...extra,
})

describe("needs me", () => {
  test("a working clanker with nothing asked is not listed", () => {
    expect(needsMe(row([clanker("working", now - HOUR)]), facts())).toBeUndefined()
    expect(needsMe(row([clanker("idle", now - HOUR)]), facts())).toBeUndefined()
  })

  test("a question filed this turn is listed with its first line, even while the clanker works on", () => {
    const asked = facts({ latestReport: () => report("question", now - 2 * HOUR, "\nRoll back the pool change?\nOr raise the timeout."), turnStartedAt: () => now - 3 * HOUR })
    expect(needsMe(row([clanker("idle", now - HOUR)]), asked)).toEqual({ reason: "asked", since: now - 2 * HOUR, excerpt: "Roll back the pool change?", clankerId: "c1" })
    expect(needsMe(row([clanker("working", now - HOUR)]), asked)?.reason).toBe("asked")
  })

  test("a question from before the current turn was answered", () => {
    const answered = facts({ latestReport: () => report("question", now - 2 * HOUR, "?"), turnStartedAt: () => now - HOUR })
    expect(needsMe(row([clanker("idle", now - HOUR)]), answered)).toBeUndefined()
  })

  test("a permission prompt is blocked, naming the kind the harness gave", () => {
    expect(needsMe(row([clanker("blocked", now - HOUR)]), facts())).toEqual({ reason: "blocked", since: now - HOUR, detail: "permission prompt", clankerId: "c1" })
    expect(needsMe(row([clanker("blocked", now - HOUR, { blockedKind: "question", blockedMessage: "Which env?" })]), facts()))
      .toEqual({ reason: "blocked", since: now - HOUR, detail: "question", excerpt: "Which env?", clankerId: "c1" })
  })

  test("a finished turn not yet seen carries the clanker's last words", () => {
    const said = facts({ lastText: () => "Done: 14 files changed, tests pass.\n\nDetails…" })
    expect(needsMe(row([clanker("done", now - 3 * HOUR)]), said)).toEqual({ reason: "finished", since: now - 3 * HOUR, excerpt: "Done: 14 files changed, tests pass.", clankerId: "c1" })
  })

  test("failed, crashed and interrupted clankers are listed", () => {
    expect(needsMe(row([clanker("failed", now - HOUR)]), facts())?.reason).toBe("failed")
    expect(needsMe(row([clanker("unknown", now - HOUR, { gone: true })]), facts())).toMatchObject({ reason: "crashed", detail: "harness exited" })
    expect(needsMe(row([]), facts({ interrupted: () => [{ clankerId: "c9", at: now - 2 * DAY }] })))
      .toEqual({ reason: "crashed", since: now - 2 * DAY, detail: "interrupted", clankerId: "c9" })
  })

  test("a your-move label lists an idle Workshop, with what its clanker last said", () => {
    const labelled = facts({ yourMoveLabel: () => ({ value: "needs-input", at: now - 5 * HOUR }), lastText: () => "Which of the two designs?" })
    expect(needsMe(row([clanker("idle", now - 4 * HOUR)]), labelled))
      .toEqual({ reason: "your-move", since: now - 5 * HOUR, detail: "needs-input", excerpt: "Which of the two designs?", clankerId: "c1" })
    // While a clanker works the label is old news.
    expect(needsMe(row([clanker("working", now - HOUR)]), labelled)).toBeUndefined()
  })

  test("the most pressing reason wins: asked over a finished sibling, a finished turn over a label", () => {
    const sibling = clanker("done", now - 9 * HOUR, { clankerId: "c2" })
    const asked = facts({ latestReport: (id) => id === "c1" ? report("question", now - HOUR, "?") : undefined, yourMoveLabel: () => ({ value: "needs-input", at: now - DAY }) })
    expect(needsMe(row([clanker("idle", now - HOUR), sibling]), asked)?.reason).toBe("asked")
    expect(needsMe(row([sibling]), facts({ yourMoveLabel: () => ({ value: "needs-input", at: now - DAY }) }))?.reason).toBe("finished")
  })

  test("clean and idle a day is ready to close; idle for the retention period is stale", () => {
    const old = Math.floor((now - 2 * DAY) / 1000)
    expect(needsMe(row([clanker("idle", now - 2 * DAY)], { flags: "clean", recency: old }), facts())).toEqual({ reason: "ready", since: now - 2 * DAY, detail: "clean" })
    expect(needsMe(row([clanker("idle", now - 2 * DAY)], { flags: "dirty", recency: old }), facts())).toBeUndefined()
    expect(needsMe(row([], { flags: "dirty", recency: Math.floor((now - 9 * DAY) / 1000) }), facts())).toEqual({ reason: "stale", since: now - 9 * DAY })
    // Recent clanker activity keeps it fresh whatever the session's own recency says.
    expect(needsMe(row([clanker("idle", now - HOUR)], { flags: "clean", recency: old }), facts())).toBeUndefined()
  })

  test("a Done Workshop is listed only for a question, a block, a failure, or as ready to close", () => {
    const done = { labels: ["done"], flags: "clean", recency: Math.floor((now - 2 * DAY) / 1000) }
    const labelled = facts({ yourMoveLabel: () => ({ value: "waiting-for-approval", at: now - 3 * DAY }) })
    // Neither its label nor an unseen finished turn lists it; clean and idle, it can be closed now.
    expect(needsMe(row([clanker("done", now - 2 * DAY)], done), labelled)).toMatchObject({ reason: "ready" })
    expect(needsMe(row([clanker("done", now - HOUR)], { ...done, recency: Math.floor((now - HOUR) / 1000) }), labelled)).toBeUndefined()
    expect(needsMe(row([clanker("blocked", now - 2 * DAY)], done), labelled)).toMatchObject({ reason: "blocked" })
  })

  test("a label row quotes only what its clanker said this turn", () => {
    const labelled = facts({
      yourMoveLabel: () => ({ value: "needs-input", at: now - 5 * HOUR }),
      latestReport: () => report("done", now - 3 * DAY, "Old news."),
      turnStartedAt: () => now - 6 * HOUR,
      lastText: () => "Which of the two?",
    })
    expect(needsMe(row([clanker("idle", now - 4 * HOUR)]), labelled)?.excerpt).toBe("Which of the two?")
  })

  test("only open Workshops are judged; a sessionless row was stopped or closed", () => {
    const sessionless = row([], { target: { type: "directory", path: "/w" }, recency: 0 })
    expect(needsMe(sessionless, facts())).toBeUndefined()
    // An unmanaged session still shows a blocked harness, but no workshop-level reason.
    expect(needsMe(row([], { workshopId: undefined, recency: 0 }), facts())).toBeUndefined()
  })

  test("a snooze holds until the reason changes or its day runs out", () => {
    const asked = facts({ latestReport: () => report("question", now - HOUR, "Which?") })
    const snoozed = (value: string) => needsMe(row([clanker("idle", now - HOUR)]), { ...asked, snooze: () => parseSnooze(value) })
    expect(snoozed(`asked:${now - HOUR}:${now + DAY}`)).toMatchObject({ reason: "asked", snoozedUntil: now + DAY })
    // Asked again later: something new.
    expect(snoozed(`asked:${now - 2 * HOUR}:${now + DAY}`)?.snoozedUntil).toBeUndefined()
    expect(snoozed(`finished:${now - HOUR}:${now + DAY}`)?.snoozedUntil).toBeUndefined()
    expect(snoozed(`asked:${now - HOUR}:${now - 1}`)?.snoozedUntil).toBeUndefined()
    expect(parseSnooze("garbage")).toBeUndefined()
  })

  test("a Workshop waiting on an unsettled one says so", () => {
    const waiting = facts({ latestReport: () => report("question", now - HOUR), waitingOn: () => "pr one" })
    expect(needsMe(row([clanker("idle", now - HOUR)]), waiting)).toMatchObject({ reason: "asked", waitingOn: "pr one" })
  })

  test("counts each open Workshop once", () => {
    const listed = { reason: "asked" as const, since: 1 }
    expect(needsMeCounts([
      row([], { needsMe: listed }),
      row([], { needsMe: listed, target: { type: "session", session: "s2" } }),
      row([], { workshopId: "other" }),
      row([], { workshopId: "gone", target: { type: "directory", path: "/g" }, needsMe: listed }),
    ])).toEqual({ needsMe: 1, open: 2 })
    // Snoozed and waiting rows are listed, not counted.
    expect(needsMeCounts([
      row([], { needsMe: { ...listed, snoozedUntil: 2 } }),
      row([], { workshopId: "w2", needsMe: { ...listed, waitingOn: "x" } }),
    ])).toEqual({ needsMe: 0, open: 2 })
  })

  test("first line and the label setting", () => {
    expect(firstLine("  \n  a   b \n c")).toBe("a b")
    expect(firstLine("x".repeat(200))).toHaveLength(160)
    expect(firstLine(null)).toBeUndefined()
    expect(yourMoveLabels({})).toEqual([{ key: "stage", value: "needs-input" }, { key: "stage", value: "waiting-for-approval" }])
    expect(yourMoveLabels({ CLANKERHOUSE_YOUR_MOVE_LABELS: "review=me, bad" })).toEqual([{ key: "review", value: "me" }])
    expect(yourMoveLabels({ CLANKERHOUSE_YOUR_MOVE_LABELS: "none" })).toEqual([])
  })
})

describe("the needs-me list without the picker", () => {
  const names = (rows: readonly SessionRow[]) => rows.map((row) => row.name)

  test("lists in the picker's order: Alt-I freshest first, Alt-E eldest first, deferred last, flat in snapshot order", () => {
    expect(names(needsMeList(fixture.sessions, "freshest"))).toEqual(fixture.freshest)
    expect(names(needsMeList(fixture.sessions, "eldest"))).toEqual(fixture.eldest)
    expect(names(needsMeList(fixture.sessions, "flat"))).toEqual(fixture.flat)
    expect(needsMeCounts(fixture.sessions)).toEqual(fixture.counts)
    // Deferred rows are listed but not counted: the count is exactly the rows before them.
    const listed = needsMeList(fixture.sessions, "freshest")
    expect(listed.filter((row) => !row.needsMe!.snoozedUntil && !row.needsMe!.waitingOn)).toHaveLength(fixture.counts.needsMe)
    expect(names(listed.slice(fixture.counts.needsMe))).toEqual(["snoozed", "waiting"])
  })

  test("lists the reasons the daemon decided, and leaves a working clanker with nothing asked off", () => {
    const working = row([clanker("working", now - HOUR, { clankerId: "w" })], { name: "working", workshopId: "w0" })
    const asked = row([clanker("idle", now - 2 * HOUR, { clankerId: "a" })], { name: "asked", workshopId: "w1" })
    const finished = row([clanker("done", now - 3 * HOUR, { clankerId: "f" })], { name: "finished", workshopId: "w2" })
    const decided = facts({ latestReport: (id) => id === "a" ? { ...report("question", now - 2 * HOUR, "Ship it?"), clankerId: "a" } : undefined })
    const rows = [working, asked, finished].map((candidate) => ({ ...candidate, needsMe: needsMe(candidate, decided) }))
    const listed = needsMeList(rows, "freshest")
    expect(listed.map((candidate) => [candidate.name, candidate.needsMe?.reason])).toEqual([["asked", "asked"], ["finished", "finished"]])
    expect(needsMeList(rows, "eldest").map((candidate) => candidate.name)).toEqual(["finished", "asked"])
  })

  test("a row names the pane, the session, why, since when, what was said, its labels and when it was made", () => {
    const blocked = fixture.sessions.find((candidate) => candidate.name === "blocked early")!
    expect(needsMeEntry(blocked, 3, { labels: { stage: "needs-input" }, createdAt: 42 })).toMatchObject({
      position: 3, workshopId: "w4", name: "blocked early", session: "early", pane: "%4", clankerId: "c4", state: "blocked",
      target: { type: "window", session: "early", windowId: "@4", pane: "%4" },
      reason: "blocked", since: 2000, detail: "permission prompt", excerpt: null, deferred: false,
      labels: { stage: "needs-input" }, createdAt: 42,
    })
    const snoozed = fixture.sessions.find((candidate) => candidate.name === "snoozed")!
    expect(needsMeEntry(snoozed, 8, {})).toMatchObject({ pane: null, target: { type: "session", session: "snoozed" }, deferred: true, snoozedUntil: 99000, labels: {}, createdAt: null })
    // An hc pane is addressed by its terminal id.
    const hc = row([clanker("done", now, { clankerId: "c1", target: { type: "window", session: "s", windowId: "t1q9", pane: "t1q9", location: { kind: "hc", instanceId: "hc:x", nativeSessionId: "n", nativeWindowId: "t1q9", nativePaneId: "t1q9" } } })], { needsMe: { reason: "finished", since: now, clankerId: "c1" } })
    expect(needsMeEntry(hc, 1, {}).pane).toBe("t1q9")
  })
})

describe("clankers needs-me", () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  /** A daemon socket that answers snapshot.get with the fixture, and a registry with labels and creation times. */
  const daemon = async () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-needs-me-"))
    roots.push(root)
    const instance = "needs-me-test"
    const runtime = join(root, "run", `clankerhouse-${process.getuid!()}-${instance}`)
    mkdirSync(runtime, { recursive: true })
    const state = join(root, "state", `clankerhouse-${instance}`)
    mkdirSync(state, { recursive: true })
    const db = new Database(join(state, "workshops.sqlite3"))
    db.exec(`CREATE TABLE repositories (id TEXT PRIMARY KEY, common_dir TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workshops (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, parent_id TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workshop_labels (workshop_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workshop_id, key));
      PRAGMA user_version = 1;
      INSERT INTO repositories VALUES ('r', '/r/.git', 1, 1);
      INSERT INTO workshops VALUES ('w3', 'r', '/late', 'late', NULL, 1, 1234, 1);
      INSERT INTO workshop_labels VALUES ('w3', 'stage', 'needs-input', 1), ('w3', 'title', 'Late question', 1), ('w3', '_snooze', 'x:1:2', 1);`)
    db.close()
    const server = Bun.listen({
      unix: join(runtime, "daemon.sock"),
      socket: {
        data(socket, data) {
          const request = JSON.parse(data.toString().trim())
          const result = request.method === "snapshot.get" ? { version: 11, revision: { source: "test", sequence: 1 }, generatedAt: 5, sessions: fixture.sessions } : undefined
          socket.write(`${JSON.stringify(result ? { version: 1, id: request.id, ok: true, result } : { version: 1, id: request.id, ok: false, error: { code: "UNSUPPORTED", message: request.method } })}\n`)
        },
      },
    })
    // Only what a headless caller has: no terminal, nothing of the invoking clanker or Herdr.
    const env = { PATH: Bun.env.PATH!, HOME: root, XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state"), CLANKERHOUSE_INSTANCE: instance, CLANKERHOUSE_HOME: repo, CLANKERHOUSE_BIN_DIR: join(repo, "bin"), CLANKERHOUSE_LIBEXEC: join(repo, "libexec") }
    return { env, stop: () => server.stop(true) }
  }

  const run = async (command: string[], env: Record<string, string>) => {
    const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code }
  }

  test("prints the picker's list as JSON with no terminal, in each order", async () => {
    const { env, stop } = await daemon()
    try {
      const freshest = await run([join(repo, "bin/clankers"), "needs-me", "--json"], env)
      expect(freshest.stderr).toBe("")
      const dump = JSON.parse(freshest.stdout)
      expect(dump).toMatchObject({ version: 1, order: "freshest", generatedAt: 5, counts: fixture.counts })
      expect(dump.rows.map((entry: { name: string }) => entry.name)).toEqual(fixture.freshest)
      expect(dump.rows[0]).toMatchObject({ position: 1, workshopId: "w3", session: "late", reason: "asked", since: 9000, excerpt: "Roll back?", labels: { stage: "needs-input" }, createdAt: 1234, deferred: false })
      for (const key of ["pane", "session", "reason", "since", "excerpt", "labels", "createdAt", "workshopId", "title", "project", "deferred", "target"]) expect(dump.rows[0]).toHaveProperty(key)
      expect(dump.rows.slice(-2).map((entry: { deferred: boolean }) => entry.deferred)).toEqual([true, true])
      expect(dump.rows.some((entry: { name: string }) => entry.name === "working")).toBe(false)

      const eldest = JSON.parse((await run([join(repo, "bin/clankers"), "needs-me", "--json", "--eldest"], env)).stdout)
      expect(eldest.rows.map((entry: { name: string }) => entry.name)).toEqual(fixture.eldest)
      const flat = JSON.parse((await run([join(repo, "bin/clankers"), "needs-me", "--json", "--flat"], env)).stdout)
      expect(flat.rows.map((entry: { name: string }) => entry.name)).toEqual(fixture.flat)
      expect(flat.rows[0]).toMatchObject({ name: "working", reason: null, state: "working" })

      // The hc launcher's spelling is the same list and starts nothing.
      const launcher = await run([join(repo, "bin/clankerhouse-hc"), "--needs-me", "--json", "--eldest"], env)
      expect(JSON.parse(launcher.stdout).rows.map((entry: { name: string }) => entry.name)).toEqual(fixture.eldest)

      const text = await run([join(repo, "bin/clankers"), "needs-me"], env)
      expect(text.stdout.split("\n")[0]).toBe(`${fixture.counts.needsMe} need you · ${fixture.counts.open} open`)
      expect(text.stdout).toContain("1. asked late  asked")
    } finally { stop() }
  })

  test("says so when the daemon is down instead of starting one", async () => {
    const { env, stop } = await daemon()
    stop()
    rmSync(join(env.XDG_RUNTIME_DIR, `clankerhouse-${process.getuid!()}-${env.CLANKERHOUSE_INSTANCE}`, "daemon.sock"), { force: true })
    const result = await run([join(repo, "bin/clankers"), "needs-me", "--json"], env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("daemon is not running")
  })

  test("the hc launcher's help and its needs-me view need no terminal and start nothing", async () => {
    const { env, stop } = await daemon()
    stop()
    const help = await run([join(repo, "bin/clankerhouse-hc"), "--help"], env)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("clankerhouse-hc --needs-me --json")
    const view = await run([join(repo, "bin/clankerhouse-hc"), "--needs-me"], env)
    expect(view.code).toBe(2)
    expect(view.stderr).toContain("clankerhouse-hc --needs-me --json")
  })
})

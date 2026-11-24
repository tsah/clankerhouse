import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openClankerLedger, validateLaunchSpec, type LedgerClanker } from "./clanker-ledger"
import type { ClankerReportFacts } from "./clanker-api"
import {
  SHARED_CONFIG_ENTRIES, chooseAccount, claudeAccountEnvironment, claudeAccountsStatus, clearAccountMark, emptyAccountState, loadClaudeAccounts,
  parseClaudeAccounts, parseLimitReset, readAccountState, setupAccountDir, spawnAccount, switchingEnabled, writeAccountState, type ClaudeAccount,
} from "./claude-accounts"
import { SWITCH_COOLDOWN_MS, planAccountSwitches, runAccountSwitchPass, switchCandidates, switchPrompt } from "./claude-account-switch"
import { harnessCommand, resumeLaunch, type HarnessLaunch } from "./harness-launch"
import type { ManagedMultiplexer } from "./multiplexer"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-claude-accounts-"))
  roots.push(root)
  return root
}

/** A fake home: a registry and state under it, never the operator's. */
const fakeEnv = (registry?: string) => {
  const home = scratch()
  const env: Record<string, string | undefined> = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"), CLANKERHOUSE_INSTANCE: "accounts-test" }
  if (registry !== undefined) {
    mkdirSync(join(home, ".config/clankerhouse"), { recursive: true })
    writeFileSync(join(home, ".config/clankerhouse/claude-accounts-accounts-test.toml"), registry)
  }
  return { home, env }
}

const TWO = `
[[account]]
label = "main"

[[account]]
label = "spare"
config_dir = "~/.claude-acct/spare"
`
const THREE = `
[[account]]
label = "work"

[[account]]
label = "personal"
config_dir = "~/.claude-acct/personal"

[[account]]
label = "team"
config_dir = "~/.claude-acct/team"
`
const accounts: ClaudeAccount[] = [{ label: "main", configDir: null }, { label: "spare", configDir: "/home/op/.claude-acct/spare" }, { label: "third", configDir: "/home/op/.claude-acct/third" }]

const ledgerRow = (overrides: Partial<LedgerClanker> = {}): LedgerClanker => ({
  clankerId: "clanker-a", harness: "claude", workshopId: "w", workshopPath: "/tmp/w", sessionLabel: "s", windowLabel: "claude", cwd: "/tmp/w",
  harnessSessionId: "00000000-0000-4000-8000-000000000001", launchSpec: { version: 1, profile: null }, originalTask: "task", state: "open",
  closedReason: null, ownerUnit: "clankerhouse-clanker-a-1.scope", serverEpoch: null, createdAt: 1, updatedAt: 1, ...overrides,
})

const NOW = Date.UTC(2026, 10, 23, 10, 0)
const weekly = { error: "rate_limit", message: "You've hit your weekly limit · resets Nov 26, 11am (UTC)", at: NOW - 1000 }

describe("the Claude account registry", () => {
  test("lists accounts in preference order, expanding ~ and leaving the default config without a directory", () => {
    expect(parseClaudeAccounts(TWO, "/home/op")).toEqual([{ label: "main", configDir: null }, { label: "spare", configDir: "/home/op/.claude-acct/spare" }])
  })

  test("refuses duplicate labels, two default accounts, unknown keys and relative directories", () => {
    expect(() => parseClaudeAccounts(`[[account]]\nlabel="a"\n[[account]]\nlabel="a"\nconfig_dir="/x"`, "/h")).toThrow(/listed twice/)
    expect(() => parseClaudeAccounts(`[[account]]\nlabel="a"\n[[account]]\nlabel="b"`, "/h")).toThrow(/only one account may omit config_dir/)
    expect(() => parseClaudeAccounts(`[[account]]\nlabel="a"\ntoken="x"`, "/h")).toThrow(/unknown keys: token/)
    expect(() => parseClaudeAccounts(`[[account]]\nlabel="a"\nconfig_dir="rel/dir"`, "/h")).toThrow(/absolute/)
    expect(() => parseClaudeAccounts(`[[account]]\nlabel="../x"\nconfig_dir="/x"`, "/h")).toThrow(/label/)
  })

  test("is off with no registry or one account, so a launch is exactly as before", () => {
    const absent = fakeEnv()
    expect(loadClaudeAccounts(absent.env)).toEqual([])
    expect(spawnAccount(absent.env, NOW)).toBeUndefined()
    const one = fakeEnv(`[[account]]\nlabel = "main"\n`)
    expect(switchingEnabled(loadClaudeAccounts(one.env))).toBe(false)
    expect(spawnAccount(one.env, NOW)).toBeUndefined()
    expect(claudeAccountsStatus(one.env, NOW).enabled).toBe(false)
  })

  test("starts a new clanker on the first account whose limit has not been hit", () => {
    const { env } = fakeEnv(TWO)
    expect(spawnAccount(env, NOW)).toBe("main")
    const statePath = join(env.XDG_STATE_HOME!, "clankerhouse-accounts-test", "claude-accounts.json")
    writeAccountState({ ...emptyAccountState(), accounts: { main: { until: NOW + 60_000, error: "rate_limit", message: "", at: NOW } } }, statePath)
    expect(spawnAccount(env, NOW)).toBe("spare")
    expect(spawnAccount(env, NOW + 60_000)).toBe("main")
    // Every account out: the first one, which waits for its reset like any limited clanker.
    writeAccountState({ ...emptyAccountState(), accounts: { main: { until: NOW + 1, error: "rate_limit", message: "", at: NOW }, spare: { until: NOW + 1, error: "rate_limit", message: "", at: NOW } } }, statePath)
    expect(spawnAccount(env, NOW)).toBe("main")
    expect(clearAccountMark("spare", env)).toBe(true)
    expect(spawnAccount(env, NOW)).toBe("spare")
  })
})

describe("launching on an account", () => {
  const workshop = { workshopId: "w", parentWorkshopId: null }
  const launch = (spec: HarnessLaunch["launchSpec"], claudeAccounts = accounts): HarnessLaunch => ({
    harness: "claude", cwd: "/tmp/w", clankerId: "clanker-a", harnessSessionId: "s-1", launchSpec: spec, workshop, prompt: "go", claudeAccounts,
  })
  const run = (input: HarnessLaunch) => harnessCommand(input, "clankerhouse-clanker-a-1.scope")

  test("a pre-accounts launch carries no account environment at all", () => {
    const argv = run(launch({ version: 1, profile: null }))
    expect(argv.some((part) => part.startsWith("CLAUDE_CONFIG_DIR") || part.startsWith("CLANKERHOUSE_CLAUDE_ACCOUNT"))).toBe(false)
    expect(argv).not.toContain("CLAUDE_CONFIG_DIR")
  })

  test("an account with a directory gets CLAUDE_CONFIG_DIR and its label, and nothing secret", () => {
    const argv = run(launch({ version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" }))
    expect(argv).toContain("CLAUDE_CONFIG_DIR=/home/op/.claude-acct/spare")
    expect(argv).toContain("CLANKERHOUSE_CLAUDE_ACCOUNT=spare")
    expect(argv.join(" ")).not.toMatch(/TOKEN|credentials|API_KEY=/i)
    expect(argv.indexOf("CLAUDE_CONFIG_DIR=/home/op/.claude-acct/spare")).toBeLessThan(argv.findIndex((part) => part.endsWith("/clankerhouse-harness-lifecycle")))
  })

  test("the default account clears an inherited CLAUDE_CONFIG_DIR; an account no longer listed runs on the default", () => {
    for (const account of ["main", "gone"]) {
      const argv = run(launch({ version: 4, profile: null, resourceClass: "untrusted", model: null, account }))
      expect(argv[argv.indexOf("CLAUDE_CONFIG_DIR") - 1]).toBe("-u")
      expect(argv.some((part) => part.startsWith("CLAUDE_CONFIG_DIR="))).toBe(false)
    }
    expect(claudeAccountEnvironment(undefined, accounts)).toEqual({ unset: [], set: [] })
  })

  test("a resume on another account keeps the profile, model and resource class", () => {
    const row = ledgerRow({ launchSpec: { version: 3, profile: "builder", resourceClass: "validation-heavy", model: "opus" } })
    const resumed = resumeLaunch(row, workshop, "continue", "spare")
    expect(resumed.launchSpec).toEqual({ version: 4, profile: "builder", resourceClass: "validation-heavy", model: "opus", account: "spare" })
    const argv = harnessCommand({ ...resumed, claudeAccounts: accounts }, "clankerhouse-clanker-a-2.scope")
    expect(argv[argv.indexOf("--resume") + 1]).toBe(row.harnessSessionId!)
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus")
    expect(argv).toContain("CLAUDE_CONFIG_DIR=/home/op/.claude-acct/spare")
    expect(resumeLaunch(row, workshop).launchSpec).toBe(row.launchSpec)
  })

  test("the ledger accepts and records a version 4 launch", () => {
    expect(validateLaunchSpec({ version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" })).toEqual({ version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" })
    expect(() => validateLaunchSpec({ version: 4, profile: null, resourceClass: "untrusted", model: null, account: "a/b" })).toThrow()
    expect(() => validateLaunchSpec({ version: 4, profile: null, resourceClass: "untrusted", model: null })).toThrow()
    const { env } = fakeEnv()
    const previous = { XDG_STATE_HOME: Bun.env.XDG_STATE_HOME, CLANKERHOUSE_INSTANCE: Bun.env.CLANKERHOUSE_INSTANCE }
    Object.assign(Bun.env, { XDG_STATE_HOME: env.XDG_STATE_HOME, CLANKERHOUSE_INSTANCE: env.CLANKERHOUSE_INSTANCE })
    try {
      const ledger = openClankerLedger()
      try {
        const { state: _state, closedReason: _closed, ownerUnit: _unit, serverEpoch: _epoch, createdAt: _created, updatedAt: _updated, ...input } = ledgerRow()
        ledger.record(input)
        ledger.setLaunchSpec("clanker-a", { version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" })
        expect(ledger.get("clanker-a")!.launchSpec).toEqual({ version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" })
      } finally { ledger.close() }
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value } }
  })
})

describe("when a limit resets", () => {
  test("reads the date, time and zone Claude writes", () => {
    expect(parseLimitReset("You've hit your weekly limit · resets Nov 26, 11am (UTC)", NOW)).toBe(Date.UTC(2026, 10, 26, 11))
    expect(parseLimitReset("You've hit your session limit · resets 3pm (UTC)", NOW)).toBe(Date.UTC(2026, 10, 23, 15))
    expect(parseLimitReset("You've hit your session limit · resets 3:30pm (Europe/Amsterdam)", NOW)).toBe(Date.UTC(2026, 10, 23, 14, 30))
    // A time already past today is tomorrow's.
    expect(parseLimitReset("resets 9am (UTC)", NOW)).toBe(Date.UTC(2026, 10, 24, 9))
    // A January reset read in December is next year's.
    expect(parseLimitReset("resets Jan 2, 1am (UTC)", Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 1))
  })

  test("names no time for text it cannot read", () => {
    expect(parseLimitReset("API Error: Request rejected (429)", NOW)).toBeUndefined()
    expect(parseLimitReset("resets 3pm (Not/AZone)", NOW)).toBeUndefined()
  })
})

describe("planning a switch", () => {
  const plan = (candidates: Parameters<typeof planAccountSwitches>[0]["candidates"], options: { state?: ReturnType<typeof emptyAccountState>; rows?: Record<string, LedgerClanker>; now?: number; list?: ClaudeAccount[] } = {}) =>
    planAccountSwitches({ accounts: options.list ?? accounts, state: options.state ?? emptyAccountState(), candidates, ledger: (id) => (options.rows ?? { "clanker-a": ledgerRow() })[id], now: options.now ?? NOW })

  test("does nothing with fewer than two accounts", () => {
    expect(plan([{ clankerId: "clanker-a", turnError: weekly }], { list: [accounts[0]!] }).decisions).toEqual([])
  })

  test("moves a limited clanker to the next account and marks its own account out until Claude's reset", () => {
    const { decisions, state } = plan([{ clankerId: "clanker-a", turnError: weekly }])
    expect(decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "main", to: "spare", error: "rate_limit" }])
    expect(state.accounts.main!.until).toBe(Date.UTC(2026, 10, 26, 11))
    expect(state.handled["clanker-a"]).toBe(weekly.at)
    // One limit moves a clanker once.
    expect(plan([{ clankerId: "clanker-a", turnError: weekly }], { state }).decisions).toEqual([])
  })

  test("a clanker already on an account moves past it, and limits marked by others are skipped", () => {
    const rows = { "clanker-a": ledgerRow({ launchSpec: { version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" } }) }
    const state = { ...emptyAccountState(), accounts: { main: { until: NOW + 3_600_000, error: "rate_limit", message: "", at: NOW } } }
    const { decisions } = plan([{ clankerId: "clanker-a", turnError: weekly }], { rows, state })
    expect(decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "spare", to: "third", error: "rate_limit" }])
  })

  test("waits, without using up the limit, while every account is out; moves once one resets", () => {
    const list = accounts.slice(0, 2)
    const state = { ...emptyAccountState(), accounts: { spare: { until: NOW + 60_000, error: "rate_limit", message: "", at: NOW } } }
    const first = plan([{ clankerId: "clanker-a", turnError: weekly }], { list, state })
    expect(first.decisions).toEqual([{ kind: "wait", clankerId: "clanker-a", reason: "every Claude account is out of usage" }])
    expect(first.state.handled["clanker-a"]).toBeUndefined()
    const later = plan([{ clankerId: "clanker-a", turnError: weekly }], { list, state: first.state, now: NOW + 60_000 })
    expect(later.decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "main", to: "spare", error: "rate_limit" }])
  })

  test("walks any number of accounts in registry order, then waits once every one is out", () => {
    const three = parseClaudeAccounts(THREE, "/home/op")
    expect(three.map((account) => account.label)).toEqual(["work", "personal", "team"])
    expect(switchingEnabled(three)).toBe(true)
    const on = (account: string): Record<string, LedgerClanker> => ({ "clanker-a": ledgerRow({ launchSpec: { version: 4, profile: null, resourceClass: "untrusted", model: null, account } }) })
    const limit = (at: number, reset: string) => ({ error: "rate_limit", message: `You've hit your session limit · resets ${reset} (UTC)`, at })
    const first = planAccountSwitches({ accounts: three, state: emptyAccountState(), candidates: [{ clankerId: "clanker-a", turnError: limit(NOW, "3pm") }], ledger: (id) => on("work")[id], now: NOW })
    expect(first.decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "work", to: "personal", error: "rate_limit" }])
    const later = NOW + SWITCH_COOLDOWN_MS
    const second = planAccountSwitches({ accounts: three, state: first.state, candidates: [{ clankerId: "clanker-a", turnError: limit(later, "4pm") }], ledger: (id) => on("personal")[id], now: later })
    expect(second.decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "personal", to: "team", error: "rate_limit" }])
    const last = later + SWITCH_COOLDOWN_MS
    const third = planAccountSwitches({ accounts: three, state: second.state, candidates: [{ clankerId: "clanker-a", turnError: limit(last, "5pm") }], ledger: (id) => on("team")[id], now: last })
    expect(third.decisions).toEqual([{ kind: "wait", clankerId: "clanker-a", reason: "every Claude account is out of usage" }])
    expect(Object.keys(third.state.accounts).sort()).toEqual(["personal", "team", "work"])
    // The first account to reset takes it: work at 15:00 UTC.
    const reset = planAccountSwitches({ accounts: three, state: third.state, candidates: [{ clankerId: "clanker-a", turnError: limit(last, "5pm") }], ledger: (id) => on("team")[id], now: Date.UTC(2026, 10, 23, 15) })
    expect(reset.decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "team", to: "work", error: "rate_limit" }])
  })

  test("has no upper limit on accounts", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ label: `acct-${index}`, configDir: index ? `/home/op/.claude-acct/acct-${index}` : null }))
    const state = { ...emptyAccountState(), accounts: Object.fromEntries(many.slice(0, 7).map((account) => [account.label, { until: NOW + 60_000, error: "rate_limit", message: "", at: NOW }])) }
    expect(chooseAccount(many, state, NOW)).toBe("acct-7")
  })

  test("never bounces a clanker twice within the cooldown", () => {
    const state = { ...emptyAccountState(), switches: [{ clankerId: "clanker-a", from: "main", to: "spare", error: "rate_limit", at: NOW - 1000 }] }
    const rows = { "clanker-a": ledgerRow({ launchSpec: { version: 4, profile: null, resourceClass: "untrusted", model: null, account: "spare" } }) }
    const second = { ...weekly, at: NOW - 500 }
    expect(plan([{ clankerId: "clanker-a", turnError: second }], { rows, state }).decisions[0]).toMatchObject({ kind: "wait" })
    expect(plan([{ clankerId: "clanker-a", turnError: second }], { rows, state, now: NOW + SWITCH_COOLDOWN_MS }).decisions[0]).toMatchObject({ kind: "switch", to: "main" })
  })

  test("a lost login moves the clanker and passes the account over for hours; other errors are left alone", () => {
    const login = { error: "authentication_failed", message: "Please run /login", at: NOW }
    const { decisions, state } = plan([{ clankerId: "clanker-a", turnError: login }])
    expect(decisions[0]).toMatchObject({ kind: "switch", to: "spare" })
    expect(state.accounts.main!.until).toBe(NOW + 6 * 3_600_000)
    expect(plan([{ clankerId: "clanker-a", turnError: { error: "billing_error", message: "", at: NOW } }]).decisions).toEqual([])
    expect(plan([{ clankerId: "clanker-a", turnError: { error: "server_error", message: "", at: NOW } }]).decisions).toEqual([])
  })

  test("a clanker the ledger cannot resume is reported once", () => {
    const { decisions, state } = plan([{ clankerId: "clanker-x", turnError: weekly }])
    expect(decisions[0]).toMatchObject({ kind: "wait", clankerId: "clanker-x" })
    expect(plan([{ clankerId: "clanker-x", turnError: weekly }], { state }).decisions).toEqual([])
  })

  test("only blocked Claude clankers with a turn error are candidates", () => {
    const row = (id: string, harness: string, state: string, turnError?: typeof weekly) => ({ clanker: { id, harness, state }, turnError } as unknown as ClankerReportFacts)
    expect(switchCandidates([row("a", "claude", "blocked", weekly), row("b", "claude", "done", weekly), row("c", "pi", "blocked", weekly), row("d", "claude", "blocked")]).map((entry) => entry.clankerId)).toEqual(["a"])
  })
})

describe("a switch pass", () => {
  const facts = { clanker: { id: "clanker-a", harness: "claude", state: "blocked", sessionId: "sess", window: "win", pane: "pane" }, harnessSessionId: "s", transcriptPath: "", latestReply: null, turnError: weekly } as unknown as ClankerReportFacts

  test("with switching off it observes nothing", async () => {
    let listed = false
    const decisions = await runAccountSwitchPass({ multiplexer: {} as ManagedMultiplexer, accounts: () => [accounts[0]!], list: async () => { listed = true; return [] } })
    expect(decisions).toEqual([])
    expect(listed).toBe(false)
  })

  test("stops the harness, closes its pane and resumes the session on the next account with a prompt", async () => {
    const { env } = fakeEnv()
    const previous = { XDG_STATE_HOME: Bun.env.XDG_STATE_HOME, CLANKERHOUSE_INSTANCE: Bun.env.CLANKERHOUSE_INSTANCE }
    Object.assign(Bun.env, { XDG_STATE_HOME: env.XDG_STATE_HOME, CLANKERHOUSE_INSTANCE: env.CLANKERHOUSE_INSTANCE })
    try {
      const ledger = openClankerLedger()
      try {
        const { state: _s, closedReason: _c, ownerUnit: _u, serverEpoch: _e, createdAt: _a, updatedAt: _b, ...input } = ledgerRow()
        ledger.record(input)
        ledger.setOwnerUnit("clanker-a", "clankerhouse-clanker-a-1.scope")
      } finally { ledger.close() }
      const calls: string[] = []
      const statePath = join(scratch(), "state.json")
      const multiplexer = { kill: async (location: { nativePaneId: string | null }) => { calls.push(`kill ${location.nativePaneId}`) } } as unknown as ManagedMultiplexer
      const logs: string[] = []
      const decisions = await runAccountSwitchPass({
        multiplexer, statePath, now: () => NOW, log: (line) => logs.push(line),
        accounts: () => accounts.slice(0, 2), list: async () => [facts],
        stop: (unit) => calls.push(`stop ${unit}`),
        readdress: (id) => { calls.push(`readdress ${id}`); return 2 },
        resume: async (id, options) => { calls.push(`resume ${id} ${options.account} ${options.prompt}`) },
      })
      expect(decisions).toEqual([{ kind: "switch", clankerId: "clanker-a", from: "main", to: "spare", error: "rate_limit" }])
      expect(calls).toEqual(["stop clankerhouse-clanker-a-1.scope", "kill pane", "readdress clanker-a", `resume clanker-a spare ${switchPrompt("main", "spare", "rate_limit")}`])
      expect(logs.at(-1)).toContain("moved from main to spare after rate_limit; 2 queued messages follow it")
      expect(readAccountState(statePath).switches).toHaveLength(1)
      // The same limit seen again does nothing.
      calls.length = 0
      await runAccountSwitchPass({ multiplexer, statePath, now: () => NOW, log: () => {}, accounts: () => accounts.slice(0, 2), list: async () => [facts], stop: () => calls.push("stop"), readdress: () => 0, resume: async () => { calls.push("resume") } })
      expect(calls).toEqual([])
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value } }
  })
})

describe("account directories", () => {
  test("link Claude's shared config, never a login or the per-account state file", () => {
    const home = scratch()
    const shared = join(home, ".claude")
    mkdirSync(join(shared, "skills"), { recursive: true })
    writeFileSync(join(shared, "settings.json"), "{}")
    writeFileSync(join(shared, "CLAUDE.md"), "# rules")
    writeFileSync(join(shared, ".claude.json"), "{}")
    const dir = join(home, ".claude-acct", "spare")
    const setup = setupAccountDir(dir, shared)
    expect(setup.linked.sort()).toEqual(["CLAUDE.md", "projects", "settings.json", "skills"])
    for (const entry of setup.linked) expect(readlinkSync(join(dir, entry))).toBe(join(shared, entry))
    expect(existsSync(join(dir, ".claude.json"))).toBe(false)
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false)
    expect((SHARED_CONFIG_ENTRIES as readonly string[]).some((entry) => /credential|\.claude\.json/.test(entry))).toBe(false)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    // Running it again keeps our links and leaves anything else alone.
    writeFileSync(join(shared, "keybindings.json"), "[]")
    writeFileSync(join(dir, "keybindings.json"), "[]")
    const again = setupAccountDir(dir, shared)
    expect(again.linked).toEqual([])
    expect(again.conflicts).toEqual(["keybindings.json"])
    expect(() => setupAccountDir(shared, shared)).toThrow()
  })

  test("status shows each account, its directory and when it is offered again", () => {
    const { env, home } = fakeEnv(TWO)
    mkdirSync(join(home, ".claude-acct/spare"), { recursive: true })
    writeAccountState({ ...emptyAccountState(), accounts: { main: { until: NOW + 60_000, error: "rate_limit", message: "resets 11am (UTC)", at: NOW } } }, join(env.XDG_STATE_HOME!, "clankerhouse-accounts-test", "claude-accounts.json"))
    const status = claudeAccountsStatus(env, NOW)
    expect(status.enabled).toBe(true)
    expect(status.accounts).toEqual([
      { label: "main", configDir: null, directory: "default", available: false, outUntil: new Date(NOW + 60_000).toISOString(), outBecause: "resets 11am (UTC)" },
      { label: "spare", configDir: join(home, ".claude-acct/spare"), directory: "not-used-yet", available: true, outUntil: null, outBecause: null },
    ])
    expect(chooseAccount(loadClaudeAccounts(env), readAccountState(join(env.XDG_STATE_HOME!, "clankerhouse-accounts-test", "claude-accounts.json")), NOW)).toBe("spare")
  })
})

describe("queued messages across a move", () => {
  test("follow the same session to its next launch instead of being fenced", async () => {
    const { OrchestrationStore } = await import("./orchestration")
    const store = OrchestrationStore.open(join(scratch(), "orchestration.sqlite3"))
    try {
      const queued = store.admitMessage({ clankerId: "clanker-a", text: "hello", busy: true, afterGeneration: 1, now: NOW, incarnation: "old-launch" })
      expect(store.readdressQueued("clanker-a")).toBe(1)
      expect(store.fenceIncarnation("clanker-a", "new-launch", NOW + 1)).toEqual([])
      expect(store.pendingMessages("clanker-a").map((message) => message.messageId)).toEqual([queued.messageId])
    } finally { store.close() }
  })
})

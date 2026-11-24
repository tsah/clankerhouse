/**
 * Moves a Claude clanker whose turn ended on a usage limit to another Claude account (src/claude-accounts.ts).
 *
 * Claude's StopFailure hook already records the error a turn ended on (native-client clankerhouse-hook), so the
 * runner sees a limited clanker as `blocked` with `turnError.error = rate_limit` and Claude's own reset time. A pass
 * marks that clanker's account out of usage until then, stops the harness, closes its pane and resumes the exact
 * session on the first account whose limit has not been hit, with a prompt to carry on.
 *
 * With fewer than two accounts the pass does nothing at all, not even observe. When every account is out of usage
 * the clanker stays blocked as before (and Claude's own auto-continue, if on, still waits for the reset); the next
 * pass after any account's reset moves it.
 */
import { listClankerReportFacts, type ClankerReportFacts } from "./clanker-api"
import { launchAccount, openClankerLedger, type LedgerClanker } from "./clanker-ledger"
import {
  chooseAccount, claudeAccountStatePath, loadClaudeAccounts, parseLimitReset, readAccountState, switchingEnabled, writeAccountState,
  type ClaudeAccount, type ClaudeAccountState,
} from "./claude-accounts"
import { stopOwnedHarness } from "./harness-launch"
import type { ManagedMultiplexer } from "./multiplexer"
import { paneLocation } from "./multiplexer/interface"
import { withOrchestrationStore } from "./orchestration"
import { resumeClanker } from "./workflow"

/** Turn errors another account can clear: out of usage, or this account's login is gone. */
const SWITCHABLE = new Set(["rate_limit", "authentication_failed", "oauth_org_not_allowed"])
/** How long an account is passed over when Claude's text names no reset time. */
const FALLBACK_LIMIT_MS = 60 * 60_000
/** A login problem waits for the operator; offer the account again after this in case it was fixed. */
const LOGIN_PROBLEM_MS = 6 * 60 * 60_000
/** One clanker moves at most once in this window, so two accounts that both fail cannot bounce it in a loop. */
export const SWITCH_COOLDOWN_MS = 5 * 60_000

export const switchPrompt = (from: string | null, to: string, error: string) =>
  `[clankerhouse] Your last turn stopped on ${error === "rate_limit" ? "a Claude usage limit" : "a Claude account error"}${from ? ` on account ${from}` : ""}. Clankerhouse resumed this same session on account ${to}. Continue exactly where you left off.`

export interface SwitchCandidate {
  clankerId: string
  turnError: { error: string; message: string; at: number }
}

export type SwitchDecision =
  | { kind: "switch"; clankerId: string; from: string | null; to: string; error: string }
  | { kind: "wait"; clankerId: string; reason: string }

/**
 * What one pass does, and the account state after it. Pure: `ledger` answers a clanker's ledger row.
 * A clanker on a pre-accounts launch runs on Claude's default config, which is the account without a config_dir.
 */
export const planAccountSwitches = (input: {
  accounts: readonly ClaudeAccount[]
  state: ClaudeAccountState
  candidates: readonly SwitchCandidate[]
  ledger: (clankerId: string) => LedgerClanker | undefined
  now: number
}): { decisions: SwitchDecision[]; state: ClaudeAccountState } => {
  const { accounts, candidates, ledger, now } = input
  const state: ClaudeAccountState = { ...input.state, accounts: { ...input.state.accounts }, handled: { ...input.state.handled }, switches: [...input.state.switches] }
  const decisions: SwitchDecision[] = []
  if (!switchingEnabled(accounts)) return { decisions, state }
  const defaultLabel = accounts.find((account) => account.configDir === null)?.label ?? null
  for (const { clankerId, turnError } of candidates) {
    if (!SWITCHABLE.has(turnError.error)) continue
    if ((state.handled[clankerId] ?? 0) >= turnError.at) continue
    const row = ledger(clankerId)
    if (!row || row.harness !== "claude" || !row.harnessSessionId) {
      decisions.push({ kind: "wait", clankerId, reason: "not a ledger Claude clanker with a session to resume" })
      state.handled[clankerId] = turnError.at
      continue
    }
    const launched = launchAccount(row.launchSpec)
    const from = launched !== undefined && accounts.some((account) => account.label === launched) ? launched : defaultLabel
    // The account is out until its reset, whatever happens to this clanker; the longest mark wins.
    if (from) {
      const until = turnError.error === "rate_limit" ? parseLimitReset(turnError.message, turnError.at) ?? turnError.at + FALLBACK_LIMIT_MS : turnError.at + LOGIN_PROBLEM_MS
      const previous = state.accounts[from]
      if (!previous || previous.until < until) state.accounts[from] = { until, error: turnError.error, message: turnError.message.slice(0, 300), at: turnError.at }
    }
    const lastSwitch = state.switches.findLast((entry) => entry.clankerId === clankerId)
    if (lastSwitch && now - lastSwitch.at < SWITCH_COOLDOWN_MS) {
      decisions.push({ kind: "wait", clankerId, reason: `moved to ${lastSwitch.to} under ${SWITCH_COOLDOWN_MS / 60_000} minutes ago` })
      continue
    }
    const to = chooseAccount(accounts, state, now, from)
    if (!to) {
      // Not handled: the next pass after any account's reset moves it.
      decisions.push({ kind: "wait", clankerId, reason: "every Claude account is out of usage" })
      continue
    }
    state.handled[clankerId] = turnError.at
    state.switches.push({ clankerId, from, to, error: turnError.error, at: now })
    decisions.push({ kind: "switch", clankerId, from, to, error: turnError.error })
  }
  return { decisions, state }
}

export const switchCandidates = (rows: readonly ClankerReportFacts[]): SwitchCandidate[] =>
  rows.flatMap((row) => row.clanker.harness === "claude" && row.clanker.state === "blocked" && row.turnError && row.turnError.at > 0
    ? [{ clankerId: row.clanker.id, turnError: row.turnError }]
    : [])

export interface SwitchPassOptions {
  multiplexer: ManagedMultiplexer
  log?: (line: string) => void
  now?: () => number
  /** Seams for tests; default to the live implementations. */
  list?: () => Promise<ClankerReportFacts[]>
  stop?: (unit: string) => void
  resume?: (clankerId: string, options: { account: string; prompt: string; multiplexer: ManagedMultiplexer }) => Promise<unknown>
  accounts?: () => ClaudeAccount[]
  statePath?: string
  readdress?: (clankerId: string) => number
  /** How long a resume waits for the closed pane to leave the Multiplexer's view. */
  settleMs?: number
}

/** One switch pass; returns what it decided. Logs each waiting reason once per clanker until it changes. */
const lastWaitReason = new Map<string, string>()
export const runAccountSwitchPass = async (options: SwitchPassOptions): Promise<SwitchDecision[]> => {
  const accounts = (options.accounts ?? loadClaudeAccounts)()
  if (!switchingEnabled(accounts)) return []
  const log = options.log ?? ((line: string) => console.error(`Claude accounts: ${line}`))
  const rows = await (options.list ?? (() => listClankerReportFacts({ multiplexer: options.multiplexer })))()
  const candidates = switchCandidates(rows)
  if (!candidates.length) return []
  const statePath = options.statePath ?? claudeAccountStatePath()
  const ledger = openClankerLedger()
  let rowsById: Map<string, LedgerClanker>
  try { rowsById = new Map(candidates.flatMap(({ clankerId }) => { const row = ledger.get(clankerId); return row ? [[clankerId, row] as const] : [] })) }
  finally { ledger.close() }
  const { decisions, state } = planAccountSwitches({ accounts, state: readAccountState(statePath), candidates, ledger: (id) => rowsById.get(id), now: (options.now ?? Date.now)() })
  // Written before acting, so a crash mid-switch never moves the same limit twice.
  writeAccountState(state, statePath)
  for (const decision of decisions) {
    if (decision.kind === "wait") {
      if (lastWaitReason.get(decision.clankerId) !== decision.reason) log(`${decision.clankerId} stays blocked: ${decision.reason}`)
      lastWaitReason.set(decision.clankerId, decision.reason)
      continue
    }
    lastWaitReason.delete(decision.clankerId)
    const row = rows.find((candidate) => candidate.clanker.id === decision.clankerId)!.clanker
    const ownerUnit = rowsById.get(decision.clankerId)?.ownerUnit
    try {
      // The turn already ended, so nothing is lost; resume refuses while the old harness or its pane lives.
      if (ownerUnit) {
        try { (options.stop ?? stopOwnedHarness)(ownerUnit) }
        catch (error) { log(`${decision.clankerId}: stopping ${ownerUnit} failed (${(error as Error).message}); closing its pane instead`) }
      }
      await options.multiplexer.kill(paneLocation(row.sessionId, row.window, row.pane)).catch(() => {})
      // The same conversation continues, so messages queued for it wait for the new launch instead of being fenced.
      const readdressed = (options.readdress ?? ((id: string) => withOrchestrationStore((store) => store.readdressQueued(id))))(decision.clankerId)
      const resume = () => (options.resume ?? resumeClanker)(decision.clankerId, { account: decision.to, prompt: switchPrompt(decision.from, decision.to, decision.error), multiplexer: options.multiplexer })
      // The closed pane can take a moment to leave the Multiplexer's view.
      const deadline = Date.now() + (options.settleMs ?? 15_000)
      for (;;) {
        try { await resume(); break }
        catch (error) {
          if (!/already running|still runs in/.test((error as Error).message) || Date.now() > deadline) throw error
          await Bun.sleep(250)
        }
      }
      log(`${decision.clankerId} moved from ${decision.from ?? "Claude's default account"} to ${decision.to} after ${decision.error}${readdressed ? `; ${readdressed} queued message${readdressed === 1 ? "" : "s"} follow it` : ""}`)
    } catch (error) {
      // Tried again by the first pass after the cooldown.
      const latest = readAccountState(statePath)
      delete latest.handled[decision.clankerId]
      writeAccountState(latest, statePath)
      log(`${decision.clankerId}: moving to ${decision.to} failed: ${(error as Error).message}; a pass retries in ${SWITCH_COOLDOWN_MS / 60_000} minutes, or resume it by hand with: clankers resume ${decision.clankerId} --account ${decision.to}`)
    }
  }
  return decisions
}

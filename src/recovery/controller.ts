import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { RECOVERY_POLICY, type DesiredClankerRecord, type ProcessIdentity } from "./model"
import { initialHarnessCommand, recoveryHarnessCommand } from "./harness"
import { openRecoveryStore, type RecoveryStore } from "./store"
import { recordRecoveryIncident } from "../incidents"
import { ensureManagedTmuxSession } from "../multiplexer"
import { parseTmuxFields, tmuxFields } from "../tmux-fields"
import { readRecoveryHostState, recoveryAdmissionDecision, type RecoveryHostState } from "./admission"
import { recoveryUnitName } from "./process-owner"
import { decideRecovery } from "./planner"

const sleep = (ms: number) => Bun.sleep(ms)
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return path } }

interface CommandResult { code: number; stdout: string; stderr: string }
const command = async (argv: string[], allowFailure = false): Promise<CommandResult> => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `${argv.join(" ")} exited ${code}`)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

export const linuxBootId = (path = Bun.env.CLANKERHOUSE_BOOT_ID_PATH || "/proc/sys/kernel/random/boot_id") => readFileSync(path, "utf8").trim()
export const processStartTicks = (pid = process.pid, procRoot = Bun.env.CLANKERHOUSE_PROC_ROOT || "/proc") => {
  const text = readFileSync(`${procRoot}/${pid}/stat`, "utf8")
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  return Number(fields[19])
}

export interface ObservedPane {
  pane: string
  session: string
  clankerId: string
  harness: string
  harnessSessionId: string
  recoveryAttemptId: string
}

export const observePanes = async (): Promise<ObservedPane[]> => {
  const result = await command(["tmux", "list-panes", "-a", "-F", tmuxFields("#{pane_id}", "#{session_name}", "#{@clankerhouse_clanker_id}", "#{@dotfiles_harness}", "#{@clankerhouse_harness_session_id}", "#{@clankerhouse_recovery_attempt}")], true)
  if (result.code !== 0) return []
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [pane = "", session = "", clankerId = "", harness = "", harnessSessionId = "", recoveryAttemptId = ""] = parseTmuxFields(line)
    return { pane, session, clankerId, harness, harnessSessionId, recoveryAttemptId }
  }).filter((row) => row.pane && row.session)
}

interface ObservedSession { id: string; name: string; path: string; workshopId: string }
const observeSessions = async (): Promise<ObservedSession[]> => {
  const result = await command(["tmux", "list-sessions", "-F", tmuxFields("#{session_id}", "#{session_name}", "#{@dotfiles_worktree_path}", "#{session_path}", "#{@dotfiles_workshop_id}")], true)
  if (result.code !== 0) return []
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", taggedPath = "", sessionPath = "", workshopId = ""] = parseTmuxFields(line)
    return { id, name, path: taggedPath || sessionPath, workshopId }
  })
}

const ensureWorkshop = async (desired: DesiredClankerRecord) => {
  const sessions = await observeSessions()
  const existing = sessions.find((row) => row.workshopId === desired.workshopId || realpathSafe(row.path) === realpathSafe(desired.workshopPath))
  if (existing) return existing.name
  if (!existsSync(desired.workshopPath)) throw new Error(`Workshop path no longer exists: ${desired.workshopPath}`)
  let name = desired.tmuxSessionName
  if (sessions.some((row) => row.name === name)) name = `${name}-${createHash("sha256").update(desired.workshopPath).digest("hex").slice(0, 8)}`
  await command(["tmux", "new-session", "-d", "-s", name, "-n", "main", "-c", desired.workshopPath, Bun.env.SHELL || "/bin/sh"])
  await command(["tmux", "set-option", "-t", name, "@dotfiles_worktree_path", desired.workshopPath])
  await command(["tmux", "set-option", "-t", name, "@dotfiles_workshop_id", desired.workshopId])
  return name
}

const nextWindowName = async (session: string, preferred: string) => {
  const result = await command(["tmux", "list-windows", "-t", `=${session}`, "-F", "#{window_name}"], true)
  const names = new Set(result.stdout.split("\n").filter(Boolean))
  let name = preferred
  let suffix = 2
  while (names.has(name)) name = `${preferred}-${suffix++}`
  return name
}

const backoffRemaining = (desired: DesiredClankerRecord, store: RecoveryStore, now: number) => {
  const attempts = store.attemptsFor(desired.clankerId)
  const latest = attempts.at(-1)
  if (!latest || latest.status === "succeeded" || latest.status === "running" || !latest.finishedAt) return 0
  const exponent = Math.min(Math.max(0, latest.attempt - 1), RECOVERY_POLICY.maxConsecutiveFailures - 1)
  const delay = Math.min(RECOVERY_POLICY.maxBackoffMs, RECOVERY_POLICY.initialBackoffMs * (2 ** exponent))
  return Math.max(0, latest.finishedAt + delay - now)
}

export interface ReconcileResult { launched: string[]; adopted: string[]; pending: string[]; skipped: Array<{ clankerId: string; reason: string }> }
export interface ReconcileOptions { trigger?: string; now?: number; allowLaunch?: boolean; automatic?: boolean; automaticCandidates?: string[]; clankerId?: string; bootEpoch?: number; hostState?: RecoveryHostState; bypassAdmission?: boolean }

export const reconcileRecovery = async (providedStore?: RecoveryStore, options: ReconcileOptions = {}): Promise<ReconcileResult> => {
  const ownStore = !providedStore
  const store = providedStore ?? openRecoveryStore()
  const result: ReconcileResult = { launched: [], adopted: [], pending: [], skipped: [] }
  try {
    const now = options.now ?? Date.now()
    let panes = await observePanes()
    for (const original of store.listDesired()) {
      if (options.clankerId && original.clankerId !== options.clankerId) continue
      let desired = original
      const matching = panes.filter((pane) => pane.clankerId === desired.clankerId)
      const automaticCandidate = !options.automatic || !options.automaticCandidates || options.automaticCandidates.includes(desired.clankerId)
      const decide = () => decideRecovery({
        desired,
        matchingPanes: matching,
        allowLaunch: Boolean(options.allowLaunch),
        automaticCandidate,
        backoffRemainingMs: backoffRemaining(desired, store, now),
        activeRecoveries: store.listDesired().filter((row) => row.desiredState === "running" && row.recoveryCondition === "recovering").length,
      })
      let decision = decide()
      if (decision.type === "mark-pending") {
        desired = store.markRecoveryPending(desired.clankerId, decision.reason, { now })
        if (desired.recoveryCondition === "interrupted_unknown") {
          recordRecoveryIncident("interrupted_tool_requires_confirmation", { clankerId: desired.clankerId, harness: desired.harness, worktreePath: desired.workshopPath, cwd: desired.cwd }, { reason: "owned recovery process disappeared before a settled checkpoint" })
        }
        decision = decide()
      }
      if (decision.type === "ignore") continue
      if (decision.type === "adopt") {
        const latest = store.attemptsFor(desired.clankerId).at(-1)
        if (latest) store.markRecoveryStable(desired.clankerId, latest.id, { now })
        result.adopted.push(desired.clankerId)
        continue
      }
      if (decision.type === "block" || decision.type === "defer") {
        result.skipped.push({ clankerId: desired.clankerId, reason: decision.reason })
        continue
      }
      if (decision.type === "pending") {
        result.pending.push(desired.clankerId)
        result.skipped.push({ clankerId: desired.clankerId, reason: decision.reason })
        continue
      }
      const activeRecoveries = store.listDesired().filter((row) => row.desiredState === "running" && row.recoveryCondition === "recovering").length
      if (!options.bypassAdmission) {
        const host = options.hostState ?? readRecoveryHostState()
        if (!host) {
          result.skipped.push({ clankerId: desired.clankerId, reason: "resource guard has not published admission health" })
          continue
        }
        const decision = recoveryAdmissionDecision({ ...host, now, activeRecoveries, lastAdmissionAt: store.getMetadata<number>("recovery.last_admission_at") ?? host.lastAdmissionAt })
        if (!decision.admit) {
          result.skipped.push({ clankerId: desired.clankerId, reason: decision.reason })
          continue
        }
      }
      for (const previous of store.attemptsFor(desired.clankerId).filter((attempt) => attempt.status === "running")) {
        store.finishAttempt(previous.id, "abandoned", { error: "operator admitted recovery after interrupted attempt", now })
      }
      const previousSucceeded = store.attemptsFor(desired.clankerId).some((attempt) => attempt.status === "succeeded")
      const admission = store.admitRecovery(desired.clankerId, { automatic: Boolean(options.automatic), bootEpoch: options.bootEpoch ?? store.runtimeEpochs().bootEpoch, trigger: previousSucceeded ? options.trigger || "recovery" : "initial", now })
      if (!admission.admitted || !admission.attempt) {
        const current = store.getDesired(desired.clankerId)
        if (current?.recoveryCondition === "quarantined") {
          recordRecoveryIncident("recovery_quarantined", { clankerId: current.clankerId, harness: current.harness, worktreePath: current.workshopPath, cwd: current.cwd }, { reason: admission.reason || "recovery policy circuit breaker" })
        }
        result.skipped.push({ clankerId: desired.clankerId, reason: admission.reason || "recovery admission denied" })
        continue
      }
      const attempt = admission.attempt
      const attemptId = String(attempt.id)
      store.setRecoveryOwner(desired.clankerId, recoveryUnitName(desired.clankerId, attemptId), { now })
      store.setMetadata("recovery.last_admission_at", now, { now })
      try {
        const session = await ensureWorkshop(desired)
        const windowName = await nextWindowName(session, desired.tmuxWindowName)
        const argv = previousSucceeded
          ? recoveryHarnessCommand(desired, attemptId)
          : initialHarnessCommand({ harness: desired.harness, cwd: desired.cwd, prompt: desired.originalTask, clankerId: desired.clankerId, harnessSessionId: desired.harnessSessionId, launchSpec: desired.launchSpec, attemptId })
        const launched = await command(["tmux", "new-window", "-d", "-P", "-F", tmuxFields("#{window_id}", "#{pane_id}"), "-t", `=${session}`, "-n", windowName, "-c", desired.cwd, ...argv])
        const [window = "", pane = ""] = parseTmuxFields(launched.stdout)
        if (!pane) throw new Error("tmux did not return a pane id")
        await command(["tmux", "set-option", "-p", "-t", pane, "@clankerhouse_clanker_id", desired.clankerId])
        await command(["tmux", "set-option", "-p", "-t", pane, "@dotfiles_harness", desired.harness])
        await command(["tmux", "set-option", "-p", "-t", pane, "@clankerhouse_recovery_attempt", attemptId])
        if (desired.harnessSessionId) await command(["tmux", "set-option", "-p", "-t", pane, "@clankerhouse_harness_session_id", desired.harnessSessionId])
        if (window) await command(["tmux", "set-option", "-w", "-t", window, "@dotfiles_harness", desired.harness])
        await ensureManagedTmuxSession(session)
        result.launched.push(desired.clankerId)
        panes = [...panes, { pane, session, clankerId: desired.clankerId, harness: desired.harness, harnessSessionId: desired.harnessSessionId || "", recoveryAttemptId: attemptId }]
      } catch (error) {
        store.finishAttempt(attempt.id, "failed", { error: error instanceof Error ? error.message : String(error), now: Date.now() })
        result.skipped.push({ clankerId: desired.clankerId, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  } finally {
    if (ownStore) store.close()
  }
}

export const controllerIdentity = (): ProcessIdentity => ({ bootId: linuxBootId(), pid: process.pid, processStartTicks: processStartTicks() })

const tmuxServerEpoch = async () => {
  const current = await command(["tmux", "show-options", "-gqv", "@clankerhouse_server_epoch"], true)
  if (current.code !== 0) return undefined
  if (current.stdout) return current.stdout
  const epoch = randomUUID()
  await command(["tmux", "set-option", "-g", "@clankerhouse_server_epoch", epoch])
  return epoch
}

export interface RecoveryCampaign {
  version: 1
  bootEpoch: number
  bootId: string
  startedAt: number
  pending: string[]
  blocked: Array<{ clankerId: string; reason: string }>
  status: "active" | "completed" | "completed_with_blocks"
}

export const startRecoveryCampaign = (bootEpoch: number, bootId: string, candidates: string[], startedAt: number): RecoveryCampaign => ({
  version: 1,
  bootEpoch,
  bootId,
  startedAt,
  pending: [...candidates],
  blocked: [],
  status: "active",
})

export const advanceRecoveryCampaign = (campaign: RecoveryCampaign, desiredRows: DesiredClankerRecord[], adopted: string[]): RecoveryCampaign => {
  const blocked = [...campaign.blocked]
  const byId = new Map(desiredRows.map((row) => [row.clankerId, row]))
  const pending = campaign.pending.filter((clankerId) => {
    const desired = byId.get(clankerId)
    if (!desired || desired.desiredState !== "running") return false
    if (desired.recoveryCondition === "quarantined" || desired.recoveryCondition === "interrupted_unknown") {
      if (!blocked.some((row) => row.clankerId === clankerId)) blocked.push({ clankerId, reason: desired.quarantineReason || desired.recoveryCondition })
      return false
    }
    return !(desired.recoveryCondition === "healthy" && adopted.includes(clankerId))
  })
  return { ...campaign, pending, blocked, status: pending.length ? "active" : blocked.length ? "completed_with_blocks" : "completed" }
}

export class RecoveryController {
  readonly ownerToken = randomUUID()
  private stopped = false
  constructor(readonly store = openRecoveryStore(), readonly intervalMs = Number(Bun.env.CLANKERHOUSE_RECOVERY_INTERVAL_MS || 10_000)) {}

  stop() { this.stopped = true }

  async run(options: { once?: boolean } = {}) {
    const identity = controllerIdentity()
    const scope = { kind: "global" } as const
    while (!this.stopped) {
      const lease = this.store.acquireLease({ ...identity, scope, ownerToken: this.ownerToken, ttlMs: Math.max(10_000, this.intervalMs * 4) })
      if (lease) {
        const previousBoot = this.store.runtimeEpochs().bootId
        const epochs = this.store.observeBoot(identity.bootId)
        const hardReboot = Boolean(previousBoot && previousBoot !== identity.bootId)
        const beforeServerEpoch = await tmuxServerEpoch()
        const recordedServerEpoch = this.store.getMetadata<string>("runtime.tmux_server_epoch")
        const trigger = hardReboot ? "hard_reboot" : recordedServerEpoch && beforeServerEpoch && recordedServerEpoch !== beforeServerEpoch ? "tmux_restart" : "reconcile"
        const automaticEnabled = Bun.env.CLANKERHOUSE_AUTO_RECOVER === undefined ? RECOVERY_POLICY.automaticRecovery : Bun.env.CLANKERHOUSE_AUTO_RECOVER !== "0"
        let campaign = this.store.getMetadata<RecoveryCampaign>("recovery.campaign")
        if (hardReboot && automaticEnabled && campaign?.bootEpoch !== epochs.bootEpoch) {
          campaign = startRecoveryCampaign(epochs.bootEpoch, identity.bootId, this.store.listDesired().filter((row) => row.desiredState === "running").map((row) => row.clankerId), Date.now())
          this.store.setMetadata("recovery.last_admission_at", null)
          this.store.setMetadata("recovery.campaign", campaign)
        }
        const activeCampaign = automaticEnabled && campaign?.status === "active" && campaign.bootEpoch === epochs.bootEpoch ? campaign : undefined
        const result = await reconcileRecovery(this.store, {
          trigger,
          allowLaunch: Boolean(activeCampaign),
          automatic: Boolean(activeCampaign),
          automaticCandidates: activeCampaign?.pending,
          bootEpoch: epochs.bootEpoch,
        })
        if (activeCampaign) {
          campaign = advanceRecoveryCampaign(activeCampaign, this.store.listDesired({ includeTombstoned: true }), result.adopted)
          if (JSON.stringify(campaign) !== JSON.stringify(activeCampaign)) this.store.setMetadata("recovery.campaign", campaign)
        }
        const serverEpoch = await tmuxServerEpoch()
        if (serverEpoch && serverEpoch !== recordedServerEpoch) {
          if (recordedServerEpoch) this.store.advanceTmuxEpoch()
          this.store.setMetadata("runtime.tmux_server_epoch", serverEpoch)
        }
        this.store.renewLease({ ...identity, scope, ownerToken: this.ownerToken }, Math.max(10_000, this.intervalMs * 4))
      }
      if (options.once && lease) break
      await sleep(this.intervalMs)
    }
    this.store.releaseLease({ ...identity, scope, ownerToken: this.ownerToken })
  }

  close() { this.store.close() }
}

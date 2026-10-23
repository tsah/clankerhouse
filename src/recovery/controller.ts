import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { RECOVERY_POLICY, type DesiredClankerRecord, type ProcessIdentity } from "./model"
import { admittedHarnessCommand, workshopEnvironment } from "./harness"
import { workshopLaunchIdentity } from "../workshop"
import { openRecoveryStore, type RecoveryStore } from "./store"
import { recordRecoveryIncident } from "../incidents"
import { ensureManagedSession, openManagedMultiplexer, type ManagedMultiplexer } from "../multiplexer"
import { paneLocation, sessionLocation, windowLocation } from "../multiplexer/interface"
import { readRecoveryHostState, recoveryAdmissionDecision, type RecoveryHostState } from "./admission"
import { recoveryUnitName } from "./process-owner"
import { decideRecovery } from "./planner"
import { gatePanesFor, observePanes } from "./panes"
import { forgetReportedResumes, GATE_LAUNCH_TIMEOUT_MS, publishGateWait, readGateAdmission, recordGateAdmission, reportResumeCommand, signalGateAdmitted } from "./gate"

const sleep = (ms: number) => Bun.sleep(ms)
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return path } }
const spawnedRuntimeEnv = (): Record<string, string> => {
  const instance = Bun.env.CLANKERHOUSE_INSTANCE?.trim()
  return instance ? { CLANKERHOUSE_INSTANCE: instance } : {}
}

export const linuxBootId = (path = Bun.env.CLANKERHOUSE_BOOT_ID_PATH || "/proc/sys/kernel/random/boot_id") => readFileSync(path, "utf8").trim()
export const processStartTicks = (pid = process.pid, procRoot = Bun.env.CLANKERHOUSE_PROC_ROOT || "/proc") => {
  const text = readFileSync(`${procRoot}/${pid}/stat`, "utf8")
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  return Number(fields[19])
}

interface ObservedSession { id: string; name: string; path: string; workshopId: string; windowNames: string[] }
const observeSessions = async (multiplexer: ManagedMultiplexer): Promise<ObservedSession[]> => {
  let snapshot
  try { snapshot = await multiplexer.observe({ processInfo: false }) }
  catch { return [] }
  return snapshot.sessions.map((session) => ({ id: session.id, name: session.nativeName, path: session.worktreePath || session.path, workshopId: session.workshopId || "", windowNames: session.windows.map((window) => window.nativeName) }))
}

const resolveWorkshop = async (desired: DesiredClankerRecord, multiplexer: ManagedMultiplexer) => {
  const sessions = await observeSessions(multiplexer)
  const existing = sessions.find((row) => row.workshopId === desired.workshopId || realpathSafe(row.path) === realpathSafe(desired.workshopPath))
  if (existing) return existing
  if (!existsSync(desired.workshopPath)) throw new Error(`Workshop path no longer exists: ${desired.workshopPath}`)
  let name = desired.preferredSessionLabel
  if (sessions.some((row) => row.name === name)) name = `${name}-${createHash("sha256").update(desired.workshopPath).digest("hex").slice(0, 8)}`
  return { id: undefined, name, path: desired.workshopPath, workshopId: desired.workshopId, windowNames: [] }
}

const nextWindowName = (existing: string[], preferred: string) => {
  const names = new Set(existing)
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
export interface ReconcileOptions { trigger?: string; now?: number; allowLaunch?: boolean; automatic?: boolean; automaticCandidates?: string[]; clankerId?: string; bootEpoch?: number; hostState?: RecoveryHostState; bypassAdmission?: boolean; multiplexer?: ManagedMultiplexer }

export const reconcileRecovery = async (providedStore?: RecoveryStore, options: ReconcileOptions = {}): Promise<ReconcileResult> => {
  const ownStore = !providedStore
  const store = providedStore ?? openRecoveryStore()
  const result: ReconcileResult = { launched: [], adopted: [], pending: [], skipped: [] }
  const multiplexer = options.multiplexer ?? openManagedMultiplexer()
  try {
    const now = options.now ?? Date.now()
    let panes = await observePanes(multiplexer)
    for (const original of store.listDesired()) {
      if (options.clankerId && original.clankerId !== options.clankerId) continue
      let desired = original
      const matching = panes.filter((pane) => pane.clankerId === desired.clankerId)
      // A Herdr-restored pane whose resume gate waits for this Clanker (ADR-0009).
      const gates = gatePanesFor(panes, desired.clankerId)
      const hold = (reason: string) => {
        result.skipped.push({ clankerId: desired.clankerId, reason })
        if (gates.length === 1) publishGateWait(desired, reason)
      }
      const gateAdmission = readGateAdmission(store, desired.clankerId)
      const admittedAttempt = store.attemptsFor(desired.clankerId).at(-1)
      if (!matching.length && gateAdmission && !gateAdmission.launchedAt && admittedAttempt?.id === gateAdmission.attemptId && admittedAttempt.status === "running") {
        const waiting = gates.some((gate) => gate.pane === gateAdmission.pane)
        if (waiting && now - gateAdmission.admittedAt < GATE_LAUNCH_TIMEOUT_MS) {
          result.skipped.push({ clankerId: desired.clankerId, reason: "waiting for the resume gate to launch" })
          continue
        }
        // No harness ran, so this is not interrupted work: return to pending.
        desired = store.abandonAdmission(desired.clankerId, admittedAttempt.id, waiting ? "resume gate did not launch" : "resume gate pane closed before launch", { now })
      }
      const runtimeResumed = desired.harnessSessionId
        ? panes.find((pane) => !pane.clankerId && pane.runtimeSession?.agent === desired.harness && pane.runtimeSession.value === desired.harnessSessionId)?.pane
        : undefined
      const automaticCandidate = !options.automatic || !options.automaticCandidates || options.automaticCandidates.includes(desired.clankerId)
      const decide = () => decideRecovery({
        desired,
        matchingPanes: matching,
        gatePanes: gates.map((gate) => gate.pane),
        runtimeResumedPane: runtimeResumed,
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
        await reportResumeCommand(multiplexer, decision.pane, desired, now)
        result.adopted.push(desired.clankerId)
        continue
      }
      if (decision.type === "block" || decision.type === "defer") {
        hold(decision.reason)
        continue
      }
      if (decision.type === "pending") {
        result.pending.push(desired.clankerId)
        hold(decision.reason)
        continue
      }
      const gatePane = decision.type === "consider-admission" ? decision.gatePane : undefined
      const gate = gates.find((candidate) => candidate.pane === gatePane)
      // The fallback relaunch creates a pane, so it must not spend an attempt while the Multiplexer is down.
      if (!gate && typeof multiplexer.available === "function" && !await multiplexer.available().catch(() => false)) {
        hold("multiplexer unavailable")
        continue
      }
      const activeRecoveries = store.listDesired().filter((row) => row.desiredState === "running" && row.recoveryCondition === "recovering").length
      if (!options.bypassAdmission) {
        const host = options.hostState ?? readRecoveryHostState()
        if (!host) {
          hold("resource guard has not published admission health")
          continue
        }
        const decision = recoveryAdmissionDecision({ ...host, now, activeRecoveries, lastAdmissionAt: store.getMetadata<number>("recovery.last_admission_at") ?? host.lastAdmissionAt })
        if (!decision.admit) {
          hold(decision.reason)
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
        if (current) desired = current
        hold(admission.reason || "recovery admission denied")
        continue
      }
      const attempt = admission.attempt
      const attemptId = String(attempt.id)
      store.setRecoveryOwner(desired.clankerId, recoveryUnitName(desired.clankerId, attemptId), { now })
      store.setMetadata("recovery.last_admission_at", now, { now })
      if (gate) {
        // Herdr already restored the pane in place: hand the admission to its gate instead of creating one.
        recordGateAdmission(store, desired.clankerId, { pane: gate.pane, attemptId: attempt.id, initial: !previousSucceeded, admittedAt: now })
        try { signalGateAdmitted(desired.clankerId, attempt.id) } catch {}
        result.launched.push(desired.clankerId)
        continue
      }
      // Fallback relaunch: no restored gate exists (restore off, session lost, gate missing, report refused).
      try {
        const session = await resolveWorkshop(desired, multiplexer)
        const windowName = nextWindowName(session.windowNames, desired.preferredWindowLabel)
        const workshop = workshopLaunchIdentity(desired.workshopId, desired.workshopPath)
        const argv = admittedHarnessCommand(desired, attemptId, !previousSucceeded)
        const launch = { cwd: desired.cwd, env: { ...spawnedRuntimeEnv(), ...workshopEnvironment(workshop) }, launch: { kind: "argv" as const, argv } }
        const launched = await multiplexer.spawn(session.id
          ? { ...launch, scope: "window", nativeSessionId: session.id, name: windowName }
          : { ...launch, scope: "session", name: session.name, windowName })
        const { nativeSessionId, nativeWindowId: window, nativePaneId: pane } = launched
        if (!pane) throw new Error(`${multiplexer.kind} did not return a pane id`)
        if (!session.id) {
          await multiplexer.claim(sessionLocation(nativeSessionId), "worktreePath", desired.workshopPath)
          await multiplexer.claim(sessionLocation(nativeSessionId), "workshopId", desired.workshopId)
        }
        const at = paneLocation(nativeSessionId, window, pane)
        await multiplexer.claim(at, "clankerId", desired.clankerId)
        await multiplexer.claim(at, "harness", desired.harness)
        await multiplexer.claim(at, "recoveryAttemptId", attemptId)
        if (desired.harnessSessionId) await multiplexer.claim(at, "harnessSessionId", desired.harnessSessionId)
        if (window) await multiplexer.claim(windowLocation(nativeSessionId, window), "windowHarness", desired.harness)
        await ensureManagedSession(nativeSessionId, multiplexer)
        result.launched.push(desired.clankerId)
        panes = [...panes, { pane, session: session.name, nativeSessionId, windowId: window, clankerId: desired.clankerId, harness: desired.harness, harnessSessionId: desired.harnessSessionId || "", recoveryAttemptId: attemptId, recoveryGate: "" }]
      } catch (error) {
        store.finishAttempt(attempt.id, "failed", { error: error instanceof Error ? error.message : String(error), now: Date.now() })
        result.skipped.push({ clankerId: desired.clankerId, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    forgetReportedResumes(new Set(panes.map((pane) => pane.pane)))
    return result
  } finally {
    if (ownStore) store.close()
  }
}

export const controllerIdentity = (): ProcessIdentity => ({ bootId: linuxBootId(), pid: process.pid, processStartTicks: processStartTicks() })

/** Multiplexer server epoch, which changes on every runtime restart even though durable native ids and Locations survive it. */
const runtimeServerEpoch = async (multiplexer: ManagedMultiplexer) => {
  try { return await multiplexer.serverEpoch() } catch { return undefined }
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
  constructor(readonly store = openRecoveryStore(), readonly intervalMs = Number(Bun.env.CLANKERHOUSE_RECOVERY_INTERVAL_MS || 30_000), readonly multiplexer: ManagedMultiplexer = openManagedMultiplexer()) {}

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
        const beforeServerEpoch = await runtimeServerEpoch(this.multiplexer)
        const recordedServerEpoch = this.store.getMetadata<string>("runtime.server_epoch")
        const trigger = hardReboot ? "hard_reboot" : recordedServerEpoch && beforeServerEpoch && recordedServerEpoch !== beforeServerEpoch ? "multiplexer_restart" : "reconcile"
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
          multiplexer: this.multiplexer,
        })
        if (activeCampaign) {
          campaign = advanceRecoveryCampaign(activeCampaign, this.store.listDesired({ includeTombstoned: true }), result.adopted)
          if (JSON.stringify(campaign) !== JSON.stringify(activeCampaign)) this.store.setMetadata("recovery.campaign", campaign)
        }
        const serverEpoch = await runtimeServerEpoch(this.multiplexer)
        if (serverEpoch && serverEpoch !== recordedServerEpoch) {
          if (recordedServerEpoch) {
            this.store.advanceMultiplexerEpoch()
            forgetReportedResumes()
          }
          this.store.setMetadata("runtime.server_epoch", serverEpoch)
        }
      }
      if (options.once && lease) break
      await sleep(this.intervalMs)
    }
    this.store.releaseLease({ ...identity, scope, ownerToken: this.ownerToken })
  }

  close() { this.store.close() }
}

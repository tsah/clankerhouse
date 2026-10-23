/**
 * Recovery gate (ADR-0009). Herdr's native session restore runs `clankerhouse-resume CLANKER_ID`
 * in each restored Clanker pane. The gate asks `runResumeGate` what to do, waits while Recovery
 * decides, and execs the launch it is handed once Recovery admits the Clanker into its pane.
 * Policy stays in Recovery: the gate never admits itself.
 */
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runtimeDirFor } from "../paths"
import { paneLocation } from "../multiplexer/interface"
import type { ManagedMultiplexer } from "../multiplexer"
import type { DesiredClankerRecord, RecoveryAttempt } from "./model"
import type { RecoveryStore } from "./store"
import { admittedHarnessCommand } from "./harness"
import { observePanes } from "./panes"

/** Plain command name Herdr types into the restored pane's shell; it must be on that shell's PATH. */
export const RESUME_GATE_COMMAND = "clankerhouse-resume"
/** An admitted gate that has not launched by then is abandoned and its Clanker returns to pending. */
export const GATE_LAUNCH_TIMEOUT_MS = 120_000

/** The resume command reported to Herdr for a Clanker pane. */
export const resumeArgv = (clankerId: string, env: Record<string, string | undefined> = Bun.env) => {
  const instance = env.CLANKERHOUSE_INSTANCE?.trim()
  return [RESUME_GATE_COMMAND, ...(instance ? ["--instance", instance] : []), clankerId]
}

const reportedResume = new Map<string, { key: string; at: number }>()
/**
 * A report is repeated this often: releasing the pane (the lifecycle mirror does on SessionEnd and Pi
 * session_shutdown) also drops its resume command, and a harness that keeps running needs it back.
 */
export const RESUME_REREPORT_MS = 300_000

/**
 * Report the gate as the pane's restore command once per pane, runtime server, and re-report period.
 * A refusal (another source holds the pane, or the runtime does not yet see the harness) is retried on
 * the next reconcile.
 */
export const reportResumeCommand = async (multiplexer: ManagedMultiplexer, pane: string, desired: DesiredClankerRecord, now = Date.now()) => {
  if (typeof multiplexer.reportAgentSession !== "function") return false
  const argv = resumeArgv(desired.clankerId)
  const key = JSON.stringify([desired.clankerId, desired.harness, desired.harnessSessionId, argv])
  const previous = reportedResume.get(pane)
  if (previous?.key === key && now - previous.at < RESUME_REREPORT_MS) return true
  try { if (!await multiplexer.reportAgentSession(pane, desired.harness, desired.harnessSessionId, argv)) return false }
  catch { return false }
  reportedResume.set(pane, { key, at: now })
  return true
}

/** Drop report memory for panes that no longer exist, or for every pane after a runtime restart. */
export const forgetReportedResumes = (livePanes?: ReadonlySet<string>) => {
  for (const pane of [...reportedResume.keys()]) if (!livePanes || !livePanes.has(pane)) reportedResume.delete(pane)
}

/** Durable record of Recovery admitting a Clanker into a waiting gate pane. */
export interface GateAdmission {
  pane: string
  attemptId: number
  /** Initial launch with the original task, rather than the inspect-first continuation. */
  initial: boolean
  admittedAt: number
  launchedAt?: number
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const admissionKey = (clankerId: string) => `recovery.gate.${clankerId.length <= 100 ? clankerId : digest(clankerId).slice(0, 32)}`
export const readGateAdmission = (store: RecoveryStore, clankerId: string) => store.getMetadata<GateAdmission | null>(admissionKey(clankerId)) ?? undefined
export const recordGateAdmission = (store: RecoveryStore, clankerId: string, admission: GateAdmission) => store.setMetadata(admissionKey(clankerId), admission, { now: admission.launchedAt ?? admission.admittedAt })
export const clearGateAdmission = (store: RecoveryStore, clankerId: string) => store.setMetadata(admissionKey(clankerId), null)

/**
 * Per-Clanker status files a waiting gate polls instead of the daemon: `<prefix>.reason` carries
 * Recovery's latest wait reason and `<prefix>.admitted` appears when Recovery admits the gate.
 */
export const gateStatusDir = (env: Record<string, string | undefined> = Bun.env) => join(runtimeDirFor(env), "recovery-gates")
export const gateStatusPrefix = (clankerId: string, env: Record<string, string | undefined> = Bun.env) => {
  const safe = /^[A-Za-z0-9_.-]{1,120}$/.test(clankerId) ? clankerId : `${clankerId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100)}-${digest(clankerId).slice(0, 12)}`
  return join(gateStatusDir(env), safe)
}

const writePrivate = (path: string, text: string) => {
  const dir = gateStatusDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Publish why Recovery is holding a gate, as the message the gate prints; an unchanged message is not rewritten. */
export const publishGateWait = (desired: DesiredClankerRecord, reason: string) => {
  const path = `${gateStatusPrefix(desired.clankerId)}.reason`
  const message = gateWaitMessage(desired, reason)
  try { if (readFileSync(path, "utf8") === message) return } catch {}
  try { writePrivate(path, message) } catch {}
}

export const signalGateAdmitted = (clankerId: string, attemptId: number) => writePrivate(`${gateStatusPrefix(clankerId)}.admitted`, `${attemptId}\n`)
export const clearGateSignal = (clankerId: string) => { try { rmSync(`${gateStatusPrefix(clankerId)}.admitted`, { force: true }) } catch {} }

/** What a waiting gate prints for a Recovery reason. */
export const gateWaitMessage = (desired: DesiredClankerRecord, reason: string) => {
  const id = desired.clankerId
  if (desired.recoveryCondition === "quarantined" || desired.recoveryCondition === "interrupted_unknown") {
    return `Recovery holds ${id} for review (${desired.quarantineReason || reason}). After reviewing its interrupted work: clankers recovery unquarantine ${id} --reason TEXT, then clankers recovery resume ${id}`
  }
  if (/manual resume required|not in the active Recovery campaign/.test(reason)) {
    return `Waiting for a manual resume; no boot campaign covers this restart. Resume ${id} here with: clankers recovery resume ${id}`
  }
  return `Waiting for Recovery to admit ${id}: ${reason}`
}

export type GateDecision =
  | { action: "launch"; message: string; admission: GateAdmission }
  | { action: "wait"; message: string }
  | { action: "exit"; message: string }

export interface GateDecisionInput {
  clankerId: string
  pane: string
  desired?: DesiredClankerRecord
  /** Another pane that already carries this Clanker's identity. */
  livePane?: string
  admission?: GateAdmission
  latestAttempt?: RecoveryAttempt
  /** Latest wait message Recovery published for this gate (see `publishGateWait`). */
  published?: string
}

/** Pure gate policy: launch only what Recovery admitted into exactly this pane. */
export const decideResumeGate = (input: GateDecisionInput): GateDecision => {
  const { clankerId: id, desired } = input
  if (!desired) return { action: "exit", message: `${id} is not tracked by Recovery (deleted or never recoverable); nothing to resume.` }
  if (desired.desiredState === "tombstoned") return { action: "exit", message: `${id} was deleted; nothing to resume.` }
  if (desired.desiredState === "stopped") return { action: "exit", message: `${id} was stopped and will not resume. Start it again with: clankers recovery start ${id}` }
  if (desired.desiredState === "suspended_resource_pressure") return { action: "exit", message: `${id} is suspended for resource pressure. Start it again with: clankers recovery start ${id}` }
  if (input.livePane && input.livePane !== input.pane) return { action: "exit", message: `${id} is already running in pane ${input.livePane}; this restored pane is not needed.` }
  const { admission, latestAttempt } = input
  if (admission && admission.pane === input.pane && !admission.launchedAt && latestAttempt?.id === admission.attemptId && latestAttempt.status === "running") {
    return { action: "launch", message: `Recovery admitted ${id} (attempt ${admission.attemptId}); starting ${desired.harness}.`, admission }
  }
  return { action: "wait", message: input.published || gateWaitMessage(desired, desired.recoveryCondition === "healthy" ? "waiting for Recovery to notice the restart" : "manual resume required") }
}

export interface ResumeGateResult { action: GateDecision["action"]; message: string; statusPrefix: string; argv?: string[] }

/**
 * One gate consultation for `clankers recovery gate`. Registers the waiting gate on its pane, and
 * on launch claims the Clanker's identity on that pane and records the launch before handing back
 * the exact harness argv.
 */
export const runResumeGate = async (store: RecoveryStore, multiplexer: ManagedMultiplexer, options: { clankerId: string; pane: string; now?: number }): Promise<ResumeGateResult> => {
  const { clankerId, pane } = options
  const statusPrefix = gateStatusPrefix(clankerId)
  const desired = store.getDesired(clankerId)
  const panes = await observePanes(multiplexer)
  const own = panes.find((row) => row.pane === pane)
  if (!own) throw new Error(`${multiplexer.kind} does not report pane ${pane}`)
  let published: string | undefined
  try { published = readFileSync(`${statusPrefix}.reason`, "utf8").trim() || undefined } catch {}
  const decision = decideResumeGate({
    clankerId, pane, desired, published,
    livePane: panes.find((row) => row.clankerId === clankerId && row.pane !== pane)?.pane,
    admission: readGateAdmission(store, clankerId),
    latestAttempt: store.attemptsFor(clankerId).at(-1),
  })
  const at = paneLocation(own.nativeSessionId, own.windowId, pane)
  if (decision.action === "exit") {
    if (own.recoveryGate) await multiplexer.claim(at, "recoveryGate", null)
    return { action: "exit", message: decision.message, statusPrefix }
  }
  if (decision.action === "wait") {
    if (own.recoveryGate !== clankerId) await multiplexer.claim(at, "recoveryGate", clankerId)
    return { action: "wait", message: decision.message, statusPrefix }
  }
  const admission = decision.admission
  const argv = admittedHarnessCommand(desired!, String(admission.attemptId), admission.initial)
  await multiplexer.claim(at, "clankerId", clankerId)
  await multiplexer.claim(at, "harness", desired!.harness)
  await multiplexer.claim(at, "recoveryAttemptId", String(admission.attemptId))
  if (desired!.harnessSessionId) await multiplexer.claim(at, "harnessSessionId", desired!.harnessSessionId)
  await multiplexer.claim(at, "recoveryGate", null)
  recordGateAdmission(store, clankerId, { ...admission, launchedAt: options.now ?? Date.now() })
  clearGateSignal(clankerId)
  return { action: "launch", message: decision.message, statusPrefix, argv }
}

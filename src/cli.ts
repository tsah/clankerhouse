#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ClankerApiError, clankerCapabilities, clankerStatus, listClankers, resultForClanker, sendClanker, waitForClanker, type ClankerDelivery } from "./clanker-api"
import { recordRecoveryIncident, resolveRecoveredClankerIncidents } from "./incidents"
import { reconcileRecovery } from "./recovery/controller"
import type { RecoveryResourceClass } from "./recovery/model"
import { harnessModelArgs } from "./recovery/harness"
import { stopOwnedHarness } from "./recovery/process-owner"
import { libexecPath } from "./installation"
import { openManagedMultiplexer } from "./multiplexer"
import { paneLocation, type ClaimKey, type NativeLocation } from "./multiplexer/interface"
import { runtimeDirFor } from "./paths"
import { diagnoseProjection } from "./diagnostics"
import type { SessionRow, Target } from "./model"
import { openRecoveryStore, type RecoveryStore } from "./recovery/store"
import { bootstrapRepositoryFromManifests, projectSnapshot, reconcileRepositoryWorkshops, workshopDetails, workshopForPath, workshopTree } from "./workshop"
import { ensureDirectorySession, ensureSession, identity, spawnClanker, spawnWorkshop, type Harness } from "./workflow"
import { getSnapshot, submitMutation, waitForOperation } from "./transport"
import type { MutationIntent } from "./transport"
import { mutationStages } from "./daemon-mutations"

const daemonSocketPath = `${runtimeDirFor()}/daemon.sock`
const progressPrefix = "CLANKERHOUSE_PROGRESS\t"

export const mutationProgressSteps = (intent: MutationIntent): readonly string[] => {
  if (intent.type !== "delete") return []
  if (intent.kind === "worktree") return [
    "Validating worktree identity",
    "Stopping tracked Clankers",
    "Deleting worktree",
    "Deleting tmux session",
    "Refreshing Clankerhouse",
  ]
  return ["Validating tmux identity", `Deleting tmux ${intent.kind}`, "Refreshing Clankerhouse"]
}

const routeCompatibilityMutation = async (intent: MutationIntent) => {
  if (Bun.env.CLANKERHOUSE_DAEMON_INTERNAL === "1" || Bun.env.CLANKERHOUSE_LEGACY_MUTATIONS === "1" || !existsSync(daemonSocketPath)) return undefined
  const progressSteps = Bun.env.CLANKERHOUSE_PROGRESS === "1" ? mutationProgressSteps(intent) : []
  let reported = -1
  const reportThrough = (index: number) => {
    while (reported < Math.min(index, progressSteps.length - 1)) console.error(`${progressPrefix}${progressSteps[++reported]}`)
  }
  reportThrough(0)
  const submitted = await submitMutation(daemonSocketPath, randomUUID(), intent)
  const stages = mutationStages(intent)
  const operation = await waitForOperation(daemonSocketPath, submitted.operation.operationId, {
    onStatus: (current) => {
      const completed = current.stage === "completed" ? stages.length : stages.indexOf(current.stage)
      reportThrough(completed + 1)
    },
  })
  reportThrough(progressSteps.length - 1)
  return { routed: true as const, result: operation.result }
}

export interface ParsedArgs {
  args: string[]
  take: (flag: string) => string | undefined
  has: (flag: string) => boolean
  shift: () => string | undefined
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = [...argv]
  const take = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`)
    args.splice(index, 2)
    return value
  }
  const has = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return false
    args.splice(index, 1)
    return true
  }
  return { args, take, has, shift: () => args.shift() }
}

const requiredClankerId = (parsed: ParsedArgs) => {
  const id = parsed.take("--id") || parsed.shift()
  if (!id) throw new Error("CLANKER_ID is required")
  return id
}

const nonNegativeNumber = (value: string | undefined, flag: string) => {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a non-negative number`)
  return number
}

const clankerDelivery = (value: string | undefined): ClankerDelivery | undefined => {
  if (value === undefined) return undefined
  if (value === "steer") return "steer"
  if (value === "follow-up" || value === "followUp") return "followUp"
  throw new Error("--delivery must be steer or follow-up")
}

const harness = (value: string | undefined): Harness => {
  const selected = value || "pi"
  if (!["pi", "claude", "opencode", "codex"].includes(selected)) throw new Error(`Unsupported harness: ${selected}`)
  return selected as Harness
}

const resourceClass = (value: string | undefined): RecoveryResourceClass | undefined => {
  if (value === undefined) return undefined
  if (["interactive", "validation-heavy", "untrusted"].includes(value)) return value as RecoveryResourceClass
  throw new Error("--resource-class must be interactive, validation-heavy, or untrusted")
}

const runClankerApi = async (command: string | undefined, parsed: ParsedArgs) => {
  if (command === "list") return console.log(JSON.stringify(await listClankers({ cwd: parsed.take("--cwd") })))
  if (command === "status") return console.log(JSON.stringify(await clankerStatus(requiredClankerId(parsed))))
  if (command === "capabilities") return console.log(JSON.stringify(await clankerCapabilities(requiredClankerId(parsed))))
  if (command === "wait") {
    const afterGeneration = nonNegativeNumber(parsed.take("--after"), "--after")
    const timeoutSeconds = nonNegativeNumber(parsed.take("--timeout"), "--timeout")
    return console.log(JSON.stringify(await waitForClanker(requiredClankerId(parsed), { afterGeneration, timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000 })))
  }
  if (command === "send") {
    const delivery = clankerDelivery(parsed.take("--delivery"))
    const wait = parsed.has("--wait")
    const timeoutSeconds = nonNegativeNumber(parsed.take("--timeout"), "--timeout")
    const textFlag = parsed.take("--text")
    const id = requiredClankerId(parsed)
    const text = textFlag ?? await Bun.stdin.text()
    const receipt = await sendClanker(id, text, { delivery })
    if (!wait) return console.log(JSON.stringify(receipt))
    const settled = await waitForClanker(id, { afterGeneration: receipt.afterGeneration, timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000 })
    return console.log(JSON.stringify({ ...receipt, settled, result: await resultForClanker(id, settled.settledGeneration) }))
  }
  if (command === "result") {
    const generation = nonNegativeNumber(parsed.take("--generation"), "--generation")
    return console.log(JSON.stringify(await resultForClanker(requiredClankerId(parsed), generation)))
  }
  throw new Error("Usage: clankers list|status|capabilities|wait|send|result ...")
}

const resolveWorkshopPath = (selector: string, cwd = process.cwd()) => {
  const project = projectSnapshot(cwd)
  const matches = project.workshops.filter((row) => row.workshopId === selector || row.branch === selector || row.canonicalPath === selector || row.canonicalPath.endsWith(`/${selector}`))
  if (matches.length === 0) throw new Error(`Unknown workshop: ${selector}`)
  if (matches.length > 1) throw new Error(`Ambiguous workshop '${selector}'; use its durable workshop ID`)
  return matches[0]!.canonicalPath
}

const adoptDesired = async (store: RecoveryStore, id: string, sessionId: string) => {
  const matches = (await listClankers()).filter((row) => row.id === id)
  if (matches.length !== 1) throw new Error(matches.length > 1 ? `Ambiguous live panes for ${id}` : `Unknown clanker ${id}`)
  const live = matches[0]!
  if (live.harness !== "pi" && live.harness !== "claude" && live.harness !== "opencode") throw new Error(`Harness ${live.harness} does not support durable recovery`)
  const path = live.worktreePath || live.cwd
  const workshop = workshopForPath(path)
  const desired = store.createDesired({
    clankerId: id,
    harness: live.harness,
    workshopId: workshop?.workshopId || `path-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`,
    workshopPath: path,
    tmuxSessionName: live.session,
    tmuxWindowName: live.name || live.harness,
    cwd: live.cwd || path,
    harnessSessionId: sessionId,
    launchSpec: { version: 1, profile: null },
    originalTask: "Autonomously continue the most recent unfinished user request.",
  })
  const adoption = store.beginAttempt(id, "adopted-live-session")
  store.finishAttempt(adoption.id, "succeeded")
  return desired
}

const adoptLivePiSessions = async (store: RecoveryStore) => {
  const runtime = `${runtimeDirFor()}/clanker-state`
  const sessionRoot = Bun.env.PI_CODING_AGENT_SESSION_DIR || join(Bun.env.HOME || "", ".pi", "agent", "sessions")
  const replies = new Map<string, Array<{ id: string; cwd: string }>>()
  const sessionsByCwd = new Map<string, Array<{ id: string; cwd: string; updatedAt: number }>>()
  const files = existsSync(sessionRoot) ? new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionRoot, absolute: true }) : []
  for (const file of files) {
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
      const header = JSON.parse(lines[0] || "{}")
      if (!header.id || !header.cwd) continue
      sessionsByCwd.set(header.cwd, [...(sessionsByCwd.get(header.cwd) || []), { id: header.id, cwd: header.cwd, updatedAt: statSync(file).mtimeMs }])
      for (const line of lines.slice(1)) {
        const entry = JSON.parse(line)
        const message = entry?.message
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
        const reply = message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n")
        if (!reply) continue
        replies.set(reply, [...(replies.get(reply) || []), { id: header.id, cwd: header.cwd }])
      }
    } catch {}
  }
  const adopted: string[] = []
  const skipped: Array<{ clankerId: string; reason: string }> = []
  const usedSessionIds = new Set(store.listDesired({ includeTombstoned: true }).flatMap((row) => row.harnessSessionId ? [row.harnessSessionId] : []))
  for (const live of (await listClankers()).filter((row) => row.harness === "pi" && !store.getDesired(row.id))) {
    let report: any = {}
    try { report = JSON.parse(readFileSync(`${runtime}/${live.pane.replace(/[^A-Za-z0-9_.%-]/g, "_")}.json`, "utf8")) } catch {}
    const matched = new Map<string, { id: string; cwd: string }>()
    for (const result of [...(report.results || [])].reverse()) {
      for (const candidate of replies.get(result?.reply) || []) if (candidate.cwd === live.cwd || candidate.cwd === live.worktreePath) matched.set(candidate.id, candidate)
      if (matched.size === 1) break
    }
    let sessionId = matched.size === 1 ? [...matched.values()][0]!.id : ""
    if (!sessionId && report.updatedAt) {
      const timed = (sessionsByCwd.get(live.cwd) || []).filter((candidate) => !usedSessionIds.has(candidate.id)).map((candidate) => ({ ...candidate, distance: Math.abs(candidate.updatedAt - Number(report.updatedAt)) })).sort((a, b) => a.distance - b.distance)
      if (timed[0] && timed[0].distance <= 30_000 && (!timed[1] || timed[1].distance - timed[0].distance >= 1_000)) sessionId = timed[0].id
    }
    if (!sessionId) {
      const only = (sessionsByCwd.get(live.cwd) || []).filter((candidate) => !usedSessionIds.has(candidate.id))
      if (only.length === 1) sessionId = only[0]!.id
    }
    if (!sessionId) {
      skipped.push({ clankerId: live.id, reason: matched.size ? "ambiguous Pi session history" : "no exact Pi result/session match" })
      continue
    }
    await adoptDesired(store, live.id, sessionId)
    usedSessionIds.add(sessionId)
    adopted.push(live.id)
  }
  return { adopted, skipped }
}

const usage = `Usage:
  clankerhouse
  clankers workshop spawn --name NAME --harness HARNESS [--base REF] [--copy PATH] [--profile NAME] [--model MODEL] [--prompt TEXT]
  clankers workshop ensure [--cwd PATH]
  clankers workshop identity [--cwd PATH]
  clankers target open --json TARGET
  clankers diagnose [--json] [--strict]
  clankers spawn --workshop WORKSHOP --name NAME --harness HARNESS [--profile NAME] [--model MODEL] [--resource-class interactive|validation-heavy|untrusted] [--prompt TEXT]
  clankers list [--cwd PATH]
  clankers status|capabilities CLANKER_ID
  clankers wait CLANKER_ID [--after GENERATION] [--timeout SECONDS]
  clankers send CLANKER_ID [--delivery steer|follow-up] [--wait] [--text TEXT]
  clankers result CLANKER_ID [--generation GENERATION]
  clankers delete session|worktree --session SESSION [--path PATH] --yes
  clankers recovery status|journal|reconcile|checkpoint
  clankers recovery attest-exit CLANKER_ID --attempt ID [--session-id ID]
  clankers recovery pending|pause-all
  clankers recovery resume CLANKER_ID [--force]
  clankers recovery unquarantine CLANKER_ID --reason TEXT
  clankers recovery stop|start|suspend|tombstone CLANKER_ID
  clankers mux kind|capabilities|pane-address-env|observe|current-location [--client CLIENT]
  clankers mux claim|read-claim (--pane PANE|--window WINDOW|--session SESSION) KEY [VALUE|--unset]
  clankers mux kill|focus (--pane PANE|--window WINDOW|--session SESSION) [--client CLIENT]
  clankers mux clanker-ids|pane-path (--pane PANE|--session SESSION)
  clankers mux spawn (--session SESSION|--new-session NAME) --name NAME --cwd PATH [--env KEY=VALUE]... [-- ARGV...]

--model MODEL overrides the profile/default model for Pi, Claude, and Codex.
Pi and Claude retain the override during Recovery. OpenCode does not support this flag.`

const claimKeys = new Set<ClaimKey>(["workshopId", "workshopParentId", "worktreePath", "directoryPath", "gitCommonDir", "sessionId", "sessionDisplayName", "windowId", "windowDisplayName", "windowHarness", "terminalId", "terminalDisplayName", "clankerId", "harness", "harnessSessionId", "recoveryAttemptId", "clankerSocket", "clankerPid", "clankerCapabilities"])

const muxLocation = (parsed: ParsedArgs): NativeLocation => {
  const pane = parsed.take("--pane")
  const window = parsed.take("--window")
  const session = parsed.take("--session")
  if (!pane && !window && !session) throw new Error("--pane, --window, or --session is required")
  return { nativeSessionId: session ?? "", nativeWindowId: window ?? null, nativePaneId: pane ?? null }
}

/**
 * Runtime-neutral multiplexer operations for shell callers (lifecycle reporters, stop
 * scripts, resource guard). Every operation goes through the selected Adapter.
 */
const runMultiplexerCli = async (parsed: ParsedArgs) => {
  const subcommand = parsed.shift()
  const multiplexer = openManagedMultiplexer()
  if (subcommand === "kind") return console.log(multiplexer.kind)
  if (subcommand === "capabilities") return console.log(JSON.stringify({ kind: multiplexer.kind, ...multiplexer.capabilities() }))
  if (subcommand === "pane-address-env") return console.log(multiplexer.paneAddressEnv())
  if (subcommand === "observe") return console.log(JSON.stringify(await multiplexer.observe()))
  if (subcommand === "current-location") return console.log(JSON.stringify(await multiplexer.currentLocation(parsed.take("--client")) ?? null))
  if (subcommand === "claim" || subcommand === "read-claim") {
    const unset = parsed.has("--unset")
    const location = muxLocation(parsed)
    const key = parsed.shift()
    if (!key || !claimKeys.has(key as ClaimKey)) throw new Error(`Unknown claim key: ${key ?? ""}`)
    if (subcommand === "read-claim") return console.log(await multiplexer.readClaim(location, key as ClaimKey) ?? "")
    const value = unset ? null : parsed.shift()
    if (value === undefined) throw new Error("claim requires VALUE or --unset")
    await multiplexer.claim(location, key as ClaimKey, value)
    return
  }
  if (subcommand === "clanker-ids" || subcommand === "pane-path") {
    const location = muxLocation(parsed)
    const snapshot = await multiplexer.observe()
    const panes = snapshot.sessions.flatMap((session) => {
      if (location.nativeSessionId && session.id !== location.nativeSessionId && session.nativeName !== location.nativeSessionId) return []
      return session.windows.flatMap((window) => window.panes.filter((pane) => !location.nativePaneId || pane.id === location.nativePaneId))
    })
    if (subcommand === "pane-path") return console.log(panes[0]?.currentPath ?? "")
    return console.log([...new Set(panes.flatMap((pane) => pane.clankerId ? [pane.clankerId] : []))].join("\n"))
  }
  if (subcommand === "kill") return multiplexer.kill(muxLocation(parsed))
  if (subcommand === "focus") {
    const client = parsed.take("--client")
    return multiplexer.focus(muxLocation(parsed), client)
  }
  if (subcommand === "spawn") {
    const newSession = parsed.take("--new-session")
    const session = parsed.take("--session")
    const name = parsed.take("--name")
    const cwd = parsed.take("--cwd")
    const instance = Bun.env.CLANKERHOUSE_INSTANCE?.trim()
    const env: Record<string, string> = { CLANKERHOUSE_MULTIPLEXER: multiplexer.kind, ...(instance ? { CLANKERHOUSE_INSTANCE: instance } : {}) }
    let pair = parsed.take("--env")
    while (pair) {
      const separator = pair.indexOf("=")
      if (separator <= 0) throw new Error("--env requires KEY=VALUE")
      env[pair.slice(0, separator)] = pair.slice(separator + 1)
      pair = parsed.take("--env")
    }
    const dash = parsed.args.indexOf("--")
    const argv = dash >= 0 ? parsed.args.slice(dash + 1) : []
    if (!cwd || (!newSession && !session) || (session && !name)) throw new Error("spawn requires --cwd and either --new-session NAME or --session SESSION --name NAME")
    const launch = argv.length ? { kind: "argv" as const, argv } : undefined
    const result = newSession
      ? await multiplexer.spawn({ scope: "session", name: newSession, cwd, windowName: name, env, launch })
      : await multiplexer.spawn({ scope: "window", nativeSessionId: session!, name: name!, cwd, env, launch })
    return console.log(JSON.stringify(result))
  }
  throw new Error("Usage: clankers mux kind|capabilities|pane-address-env|observe|current-location|claim|read-claim|kill|focus|spawn ...")
}

export async function runClankersCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  const command = parsed.shift()
  if (!command || command === "help" || command === "--help" || command === "-h") return console.log(usage)
  if (["list", "status", "capabilities", "wait", "send", "result"].includes(command)) return runClankerApi(command, parsed)

  if (command === "mux") return runMultiplexerCli(parsed)

  if (command === "delete") {
    const kind = parsed.shift()
    if (kind !== "session" && kind !== "worktree") throw new Error("Usage: clankers delete session|worktree --session SESSION [--path PATH] --yes")
    const session = parsed.take("--session")
    const path = parsed.take("--path")
    if (!session || !parsed.has("--yes") || (kind === "worktree" && !path)) throw new Error("Usage: clankers delete session|worktree --session SESSION [--path PATH] --yes")
    const routed = await routeCompatibilityMutation({ type: "delete", kind, session, confirmed: true, ...(path ? { path } : {}) })
    if (!routed) throw new Error("Clankerhouse daemon is required for durable deletion")
    if (Bun.env.CLANKERHOUSE_PROGRESS !== "1") console.log(JSON.stringify(routed.result ?? { deleted: true }))
    return
  }

  if (command === "diagnose") {
    const json = parsed.has("--json")
    const strict = parsed.has("--strict")
    const snapshot = await getSnapshot<SessionRow>(daemonSocketPath)
    const report = diagnoseProjection(snapshot.sessions)
    if (json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`Clankerhouse projection: ${report.counts.tmuxSessions} tmux sessions, ${report.counts.directories} directories, ${report.counts.renderedSessionRows} rendered session rows`)
      if (!report.issues.length) console.log("No projection anomalies detected.")
      for (const entry of report.issues) console.log(`${entry.severity.toUpperCase()} ${entry.code}: ${entry.summary}`)
    }
    if (strict && !report.healthy) throw new Error("Projection diagnostics found invariant violations")
    return
  }

  if (command === "target") {
    const subcommand = parsed.shift()
    if (subcommand !== "open") throw new Error("Usage: clankers target open --json TARGET")
    const encoded = parsed.take("--json")
    if (!encoded) throw new Error("--json is required")
    const target = JSON.parse(encoded) as Target
    const client = parsed.take("--client")
    const routed = await routeCompatibilityMutation({ type: "open", target, ...(client ? { client } : {}) })
    if (routed) return
    const multiplexer = openManagedMultiplexer()
    if (target.type === "tmux_session" || target.type === "tmux_window") {
      await multiplexer.openTarget(target, client)
      return
    }
    if (target.type === "opencode") {
      const location = await multiplexer.resolve(target)
      if (multiplexer.kind !== "tmux") {
        if (!location) throw new Error(`OpenCode target has no current ${multiplexer.kind} location`)
        await multiplexer.open(location, client)
        return
      }
      const pane = location?.nativePaneId || target.pane
      const proc = Bun.spawn([libexecPath("opencode-attach-target"), target.session, pane], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      const code = await proc.exited
      if (code !== 0) throw new Error(`opencode attach exited ${code}`)
      return
    }
    const session = await ensureDirectorySession(target.path)
    await multiplexer.openTarget({ type: "tmux_session", session }, client)
    return
  }

  if (command === "recovery") {
    const subcommand = parsed.shift()
    const store = openRecoveryStore()
    try {
      if (subcommand === "status") return console.log(JSON.stringify({ epochs: store.runtimeEpochs(), tmuxServerEpoch: store.getMetadata("runtime.tmux_server_epoch") ?? null, clankers: store.listDesired({ includeTombstoned: true }).map((row) => ({ ...row, originalTask: undefined })), attempts: store.listDesired({ includeTombstoned: true }).flatMap((row) => store.attemptsFor(row.clankerId)) }))
      if (subcommand === "journal") return console.log(JSON.stringify(store.journalEntries({ afterId: nonNegativeNumber(parsed.take("--after"), "--after"), limit: nonNegativeNumber(parsed.take("--limit"), "--limit") })))
      if (subcommand === "reconcile") return console.log(JSON.stringify(await reconcileRecovery(store, { trigger: parsed.take("--reason") || "manual" })))
      if (subcommand === "pending") return console.log(JSON.stringify(store.listDesired().filter((row) => row.recoveryCondition !== "healthy")))
      if (subcommand === "pause-all") {
        const reason = parsed.take("--reason") || "operator-paused-all"
        const live = await listClankers()
        const paused = []
        for (const row of store.listDesired().filter((candidate) => candidate.desiredState === "running")) {
          const desired = store.setDesiredState(row.clankerId, "suspended_resource_pressure", { reason })
          if (desired.ownerUnit) stopOwnedHarness(desired.ownerUnit)
          for (const match of live.filter((candidate) => candidate.id === row.clankerId)) await openManagedMultiplexer().kill(paneLocation(match.sessionId, match.window, match.pane)).catch(() => {})
          paused.push(row.clankerId)
        }
        return console.log(JSON.stringify({ paused }))
      }
      if (subcommand === "resume") {
        const id = requiredClankerId(parsed)
        const force = parsed.has("--force")
        const routed = await routeCompatibilityMutation({ type: "recovery", clankerId: id, action: "resume", force })
        return console.log(JSON.stringify(routed ? routed.result : await reconcileRecovery(store, { trigger: "manual", clankerId: id, allowLaunch: true, automatic: false, bypassAdmission: force })))
      }
      if (subcommand === "unquarantine") {
        const id = requiredClankerId(parsed)
        const reason = parsed.take("--reason")
        if (!reason) throw new Error("--reason is required")
        return console.log(JSON.stringify(store.resetRecovery(id, reason)))
      }
      if (subcommand === "adopt-live") return console.log(JSON.stringify(await adoptLivePiSessions(store)))
      if (subcommand === "checkpoint") {
        store.setMetadata("checkpoint.latest", { reason: parsed.take("--reason") || "manual", deadline: parsed.take("--deadline") || null, createdAt: Date.now() })
        return console.log(JSON.stringify({ checkpointed: true }))
      }
      if (subcommand === "attest") {
        const id = requiredClankerId(parsed)
        const sessionId = parsed.take("--session-id")
        if (!sessionId) throw new Error("--session-id is required")
        let desired = store.getDesired(id)
        if (!desired) {
          desired = await adoptDesired(store, id, sessionId)
        } else {
          desired = store.bindHarnessSession(id, sessionId)
        }
        const reportState = parsed.take("--state")
        const attemptId = nonNegativeNumber(parsed.take("--attempt"), "--attempt")
        if (attemptId !== undefined) {
          const attempt = store.getAttempt(attemptId)
          if (!attempt || attempt.clankerId !== id) throw new Error(`Recovery attempt ${attemptId} does not belong to ${id}`)
          store.finishAttempt(attemptId, "succeeded")
          if (reportState) store.markRecoverySettled(id, attemptId, reportState)
          if (store.getDesired(id)?.recoveryCondition === "healthy") resolveRecoveredClankerIncidents(id)
        }
        return console.log(JSON.stringify({ clankerId: id, harnessSessionId: desired.harnessSessionId, attested: true }))
      }
      if (subcommand === "attest-exit") {
        const id = requiredClankerId(parsed)
        const attemptId = nonNegativeNumber(parsed.take("--attempt"), "--attempt")
        if (attemptId === undefined) throw new Error("--attempt is required")
        const sessionId = parsed.take("--session-id")
        if (!sessionId) throw new Error("--session-id is required")
        const desired = store.attestHarnessExit(id, attemptId, {
          harnessSessionId: sessionId,
          reason: parsed.take("--reason") || "harness-exit",
        })
        return console.log(JSON.stringify(desired))
      }
      if (["stop", "start", "suspend", "tombstone"].includes(subcommand || "")) {
        const id = requiredClankerId(parsed)
        const state = subcommand === "start" ? "running" : subcommand === "suspend" ? "suspended_resource_pressure" : subcommand === "tombstone" ? "tombstoned" : "stopped"
        const noKill = parsed.has("--no-kill")
        const noPaneKill = parsed.has("--no-pane-kill")
        const reason = parsed.take("--reason") || subcommand!
        if (parsed.has("--if-present") && !store.getDesired(id)) return console.log(JSON.stringify({ clankerId: id, tracked: false }))
        if (!noKill && !noPaneKill) {
          const intent: MutationIntent = subcommand === "start"
            ? { type: "start", clankerId: id }
            : subcommand === "stop"
              ? { type: "stop", clankerId: id, confirmed: true, reason }
              : { type: "recovery", clankerId: id, action: subcommand as "suspend" | "tombstone", reason }
          const routed = await routeCompatibilityMutation(intent)
          if (routed) return console.log(JSON.stringify(routed.result))
        }
        const desired = store.setDesiredState(id, state, { reason })
        if (!noKill && (subcommand === "stop" || subcommand === "suspend" || subcommand === "tombstone")) {
          if (desired.ownerUnit) {
            try { stopOwnedHarness(desired.ownerUnit) }
            catch (error) {
              recordRecoveryIncident("recovery_descendant_cleanup_failed", { clankerId: desired.clankerId, harness: desired.harness, worktreePath: desired.workshopPath, cwd: desired.cwd }, { reason: error instanceof Error ? error.message : String(error), ownerUnit: desired.ownerUnit })
              throw error
            }
          }
          if (!noPaneKill) {
            const matches = (await listClankers()).filter((row) => row.id === id)
            if (matches.length > 1) throw new Error(`Ambiguous live panes for ${id}`)
            if (matches.length === 1) await openManagedMultiplexer().kill(paneLocation(matches[0]!.sessionId, matches[0]!.window, matches[0]!.pane)).catch(() => {})
          }
        }
        return console.log(JSON.stringify(desired))
      }
      throw new Error("Usage: clankers recovery status|journal|reconcile|pending|pause-all|resume|unquarantine|checkpoint|attest|attest-exit|stop|start|suspend|tombstone ...")
    } finally { store.close() }
  }

  if (command === "workshop") {
    const subcommand = parsed.shift()
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return console.log(usage)
    if (subcommand === "spawn") {
      const name = parsed.take("--name")
      if (!name) throw new Error("--name is required")
      const selectedHarness = harness(parsed.take("--harness"))
      const model = parsed.take("--model")
      const base = parsed.take("--base"); const copy = parsed.take("--copy"); const window = parsed.take("--clanker-name"); const profile = parsed.take("--profile"); const selectedResourceClass = resourceClass(parsed.take("--resource-class")); const wait = parsed.has("--wait"); const parentWorkshopId = parsed.take("--parent"); const noParent = parsed.has("--no-parent")
      if (parentWorkshopId && noParent) throw new Error("--parent and --no-parent are mutually exclusive")
      const prompt = parsed.take("--prompt") || parsed.args.join(" ") || "Ready for instructions."
      const result = await spawnWorkshop(selectedHarness, name, prompt, {
        base,
        copy,
        window,
        profile,
        model,
        resourceClass: selectedResourceClass,
        wait,
        parentWorkshopId,
        noParent,
      })
      return console.log(JSON.stringify(result))
    }
    const cwd = parsed.take("--cwd") || process.cwd()
    if (subcommand === "ensure") {
      let worktree
      try { worktree = await identity(cwd) }
      catch { return console.log(await ensureDirectorySession(cwd)) }
      const routed = await routeCompatibilityMutation({ type: "create", repository: worktree.path, branch: worktree.branch, create: false })
      if (routed) {
        const target = (routed.result as { target?: { session?: string } } | undefined)?.target
        if (!target?.session) throw new Error("Daemon did not return the ensured Workshop session")
        return console.log(target.session)
      }
      return console.log(await ensureSession(worktree))
    }
    if (subcommand === "identity") return console.log(JSON.stringify(await identity(cwd)))
    if (subcommand === "show") return console.log(JSON.stringify(workshopDetails(cwd, { id: parsed.take("--id"), path: parsed.take("--path") }) ?? null, null, 2))
    if (subcommand === "tree") return console.log(JSON.stringify(workshopTree(cwd), null, 2))
    if (subcommand === "project") return console.log(JSON.stringify(projectSnapshot(cwd), null, 2))
    if (subcommand === "reconcile") return console.log(JSON.stringify(reconcileRepositoryWorkshops(cwd), null, 2))
    if (subcommand === "bootstrap") return console.log(JSON.stringify(bootstrapRepositoryFromManifests(cwd), null, 2))
    throw new Error("Usage: clankers workshop spawn|ensure|identity|show|tree|project|reconcile|bootstrap ...")
  }

  if (command === "spawn") {
    const selector = parsed.take("--workshop")
    const name = parsed.take("--name")
    if (!selector || !name) throw new Error("--workshop and --name are required")
    const selectedHarness = harness(parsed.take("--harness")); const profile = parsed.take("--profile"); const selectedResourceClass = resourceClass(parsed.take("--resource-class")); const wait = parsed.has("--wait")
    const model = parsed.take("--model")
    harnessModelArgs(selectedHarness, model)
    const prompt = parsed.take("--prompt") || parsed.args.join(" ") || "Ready for instructions."
    return console.log(JSON.stringify(await spawnClanker(selectedHarness, resolveWorkshopPath(selector), prompt, { profile, model, name, wait, resourceClass: selectedResourceClass })))
  }

  throw new Error("Usage: clankers workshop spawn ... | spawn ... | list|status|capabilities|wait|send|result ...")
}

if (import.meta.main) {
  runClankersCli().catch((error) => {
    const apiError = error instanceof ClankerApiError ? error : undefined
    console.error(JSON.stringify({ apiVersion: 1, error: { code: apiError?.code || "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) } }))
    process.exit(apiError?.exitCode || 2)
  })
}

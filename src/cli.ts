#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { existsSync, fstatSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { ClankerApiError, clankerCapabilities, clankerStatusWithReport, listClankers, resultForClanker, sendClanker, sendStatus, waitForClanker, waitForMessage, type ClankerDelivery } from "./clanker-api"
import { DEFAULT_STALE_AFTER_MS, parseReportPayload, parseReportState } from "./orchestration"
import { submitReport } from "./report"
import { listClankerRows, parseStates } from "./clanker-list"
import { emitJsonLine, liveWatchView, resolveWorkshopSelector, runWatch, type WatchScope } from "./watch"
import { recordRecoveryIncident } from "./incidents"
import { reconcileRecovery } from "./recovery/controller"
import type { RecoveryResourceClass } from "./recovery/model"
import { harnessModelArgs } from "./recovery/harness"
import { stopOwnedHarness } from "./recovery/process-owner"
import { openManagedMultiplexer } from "./multiplexer"
import { MultiplexerResourceExhaustedError, paneLocation, type ClaimKey, type NativeLocation } from "./multiplexer/interface"
import { runtimeDirFor } from "./paths"
import { diagnoseProjection } from "./diagnostics"
import type { SessionRow, Target } from "./model"
import { adoptDesired, attestHarnessSession } from "./recovery/attest"
import { openRecoveryStore, type RecoveryStore } from "./recovery/store"
import { bootstrapRepositoryFromManifests, projectSnapshot, reconcileRepositoryWorkshops, workshopDetails, workshopLabels, workshopTree } from "./workshop"
import { ensureDirectorySession, ensureSession, identity, spawnClanker, spawnWorkshop, type Harness } from "./workflow"
import { getSnapshot, submitMutation, waitForOperation } from "./transport"
import type { MutationIntent } from "./transport"
import { mutationStages } from "./daemon-mutations"
import { TITLE_KEY, branchFromTitle, parseLabelAssignment, validLabelKey, validLabelValue } from "./labels"
import { applyWorkshopLabel, completeDone, dispatchLabelsChangedHook, workshopForLabelTarget, type LabelTarget } from "./workshop-hooks"

const daemonSocketPath = `${runtimeDirFor()}/daemon.sock`
const progressPrefix = "CLANKERHOUSE_PROGRESS\t"

export const mutationProgressSteps = (intent: MutationIntent): readonly string[] => {
  if (intent.type !== "delete") return []
  if (intent.kind === "worktree") return [
    "Validating worktree identity",
    "Stopping tracked Clankers",
    "Deleting worktree",
    "Deleting session",
    "Refreshing Clankerhouse",
  ]
  return ["Validating identity", `Deleting ${intent.kind}`, "Refreshing Clankerhouse"]
}

// Fetching the base and checking out a large repository takes longer than an ordinary mutation.
const workshopCreateTimeoutMs = 10 * 60_000

const routeCompatibilityMutation = async (intent: MutationIntent, options: { timeoutMs?: number } = {}) => {
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
    timeoutMs: options.timeoutMs,
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

/** Piped or redirected stdin only: a terminal or an inherited /dev/null never blocks the reporter. */
const pipedStdin = async () => {
  try {
    const stat = fstatSync(0)
    if (!stat.isFIFO() && !stat.isFile()) return undefined
  } catch { return undefined }
  return Bun.stdin.text()
}

/** `--children-of` takes an optional Workshop selector; without one it means the current Workshop. */
const takeOptionalValue = (parsed: ParsedArgs, flag: string) => {
  const index = parsed.args.indexOf(flag)
  if (index < 0) return undefined
  const value = parsed.args[index + 1]
  const present = value !== undefined && !value.startsWith("-")
  parsed.args.splice(index, present ? 2 : 1)
  return present ? value : "."
}

const takeAll = (parsed: ParsedArgs, flag: string) => {
  const values: string[] = []
  for (let value = parsed.take(flag); value !== undefined; value = parsed.take(flag)) values.push(value)
  return values
}

const runReport = async (parsed: ParsedArgs) => {
  const state = parseReportState(parsed.take("--state"))
  const message = parsed.take("--message") ?? null
  const inline = parsed.take("--payload")
  const file = parsed.take("--payload-file")
  const to = parsed.take("--to")
  const noParent = parsed.has("--no-parent")
  if (inline !== undefined && file !== undefined) throw new Error("--payload and --payload-file are mutually exclusive")
  if (parsed.args.length) throw new Error(`Unexpected argument: ${parsed.args[0]}`)
  const payloadText = inline ?? (file !== undefined ? readFileSync(file, "utf8") : await pipedStdin())
  const report = await submitReport({ state, message, payload: parseReportPayload(payloadText), to, noParent })
  return console.log(JSON.stringify(report))
}

const runWatchCommand = async (parsed: ParsedArgs) => {
  const childrenOf = takeOptionalValue(parsed, "--children-of")
  const descendants = parsed.has("--descendants")
  const clankerIds = takeAll(parsed, "--clanker")
  const cursorFile = parsed.take("--cursor-file")
  const once = parsed.has("--once")
  const timeoutSeconds = nonNegativeNumber(parsed.take("--timeout"), "--timeout")
  const staleAfterSeconds = nonNegativeNumber(parsed.take("--stale-after"), "--stale-after")
  // `--clanker A B` lists further ids positionally.
  if (clankerIds.length) clankerIds.push(...parsed.args.splice(0).filter((arg) => !arg.startsWith("-")))
  if (parsed.args.length) throw new Error(`Unexpected argument: ${parsed.args[0]}`)
  if ((childrenOf === undefined) === (clankerIds.length === 0)) throw new Error("Usage: clankers watch (--children-of [WORKSHOP] [--descendants] | --clanker ID...) [--cursor-file PATH] [--once] [--timeout SECONDS] [--stale-after SECONDS]")
  if (descendants && childrenOf === undefined) throw new Error("--descendants requires --children-of")
  const scope: WatchScope = childrenOf !== undefined
    ? { kind: "children", workshopId: resolveWorkshopSelector(childrenOf).workshopId, descendants }
    : { kind: "clankers", clankerIds }
  await runWatch({
    view: liveWatchView(scope),
    emit: emitJsonLine,
    cursorFile: cursorFile === undefined ? undefined : resolve(cursorFile),
    once,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    staleAfterMs: staleAfterSeconds === undefined ? DEFAULT_STALE_AFTER_MS : staleAfterSeconds * 1000,
  })
}

const runListCommand = async (parsed: ParsedArgs) => {
  const cwd = parsed.take("--cwd")
  const childrenOf = takeOptionalValue(parsed, "--children-of")
  const descendants = parsed.has("--descendants")
  const state = parsed.take("--state")
  if (parsed.args.length) throw new Error(`Unexpected argument: ${parsed.args[0]}\nUsage: clankers list [--cwd PATH] [--children-of [WORKSHOP] [--descendants]] [--state STATE,...]`)
  if (descendants && childrenOf === undefined) throw new Error("--descendants requires --children-of")
  const scope = childrenOf === undefined ? undefined : { workshopId: resolveWorkshopSelector(childrenOf).workshopId, descendants }
  const states = state === undefined ? undefined : parseStates(state)
  return console.log(JSON.stringify(await listClankerRows({ cwd, childrenOf: scope, states })))
}

/** `clankers view children [WORKSHOP]` narrows the Multiplexer's agent list to that Workshop's children; `clear` restores it. */
const runViewCommand = async (parsed: ParsedArgs) => {
  const action = parsed.shift()
  const usage = "Usage: clankers view children [WORKSHOP] | clear"
  if (action === "clear") {
    if (parsed.args.length) throw new Error(`Unexpected argument: ${parsed.args[0]}\n${usage}`)
    await openManagedMultiplexer().showChildAgents(null)
    return console.log(JSON.stringify({ view: null }))
  }
  if (action !== "children") throw new Error(usage)
  const selector = parsed.shift() ?? "."
  if (parsed.args.length) throw new Error(`Unexpected argument: ${parsed.args[0]}\n${usage}`)
  const workshop = resolveWorkshopSelector(selector)
  const name = workshopLabels(workshop.workshopId)[TITLE_KEY] || workshop.branch
  const label = `children of ${name}`.slice(0, 60)
  await openManagedMultiplexer().showChildAgents({ parentWorkshopId: workshop.workshopId, label })
  return console.log(JSON.stringify({ view: "children", workshopId: workshop.workshopId, label }))
}

const runClankerApi = async (command: string | undefined, parsed: ParsedArgs) => {
  if (command === "list") return runListCommand(parsed)
  if (command === "status") return console.log(JSON.stringify(await clankerStatusWithReport(requiredClankerId(parsed))))
  if (command === "capabilities") return console.log(JSON.stringify(await clankerCapabilities(requiredClankerId(parsed))))
  if (command === "report") return runReport(parsed)
  if (command === "watch") return runWatchCommand(parsed)
  if (command === "send-status") {
    const messageId = parsed.take("--message") || parsed.shift()
    if (!messageId) throw new Error("MESSAGE_ID is required")
    return console.log(JSON.stringify(await sendStatus(messageId)))
  }
  if (command === "wait") {
    const afterGeneration = nonNegativeNumber(parsed.take("--after"), "--after")
    const messageId = parsed.take("--message")
    const timeoutSeconds = nonNegativeNumber(parsed.take("--timeout"), "--timeout")
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000
    if (messageId !== undefined && afterGeneration !== undefined) throw new Error("--message and --after are mutually exclusive")
    const id = requiredClankerId(parsed)
    if (messageId !== undefined) return console.log(JSON.stringify(await waitForMessage(id, messageId, { timeoutMs })))
    return console.log(JSON.stringify(await waitForClanker(id, { afterGeneration, timeoutMs })))
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
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000
    const status = await clankerCapabilities(id)
    if (status.capabilities.send === "multiplexer-prompt") {
      // A prompt-transport message may queue, so wait for the turn it started; the turn's
      // Report stands in for a result where the harness keeps no reply.
      const { lastReport, message, ...settled } = await waitForMessage(id, receipt.messageId, { timeoutMs })
      const generation = message.startedGeneration ?? settled.settledGeneration
      const result = status.capabilities.result ? await resultForClanker(id, generation).catch(() => null) : undefined
      return console.log(JSON.stringify({ ...receipt, settled, lastReport, ...(result === undefined ? {} : { result }) }))
    }
    const settled = await waitForClanker(id, { afterGeneration: receipt.afterGeneration, timeoutMs })
    return console.log(JSON.stringify({ ...receipt, settled, result: await resultForClanker(id, settled.settledGeneration) }))
  }
  if (command === "result") {
    const generation = nonNegativeNumber(parsed.take("--generation"), "--generation")
    return console.log(JSON.stringify(await resultForClanker(requiredClankerId(parsed), generation)))
  }
  throw new Error("Usage: clankers list|status|capabilities|wait|send|send-status|result|report|watch ...")
}

const resolveWorkshopPath = (selector: string, cwd = process.cwd()) => {
  const project = projectSnapshot(cwd)
  const matches = project.workshops.filter((row) => row.workshopId === selector || row.branch === selector || row.canonicalPath === selector || row.canonicalPath.endsWith(`/${selector}`))
  if (matches.length === 0) throw new Error(`Unknown workshop: ${selector}`)
  if (matches.length > 1) throw new Error(`Ambiguous workshop '${selector}'; use its durable workshop ID`)
  return matches[0]!.canonicalPath
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
  clankers workshop spawn (--title TITLE | --name NAME) --harness HARNESS [--base REF] [--profile NAME] [--model MODEL] [--prompt TEXT]
  clankers workshop ensure [--cwd PATH]
  clankers workshop identity [--cwd PATH]
  clankers workshop label set KEY=VALUE | unset KEY | list [--cwd PATH | --workshop ID|BRANCH|PATH]
  clankers workshop done [--cwd PATH]
  clankers workshop stop [--cwd PATH]
  clankers target open --json TARGET
  clankers diagnose [--json] [--strict]
  clankers spawn --workshop WORKSHOP --name NAME --harness HARNESS [--profile NAME] [--model MODEL] [--resource-class interactive|validation-heavy|untrusted] [--prompt TEXT]
  clankers list [--cwd PATH] [--children-of [WORKSHOP] [--descendants]] [--state STATE,...]
  clankers status|capabilities CLANKER_ID
  clankers wait CLANKER_ID [--after GENERATION | --message MESSAGE_ID] [--timeout SECONDS]
  clankers send CLANKER_ID [--delivery steer|follow-up] [--wait] [--text TEXT]
  clankers send-status MESSAGE_ID
  clankers result CLANKER_ID [--generation GENERATION]
  clankers report --state question|blocked|done|failed|working [--message TEXT] [--payload JSON | --payload-file PATH | <JSON on stdin] [--to CLANKER_ID|WORKSHOP_ID | --no-parent]
  clankers watch (--children-of [WORKSHOP] [--descendants] | --clanker ID...) [--cursor-file PATH] [--once] [--timeout SECONDS] [--stale-after SECONDS]
  clankers view children [WORKSHOP] | clear
  clankers delete session|worktree --session SESSION [--path PATH] --yes
  clankers recovery status|journal|reconcile|checkpoint
  clankers recovery attest-exit CLANKER_ID --attempt ID [--session-id ID]
  clankers recovery pending|pause-all
  clankers recovery resume CLANKER_ID [--force]
  clankers recovery unquarantine CLANKER_ID --reason TEXT
  clankers recovery stop|start|suspend|tombstone CLANKER_ID
  clankers mux kind|capabilities|pane-address-env|observe|current-location
  clankers mux claim|read-claim (--pane PANE|--window WINDOW|--session SESSION) KEY [VALUE|--unset]
  clankers mux kill|focus (--pane PANE|--window WINDOW|--session SESSION)
  clankers mux clanker-ids|pane-path (--pane PANE|--session SESSION)
  clankers mux spawn (--session SESSION|--new-session NAME) --name NAME --cwd PATH [--env KEY=VALUE]... [-- ARGV...]

--model MODEL overrides the profile/default model for Pi, Claude, and Codex.
Pi and Claude retain the override during Recovery. OpenCode does not support this flag.`

const claimKeys = new Set<ClaimKey>(["workshopId", "workshopParentId", "worktreePath", "directoryPath", "gitCommonDir", "sessionId", "sessionDisplayName", "windowId", "windowDisplayName", "windowHarness", "terminalId", "terminalDisplayName", "clankerId", "harness", "harnessSessionId", "recoveryAttemptId", "clankerSocket", "clankerPid", "clankerCapabilities", "paneWorkshopParentId"])

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
  if (subcommand === "current-location") return console.log(JSON.stringify(await multiplexer.currentLocation() ?? null))
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
  if (subcommand === "focus") return multiplexer.focus(muxLocation(parsed))
  if (subcommand === "spawn") {
    const newSession = parsed.take("--new-session")
    const session = parsed.take("--session")
    const name = parsed.take("--name")
    const cwd = parsed.take("--cwd")
    const instance = Bun.env.CLANKERHOUSE_INSTANCE?.trim()
    const env: Record<string, string> = instance ? { CLANKERHOUSE_INSTANCE: instance } : {}
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

/** The versioned error code and exit status for a failure, looking through wrapped causes. */
export const cliErrorCode = (error: unknown): { code: string; exitCode: number } => {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof ClankerApiError) return { code: current.code, exitCode: current.exitCode }
    if (current instanceof MultiplexerResourceExhaustedError) return { code: current.code, exitCode: 5 }
  }
  return { code: "INVALID_REQUEST", exitCode: 2 }
}

export async function runClankersCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  const command = parsed.shift()
  if (!command || command === "help" || command === "--help" || command === "-h") return console.log(usage)
  if (["list", "status", "capabilities", "wait", "send", "send-status", "result", "report", "watch"].includes(command)) return runClankerApi(command, parsed)

  if (command === "mux") return runMultiplexerCli(parsed)
  if (command === "view") return runViewCommand(parsed)

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
      console.log(`Clankerhouse projection: ${report.counts.sessions} sessions, ${report.counts.directories} directories, ${report.counts.renderedSessionRows} rendered session rows`)
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
    const routed = await routeCompatibilityMutation({ type: "open", target })
    if (routed) return
    const multiplexer = openManagedMultiplexer()
    if (target.type === "session" || target.type === "window") {
      await multiplexer.openTarget(target)
      return
    }
    if (target.type === "opencode") {
      const location = await multiplexer.resolve(target)
      if (!location) throw new Error(`OpenCode target has no current ${multiplexer.kind} location`)
      await multiplexer.open(location)
      return
    }
    const session = await ensureDirectorySession(target.path)
    await multiplexer.openTarget({ type: "session", session })
    return
  }

  if (command === "recovery") {
    const subcommand = parsed.shift()
    const store = openRecoveryStore()
    try {
      if (subcommand === "status") return console.log(JSON.stringify({ epochs: store.runtimeEpochs(), serverEpoch: store.getMetadata("runtime.server_epoch") ?? null, clankers: store.listDesired({ includeTombstoned: true }).map((row) => ({ ...row, originalTask: undefined })), attempts: store.listDesired({ includeTombstoned: true }).flatMap((row) => store.attemptsFor(row.clankerId)) }))
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
        const state = parsed.take("--state")
        const attemptId = nonNegativeNumber(parsed.take("--attempt"), "--attempt")
        return console.log(JSON.stringify(await attestHarnessSession(store, { clankerId: id, harnessSessionId: sessionId, state, attemptId })))
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
      const title = parsed.take("--title")
      if (title !== undefined && !validLabelValue(title, TITLE_KEY)) throw new Error("--title must be 1-80 characters without control characters")
      const name = parsed.take("--name") ?? (title ? branchFromTitle(title) : undefined)
      if (!name) throw new Error("--name or --title is required")
      const selectedHarness = harness(parsed.take("--harness"))
      const model = parsed.take("--model")
      const base = parsed.take("--base"); const window = parsed.take("--clanker-name"); const profile = parsed.take("--profile"); const selectedResourceClass = resourceClass(parsed.take("--resource-class")); const wait = parsed.has("--wait"); const parentWorkshopId = parsed.take("--parent"); const noParent = parsed.has("--no-parent")
      if (parentWorkshopId && noParent) throw new Error("--parent and --no-parent are mutually exclusive")
      const prompt = parsed.take("--prompt") || parsed.args.join(" ") || "Ready for instructions."
      const result = await spawnWorkshop(selectedHarness, name, prompt, {
        base,
        window,
        profile,
        model,
        resourceClass: selectedResourceClass,
        wait,
        parentWorkshopId,
        noParent,
        title,
        daemonCreate: async (branch, base, title) => {
          const repository = (await identity()).path
          // The daemon's create opens a branch's existing worktree; spawn only ever makes a new one, as `wt switch --create` does.
          if (Bun.spawnSync(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0) throw new Error(`Branch '${branch}' already exists`)
          const routed = await routeCompatibilityMutation({ type: "create", repository, branch, create: true, base, title, deferSession: true }, { timeoutMs: workshopCreateTimeoutMs })
          if (!routed) return undefined
          const path = (routed.result as { path?: unknown } | undefined)?.path
          if (typeof path !== "string" || !path) throw new Error(`Daemon created '${branch}' but did not return a worktree path`)
          return path
        },
      })
      return console.log(JSON.stringify(result))
    }
    const cwdOption = parsed.take("--cwd")
    const cwd = cwdOption || process.cwd()
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
    if (subcommand === "label") {
      const selector = parsed.take("--workshop")
      if (selector !== undefined && cwdOption !== undefined) throw new Error("--workshop and --cwd are mutually exclusive")
      // A selected Workshop resolves to its durable ID, so its worktree may already be gone, as after a merge.
      const target: LabelTarget = selector !== undefined ? { workshopId: resolveWorkshopSelector(selector).workshopId } : { path: resolve(cwd) }
      const action = parsed.shift()
      if (action === "list") return console.log(JSON.stringify(workshopLabels(workshopForLabelTarget(target).workshopId)))
      const argument = parsed.shift()
      if ((action !== "set" && action !== "unset") || !argument) throw new Error("Usage: clankers workshop label set KEY=VALUE | unset KEY | list [--cwd PATH | --workshop ID|BRANCH|PATH]")
      if (action === "unset" && !validLabelKey(argument)) throw new Error(`Invalid label key '${argument}'`)
      const { key, value } = action === "set" ? parseLabelAssignment(argument) : { key: argument, value: null }
      const routed = await routeCompatibilityMutation({ type: "label", ...target, key, value })
      if (routed) return console.log(JSON.stringify(routed.result))
      const applied = applyWorkshopLabel(target, key, value)
      if (applied.changed) dispatchLabelsChangedHook(applied.workshop, applied.previous, applied.labels)
      return console.log(JSON.stringify({ workshopId: applied.workshop.workshopId, labels: applied.labels, changed: applied.changed }))
    }
    if (subcommand === "done") {
      const routed = await routeCompatibilityMutation({ type: "done", path: resolve(cwd) })
      return console.log(JSON.stringify(routed ? routed.result : await completeDone(cwd)))
    }
    if (subcommand === "stop") {
      const routed = await routeCompatibilityMutation({ type: "workshop.stop", path: resolve(cwd) })
      if (!routed) throw new Error("Clankerhouse daemon is required to stop a Workshop")
      return console.log(JSON.stringify(routed.result))
    }
    if (subcommand === "show") return console.log(JSON.stringify(workshopDetails(cwd, { id: parsed.take("--id"), path: parsed.take("--path") }) ?? null, null, 2))
    if (subcommand === "tree") return console.log(JSON.stringify(workshopTree(cwd), null, 2))
    if (subcommand === "project") return console.log(JSON.stringify(projectSnapshot(cwd), null, 2))
    if (subcommand === "reconcile") return console.log(JSON.stringify(reconcileRepositoryWorkshops(cwd), null, 2))
    if (subcommand === "bootstrap") return console.log(JSON.stringify(bootstrapRepositoryFromManifests(cwd), null, 2))
    throw new Error("Usage: clankers workshop spawn|ensure|identity|label|done|stop|show|tree|project|reconcile|bootstrap ...")
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

  throw new Error("Usage: clankers workshop spawn ... | spawn ... | list|status|capabilities|wait|send|send-status|result|report|watch ...")
}

if (import.meta.main) {
  runClankersCli().catch((error) => {
    const { code, exitCode } = cliErrorCode(error)
    console.error(JSON.stringify({ apiVersion: 1, error: { code, message: error instanceof Error ? error.message : String(error) } }))
    process.exit(exitCode)
  })
}

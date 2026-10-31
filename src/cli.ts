#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { existsSync, fstatSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { ClankerApiError, clankerCapabilities, clankerStatusWithReport, listClankers, resultForClanker, sendClanker, sendStatus, waitForClanker, waitForMessage, type ClankerDelivery } from "./clanker-api"
import { DEFAULT_STALE_AFTER_MS, parseReportPayload, parseReportState } from "./orchestration"
import { submitReport } from "./report"
import { listClankerRows, parseStates } from "./clanker-list"
import { emitJsonLine, liveWatchView, resolveWorkshopSelector, runWatch, type WatchScope } from "./watch"
import { openClankerLedger, type LedgerState, type ResourceClass } from "./clanker-ledger"
import { harnessModelArgs, stopOwnedHarness } from "./harness-launch"
import { createMultiplexer, openManagedMultiplexer } from "./multiplexer"
import { HcAdapter, HcAttachError } from "./multiplexer/hc"
import { ensureHcCore, hcCoreEnvironment, hcHealth, restartHcCore } from "./multiplexer/hc-core"
import { MultiplexerResourceExhaustedError, paneLocation, UnsupportedMultiplexerOperation, type ClaimKey, type NativeLocation } from "./multiplexer/interface"
import { runtimeDirFor } from "./paths"
import { diagnoseProjection } from "./diagnostics"
import type { SessionRow, Target } from "./model"
import { bootstrapRepositoryFromManifests, projectSnapshot, reconcileRepositoryWorkshops, workshopDetails, workshopForId, workshopLabels, workshopTree } from "./workshop"
import { ensureDirectorySession, ensureSession, identity, resumeClanker, spawnClanker, spawnWorkshop, type Harness } from "./workflow"
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

const resourceClass = (value: string | undefined): ResourceClass | undefined => {
  if (value === undefined) return undefined
  if (["interactive", "validation-heavy", "untrusted"].includes(value)) return value as ResourceClass
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


/**
 * The clanker ledger with liveness: an open clanker that is not alive was interrupted by a
 * restart and can be resumed. Liveness is null when the daemon cannot be asked.
 */
const ledgerRows = async (options: { state?: LedgerState; workshopId?: string; interrupted?: boolean }) => {
  const ledger = openClankerLedger()
  let rows
  try { rows = ledger.list({ state: options.interrupted ? "open" : options.state, workshopId: options.workshopId }) } finally { ledger.close() }
  const live = await listClankers().then((clankers) => new Set(clankers.map((clanker) => clanker.id)), () => undefined)
  return rows
    .map((row) => ({ ...row, alive: live ? live.has(row.clankerId) : null, interrupted: live ? row.state === "open" && !live.has(row.clankerId) : null }))
    .filter((row) => !options.interrupted || row.interrupted !== false)
}

export const usage = `Usage:
  clankerhouse
  clankers workshop spawn (--title TITLE | --name NAME) --harness HARNESS [--base REF] [--profile NAME] [--model MODEL] [--clanker-name NAME] [--resource-class interactive|validation-heavy|untrusted] [--parent ID | --no-parent] [--wait] [--prompt TEXT]
  clankers workshop ensure [--cwd PATH]
  clankers workshop identity [--cwd PATH]
  clankers workshop label set KEY=VALUE | unset KEY | list [--cwd PATH | --workshop ID|BRANCH|PATH]
  clankers workshop done [--cwd PATH]
  clankers workshop stop [--cwd PATH]
  clankers workshop detach [ID|BRANCH|PATH] [--cwd PATH]
  clankers workshop reparent [ID|BRANCH|PATH] --parent ID|BRANCH|PATH [--cwd PATH]
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
  clankers ledger [--state open|closed | --interrupted] [--workshop ID]
  clankers ledger close CLANKER_ID [--reason TEXT] [--if-present]
  clankers resume CLANKER_ID [--prompt TEXT]
  clankers mux kind|capabilities|pane-address-env|observe|current-location
  clankers mux claim|read-claim (--pane PANE|--window WINDOW|--session SESSION) KEY [VALUE|--unset]
  clankers mux kill|focus (--pane PANE|--window WINDOW|--session SESSION)
  clankers mux interrupt|attach --pane PANE
  clankers mux instance-id|hc-health|hc-ensure|hc-restart|hc-env
  clankers mux clanker-ids|pane-path (--pane PANE|--session SESSION)
  clankers mux spawn (--session SESSION|--new-session NAME) --name NAME --cwd PATH [--env KEY=VALUE]... [-- ARGV...]

--model MODEL overrides the profile/default model for Pi, Claude, and Codex.
Pi and Claude keep the override when resumed. OpenCode does not support this flag.

A spawned Workshop's parent defaults to the Workshop of the current directory. --parent ID names
another one and --no-parent makes it top-level. --clanker-name names the first clanker, and --wait
waits for it to be ready.

workshop detach makes a Workshop top-level, workshop reparent moves it under another Workshop of the
same repository. Both default to the current Workshop and keep its subtree, clankers, panes, worktree
and branch; they need the daemon, and a parent inside the Workshop's own subtree is rejected.`

const claimKeys = new Set<ClaimKey>(["workshopId", "workshopParentId", "worktreePath", "directoryPath", "gitCommonDir", "sessionId", "sessionDisplayName", "windowId", "windowDisplayName", "windowHarness", "terminalId", "terminalDisplayName", "clankerId", "harness", "harnessSessionId", "clankerSocket", "clankerPid", "clankerCapabilities", "paneWorkshopParentId"])

const muxLocation = (parsed: ParsedArgs): NativeLocation => {
  const pane = parsed.take("--pane")
  const window = parsed.take("--window")
  const session = parsed.take("--session")
  if (!pane && !window && !session) throw new Error("--pane, --window, or --session is required")
  return { nativeSessionId: session ?? "", nativeWindowId: window ?? null, nativePaneId: pane ?? null }
}

/**
 * Runtime-neutral multiplexer operations for shell callers (lifecycle reporters, stop
 * scripts). Every operation goes through the selected Adapter.
 */
const attachHcTerminal = async (location: NativeLocation) => {
  const adapter = createMultiplexer()
  if (!(adapter instanceof HcAdapter)) throw new UnsupportedMultiplexerOperation(adapter.kind, "attach")
  try {
    const target = await adapter.attachTarget(location.nativePaneId ?? location.nativeWindowId ?? "")
    process.exitCode = await Bun.spawn([Bun.env.HC_BIN || "hc", "attach", target], { stdio: ["inherit", "inherit", "inherit"] }).exited
  } catch (error) {
    if (!(error instanceof HcAttachError)) throw error
    console.error(error.message)
    if (error.transcript.trim()) console.error(`Its last output:\n${error.transcript.trimEnd()}`)
    process.exitCode = 3
  }
}

const runMultiplexerCli = async (parsed: ParsedArgs) => {
  const subcommand = parsed.shift()
  const multiplexer = openManagedMultiplexer()
  if (subcommand === "kind") return console.log(multiplexer.kind)
  if (subcommand === "instance-id") return console.log(await multiplexer.instanceId())
  if (subcommand === "hc-env") return console.log(Object.entries(hcCoreEnvironment()).map(([key, value]) => `${key}=${value}`).join("\n"))
  if (subcommand === "hc-ensure") return console.log(JSON.stringify(await ensureHcCore()))
  if (subcommand === "hc-restart") return restartHcCore()
  if (subcommand === "hc-health") {
    const health = await hcHealth()
    console.log(JSON.stringify(health))
    if (!health.reachable) process.exitCode = 1
    return
  }
  if (subcommand === "interrupt") return console.log(await multiplexer.interruptAgent(muxLocation(parsed)))
  if (subcommand === "attach") return attachHcTerminal(muxLocation(parsed))
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

  if (command === "ledger") {
    if (parsed.args[0] === "close") {
      // Closing stops the harness too, so it is not reopened by the next observation.
      parsed.shift()
      const id = requiredClankerId(parsed)
      const reason = parsed.take("--reason") || "operator"
      const ifPresent = parsed.has("--if-present")
      const ledger = openClankerLedger()
      try {
        const clanker = ledger.get(id)
        if (!clanker) {
          if (ifPresent) return console.log(JSON.stringify({ clankerId: id, tracked: false }))
          throw new Error(`Unknown clanker ${id}`)
        }
        if (clanker.ownerUnit) stopOwnedHarness(clanker.ownerUnit)
        ledger.end(id, reason)
        return console.log(JSON.stringify(ledger.get(id)))
      } finally { ledger.close() }
    }
    const state = parsed.take("--state")
    if (state !== undefined && state !== "open" && state !== "closed") throw new Error("--state must be open or closed")
    return console.log(JSON.stringify(await ledgerRows({ state, workshopId: parsed.take("--workshop"), interrupted: parsed.has("--interrupted") })))
  }

  if (command === "resume") {
    const id = requiredClankerId(parsed)
    return console.log(JSON.stringify(await resumeClanker(id, { prompt: parsed.take("--prompt") })))
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
    if (subcommand === "detach" || subcommand === "reparent") {
      const parentSelector = parsed.take("--parent")
      if (subcommand === "reparent" && !parentSelector) throw new Error("--parent is required")
      const selector = parsed.shift()
      if (parsed.args.length > 0) throw new Error(`Usage: clankers workshop ${subcommand} [ID|BRANCH|PATH]${subcommand === "reparent" ? " --parent ID|BRANCH|PATH" : ""} [--cwd PATH]`)
      if (selector !== undefined && cwdOption !== undefined) throw new Error("A workshop selector and --cwd are mutually exclusive")
      const workshop = selector !== undefined ? resolveWorkshopSelector(selector) : workshopForLabelTarget({ path: resolve(cwd) })
      const parent = parentSelector ? resolveWorkshopSelector(parentSelector, workshop.canonicalPath) : undefined
      const routed = await routeCompatibilityMutation(parent ? { type: "reparent", workshopId: workshop.workshopId, parentWorkshopId: parent.workshopId } : { type: "detach", workshopId: workshop.workshopId })
      if (!routed) throw new Error("Clankerhouse daemon is required to change a Workshop's parent")
      const updated = workshopForId(workshop.workshopId)
      return console.log(JSON.stringify({ workshopId: workshop.workshopId, parentWorkshopId: updated?.parentWorkshopId ?? null, previousParentWorkshopId: workshop.parentWorkshopId, revision: updated?.revision, changed: updated?.revision !== workshop.revision }))
    }
    if (subcommand === "show") return console.log(JSON.stringify(workshopDetails(cwd, { id: parsed.take("--id"), path: parsed.take("--path") }) ?? null, null, 2))
    if (subcommand === "tree") return console.log(JSON.stringify(workshopTree(cwd), null, 2))
    if (subcommand === "project") return console.log(JSON.stringify(projectSnapshot(cwd), null, 2))
    if (subcommand === "reconcile") return console.log(JSON.stringify(reconcileRepositoryWorkshops(cwd), null, 2))
    if (subcommand === "bootstrap") return console.log(JSON.stringify(bootstrapRepositoryFromManifests(cwd), null, 2))
    throw new Error("Usage: clankers workshop spawn|ensure|identity|label|done|stop|detach|reparent|show|tree|project|reconcile|bootstrap ...")
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

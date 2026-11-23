/**
 * The Rex lane's one background process, for timed work only: queued message delivery, Routines, Status Event sinks,
 * the done-Workshop reaper, Claude account switching and directory rediscovery. It keeps the snapshot cache (state.json) warm for the picker's
 * first paint and the clanker ledger in step with Rex, but serves nothing: no socket, no projection authority.
 * Runs as the systemd user service `clankerhouse-runner-<instance>` (bin/clankerhouse-rex --ensure-runner).
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { deliverQueuedMessages } from "./clanker-api"
import { openClankerLedger } from "./clanker-ledger"
import { runAccountSwitchPass } from "./claude-account-switch"
import { deliveryEscalationEvent, runDeliveryWatch, type DeliveryEscalation } from "./delivery-watch"
import { watchHookStateRequests, type HookStateRequest } from "./hook-events"
import { reapDoneWorkshops, resumeUnfinishedMutations } from "./mutations"
import { withOrchestrationStore } from "./orchestration"
import { fireRoutinesThroughSend, routineNoticeEvent } from "./routine-api"
import type { RoutineNotice } from "./routines"
import { daemonMultiplexer, ensurePrivateRuntimeDirectory, invalidateProjectionEnrichment, latestHerdOf, onSnapshot, refreshProjectionSnapshot, refreshStaleDirectories, runtimeDir, scheduleProjectionRefresh } from "./snapshot"
import { StatusHookRuntime, liveStatusView } from "./status-hooks"
import { workshopForId } from "./workshop"

const pidPath = `${runtimeDir}/runner.pid`
const refreshMs = Number(Bun.env.CLANKERHOUSE_REFRESH_MS ?? 15_000) || 15_000


// Queued Claude messages: a delivery pass when a clanker with pending messages changes state or
// the operator's focus moves, and a slow fallback pass while anything is pending. Every pass
// observes the whole Multiplexer, so none runs on a fast timer. Each failure is logged once
// until it changes.
const QUEUED_DELIVERY_MS = 30_000
let queuedDeliveryRunning = false
let queuedDeliveryFailure = ""
const runQueuedDelivery = () => {
  if (queuedDeliveryRunning) return
  queuedDeliveryRunning = true
  void deliverQueuedMessages(daemonMultiplexer())
    .then((result) => {
      const failure = result.failed.map((entry) => `${entry.messageId}: ${entry.error}`).join("; ")
      if (failure && failure !== queuedDeliveryFailure) console.error(`Queued message delivery failed: ${failure}`)
      queuedDeliveryFailure = failure
    })
    .catch((error) => {
      const failure = error instanceof Error ? error.message : String(error)
      if (failure !== queuedDeliveryFailure) console.error(`Queued message delivery failed: ${failure}`)
      queuedDeliveryFailure = failure
    })
    .finally(() => { queuedDeliveryRunning = false })
}
const hasPendingMessagesFor = (clankerId?: string) => {
  try { return withOrchestrationStore((store) => clankerId ? store.pendingMessages(clankerId).length > 0 : store.hasPendingMessages()) }
  catch { return true }
}
const startQueuedDelivery = () => {
  const timer = setInterval(runQueuedDelivery, QUEUED_DELIVERY_MS)
  return () => clearInterval(timer)
}

// Clanker Routines: every pass fires the Routines whose minute has come, through the same send
// path and queue as `clankers send`. Cron has minute resolution, so a pass every 15 seconds
// wakes a clanker within a quarter of a minute of its scheduled time.
const ROUTINE_PASS_MS = Number(Bun.env.CLANKERHOUSE_ROUTINE_PASS_MS ?? 15_000) || 15_000
let routinePassRunning = false
let routinePassFailure = ""
let routineNotify: ((notice: RoutineNotice) => void) | undefined
const runRoutinePass = () => {
  if (routinePassRunning) return
  routinePassRunning = true
  void fireRoutinesThroughSend(daemonMultiplexer(), { notify: routineNotify })
    .then((fired) => {
      for (const entry of fired) {
        if (entry.outcome === "fired" || entry.outcome === "resumed" || entry.outcome === "caught-up") console.error(`Routine ${entry.routineId} woke ${entry.clankerId} (${entry.messageId})${entry.outcome === "fired" ? "" : `, ${entry.outcome}`}`)
        else console.error(`Routine ${entry.routineId} for ${entry.clankerId}: ${entry.outcome}${entry.error ? `: ${entry.error}` : ""}`)
      }
      routinePassFailure = ""
    })
    .catch((error) => {
      const failure = error instanceof Error ? error.message : String(error)
      if (failure !== routinePassFailure) console.error(`Routine pass failed: ${failure}`)
      routinePassFailure = failure
    })
    .finally(() => { routinePassRunning = false })
}
const startRoutines = () => {
  const timer = setInterval(runRoutinePass, ROUTINE_PASS_MS)
  runRoutinePass()
  return () => clearInterval(timer)
}

// The delivery watch: senders hear why a message is held or failed, and a hold that will not fix itself reaches the
// operator's phone and needs-me list. It also hands Reports no watch showed to their addressee.
const DELIVERY_WATCH_MS = Number(Bun.env.CLANKERHOUSE_DELIVERY_WATCH_MS ?? 60_000) || 60_000
let deliveryWatchRunning = false
let deliveryWatchFailure = ""
let deliveryEscalate: ((escalations: DeliveryEscalation[]) => void) | undefined
const runDeliveryWatchPass = () => {
  if (deliveryWatchRunning) return
  deliveryWatchRunning = true
  void runDeliveryWatch({ multiplexer: daemonMultiplexer(), escalate: deliveryEscalate, log: (line) => console.error(`Delivery watch: ${line}`) })
    .then(() => { deliveryWatchFailure = "" })
    .catch((error) => {
      const failure = error instanceof Error ? error.message : String(error)
      if (failure !== deliveryWatchFailure) console.error(`Delivery watch failed: ${failure}`)
      deliveryWatchFailure = failure
    })
    .finally(() => { deliveryWatchRunning = false })
}
const startDeliveryWatch = () => {
  const timer = setInterval(runDeliveryWatchPass, DELIVERY_WATCH_MS)
  return () => clearInterval(timer)
}
const recipientWorkshop = (clankerId: string) => {
  try {
    const ledger = openClankerLedger()
    try {
      const workshopId = ledger.get(clankerId)?.workshopId
      const record = workshopId ? workshopForId(workshopId) : undefined
      return record ? { id: record.workshopId, path: record.canonicalPath, branch: record.branch } : undefined
    } finally { ledger.close() }
  } catch { return undefined }
}

// Claude account switching: a clanker whose turn ended on a usage limit resumes on another account. A pass runs when a
// clanker's state changes (a StopFailure is one) and on a slow timer, which also catches an account's reset. With
// fewer than two accounts configured a pass returns before observing anything.
const ACCOUNT_SWITCH_MS = Number(Bun.env.CLANKERHOUSE_ACCOUNT_SWITCH_MS ?? 60_000) || 60_000
let accountSwitchRunning = false
let accountSwitchFailure = ""
const runAccountSwitch = () => {
  if (accountSwitchRunning) return
  accountSwitchRunning = true
  void runAccountSwitchPass({ multiplexer: daemonMultiplexer() })
    .then(() => { accountSwitchFailure = "" })
    .catch((error) => {
      const failure = error instanceof Error ? error.message : String(error)
      if (failure !== accountSwitchFailure) console.error(`Claude account switch pass failed: ${failure}`)
      accountSwitchFailure = failure
    })
    .finally(() => { accountSwitchRunning = false })
}
const startAccountSwitch = () => {
  const timer = setInterval(runAccountSwitch, ACCOUNT_SWITCH_MS)
  return () => clearInterval(timer)
}

const applyHookStateRequest = async (request: HookStateRequest) => {
  // A request means the clanker's state changed; show it now rather than on the next poll.
  scheduleProjectionRefresh()
  if (hasPendingMessagesFor(request.clankerId)) runQueuedDelivery()
  // A usage limit leaves a Claude clanker blocked; other hook events wait for the timer.
  if (request.state === "blocked" && (request.harness ?? "claude") === "claude") runAccountSwitch()
}


export const runRunner = async () => {
  ensurePrivateRuntimeDirectory()
  writeFileSync(pidPath, `${process.pid}\n`)
  refreshStaleDirectories(true)
  const stops: Array<() => void> = []
  const changeSignal = new AbortController()
  const shutdown = () => {
    changeSignal.abort()
    for (const stop of stops) stop()
    try { if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath) } catch {}
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  const statusHooks = new StatusHookRuntime({
    view: liveStatusView({ panes: () => latestHerdOf()?.panes, multiplexer: daemonMultiplexer }),
    requestObservation: scheduleProjectionRefresh,
  })
  stops.push(() => statusHooks.stop())
  // A broken or ended Routine goes to the sinks that want `routine.*` (the operator's phone).
  routineNotify = (notice) => {
    const sinks = statusHooks.publish([routineNoticeEvent(notice)])
    console.error(`Routine ${notice.routine.routineId} ${notice.kind}: ${notice.reason} (${sinks ? `sent to ${sinks} sink${sinks === 1 ? "" : "s"}` : "no sink wants routine events"})`)
  }
  // An undelivered message goes to the sinks that want `message.*` (the operator's phone), one push per recipient.
  deliveryEscalate = (escalations) => {
    const due = escalations.filter((escalation) => escalation.pushed)
    const sinks = due.length ? statusHooks.publish(due.map((escalation) => deliveryEscalationEvent(escalation, recipientWorkshop(escalation.message.clankerId)))) : 0
    for (const escalation of escalations) console.error(`Message ${escalation.message.messageId} to ${escalation.name} escalated: ${escalation.reason} (${!escalation.pushed ? "needs-me row only" : sinks ? `sent to ${sinks} sink${sinks === 1 ? "" : "s"}` : "no sink wants message events"})`)
  }
  stops.push(onSnapshot((sessions) => {
    void statusHooks.observed()
    void reapDoneWorkshops(sessions).catch((error) => console.error(`Done Workshop reaper failed: ${error instanceof Error ? error.message : String(error)}`))
  }))
  stops.push(watchHookStateRequests(`${runtimeDir}/hook-events`, applyHookStateRequest))
  stops.push(startQueuedDelivery())
  stops.push(startRoutines())
  stops.push(startDeliveryWatch())
  stops.push(startAccountSwitch())
  void (async () => {
    try {
      for await (const change of daemonMultiplexer().changes(changeSignal.signal)) {
        if (change.kind === "reconnect") invalidateProjectionEnrichment()
        scheduleProjectionRefresh()
        // A message held while the operator typed into its clanker goes out once focus moves on.
        if (change.kind === "focus" && hasPendingMessagesFor()) runQueuedDelivery()
      }
    } catch (error) {
      if (!changeSignal.signal.aborted) console.error(`Rex change stream stopped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  while (true) {
    // A mutation whose process died (a picker closed mid-delete) finishes here rather than on the next one.
    try { await resumeUnfinishedMutations() } catch (error) { console.error(`Resuming unfinished mutations failed: ${error instanceof Error ? error.message : String(error)}`) }
    try { await refreshProjectionSnapshot() } catch (error) { console.error(error instanceof Error ? error.message : String(error)) }
    await Bun.sleep(refreshMs)
  }
}

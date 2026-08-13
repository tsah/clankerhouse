import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { RECOVERY_POLICY, type DesiredClankerRecord, type ProcessIdentity } from "./model"
import { initialHarnessCommand, recoveryHarnessCommand } from "./harness"
import { openRecoveryStore, type RecoveryStore } from "./store"
import { parseTmuxFields, tmuxFields } from "../tmux-fields"

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
  const exponent = Math.min(Math.max(0, latest.attempt - 1), RECOVERY_POLICY.maxAttempts - 1)
  const delay = Math.min(RECOVERY_POLICY.maxBackoffMs, RECOVERY_POLICY.initialBackoffMs * (2 ** exponent))
  return Math.max(0, latest.finishedAt + delay - now)
}

export interface ReconcileResult { launched: string[]; adopted: string[]; skipped: Array<{ clankerId: string; reason: string }> }

export const reconcileRecovery = async (providedStore?: RecoveryStore, options: { trigger?: string; now?: number } = {}): Promise<ReconcileResult> => {
  const ownStore = !providedStore
  const store = providedStore ?? openRecoveryStore()
  const result: ReconcileResult = { launched: [], adopted: [], skipped: [] }
  try {
    const now = options.now ?? Date.now()
    let panes = await observePanes()
    for (const desired of store.listDesired()) {
      if (desired.desiredState !== "running") continue
      const matching = panes.filter((pane) => pane.clankerId === desired.clankerId)
      if (matching.length > 1) {
        result.skipped.push({ clankerId: desired.clankerId, reason: "ambiguous duplicate live panes" })
        continue
      }
      if (matching.length === 1) {
        const pane = matching[0]!
        if (pane.harness && pane.harness !== desired.harness) result.skipped.push({ clankerId: desired.clankerId, reason: "live harness mismatch" })
        else if (pane.harnessSessionId && desired.harnessSessionId && pane.harnessSessionId !== desired.harnessSessionId) result.skipped.push({ clankerId: desired.clankerId, reason: "live harness session mismatch" })
        else result.adopted.push(desired.clankerId)
        continue
      }
      const remaining = backoffRemaining(desired, store, now)
      if (remaining > 0) {
        result.skipped.push({ clankerId: desired.clankerId, reason: `backoff ${remaining}ms` })
        continue
      }
      for (const previous of store.attemptsFor(desired.clankerId).filter((attempt) => attempt.status === "running")) {
        store.finishAttempt(previous.id, "abandoned", { error: "no live pane attested the attempt", now })
      }
      const previousSucceeded = store.attemptsFor(desired.clankerId).some((attempt) => attempt.status === "succeeded")
      const attempt = store.beginAttempt(desired.clankerId, previousSucceeded ? options.trigger || "recovery" : "initial", { now })
      const attemptId = String(attempt.id)
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

export class RecoveryController {
  readonly ownerToken = randomUUID()
  private stopped = false
  constructor(readonly store = openRecoveryStore(), readonly intervalMs = Number(Bun.env.CLANKERHOUSE_RECOVERY_INTERVAL_MS || 2_000)) {}

  stop() { this.stopped = true }

  async run(options: { once?: boolean } = {}) {
    const identity = controllerIdentity()
    const scope = { kind: "global" } as const
    while (!this.stopped) {
      const lease = this.store.acquireLease({ ...identity, scope, ownerToken: this.ownerToken, ttlMs: Math.max(10_000, this.intervalMs * 4) })
      if (lease) {
        const previousBoot = this.store.runtimeEpochs().bootId
        this.store.observeBoot(identity.bootId)
        const beforeServerEpoch = await tmuxServerEpoch()
        const recordedServerEpoch = this.store.getMetadata<string>("runtime.tmux_server_epoch")
        let trigger = previousBoot && previousBoot !== identity.bootId ? "hard_reboot" : recordedServerEpoch && beforeServerEpoch && recordedServerEpoch !== beforeServerEpoch ? "tmux_restart" : "reconcile"
        await reconcileRecovery(this.store, { trigger })
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

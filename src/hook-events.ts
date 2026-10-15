/**
 * Spooled lifecycle-hook requests. `clankerhouse-hook` runs synchronously inside every
 * harness tool call, so it never waits on the daemon: when a clanker's state, session or
 * Recovery attempt changes it leaves one request per pane in the runtime spool, replacing
 * any request not yet applied. The daemon claims each request by renaming it, so a hook
 * that writes again meanwhile starts a new file instead of being lost.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch } from "node:fs"

export interface HookAttestRequest {
  pane: string
  clankerId: string
  harnessSessionId: string
  state: string
  attemptId?: number
}

const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined

export const parseHookAttestRequest = (value: unknown): HookAttestRequest | undefined => {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const pane = text(record.pane), clankerId = text(record.clankerId), harnessSessionId = text(record.harnessSessionId), state = text(record.state)
  if (!pane || !clankerId || !harnessSessionId || !state) return undefined
  const attempt = record.recoveryAttemptId === null || record.recoveryAttemptId === undefined ? undefined : Number(record.recoveryAttemptId)
  if (attempt !== undefined && !(Number.isSafeInteger(attempt) && attempt >= 0)) return undefined
  return { pane, clankerId, harnessSessionId, state, attemptId: attempt }
}

/** Claim and return every pending request; malformed ones are discarded. */
export const takeHookAttestRequests = (directory: string): HookAttestRequest[] => {
  if (!existsSync(directory)) return []
  const requests: HookAttestRequest[] = []
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue
    const claimed = `${directory}/${entry}.${process.pid}.claimed`
    try { renameSync(`${directory}/${entry}`, claimed) } catch { continue }
    try {
      const request = parseHookAttestRequest(JSON.parse(readFileSync(claimed, "utf8")))
      if (request) requests.push(request)
    } catch {}
    try { unlinkSync(claimed) } catch {}
  }
  return requests
}

/**
 * Apply spooled requests one batch at a time, on change notification plus a slow sweep that
 * covers missed notifications. Returns a stop function.
 */
export const watchHookAttestRequests = (directory: string, apply: (request: HookAttestRequest) => Promise<void>, sweepMs = 30_000) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let running = false
  let pending = false
  const drain = async () => {
    if (running) { pending = true; return }
    running = true
    try {
      do {
        pending = false
        for (const request of takeHookAttestRequests(directory)) await apply(request)
      } while (pending)
    } finally { running = false }
  }
  const schedule = () => { void drain().catch((error) => console.error(`Hook request processing failed: ${error instanceof Error ? error.message : String(error)}`)) }
  const watcher = watch(directory, (_event, name) => { if (!name || String(name).endsWith(".json")) schedule() })
  const sweep = setInterval(schedule, sweepMs)
  schedule()
  return () => { watcher.close(); clearInterval(sweep) }
}

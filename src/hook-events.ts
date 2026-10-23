/**
 * Spooled lifecycle-hook requests. `clankerhouse-hook` runs synchronously inside every
 * harness tool call, so it never waits on the daemon: when a clanker's state or session
 * changes it leaves one request per pane in the runtime spool, replacing any request not yet
 * applied. The daemon claims each request by renaming it, so a hook that writes again
 * meanwhile starts a new file instead of being lost, then mirrors its state into the
 * Multiplexer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch } from "node:fs"

export interface HookStateRequest {
  pane: string
  clankerId: string
  harnessSessionId: string
  state: string
  /** Harness that ran the hook; absent from hooks that predate lifecycle mirroring. */
  harness?: string
  generation?: number
  updatedAt?: number
}

const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined

export const parseHookStateRequest = (value: unknown): HookStateRequest | undefined => {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const pane = text(record.pane), clankerId = text(record.clankerId), harnessSessionId = text(record.harnessSessionId), state = text(record.state)
  if (!pane || !clankerId || !harnessSessionId || !state) return undefined
  const harness = text(record.harness)
  const generation = Number(record.generation), updatedAt = Number(record.updatedAt)
  return {
    pane, clankerId, harnessSessionId, state,
    ...(harness ? { harness } : {}),
    ...(Number.isSafeInteger(generation) && generation >= 0 ? { generation } : {}),
    ...(Number.isFinite(updatedAt) && updatedAt > 0 ? { updatedAt } : {}),
  }
}

/** Claim and return every pending request; malformed ones are discarded. */
export const takeHookStateRequests = (directory: string): HookStateRequest[] => {
  if (!existsSync(directory)) return []
  const requests: HookStateRequest[] = []
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue
    const claimed = `${directory}/${entry}.${process.pid}.claimed`
    try { renameSync(`${directory}/${entry}`, claimed) } catch { continue }
    try {
      const request = parseHookStateRequest(JSON.parse(readFileSync(claimed, "utf8")))
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
export const watchHookStateRequests = (directory: string, apply: (request: HookStateRequest) => Promise<void>, sweepMs = 30_000, fallbackSweepMs = 1_000, watchDirectory: typeof watch = watch) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let running = false
  let pending = false
  const drain = async () => {
    if (running) { pending = true; return }
    running = true
    try {
      do {
        pending = false
        for (const request of takeHookStateRequests(directory)) await apply(request)
      } while (pending)
    } finally { running = false }
  }
  const schedule = () => { void drain().catch((error) => console.error(`Hook request processing failed: ${error instanceof Error ? error.message : String(error)}`)) }
  // Without change notification (the host's inotify instances exhausted, say) a fast sweep stands in.
  let watcher: ReturnType<typeof watch> | undefined
  try { watcher = watchDirectory(directory, (_event, name) => { if (!name || String(name).endsWith(".json")) schedule() }) }
  catch (error) { console.error(`Hook request notifications unavailable, polling instead: ${error instanceof Error ? error.message : String(error)}`) }
  const sweep = setInterval(schedule, watcher ? sweepMs : Math.min(sweepMs, fallbackSweepMs))
  schedule()
  return () => { watcher?.close(); clearInterval(sweep) }
}

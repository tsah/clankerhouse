/**
 * Lifecycle of the herdr-core process behind the hc lane. A core keeps the environment of the client that started or
 * restarted it and hands it to every terminal, so every start here goes through one allowlisted environment. Nothing in
 * this module runs `hc server status`: on a stopped session that command starts a core, in the caller's environment.
 * Liveness comes from the socket and the JSON-RPC API, neither of which can start anything.
 */
import { existsSync, readFileSync } from "node:fs"
import { hcRequest, hcSocketPath, type HcRequest } from "./hc"

export const HC_DEFAULT_SUPERVISE_INTERVAL_MS = 5_000
export const HC_MAX_RESTART_BACKOFF_MS = 60_000

/** What a core needs to run and what programs need from the login, and nothing that names a clanker. */
const CORE_ENV_NAMES = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "HC_SESSION", "HC_SOCKET", "CLANKERHOUSE_MULTIPLEXER", "CLANKERHOUSE_INSTANCE"]

/** Variables that say who a process is. In a core's environment they would be inherited by every terminal. */
export const HC_IDENTITY_ENV = /^(CLANKER_|CLANKERHOUSE_(WORKSHOP|PARENT_WORKSHOP)|HERDR_|TMUX|CLAUDECODE$|CLAUDE_CODE_|HC_TERMINAL_|HC_SCOPE$)/

export const hcCoreEnvironment = (env: Record<string, string | undefined> = Bun.env) => {
  const extra = (env.CLANKERHOUSE_HC_CORE_ENV ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  const names = [...CORE_ENV_NAMES, ...Object.keys(env).filter((name) => name.startsWith("LC_")), ...extra]
  return Object.fromEntries(names.flatMap((name) => env[name] ? [[name, env[name]!]] : []))
}

export interface HcHealth {
  reachable: boolean
  socketPath: string
  version?: string
  pid?: number
  live?: number
  finished?: number
  /** Holders still serving terminals from before an upgrade. */
  staleHolders?: number
  /** Identity variables in the core's environment; any here means it was started outside this module. */
  polluted?: string[]
}

export const hcCorePollution = (pid: number): string[] => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((entry) => entry.split("=", 1)[0]!).filter((name) => HC_IDENTITY_ENV.test(name)).sort()
  } catch { return [] }
}

/** Never starts a core. */
export const hcHealth = async (options: { socketPath?: string; request?: HcRequest } = {}): Promise<HcHealth> => {
  const socketPath = options.socketPath ?? hcSocketPath()
  if (!options.request && !existsSync(socketPath)) return { reachable: false, socketPath }
  try {
    const status = await (options.request ?? hcRequest(socketPath, 2_000))("server.status")
    const holders = (status.holders ?? []) as Array<{ current?: boolean }>
    return { reachable: true, socketPath, version: status.version, pid: status.pid, live: status.live, finished: status.finished, staleHolders: holders.filter((holder) => !holder.current).length, polluted: hcCorePollution(status.pid) }
  } catch { return { reachable: false, socketPath } }
}

export type HcCoreCommand = (args: string[], env: Record<string, string>) => { exitCode: number; stderr: string }

const runHc: HcCoreCommand = (args, env) => {
  const result = Bun.spawnSync([Bun.env.HC_BIN || "hc", ...args], { env, stdout: "ignore", stderr: "pipe" })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

/** Start a core unless one answers. The allowlisted environment is the point: see the module comment. */
export const ensureHcCore = async (options: { env?: Record<string, string | undefined>; command?: HcCoreCommand; health?: () => Promise<HcHealth> } = {}) => {
  const env = options.env ?? Bun.env
  const health = options.health ?? (() => hcHealth({ socketPath: hcSocketPath(env) }))
  const before = await health()
  if (before.reachable) return before
  const started = (options.command ?? runHc)(["server", "start"], hcCoreEnvironment(env))
  if (started.exitCode !== 0) throw new Error(`hc server start failed: ${started.stderr.trim() || `exit ${started.exitCode}`}`)
  return health()
}

/** A planned restart adopts the restarter's environment, so it goes through the same allowlist as a start. */
export const restartHcCore = (options: { env?: Record<string, string | undefined>; command?: HcCoreCommand } = {}) => {
  const result = (options.command ?? runHc)(["server", "restart"], hcCoreEnvironment(options.env ?? Bun.env))
  if (result.exitCode !== 0) throw new Error(`hc server restart failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
}

/**
 * Restarts a core that stopped answering. A dead core leaves its terminals running under the holder and nothing restarts
 * it by itself, so one poll is the whole supervisor. Failed starts back off; a recovery resets the delay.
 */
export const superviseHcCore = (signal: AbortSignal, options: { intervalMs?: number; ensure?: () => Promise<HcHealth>; health?: () => Promise<HcHealth>; log?: (message: string) => void } = {}) => {
  const intervalMs = options.intervalMs ?? HC_DEFAULT_SUPERVISE_INTERVAL_MS
  const health = options.health ?? (() => hcHealth())
  const ensure = options.ensure ?? (() => ensureHcCore())
  const log = options.log ?? (() => {})
  let failures = 0
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve() }, ms)
    const done = () => { clearTimeout(timer); resolve() }
    signal.addEventListener("abort", done, { once: true })
  })
  return (async () => {
    while (!signal.aborted) {
      const current = await health()
      if (!current.reachable) {
        log(`hc core at ${current.socketPath} is not answering; restarting it`)
        try {
          const after = await ensure()
          if (!after.reachable) throw new Error("the core did not come back")
          failures = 0
          log(`hc core restarted as pid ${after.pid}`)
        } catch (error) {
          failures += 1
          log(`hc core restart failed: ${error instanceof Error ? error.message : String(error)}`)
          await sleep(Math.min(intervalMs * 2 ** failures, HC_MAX_RESTART_BACKOFF_MS))
          continue
        }
      } else if (current.polluted?.length) log(`hc core ${current.pid} carries identity variables: ${current.polluted.join(" ")}`)
      await sleep(intervalMs)
    }
  })()
}

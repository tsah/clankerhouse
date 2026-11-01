/**
 * Status hook configuration and sinks. The config holds secrets, so it lives outside git, is
 * refused unless only its owner can read it, and nothing here ever puts a sink's URL or headers
 * into an error, a log, or `clankers hooks status`.
 */
import { lstatSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, normalize } from "node:path"
import { instanceSlug } from "./paths"
import type { StatusEvent } from "./status-events"

export interface WebhookSinkConfig { kind: "webhook"; name: string; events?: string[]; url: string; headers: Record<string, string> }
export interface ExecSinkConfig { kind: "exec"; name: string; events?: string[]; argv: string[] }
export type SinkConfig = WebhookSinkConfig | ExecSinkConfig

export interface HooksConfig {
  sinks: SinkConfig[]
  detect: { debounceMs: number; exitGraceMs: number; stuckMessageMs: number; markers: Record<string, string> }
  delivery: { timeoutMs: number; retryBaseMs: number; retryMaxMs: number; giveUpMs: number }
}

export const DEFAULT_MARKERS: Readonly<Record<string, string>> = { "aws-login-pending": "temp/aws/login-pending" }

export class HooksConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HooksConfigError"
  }
}

/** Every Clankerhouse instance has its own config, so a test instance never reaches a real sink. */
export const hooksConfigPath = (env: Record<string, string | undefined> = Bun.env) => {
  if (env.CLANKERHOUSE_HOOKS_CONFIG) return env.CLANKERHOUSE_HOOKS_CONFIG
  const slug = instanceSlug(env)
  return `${env.XDG_CONFIG_HOME || `${env.HOME || ""}/.config`}/clankerhouse/hooks${slug === "-herdr" ? "" : slug}.toml`
}

type Table = Record<string, unknown>
const isTable = (value: unknown): value is Table => Boolean(value) && typeof value === "object" && !Array.isArray(value)

const seconds = (table: Table, key: string, fallback: number, section: string) => {
  const value = table[key]
  if (value === undefined) return fallback * 1000
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new HooksConfigError(`${section}.${key} must be a non-negative number of seconds`)
  return value * 1000
}

const stringList = (value: unknown, label: string) => {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) throw new HooksConfigError(`${label} must be a non-empty list of strings`)
  return value as string[]
}

const validWebhookUrl = (url: unknown, label: string) => {
  let parsed: URL
  try { parsed = new URL(String(url)) }
  catch { throw new HooksConfigError(`${label}.url is not a valid URL`) }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new HooksConfigError(`${label}.url must be https (plain http is allowed only on loopback)`)
  return parsed.href
}

const parseSink = (value: unknown, index: number): SinkConfig => {
  const label = `sinks[${index}]`
  if (!isTable(value)) throw new HooksConfigError(`${label} must be a table`)
  const name = value.name
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) throw new HooksConfigError(`${label}.name must use letters, digits, '.', '_' or '-'`)
  const events = value.events === undefined ? undefined : stringList(value.events, `${label}.events`)
  const common = { name, ...(events ? { events } : {}) }
  const kind = value.kind ?? "webhook"
  if (kind === "webhook") {
    const headers = value.headers ?? {}
    if (!isTable(headers)) throw new HooksConfigError(`${label}.headers must be a table`)
    for (const [header, text] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(header) || typeof text !== "string" || /[\r\n]/.test(text)) throw new HooksConfigError(`${label}.headers has an invalid entry for ${JSON.stringify(header)}`)
    }
    return { kind, ...common, url: validWebhookUrl(value.url, label), headers: headers as Record<string, string> }
  }
  if (kind === "exec") return { kind, ...common, argv: stringList(value.argv, `${label}.argv`) }
  throw new HooksConfigError(`${label}.kind must be webhook or exec`)
}

export const parseHooksConfig = (text: string, label = "hooks config"): HooksConfig => {
  let raw: unknown
  // The parser's message can quote the offending line, which may be a secret.
  try { raw = Bun.TOML.parse(text) }
  catch { throw new HooksConfigError(`${label} is not valid TOML`) }
  if (!isTable(raw)) throw new HooksConfigError(`${label} is not a table`)
  const detect = raw.detect ?? {}, delivery = raw.delivery ?? {}
  if (!isTable(detect)) throw new HooksConfigError("detect must be a table")
  if (!isTable(delivery)) throw new HooksConfigError("delivery must be a table")
  if (!Array.isArray(raw.sinks ?? [])) throw new HooksConfigError("sinks must be an array of tables: use [[sinks]]")
  const sinks = ((raw.sinks ?? []) as unknown[]).map(parseSink)
  const names = new Set<string>()
  for (const sink of sinks) {
    if (names.has(sink.name)) throw new HooksConfigError(`Duplicate sink name: ${sink.name}`)
    names.add(sink.name)
  }
  const markers = detect.markers ?? DEFAULT_MARKERS
  if (!isTable(markers)) throw new HooksConfigError("detect.markers must be a table of name = \"relative/path\"")
  for (const [name, path] of Object.entries(markers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new HooksConfigError(`detect.markers has an invalid name: ${name}`)
    if (typeof path !== "string" || !path || isAbsolute(path) || normalize(path).startsWith("..")) throw new HooksConfigError(`detect.markers.${name} must be a path inside the worktree`)
  }
  return {
    sinks,
    detect: {
      debounceMs: seconds(detect, "debounce_seconds", 5, "detect"),
      exitGraceMs: seconds(detect, "exit_grace_seconds", 20, "detect"),
      stuckMessageMs: seconds(detect, "stuck_message_seconds", 180, "detect"),
      markers: markers as Record<string, string>,
    },
    delivery: {
      timeoutMs: seconds(delivery, "timeout_seconds", 10, "delivery"),
      retryBaseMs: seconds(delivery, "retry_base_seconds", 5, "delivery"),
      retryMaxMs: seconds(delivery, "retry_max_seconds", 900, "delivery"),
      giveUpMs: seconds(delivery, "give_up_after_seconds", 86_400, "delivery"),
    },
  }
}

/** The config is a secret: refuse one that another user can read. */
export const assertPrivateConfig = (path: string) => {
  const stat = statSync(path)
  if (!stat.isFile()) throw new HooksConfigError(`${path} is not a file`)
  if (stat.mode & 0o077) throw new HooksConfigError(`${path} must be readable only by its owner: chmod 600 it`)
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new HooksConfigError(`${path} is not owned by the current user`)
}

export const readHooksConfig = (path = hooksConfigPath()) => {
  assertPrivateConfig(path)
  return parseHooksConfig(readFileSync(path, "utf8"), path)
}

/** Whether a config file exists; a dangling symlink counts, so it is reported rather than ignored. */
export const hooksConfigExists = (path: string) => {
  try { lstatSync(path); return true } catch { return false }
}

/** `clanker.*` matches by prefix; no list at all means every event. */
export const sinkWants = (sink: Pick<SinkConfig, "events">, type: string) =>
  !sink.events || sink.events.some((pattern) => pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1))))

export type SendResult =
  | { ok: true; status?: number }
  | { ok: false; retryable: boolean; error: string; status?: number; retryAfterMs?: number }

export interface Sink {
  readonly name: string
  send(event: StatusEvent, timeoutMs: number): Promise<SendResult>
}

const retryAfter = (value: string | null) => {
  const seconds = value === null ? NaN : Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

const webhookSink = (config: WebhookSinkConfig): Sink => ({
  name: config.name,
  async send(event, timeoutMs) {
    try {
      const response = await fetch(config.url, {
        method: "POST",
        // A redirect would carry the key to a host nobody configured.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "clankerhouse-status-hooks/1",
          "x-clankerhouse-event": event.type,
          "x-clankerhouse-dedupe-key": event.dedupeKey,
          ...config.headers,
        },
        body: JSON.stringify(event),
      })
      await response.arrayBuffer().catch(() => undefined)
      if (response.ok) return { ok: true, status: response.status }
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
      return { ok: false, retryable, status: response.status, error: `HTTP ${response.status}`, retryAfterMs: retryAfter(response.headers.get("retry-after")) }
    } catch (error) {
      // Only the failure's name: a fetch error can quote the URL, and the URL can be the secret.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      return { ok: false, retryable: true, error: timedOut ? `no response within ${timeoutMs}ms` : `network error: ${error instanceof Error ? error.name : "unknown"}${errorCode(error)}` }
    }
  },
})

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === "string" ? ` (${code})` : ""
}

/** Runs one command per event with the event as JSON on stdin; exit 0 is success, anything else retries. */
const execSink = (config: ExecSinkConfig): Sink => ({
  name: config.name,
  async send(event, timeoutMs) {
    try {
      const proc = Bun.spawn(config.argv, {
        stdin: new Blob([JSON.stringify(event)]),
        stdout: "ignore",
        stderr: "ignore",
        timeout: timeoutMs,
        env: { ...Bun.env, CLANKERHOUSE_EVENT_TYPE: event.type, CLANKERHOUSE_EVENT_DEDUPE_KEY: event.dedupeKey },
      })
      const code = await proc.exited
      return code === 0 ? { ok: true } : { ok: false, retryable: true, error: proc.signalCode ? `no exit within ${timeoutMs}ms` : `exit ${code}` }
    } catch (error) {
      return { ok: false, retryable: true, error: `spawn failed: ${error instanceof Error ? error.name : "unknown"}${errorCode(error)}` }
    }
  },
})

const sinkFactories: { [Kind in SinkConfig["kind"]]: (config: Extract<SinkConfig, { kind: Kind }>) => Sink } = { webhook: webhookSink, exec: execSink }

export const openSink = (config: SinkConfig): Sink => (sinkFactories[config.kind] as (config: SinkConfig) => Sink)(config)

/** Doubles from the base up to the cap, unless the receiver said how long to wait. */
export const retryDelayMs = (attempts: number, delivery: Pick<HooksConfig["delivery"], "retryBaseMs" | "retryMaxMs">, retryAfterMs?: number) => {
  const backoff = Math.min(delivery.retryMaxMs, delivery.retryBaseMs * 2 ** Math.max(0, attempts - 1))
  return retryAfterMs === undefined ? backoff : Math.min(delivery.retryMaxMs, Math.max(backoff, retryAfterMs))
}

/** What may be shown of a sink: never a URL path or query, never a header value. */
export const redactedSink = (sink: SinkConfig) => sink.kind === "webhook"
  ? { name: sink.name, kind: sink.kind, host: new URL(sink.url).host, headers: Object.keys(sink.headers), events: sink.events ?? ["*"] }
  : { name: sink.name, kind: sink.kind, command: sink.argv[0]!, events: sink.events ?? ["*"] }

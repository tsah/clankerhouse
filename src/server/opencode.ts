import { readFileSync } from "node:fs"
import type { ForegroundAgentDiscovery } from "./process-discovery"
import type { OpencodeStatus, TmuxWindow } from "./resources"

interface OpenCodeSession {
  id: string
  parentID?: string
  title?: string
  location?: { directory?: string }
  time?: { updated?: number; archived?: number }
}

interface OpenCodeServiceFile {
  url: string
  password: string
}

interface OpenCodeServiceSnapshot {
  sessions: OpenCodeSession[]
  active: ReadonlySet<string>
  questions: ReadonlySet<string>
  permissions: ReadonlySet<string>
}

let sessionCache: { key: string; refreshedAt: number; sessions: OpenCodeSession[] } | undefined
const sessionCacheMs = 10 * 60_000
let questionCache: { key: string; refreshedAt: number; sessions: ReadonlySet<string> } | undefined
let permissionCache: { key: string; refreshedAt: number; sessions: ReadonlySet<string> } | undefined
let stateCache: { key: string; refreshedAt: number; rows: OpencodeStatus[] } | undefined

export const invalidateOpenCodeServiceState = () => { stateCache = undefined }

const text = (value: unknown) => typeof value === "string" ? value : ""
const sessionIdFromRequest = (value: unknown) => value && typeof value === "object" ? text((value as Record<string, unknown>).sessionID) : ""

export const openCodeSessionIdFromArgv = (argv: readonly string[]) => {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if ((argument === "-s" || argument === "--session") && argv[index + 1]) return argv[index + 1]
    if (argument.startsWith("--session=")) return argument.slice("--session=".length)
  }
  return undefined
}

const paneTitle = (title: string) => title.replace(/^OC \| /, "").trim()
const livePath = (path: string) => path.replace(/ \(deleted\)$/, "")
const titleMatches = (sessionTitle: string, title: string) => sessionTitle === title
  || (title.endsWith("...") && sessionTitle.startsWith(title.slice(0, -3)))

export const projectOpenCodeService = (
  windows: readonly TmuxWindow[],
  discoveries: ReadonlyMap<string, ForegroundAgentDiscovery>,
  snapshot: OpenCodeServiceSnapshot,
): OpencodeStatus[] => {
  const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]))
  return windows.flatMap((window) => {
    const discovery = discoveries.get(window.pane)
    if (discovery?.harness !== "opencode") return []
    const explicitSessionId = openCodeSessionIdFromArgv(discovery.matchedProcess.argv)
    const title = paneTitle(window.title)
    const candidates = snapshot.sessions.filter((session) => !session.parentID
      && !session.time?.archived
      && livePath(session.location?.directory ?? "") === livePath(window.currentPath)
      && titleMatches(session.title ?? "", title))
    const sessionId = explicitSessionId ?? (candidates.length === 1 ? candidates[0]?.id : undefined)
    if (!sessionId) return []
    const session = sessionsById.get(sessionId)
    const blocked = snapshot.questions.has(sessionId) || snapshot.permissions.has(sessionId)
    const status = snapshot.permissions.has(sessionId) ? "waiting permission" : blocked ? "waiting question" : snapshot.active.has(sessionId) ? "generating" : "idle"
    const detail = snapshot.permissions.has(sessionId) ? "permission" : snapshot.questions.has(sessionId) ? "question" : snapshot.active.has(sessionId) ? "session running" : "awaiting next task"
    return [{
      directory: window.currentPath,
      status,
      detail,
      title: session?.title ?? title,
      age: "",
      session: window.session,
      pane: window.pane,
      updatedAt: session?.time?.updated ?? 0,
      stablePane: window.pane,
      harnessSessionId: sessionId,
    }]
  })
}

const responseData = (value: unknown) => value && typeof value === "object" && "data" in value
  ? (value as { data: unknown }).data
  : value

export const collectOpenCodeService = async (
  windows: readonly TmuxWindow[],
  discoveries: ReadonlyMap<string, ForegroundAgentDiscovery>,
  stateHome = process.env.XDG_STATE_HOME || `${process.env.HOME || ""}/.local/state`,
): Promise<OpencodeStatus[]> => {
  if (![...discoveries.values()].some((discovery) => discovery.harness === "opencode")) return []
  try {
    const service = JSON.parse(readFileSync(`${stateHome}/opencode/service.json`, "utf8")) as OpenCodeServiceFile
    if (!service.url || !service.password) return []
    const authorization = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`
    const get = async (path: string) => {
      const response = await fetch(new URL(path, service.url), { headers: { accept: "application/json", authorization }, signal: AbortSignal.timeout(1_000) })
      if (!response.ok) throw new Error(`OpenCode API returned ${response.status}`)
      return responseData(await response.json())
    }
    const sessionKey = [service.url, ...windows.flatMap((window) => {
      const discovery = discoveries.get(window.pane)
      return discovery?.harness === "opencode"
        ? [`${window.pane}\0${discovery.matchedProcess.pid}\0${discovery.matchedProcess.argv.join("\0")}\0${window.currentPath}\0${window.title}`]
        : []
    }).sort()].join("\n")
    if (stateCache?.key === sessionKey && Date.now() - stateCache.refreshedAt < 30_000) return stateCache.rows
    const cachedSessions = sessionCache?.key === sessionKey && Date.now() - sessionCache.refreshedAt < sessionCacheMs
      ? sessionCache.sessions
      : undefined
    const [rawSessions, rawActive] = await Promise.all([
      cachedSessions ?? get("/api/session?limit=200&order=desc"),
      get("/api/session/active"),
    ])
    const sessions = Array.isArray(rawSessions) ? rawSessions.filter((session): session is OpenCodeSession => Boolean(session && typeof session === "object" && text((session as OpenCodeSession).id))) : []
    if (!cachedSessions) sessionCache = { key: sessionKey, refreshedAt: Date.now(), sessions }
    const active = rawActive && typeof rawActive === "object" ? new Set(Object.keys(rawActive)) : new Set<string>()
    const selectedActive = new Set(projectOpenCodeService(windows, discoveries, { sessions, active, questions: new Set(), permissions: new Set() })
      .flatMap((row) => row.harnessSessionId && active.has(row.harnessSessionId) ? [row.harnessSessionId] : []))
    const pendingKey = [...selectedActive].sort().join("\n")
    let questions = questionCache?.key === pendingKey && Date.now() - questionCache.refreshedAt < 30_000 ? questionCache.sessions : undefined
    let permissions = permissionCache?.key === pendingKey && Date.now() - permissionCache.refreshedAt < 60_000 ? permissionCache.sessions : undefined
    const pending = await Promise.all([...selectedActive].flatMap((sessionId) => [
      ...(questions ? [] : [get(`/api/session/${encodeURIComponent(sessionId)}/form`).then((requests) => ({ kind: "question" as const, sessionId, requests })).catch(() => undefined)]),
      ...(permissions ? [] : [get(`/api/session/${encodeURIComponent(sessionId)}/permission`).then((requests) => ({ kind: "permission" as const, sessionId, requests })).catch(() => undefined)]),
    ]))
    if (!questions) {
      questions = new Set(pending.flatMap((result) => result?.kind === "question" && Array.isArray(result.requests) && result.requests.some((request) => sessionIdFromRequest(request) === result.sessionId) ? [result.sessionId] : []))
      questionCache = { key: pendingKey, refreshedAt: Date.now(), sessions: questions }
    }
    if (!permissions) {
      permissions = new Set(pending.flatMap((result) => result?.kind === "permission" && Array.isArray(result.requests) && result.requests.some((request) => sessionIdFromRequest(request) === result.sessionId) ? [result.sessionId] : []))
      permissionCache = { key: pendingKey, refreshedAt: Date.now(), sessions: permissions }
    }
    const rows = projectOpenCodeService(windows, discoveries, { sessions, active, questions, permissions })
    stateCache = { key: sessionKey, refreshedAt: Date.now(), rows }
    return rows
  } catch {
    return []
  }
}

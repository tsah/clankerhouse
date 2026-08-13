#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ClankerApiError, clankerCapabilities, clankerStatus, listClankers, resultForClanker, sendClanker, waitForClanker, type ClankerDelivery } from "./clanker-api"
import { resolveRecoveredClankerIncidents } from "./incidents"
import { reconcileRecovery } from "./recovery/controller"
import { openRecoveryStore, type RecoveryStore } from "./recovery/store"
import { bootstrapRepositoryFromManifests, projectSnapshot, reconcileRepositoryWorkshops, workshopDetails, workshopForPath, workshopTree } from "./workshop"
import { ensureDirectorySession, ensureSession, identity, spawnClanker, spawnWorkshop, type Harness } from "./workflow"

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
  const runtime = `${Bun.env.XDG_RUNTIME_DIR || "/tmp"}/clankerhouse-${process.getuid?.() || 0}/clanker-state`
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
  clankers workshop spawn --name NAME --harness HARNESS [--base REF] [--copy PATH] [--profile NAME] [--prompt TEXT]
  clankers workshop ensure [--cwd PATH]
  clankers workshop identity [--cwd PATH]
  clankers spawn --workshop WORKSHOP --name NAME --harness HARNESS [--profile NAME] [--prompt TEXT]
  clankers list [--cwd PATH]
  clankers status|capabilities CLANKER_ID
  clankers wait CLANKER_ID [--after GENERATION] [--timeout SECONDS]
  clankers send CLANKER_ID [--delivery steer|follow-up] [--wait] [--text TEXT]
  clankers result CLANKER_ID [--generation GENERATION]
  clankers recovery status|journal|reconcile|checkpoint
  clankers recovery attest-exit CLANKER_ID --attempt ID [--session-id ID]
  clankers recovery stop|start|suspend|tombstone CLANKER_ID`

export async function runClankersCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  const command = parsed.shift()
  if (!command || command === "help" || command === "--help" || command === "-h") return console.log(usage)
  if (["list", "status", "capabilities", "wait", "send", "result"].includes(command)) return runClankerApi(command, parsed)

  if (command === "recovery") {
    const subcommand = parsed.shift()
    const store = openRecoveryStore()
    try {
      if (subcommand === "status") return console.log(JSON.stringify({ epochs: store.runtimeEpochs(), tmuxServerEpoch: store.getMetadata("runtime.tmux_server_epoch") ?? null, clankers: store.listDesired({ includeTombstoned: true }).map((row) => ({ ...row, originalTask: undefined })), attempts: store.listDesired({ includeTombstoned: true }).flatMap((row) => store.attemptsFor(row.clankerId)) }))
      if (subcommand === "journal") return console.log(JSON.stringify(store.journalEntries({ afterId: nonNegativeNumber(parsed.take("--after"), "--after"), limit: nonNegativeNumber(parsed.take("--limit"), "--limit") })))
      if (subcommand === "reconcile") return console.log(JSON.stringify(await reconcileRecovery(store, { trigger: parsed.take("--reason") || "manual" })))
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
        const attemptId = nonNegativeNumber(parsed.take("--attempt"), "--attempt")
        if (attemptId !== undefined) {
          const attempt = store.getAttempt(attemptId)
          if (!attempt || attempt.clankerId !== id) throw new Error(`Recovery attempt ${attemptId} does not belong to ${id}`)
          store.finishAttempt(attemptId, "succeeded")
          resolveRecoveredClankerIncidents(id)
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
        if (parsed.has("--if-present") && !store.getDesired(id)) return console.log(JSON.stringify({ clankerId: id, tracked: false }))
        const desired = store.setDesiredState(id, state, { reason: parsed.take("--reason") || subcommand })
        if (!noKill && (subcommand === "stop" || subcommand === "suspend" || subcommand === "tombstone")) {
          const matches = (await listClankers()).filter((row) => row.id === id)
          if (matches.length > 1) throw new Error(`Ambiguous live panes for ${id}`)
          if (matches.length === 1) Bun.spawnSync(["tmux", "kill-pane", "-t", matches[0]!.pane], { stdout: "ignore", stderr: "ignore" })
        }
        return console.log(JSON.stringify(desired))
      }
      throw new Error("Usage: clankers recovery status|journal|reconcile|checkpoint|attest|attest-exit|stop|start|suspend|tombstone ...")
    } finally { store.close() }
  }

  if (command === "workshop") {
    const subcommand = parsed.shift()
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return console.log(usage)
    if (subcommand === "spawn") {
      const name = parsed.take("--name")
      if (!name) throw new Error("--name is required")
      const selectedHarness = harness(parsed.take("--harness"))
      const base = parsed.take("--base"); const copy = parsed.take("--copy"); const window = parsed.take("--clanker-name"); const profile = parsed.take("--profile"); const wait = parsed.has("--wait"); const parentWorkshopId = parsed.take("--parent"); const noParent = parsed.has("--no-parent")
      if (parentWorkshopId && noParent) throw new Error("--parent and --no-parent are mutually exclusive")
      const prompt = parsed.take("--prompt") || parsed.args.join(" ") || "Ready for instructions."
      const result = await spawnWorkshop(selectedHarness, name, prompt, {
        base,
        copy,
        window,
        profile,
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
    const selectedHarness = harness(parsed.take("--harness")); const profile = parsed.take("--profile"); const wait = parsed.has("--wait")
    const prompt = parsed.take("--prompt") || parsed.args.join(" ") || "Ready for instructions."
    return console.log(JSON.stringify(await spawnClanker(selectedHarness, resolveWorkshopPath(selector), prompt, profile, name, wait)))
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

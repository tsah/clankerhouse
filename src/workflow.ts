import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { markDirectoryActivity } from "./activity"
import { clankerForPane, generatedClankerId, listClankers, resultForClanker, sendClanker, waitForClanker, type ClankerDelivery } from "./clanker-api"
import { initialHarnessCommand } from "./recovery/harness"
import { openRecoveryStore } from "./recovery/store"
import { parseTmuxFields, tmuxFields } from "./tmux-fields"
import { lineageMode, persistWorkshopLineage, type LineageMode, type WorkshopRecord, workshopForId, workshopForPath } from "./workshop"

export type Harness = "pi" | "claude" | "opencode" | "codex"
export interface WorktreeIdentity { path: string; commonDir: string; repo: string; branch: string }

async function command(argv: string[], cwd?: string, allowFailure = false) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `${argv.join(" ")} exited ${code}`)
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

export async function identity(cwd = process.cwd()): Promise<WorktreeIdentity> {
  const top = (await command(["git", "rev-parse", "--show-toplevel"], cwd)).stdout
  const commonRaw = (await command(["git", "rev-parse", "--git-common-dir"], top)).stdout
  const commonDir = realpathSync(resolve(top, commonRaw))
  const branch = (await command(["git", "branch", "--show-current"], top)).stdout || "detached"
  return { path: realpathSync(top), commonDir, repo: basename(dirname(commonDir)), branch }
}

const safeName = (value: string) => value.replace(/[.:]/g, "-").replace(/[^A-Za-z0-9_@-]/g, "-").slice(0, 80)
const realpathSafe = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

async function sessionForPath(path: string) {
  const canonical = realpathSafe(path)
  const result = await command([
    "tmux", "list-sessions", "-F",
    tmuxFields("#{session_id}", "#{session_name}", "#{@dotfiles_worktree_path}", "#{@dotfiles_directory_path}", "#{session_path}", "#{session_activity}"),
  ], undefined, true)
  if (result.code !== 0) return undefined
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", worktreePath = "", directoryPath = "", sessionPath = "", activity = "0"] = parseTmuxFields(line)
    const taggedPath = worktreePath || directoryPath
    const candidatePath = taggedPath || sessionPath
    return { id, name, candidatePath, activity: Number(activity) || 0 }
  }).filter((session) => session.id && session.name && session.candidatePath && realpathSafe(session.candidatePath) === canonical)
    .sort((a, b) => b.activity - a.activity)[0]
}

export async function sessionName(id: WorktreeIdentity) {
  const human = safeName(`${id.repo}@${id.branch}`)
  const result = await command(["tmux", "display-message", "-p", "-t", `=${human}`, tmuxFields("#{@dotfiles_worktree_path}", "#{session_path}")], undefined, true)
  if (result.code !== 0 || !result.stdout) return human
  const [taggedPath = "", sessionPath = ""] = parseTmuxFields(result.stdout)
  if (realpathSafe(taggedPath || sessionPath) === id.path) return human
  return `${human}-${createHash("sha256").update(id.path).digest("hex").slice(0, 8)}`
}

const applyWorkshopOptions = async (target: string, id: WorktreeIdentity, record?: WorkshopRecord) => {
  await command(["tmux", "set-option", "-t", target, "@dotfiles_worktree_path", id.path])
  await command(["tmux", "set-option", "-t", target, "@dotfiles_git_common_dir", id.commonDir])
  if (!record) return
  await command(["tmux", "set-option", "-t", target, "@dotfiles_workshop_id", record.workshopId])
  await command(["tmux", "set-option", "-t", target, "@dotfiles_workshop_parent_id", record.parentWorkshopId ?? ""])
}

export async function ensureSession(id: WorktreeIdentity, options: { parentWorkshopId?: string | null; preserveParent?: boolean; mode?: LineageMode } = {}) {
  markDirectoryActivity(id.path, "opened")
  const record = persistWorkshopLineage(id, { parentWorkshopId: options.parentWorkshopId, preserveParent: options.preserveParent, mode: options.mode })
  const existing = await sessionForPath(id.path)
  const name = existing?.name ?? await sessionName(id)
  if (!existing && (await command(["tmux", "has-session", "-t", `=${name}`], undefined, true)).code !== 0) {
    await command(["tmux", "new-session", "-d", "-s", name, "-n", "main", "-c", id.path])
  }
  const target = existing?.id || name
  await applyWorkshopOptions(target, id, record)
  return name
}

const codexCommand = (prompt: string, clankerId: string) => [
  "env",
  `BROWSER=${Bun.env.BROWSER || "xdg-open"}`,
  `PLANNOTATOR_BROWSER=${Bun.env.PLANNOTATOR_BROWSER || `${Bun.env.HOME}/.local/bin/xdg-open`}`,
  `PLANNOTATOR_REMOTE=${Bun.env.PLANNOTATOR_REMOTE || "1"}`,
  `PLANNOTATOR_PORT=${Bun.env.PLANNOTATOR_PORT || "19432-19439"}`,
  `CLANKER_ID=${clankerId}`,
  "codex",
  prompt,
]

export async function spawnClanker(harness: Harness, cwd: string, prompt: string, profile?: string, requestedName?: string, wait = false) {
  if (wait && harness === "opencode") throw new Error("OpenCode does not expose a verified lifecycle report transport for waiting")
  const id = await identity(cwd)
  const session = await ensureSession(id)
  markDirectoryActivity(id.path, "clanker")
  const prefix = requestedName || harness
  const existing = (await command(["tmux", "list-windows", "-t", `=${session}`, "-F", "#{window_name}"], undefined, true)).stdout.split("\n")
  let name = prefix; let n = 2
  while (existing.includes(name)) name = `${prefix}-${n++}`
  const clankerId = generatedClankerId()
  const recoverable = harness !== "codex"
  const harnessSessionId = harness === "pi" || harness === "claude" ? randomUUID() : null
  let argv = codexCommand(prompt, clankerId)
  if (recoverable) {
    const recoverableHarness = harness as Exclude<Harness, "codex">
    const workshop = workshopForPath(id.path)
    const store = openRecoveryStore()
    try {
      store.createDesired({
        clankerId,
        harness: recoverableHarness,
        workshopId: workshop?.workshopId || `path-${createHash("sha256").update(id.path).digest("hex").slice(0, 24)}`,
        workshopPath: id.path,
        tmuxSessionName: session,
        tmuxWindowName: name,
        cwd: id.path,
        harnessSessionId,
        launchSpec: { version: 1, profile: profile || null },
        originalTask: prompt,
      })
      const attempt = store.beginAttempt(clankerId, "initial")
      argv = initialHarnessCommand({ harness: recoverableHarness, cwd: id.path, prompt, clankerId, harnessSessionId, launchSpec: { version: 1, profile: profile || null }, attemptId: String(attempt.id) })
    } finally { store.close() }
  }
  const result = await command(["tmux", "new-window", "-d", "-P", "-F", tmuxFields("#{window_id}", "#{pane_id}"), "-t", `=${session}`, "-n", name, "-c", id.path, ...argv])
  const [window, pane] = parseTmuxFields(result.stdout)
  await command(["tmux", "set-option", "-p", "-t", pane!, "@clankerhouse_clanker_id", clankerId])
  await command(["tmux", "set-option", "-p", "-t", pane!, "@dotfiles_harness", harness])
  await command(["tmux", "set-option", "-w", "-t", window!, "@dotfiles_harness", harness])
  const spawned: Record<string, unknown> = { identity: id, session, window, pane, name, clankerId, ...(recoverable ? { harnessSessionId } : {}) }
  if (wait) {
    const timeout = Number(Bun.env.CLANKER_WAIT_TIMEOUT || 600) * 1000
    const settled = await waitForClanker(clankerId, { afterGeneration: 0, timeoutMs: timeout })
    spawned.settled = settled
    if (harness === "pi") {
      const result = await resultForClanker(clankerId, settled.settledGeneration)
      if (result.status !== 0) throw new Error(result.errorMessage || result.stopReason || "clanker failed")
      spawned.result = result.reply
    }
  }
  return spawned
}

export async function createWorkshop(branch: string, base?: string, options: { parentWorkshopId?: string | null; preserveParent?: boolean; mode?: LineageMode; copy?: string } = {}) {
  const result = await command(["wt", "switch", "--create", branch, "--no-cd", "--format", "json", ...(base ? ["--base", base] : []), ...(options.copy ? ["--copy", options.copy] : [])])
  let worktree: { path?: string }
  try { worktree = JSON.parse(result.stdout) }
  catch { throw new Error(`Worktrunk returned invalid JSON while creating '${branch}'`) }
  if (!worktree.path) throw new Error(`Worktrunk created '${branch}', but did not return its path`)
  const id = await identity(worktree.path)
  return { identity: id, session: await ensureSession(id, options) }
}

const currentSessionTarget = async () => {
  if (!Bun.env.TMUX) return undefined
  const result = await command(["tmux", "display-message", "-p", "#{session_id}"], undefined, true)
  return result.code === 0 && result.stdout ? result.stdout : undefined
}

const explicitParentRecord = (parentWorkshopId: string) => {
  const record = workshopForId(parentWorkshopId)
  if (record) return record
  throw new Error(`Unknown workshop parent id: ${parentWorkshopId}`)
}

const captureAutomaticParent = async (mode: LineageMode) => {
  try {
    const parentIdentity = await identity(process.cwd())
    const record = persistWorkshopLineage(parentIdentity, { mode })
    const target = await currentSessionTarget()
    if (target && record) await applyWorkshopOptions(target, parentIdentity, record)
    return record
  } catch (error) {
    if (mode === "strict") throw error
    return undefined
  }
}

export async function resolveWorkshopParent(options: { parentWorkshopId?: string; noParent?: boolean }, mode = lineageMode()) {
  if (options.parentWorkshopId && mode === "off") throw new Error("DOTFILES_WORKSHOP_LINEAGE=off does not support --parent")
  if (mode === "off") return { mode, preserveParent: true } as const
  if (options.noParent) return { mode, parentWorkshopId: null, preserveParent: false } as const
  if (options.parentWorkshopId) {
    const parent = explicitParentRecord(options.parentWorkshopId)
    return { mode, parentWorkshopId: parent.workshopId, preserveParent: false } as const
  }
  const parent = await captureAutomaticParent(mode)
  return parent ? { mode, parentWorkshopId: parent.workshopId, preserveParent: false } as const : { mode, preserveParent: true } as const
}

export async function spawnWorkshop(harness: Harness, branch: string, prompt: string, options: { profile?: string; base?: string; copy?: string; window?: string; wait?: boolean; parentWorkshopId?: string; noParent?: boolean } = {}) {
  const parent = await resolveWorkshopParent(options)
  const created = await createWorkshop(branch, options.base, { ...parent, copy: options.copy })
  return spawnClanker(harness, created.identity.path, prompt, options.profile, options.window, options.wait)
}

export async function ensureDirectorySession(directory: string) {
  const canonical = realpathSync(directory)
  markDirectoryActivity(canonical, "opened")
  const existing = await sessionForPath(canonical)
  if (existing) {
    await command(["tmux", "set-option", "-t", existing.id, "@dotfiles_directory_path", canonical])
    return existing.name
  }
  const base = safeName(basename(canonical)) || "shell"
  let name = base
  const current = await command(["tmux", "display-message", "-p", "-t", `=${name}`, tmuxFields("#{@dotfiles_worktree_path}", "#{@dotfiles_directory_path}", "#{session_path}")], undefined, true)
  if (current.code === 0) {
    const [worktreePath = "", directoryPath = "", sessionPath = ""] = parseTmuxFields(current.stdout)
    if (realpathSafe(worktreePath || directoryPath || sessionPath) !== canonical) name = `${base}-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`
  }
  if ((await command(["tmux", "has-session", "-t", `=${name}`], undefined, true)).code !== 0) await command(["tmux", "new-session", "-d", "-s", name, "-n", "main", "-c", canonical])
  await command(["tmux", "set-option", "-t", name, "@dotfiles_directory_path", canonical])
  return name
}

export async function currentWorkshopClankers(cwd = process.cwd()) {
  return listClankers({ cwd })
}

export async function sendToPane(pane: string, text: string, submit = true, delivery?: ClankerDelivery) {
  if (!submit) throw new Error("Native clanker transports cannot append without submitting a user message")
  const clanker = await clankerForPane(pane)
  return sendClanker(clanker.id, text, { delivery })
}

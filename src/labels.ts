export type WorkshopLabels = Readonly<Record<string, string>>
export type WorkshopHookEvent = "labels-changed" | "done"

export interface LabelChange {
  previous: WorkshopLabels
  labels: WorkshopLabels
  changed: boolean
}

const labelKeyPattern = /^[a-z][a-z0-9_-]{0,31}$/
const labelValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/

/** The human name of a Workshop. Unlike other labels its value is free text, and it is shown as the row's name, not as a tag. */
export const TITLE_KEY = "title"
const titlePattern = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,78}[^\s\p{Cc}])?$/u

export const validLabelKey = (key: unknown): key is string => typeof key === "string" && labelKeyPattern.test(key)
export const validLabelValue = (value: unknown, key?: string): value is string =>
  typeof value === "string" && (key === TITLE_KEY ? titlePattern.test(value) : labelValuePattern.test(value))

/**
 * The branch a new Workshop gets for a title. Something already shaped like a branch name is
 * kept verbatim; free text becomes a lowercase dash-separated slug cut at a word boundary.
 */
export const branchFromTitle = (title: string) => {
  const trimmed = title.trim()
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) return trimmed
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (!slug) throw new Error(`Cannot derive a branch name from '${title}'`)
  if (slug.length <= 50) return slug
  const cut = slug.slice(0, 50)
  const boundary = cut.lastIndexOf("-")
  return (boundary >= 20 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "")
}

export const parseLabelAssignment = (text: string) => {
  const separator = text.indexOf("=")
  const key = separator < 0 ? "" : text.slice(0, separator)
  const value = separator < 0 ? "" : text.slice(separator + 1)
  if (!validLabelKey(key) || !validLabelValue(value, key)) throw new Error(`Invalid label '${text}'; expected KEY=VALUE with a lowercase key and a value without whitespace (only title may contain spaces)`)
  return { key, value }
}

const sorted = (labels: WorkshopLabels): WorkshopLabels => Object.fromEntries(Object.entries(labels).toSorted(([left], [right]) => left.localeCompare(right)))

/** A null value removes the key. Setting a key replaces its previous value, so one key holds one value. */
export const applyLabelChange = (current: WorkshopLabels, key: string, value: string | null): LabelChange => {
  if (!validLabelKey(key)) throw new Error(`Invalid label key '${key}'`)
  if (value !== null && !validLabelValue(value, key)) throw new Error(`Invalid label value '${value}'`)
  const previous = sorted(current)
  if ((previous[key] ?? null) === value) return { previous, labels: previous, changed: false }
  const next: Record<string, string> = { ...previous }
  if (value === null) delete next[key]
  else next[key] = value
  return { previous, labels: sorted(next), changed: true }
}

/** Presentation tags: values only, ordered by key. The title is the row's name, never a tag. */
export const labelTags = (labels: WorkshopLabels | undefined) => Object.entries(labels ?? {}).filter(([key]) => key !== TITLE_KEY).toSorted(([left], [right]) => left.localeCompare(right)).map(([, value]) => value)

const environmentName = (prefix: string, key: string) => `${prefix}${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

export interface HookContext {
  event: WorkshopHookEvent
  workshopId: string
  path: string
  branch: string
  labels: WorkshopLabels
  previousLabels?: WorkshopLabels
}

/** The variables a repository hook receives; each label is also exposed as CLANKERHOUSE_LABEL_<KEY> for a plain shell test. */
export const hookEnvironment = (context: HookContext): Record<string, string> => ({
  CLANKERHOUSE_HOOK_EVENT: context.event,
  CLANKERHOUSE_WORKSHOP_ID: context.workshopId,
  CLANKERHOUSE_WORKSHOP_PATH: context.path,
  CLANKERHOUSE_WORKSHOP_BRANCH: context.branch,
  CLANKERHOUSE_LABELS: JSON.stringify(sorted(context.labels)),
  ...Object.fromEntries(Object.entries(context.labels).map(([key, value]) => [environmentName("CLANKERHOUSE_LABEL_", key), value])),
  ...(context.previousLabels ? {
    CLANKERHOUSE_PREVIOUS_LABELS: JSON.stringify(sorted(context.previousLabels)),
    ...Object.fromEntries(Object.entries(context.previousLabels).map(([key, value]) => [environmentName("CLANKERHOUSE_PREVIOUS_LABEL_", key), value])),
  } : {}),
})

/** Done-hook contract: exit 0 = handled, exit 1 = fall through to the default action, anything else = failure. */
export const doneHookHandled = (exitCode: number | null) => exitCode === 0

/** The one label Clankerhouse itself understands: finished work that the reaper may later remove. */
export const DONE_LABEL = { key: "status", value: "done" } as const
export const isDone = (labels: WorkshopLabels | undefined) => labels?.[DONE_LABEL.key] === DONE_LABEL.value

const defaultDoneTtlDays = 7
/** CLANKERHOUSE_DONE_TTL_DAYS overrides the retention; 0 disables reaping. */
export const doneTtlMs = (env: Record<string, string | undefined> = Bun.env) => {
  const configured = env.CLANKERHOUSE_DONE_TTL_DAYS
  const days = configured === undefined || configured === "" ? defaultDoneTtlDays : Number(configured)
  if (!Number.isFinite(days) || days < 0) return defaultDoneTtlDays * 86_400_000
  return days === 0 ? undefined : days * 86_400_000
}

export interface ReapCandidate {
  markedAt: number
  /** Newest observed use of the Workshop; coming back to it restarts the clock. */
  lastActivityAt: number
  linkedWorktree: boolean
  dirty: boolean
  /** A clanker that is working, waiting on the operator, or finished but not yet looked at. */
  busyClanker: boolean
}
export type ReapDecision = { reap: true } | { reap: false; reason: "disabled" | "not-expired" | "not-a-linked-worktree" | "busy-clanker" | "uncommitted-changes" }

/** Deleting a worktree keeps its branch, so only uncommitted work and live clankers are worth protecting. */
export const reapDecision = (candidate: ReapCandidate, now: number, ttlMs: number | undefined): ReapDecision => {
  if (ttlMs === undefined) return { reap: false, reason: "disabled" }
  if (now - Math.max(candidate.markedAt, candidate.lastActivityAt) < ttlMs) return { reap: false, reason: "not-expired" }
  if (!candidate.linkedWorktree) return { reap: false, reason: "not-a-linked-worktree" }
  if (candidate.busyClanker) return { reap: false, reason: "busy-clanker" }
  if (candidate.dirty) return { reap: false, reason: "uncommitted-changes" }
  return { reap: true }
}

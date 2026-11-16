/**
 * Typed mutation intents: what `clankers mutate --json` accepts, from the picker or a script, and the operation records
 * the staged executor keeps for them.
 */
import { validLabelKey, validLabelValue } from "./labels"
import type { Target } from "./model"

export type AvailableAction = "open" | "absorb" | "rename" | "attach" | "reparent" | "detach" | "delete" | "create"

export type MutationIntent =
  | { type: "open"; target: Target }
  | { type: "absorb"; target: Target }
  | { type: "rename"; session: string; resourceId?: string; displayName: string }
  | { type: "attach" | "reparent"; workshopId: string; parentWorkshopId: string; session?: string }
  | { type: "detach"; workshopId: string; session?: string }
  | { type: "delete"; kind: "pane" | "session" | "worktree"; session: string; confirmed: true; pane?: string; path?: string }
  /** deferSession leaves the session to the Workshop's first Clanker; the outcome is then the worktree path. */
  /** `parentWorkshopId` records the lineage the creating client gives the Workshop (null: top-level); the client applies it, the daemon only keeps it with the operation. */
  | { type: "create"; repository: string; branch: string; create: boolean; base?: string; remoteRef?: string; title?: string; deferSession?: boolean; parentWorkshopId?: string | null }
  /** The Workshop is named by its worktree path, or by workshopId when the worktree may already be gone. */
  | { type: "label"; path?: string; workshopId?: string; key: string; value: string | null }
  | { type: "done"; path: string }
  /** Releases a Workshop's live resources: its clankers stop for good and its sessions close. */
  | { type: "workshop.stop"; path: string }
  | { type: "repository.refresh" }

export interface HerdResult<T = unknown> { instanceId: string; observedAt: number; panes: T[] }

export type OperationState = "queued" | "running" | "succeeded" | "failed"
export interface OperationRecord {
  operationId: string
  idempotencyKey: string
  intent: MutationIntent
  state: OperationState
  stage: string
  attempts: number
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
}

export interface MutationSubmitResult { operation: OperationRecord; replayed: boolean }

const validText = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const validTarget = (value: unknown): value is Target => {
  if (!value || typeof value !== "object") return false
  const target = value as Record<string, unknown>
  if (target.type === "directory") return validText(target.path)
  if (target.type === "session") return validText(target.session)
  if (target.type === "window") return validText(target.session) && validText(target.windowId) && validText(target.pane)
  return target.type === "opencode" && validText(target.session) && validText(target.pane)
}

/** The intent in `value` when it is well formed, with unknown fields dropped; otherwise undefined. */
export const parseMutationIntent = (value: unknown): MutationIntent | undefined => {
  if (!value || typeof value !== "object") return undefined
  const intent = value as Record<string, unknown>
  switch (intent.type) {
    case "open": {
      if (!validTarget(intent.target)) return undefined
      return { type: "open", target: intent.target }
    }
    case "absorb": return validTarget(intent.target) ? { type: "absorb", target: intent.target } : undefined
    case "rename": return validText(intent.session) && validText(intent.displayName, 256) ? { type: "rename", session: intent.session, resourceId: validText(intent.resourceId) ? intent.resourceId : undefined, displayName: intent.displayName } : undefined
    case "attach":
    case "reparent": return validText(intent.workshopId) && validText(intent.parentWorkshopId) ? { type: intent.type, workshopId: intent.workshopId, parentWorkshopId: intent.parentWorkshopId, session: validText(intent.session) ? intent.session : undefined } : undefined
    case "detach": return validText(intent.workshopId) ? { type: "detach", workshopId: intent.workshopId, session: validText(intent.session) ? intent.session : undefined } : undefined
    case "delete": return ["pane", "session", "worktree"].includes(String(intent.kind)) && validText(intent.session) && intent.confirmed === true ? { type: "delete", kind: intent.kind as "pane" | "session" | "worktree", session: intent.session, confirmed: true, pane: validText(intent.pane) ? intent.pane : undefined, path: validText(intent.path) ? intent.path : undefined } : undefined
    case "create": return validText(intent.repository) && validText(intent.branch) && typeof intent.create === "boolean" ? { type: "create", repository: intent.repository, branch: intent.branch, create: intent.create, base: validText(intent.base) ? intent.base : undefined, remoteRef: validText(intent.remoteRef) ? intent.remoteRef : undefined, ...(validLabelValue(intent.title, "title") ? { title: intent.title } : {}), ...(intent.deferSession === true ? { deferSession: true } : {}), ...(validText(intent.parentWorkshopId) || intent.parentWorkshopId === null ? { parentWorkshopId: intent.parentWorkshopId } : {}) } : undefined
    case "label": return validText(intent.path) !== validText(intent.workshopId) && validLabelKey(intent.key) && (intent.value === null || validLabelValue(intent.value, intent.key)) ? { type: "label", ...(validText(intent.path) ? { path: intent.path } : { workshopId: intent.workshopId as string }), key: intent.key, value: intent.value } : undefined
    case "done": return validText(intent.path) ? { type: "done", path: intent.path } : undefined
    case "workshop.stop": return validText(intent.path) ? { type: "workshop.stop", path: intent.path } : undefined
    case "repository.refresh": return { type: "repository.refresh" }
    default: return undefined
  }
}

import type { ActivitySource } from "../activity"
import type { ClankerState, DirectorySource } from "../model"

export interface TmuxSession {
  name: string
  recency: number
  path: string
  attached: boolean
  worktreePath: string
  directoryPath: string
  workshopId?: string
  parentWorkshopId?: string | null
}

export interface TmuxWindow {
  session: string
  id: string
  index: string
  name: string
  pane: string
  pid: string
  command: string
  title: string
  activity: number
  active: boolean
}

export interface OpencodeStatus {
  directory: string
  status: string
  detail: string
  title: string
  age: string
  session: string
  pane: string
  updatedAt: number
  stablePane: string
  harnessSessionId?: string
}

export interface DirectoryRow {
  path: string
  source: DirectorySource
  branch: string
  activityAt?: number
  activitySource?: ActivitySource
  frecency?: number
}

export interface ClankerReport {
  harness: string
  state: ClankerState
  pane: string
  updatedAt: number
  hookEvent?: string
  harnessSessionId?: string
  recoveryAttemptId?: string
}

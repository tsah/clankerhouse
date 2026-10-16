import type { ActivitySource } from "../activity"
import type { ClankerState, DirectorySource } from "../model"
import type { RuntimeAgentStatus } from "../multiplexer/interface"

export interface MuxSession {
  id: string
  name: string
  recency: number
  path: string
  attached: boolean
  worktreePath: string
  directoryPath: string
  workshopId?: string
  parentWorkshopId?: string | null
  resourceId?: string
  displayName?: string
}

export interface MuxWindow {
  session: string
  sessionId: string
  id: string
  index: string
  name: string
  pane: string
  pid: string
  currentPath: string
  command: string
  title: string
  activity: number
  active: boolean
  windowResourceId?: string
  windowDisplayName?: string
  terminalId?: string
  terminalDisplayName?: string
  clankerId?: string
  explicitHarness?: string
  harnessSessionId?: string
  recoveryAttemptId?: string
  agentStatus?: { agent?: string; status: RuntimeAgentStatus }
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
  clankerId: string
  harness: string
  state: ClankerState
  pane: string
  updatedAt: number
  hookEvent?: string
  harnessSessionId?: string
  recoveryAttemptId?: string
}

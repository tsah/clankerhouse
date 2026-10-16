/**
 * `clankers report`, run from inside a clanker: record a structured Report addressed by
 * default to the reporting Workshop's parent.
 */
import { ClankerApiError } from "./clanker-api"
import { openManagedMultiplexer, type ManagedMultiplexer } from "./multiplexer"
import { paneLocation } from "./multiplexer/interface"
import { ReportInputError, reportAddressee, withOrchestrationStore, type ClankerReportRecord, type ReportState } from "./orchestration"
import { currentWorkshop } from "./watch"
import { workshopForId } from "./workshop"

export interface ReportRequest {
  state: ReportState
  message: string | null
  payload: Record<string, unknown> | null
  to?: string
  noParent?: boolean
}

/** `CLANKER_ID` from the launch environment, else the current pane's Clanker claim. */
export const reportingClankerId = async (env: Record<string, string | undefined> = Bun.env, multiplexer?: ManagedMultiplexer) => {
  const declared = env.CLANKER_ID?.trim()
  if (declared) return declared
  const mux = multiplexer ?? openManagedMultiplexer()
  const pane = env[mux.paneAddressEnv()]?.trim()
  const claimed = pane ? await mux.readClaim(paneLocation("", null, pane), "clankerId").catch(() => undefined) : undefined
  if (claimed) return claimed
  throw new ReportInputError("Cannot identify the reporting clanker: CLANKER_ID is unset and the current pane has no clankerId claim; run clankers report from inside a clanker")
}

/** An explicit addressee is a registered Workshop id or a Clanker id. */
const validAddressee = (to: string) => {
  if (workshopForId(to) || /^clanker-[A-Za-z0-9-]+$/.test(to)) return to
  throw new ClankerApiError("NOT_FOUND", `Unknown report addressee: ${to}; use a Workshop id or a Clanker id`, 3)
}

export async function submitReport(request: ReportRequest, options: { cwd?: string; env?: Record<string, string | undefined>; multiplexer?: ManagedMultiplexer } = {}): Promise<ClankerReportRecord> {
  const env = options.env ?? Bun.env
  const clankerId = await reportingClankerId(env, options.multiplexer)
  const workshop = currentWorkshop(options.cwd, env)
  // The registry is authoritative for lineage; a missing parent still records the Report, unaddressed.
  const to = reportAddressee({ workshopId: workshop?.workshopId ?? null, parentWorkshopId: workshop?.parentWorkshopId ?? null, to: request.to === undefined ? undefined : validAddressee(request.to), noParent: request.noParent })
  return withOrchestrationStore((store) => store.appendReport({ clankerId, workshopId: workshop?.workshopId ?? null, to, state: request.state, message: request.message, payload: request.payload }))
}

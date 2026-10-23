/**
 * Attention: a Report that needs the operator becomes a Multiplexer notification. Clankerhouse decides nothing
 * about the Report itself; the operator chooses which states notify with CLANKERHOUSE_REPORT_NOTIFY.
 */
import { REPORT_STATES, type ClankerReportRecord, type ReportState } from "./orchestration"

export const DEFAULT_NOTIFY_STATES: readonly ReportState[] = ["question", "blocked", "failed"]
/** The reporting command never waits longer than this for the notification. */
export const REPORT_NOTIFY_BUDGET_MS = 1_500

/** Unset or empty: the default states. `none`, `off`, or `0`: no notifications. Otherwise a comma list of states. */
export const reportNotifyStates = (env: Record<string, string | undefined> = Bun.env): ReadonlySet<ReportState> => {
  const configured = env.CLANKERHOUSE_REPORT_NOTIFY?.trim().toLowerCase()
  if (!configured) return new Set(DEFAULT_NOTIFY_STATES)
  if (["none", "off", "0"].includes(configured)) return new Set()
  return new Set(configured.split(",").map((state) => state.trim()).filter((state): state is ReportState => (REPORT_STATES as readonly string[]).includes(state)))
}

const plain = (text: string, limit: number) => {
  const collapsed = text.replace(/[\p{Cc}\s]+/gu, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`
}

/** Title `<state> · <workshop>`, body the Report's message; both within herdr's 80/240 limits. */
export const reportNotice = (report: Pick<ClankerReportRecord, "state" | "message" | "clankerId">, workshopName: string | undefined) => {
  const title = plain(`${report.state} · ${workshopName?.trim() || report.clankerId}`, 80)
  const body = report.message ? plain(report.message, 240) : ""
  return { title, ...(body ? { body } : {}) }
}

/**
 * Best effort and bounded: a notification never fails the Report or holds it up beyond the budget. Returns whether
 * one was shown.
 */
export const notifyReport = async (
  report: Pick<ClankerReportRecord, "state" | "message" | "clankerId">,
  workshopName: string | undefined,
  notify: (notice: { title: string; body?: string }) => Promise<boolean>,
  env: Record<string, string | undefined> = Bun.env,
) => {
  if (!reportNotifyStates(env).has(report.state)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      notify(reportNotice(report, workshopName)).catch(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), REPORT_NOTIFY_BUDGET_MS) }),
    ])
  } catch { return false } finally { clearTimeout(timer) }
}

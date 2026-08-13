import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"

const pane = process.env.TMUX_PANE?.trim() || ""
const clankerId = process.env.CLANKER_ID?.trim() || ""
const expectedSessionId = process.env.CLANKER_SESSION_ID?.trim() || ""
const recoveryAttemptId = process.env.CLANKER_RECOVERY_ATTEMPT?.trim() || ""
const tracked = Boolean(clankerId)
let attestedSessionId = ""

const tmux = (args: string[]) => {
  if (!pane) return
  spawnSync("tmux", args, { stdio: "ignore" })
}

const attest = (sessionId: string) => {
  if (!tracked || !sessionId || attestedSessionId === sessionId) return
  if (expectedSessionId && expectedSessionId !== sessionId) return
  tmux(["set-option", "-p", "-t", pane, "@clankerhouse_clanker_id", clankerId])
  tmux(["set-option", "-p", "-t", pane, "@dotfiles_harness", "opencode"])
  tmux(["set-option", "-p", "-t", pane, "@clankerhouse_harness_session_id", sessionId])
  if (recoveryAttemptId) tmux(["set-option", "-p", "-t", pane, "@clankerhouse_recovery_attempt", recoveryAttemptId])
  const cli = process.env.CLANKERHOUSE_CLANKERS || "clankers"
  const args = ["recovery", "attest", clankerId, "--session-id", sessionId]
  if (recoveryAttemptId) args.push("--attempt", recoveryAttemptId)
  const result = spawnSync(cli, args, { stdio: "ignore" })
  if (result.status === 0) attestedSessionId = sessionId
}

export const ClankerhouseLifecyclePlugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.created") return attest(event.properties.info.id)
    if (event.type === "session.updated" && expectedSessionId && event.properties.info.id === expectedSessionId) attest(event.properties.info.id)
  },
  "chat.message": async ({ sessionID }) => {
    attest(sessionID)
  },
})

export default ClankerhouseLifecyclePlugin

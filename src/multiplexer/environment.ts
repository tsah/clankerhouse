export const SUPPORTED_MULTIPLEXERS = ["tmux", "herdr"] as const
export type SupportedMultiplexer = typeof SUPPORTED_MULTIPLEXERS[number]

/** Resolve the innermost managed runtime while preserving explicit operator selection. */
export const resolvedMultiplexerKind = (env: Record<string, string | undefined>): SupportedMultiplexer => {
  const requested = (env.CLANKERHOUSE_MULTIPLEXER || "").trim().toLowerCase()
  if (requested) {
    if ((SUPPORTED_MULTIPLEXERS as readonly string[]).includes(requested)) return requested as SupportedMultiplexer
    throw new Error(`Unsupported CLANKERHOUSE_MULTIPLEXER: ${requested} (expected ${SUPPORTED_MULTIPLEXERS.join(" or ")})`)
  }
  return env.HERDR_ENV?.trim() === "1" && Boolean(env.HERDR_PANE_ID?.trim()) ? "herdr" : "tmux"
}

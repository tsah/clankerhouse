/**
 * Adapter selection. tmux remains the default; herdr is opt-in through
 * Explicit `CLANKERHOUSE_MULTIPLEXER` selection wins. Otherwise only the paired
 * markers of a managed Herdr pane infer Herdr, so merely installing Herdr never
 * changes the legacy tmux default.
 */
import { HerdrAdapter } from "./herdr"
import { resolvedMultiplexerKind, type SupportedMultiplexer } from "./environment"
import type { Multiplexer, MultiplexerKind } from "./interface"
import { ManagedMultiplexer } from "./managed"
import { TmuxAdapter, type MultiplexerCommand } from "./tmux"

export { SUPPORTED_MULTIPLEXERS, type SupportedMultiplexer } from "./environment"

export const multiplexerKind = (env: Record<string, string | undefined> = Bun.env): SupportedMultiplexer => resolvedMultiplexerKind(env)

export const createMultiplexer = (kind: MultiplexerKind = multiplexerKind(), options: { command?: MultiplexerCommand; socketPath?: string } = {}): Multiplexer => {
  if (kind === "tmux") return new TmuxAdapter({ command: options.command })
  if (kind === "herdr") return new HerdrAdapter({ socketPath: options.socketPath })
  throw new Error(`Unknown multiplexer kind: ${kind}`)
}

export const openManagedMultiplexer = (options: { kind?: MultiplexerKind; registryPath?: string; command?: MultiplexerCommand; socketPath?: string } = {}) =>
  new ManagedMultiplexer(createMultiplexer(options.kind ?? multiplexerKind(), { command: options.command, socketPath: options.socketPath }), { registryPath: options.registryPath })

/**
 * Compatibility facade over `src/multiplexer/`. Existing callers keep importing
 * `TmuxMultiplexer` and `ensureManagedTmuxSession`; new code should use the
 * Interface and `openManagedMultiplexer` from `./multiplexer/select`.
 */
import { ManagedMultiplexer, newManagedResourceId } from "./multiplexer/managed"
import { openManagedMultiplexer } from "./multiplexer/select"
import { TmuxAdapter, type MultiplexerCommand } from "./multiplexer/tmux"

export type { MultiplexerPane, MultiplexerWindow, MultiplexerSession, MultiplexerSnapshot, Multiplexer, MultiplexerCapabilities, ClaimKey, NativeLocation, SpawnRequest, SpawnResult } from "./multiplexer/interface"
export type { MultiplexerTarget, OpenMultiplexerTarget, AbsorbedSession } from "./multiplexer/managed"
export type { MultiplexerCommand } from "./multiplexer/tmux"
export { ManagedMultiplexer, newManagedResourceId } from "./multiplexer/managed"
export { openManagedMultiplexer, multiplexerKind, createMultiplexer } from "./multiplexer/select"

/** The tmux Adapter composed with registry-backed managed operations. */
export class TmuxMultiplexer extends ManagedMultiplexer {
  constructor(options: { command?: MultiplexerCommand; registryPath?: string } = {}) {
    super(new TmuxAdapter({ command: options.command }), { registryPath: options.registryPath })
  }
}

/** Absorb the session identified by a native id or name using the selected Adapter. */
export const ensureManagedSession = async (selector: string, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) => multiplexer.ensureManagedSession(selector)

/** @deprecated use `ensureManagedSession`; retained for existing callers. */
export const ensureManagedTmuxSession = (selector: string) => ensureManagedSession(selector)

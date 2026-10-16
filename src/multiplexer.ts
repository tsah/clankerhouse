/**
 * Facade over `src/multiplexer/`: the Interface types, the registry-backed managed
 * layer, and Adapter selection.
 */
import type { ManagedMultiplexer } from "./multiplexer/managed"
import { openManagedMultiplexer } from "./multiplexer/select"

export type { MultiplexerPane, MultiplexerWindow, MultiplexerSession, MultiplexerSnapshot, Multiplexer, MultiplexerCapabilities, ClaimKey, NativeLocation, SpawnRequest, SpawnResult } from "./multiplexer/interface"
export type { MultiplexerTarget, OpenMultiplexerTarget, AbsorbedSession } from "./multiplexer/managed"
export { ManagedMultiplexer, newManagedResourceId } from "./multiplexer/managed"
export { openManagedMultiplexer, createMultiplexer } from "./multiplexer/select"

/** Absorb the session identified by a native id or name. */
export const ensureManagedSession = async (selector: string, multiplexer: ManagedMultiplexer = openManagedMultiplexer()) => multiplexer.ensureManagedSession(selector)

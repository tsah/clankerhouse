/**
 * Adapter selection. Rex is the only Multiplexer Adapter.
 */
import type { Multiplexer } from "./interface"
import { ManagedMultiplexer } from "./managed"
import { RexAdapter } from "./rex"

export const createMultiplexer = (_options: { socketPath?: string } = {}): Multiplexer => new RexAdapter()

export const openManagedMultiplexer = (options: { registryPath?: string; socketPath?: string } = {}) =>
  new ManagedMultiplexer(createMultiplexer({ socketPath: options.socketPath }), { registryPath: options.registryPath })

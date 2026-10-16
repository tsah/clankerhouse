/**
 * Adapter selection. Herdr is the only Multiplexer Adapter; the Interface stays so
 * another runtime can be added without touching callers (ADR-0001, ADR-0008).
 */
import { HerdrAdapter } from "./herdr"
import type { Multiplexer } from "./interface"
import { ManagedMultiplexer } from "./managed"

export const createMultiplexer = (options: { socketPath?: string } = {}): Multiplexer => new HerdrAdapter({ socketPath: options.socketPath })

export const openManagedMultiplexer = (options: { registryPath?: string; socketPath?: string } = {}) =>
  new ManagedMultiplexer(createMultiplexer({ socketPath: options.socketPath }), { registryPath: options.registryPath })

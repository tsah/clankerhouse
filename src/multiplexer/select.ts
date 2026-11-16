/**
 * Adapter selection. Herdr is the default Multiplexer Adapter; the Interface lets another
 * runtime be added without touching callers (ADR-0001, ADR-0008).
 */
import { HcAdapter } from "./hc"
import { HerdrAdapter } from "./herdr"
import type { Multiplexer } from "./interface"
import { ManagedMultiplexer } from "./managed"
import { RexAdapter } from "./rex"

// `CLANKERHOUSE_MULTIPLEXER=hc` selects the herdr-core lane and `rex` the Rex lane; Herdr stays the default.
export const createMultiplexer = (options: { socketPath?: string } = {}): Multiplexer => {
  if (Bun.env.CLANKERHOUSE_MULTIPLEXER === "hc") return new HcAdapter({ socketPath: options.socketPath })
  if (Bun.env.CLANKERHOUSE_MULTIPLEXER === "rex") return new RexAdapter()
  return new HerdrAdapter({ socketPath: options.socketPath })
}

export const openManagedMultiplexer = (options: { registryPath?: string; socketPath?: string } = {}) =>
  new ManagedMultiplexer(createMultiplexer({ socketPath: options.socketPath }), { registryPath: options.registryPath })

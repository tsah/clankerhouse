import { openManagedMultiplexer, type ManagedMultiplexer } from "../multiplexer"

/** One Multiplexer pane as Recovery sees it: identity claims plus the runtime's own session reference. */
export interface ObservedPane {
  pane: string
  session: string
  nativeSessionId: string
  windowId: string
  clankerId: string
  harness: string
  harnessSessionId: string
  recoveryAttemptId: string
  /** Clanker whose resume gate waits in this pane (ADR-0009); empty otherwise. */
  recoveryGate: string
  /** Harness session the runtime itself reports for this pane, e.g. one its own integration resumed. */
  runtimeSession?: { agent: string; value: string }
}

/** Panes from one observation, or none when the Multiplexer is unreachable. */
export const observePanes = async (multiplexer: ManagedMultiplexer = openManagedMultiplexer()): Promise<ObservedPane[]> => {
  let snapshot
  try { snapshot = await multiplexer.observe({ processInfo: false }) }
  catch { return [] }
  return snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.map((pane) => {
    const claims = pane.claims ?? {}
    return {
      pane: pane.id,
      session: session.nativeName,
      nativeSessionId: session.id,
      windowId: window.id,
      clankerId: claims.clankerId || pane.clankerId || "",
      harness: claims.harness || pane.harness || "",
      harnessSessionId: claims.harnessSessionId || pane.harnessSessionId || "",
      recoveryAttemptId: claims.recoveryAttemptId || pane.recoveryAttemptId || "",
      recoveryGate: claims.recoveryGate || "",
      ...(pane.sessionRef ? { runtimeSession: { agent: pane.sessionRef.agent, value: pane.sessionRef.value } } : {}),
    }
  })))
}

/** Panes whose only Clanker evidence is a waiting resume gate for `clankerId`. */
export const gatePanesFor = (panes: readonly ObservedPane[], clankerId: string) =>
  panes.filter((pane) => !pane.clankerId && pane.recoveryGate === clankerId)

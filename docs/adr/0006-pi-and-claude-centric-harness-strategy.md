# ADR-0006: Center Clankerhouse on Pi and Claude

## Status

Accepted. Amended by ADR-0009 (2026-10-23): automatic Recovery was retired; Clankerhouse now records sessions in a clanker ledger and resumes them only on request.

## Context

Clankerhouse and OpenCode 2 increasingly provide overlapping control-plane behavior. OpenCode 2 owns a long-lived server, projects and worktrees, durable sessions, lifecycle events, prompts, permissions, results, and attachable clients. Reimplementing those semantics inside Clankerhouse creates two authorities and requires fragile correlation between server-global sessions, local processes, panes, and Clanker identity.

Pi has the opposite shape. It is a local, extensible harness with transparent session persistence and public lifecycle, messaging, SDK, and RPC Interfaces, but it does not prescribe a central server, Workshop model, herd UI, multiplexer topology, or restart policy. Claude also remains a primary supported harness through its native session and lifecycle contracts. These harnesses leave Clankerhouse's Workshop, Terminal, Clanker, navigation, session-ledger, and host-safety responsibilities distinct.

Supporting every harness symmetrically would force Clankerhouse's Interfaces toward the least capable Adapter and spend implementation effort duplicating external systems rather than deepening its own Modules.

## Decision

Clankerhouse is Pi- and Claude-centric.

Pi is the reference harness Adapter and defines the complete Clanker communication acceptance path: lifecycle, native send, generation-aware wait, result, and session resume. Claude is a primary Adapter where verified semantic harness or runtime contracts support those operations. Capabilities remain explicit; unsupported operations fail rather than falling back to raw pane input or output capture.

OpenCode remains supported as a delegated Adapter. Its server is authoritative for OpenCode projects, worktrees, sessions, parent/child relationships, lifecycle, prompts, permissions, results, persistence, and session attachment. Clankerhouse consumes the server's documented API and event stream wherever possible and does not independently recreate those semantics. Clankerhouse continues to own only its local concerns around an OpenCode session: Workshop correlation, Terminal presentation and navigation, Multiplexer Location, host pressure, and operator-visible diagnostics.

Clankerhouse does not poll the OpenCode service or correlate its sessions to panes. Pane-local OpenCode state is delegated to Herdr's OpenCode integration, whose TUI reporter associates lifecycle, permission, and form state with the pane's selected root session (including OpenCode 2 shared servers); the Clankerhouse plugin only binds an owned Clanker to its `ses_…` session for the clanker ledger and reports attested lifecycle for that owned session. Resuming an OpenCode Clanker delegates to server persistence and native session attachment; Clankerhouse must not claim stronger interrupted-operation or replay guarantees than the server provides. Migration from an OpenCode Clanker to Pi exports the OpenCode session context, preserves repository state, stops the OpenCode operation and clients through native mechanisms, and starts a new Pi Clanker with an explicit handoff rather than attempting to translate session storage.

Codex and other harnesses may remain observable or gain focused Adapters, but feature parity with Pi and Claude is not a product requirement.

## Consequences

- New Clankerhouse behavior is accepted first through the Pi Adapter and, where supported by a verified contract, Claude.
- Harness capability differences remain visible in the Interface instead of being hidden behind inferred or raw-terminal behavior.
- OpenCode integration should become smaller as session listing, status, messaging, results, worktrees, persistence, and attachment move behind its server API.
- Clankerhouse avoids a second OpenCode session registry, message transport, result store, or resume authority.
- The OpenCode Adapter remains exposed to a beta API and must isolate version-specific schemas and failures behind one deep Module.
- Users retain OpenCode compatibility without making OpenCode's server model the architecture of Clankerhouse.
- Global Workshop search, lineage, exact local navigation, the clanker ledger, and host-safety behavior remain Clankerhouse responsibilities.

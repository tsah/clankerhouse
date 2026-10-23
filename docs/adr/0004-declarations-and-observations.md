# ADR-0004: Separate Owned Declarations from Runtime Observations

## Status

Accepted. Amended by ADR-0009 (2026-10-23): Recovery was retired, so Declarations no longer include desired recovery state and lifecycle reports carry no Recovery attempt id.

## Context

Clankerhouse owns durable Workshop, Terminal, and Clanker identity while the Multiplexer, processes, harnesses, Git, and the host own their current facts. The existing projection sometimes discarded facts that failed identity correlation, then presentation inferred replacement state such as treating the current session as working. This made missing attestation look like missing reality and allowed derived UI state to masquerade as runtime state.

## Decision

Clankerhouse is authoritative for Declarations: stable identity, Display Names, Workshop lineage, Clanker Ledger records, and durable mutation intent.

Runtime Adapters are authoritative for their Observations. Every Observation carries its source, observed time, reported state when available, and confidence. Identity correlation may classify evidence as attested, observed, or rejected. Rejected or incomplete evidence cannot establish managed identity, enter the Clanker Ledger, or become an actionable Clanker, but remains reportable when it has a current target.

A pane-addressed harness lifecycle report that makes no Clanker identity claim may establish observed harness state when a current process observation on the same pane confirms the harness. The Multiplexer supplies that process observation: Herdr's per-pane agent detection, not a separate Clankerhouse process scan. It remains an Observation, not a Clanker: it cannot establish owned identity, expose Clanker actions, or enter the Clanker Ledger. A report that claims Clanker identity still requires exact owned identity and harness-session correlation to become attested state.

Projection keeps existing state and target fields as compatibility outputs while adding structured observation metadata. Unknown runtime state remains unknown. Attention, current selection, and subtree aggregation must not overwrite runtime facts. Clients render the projection and do not invent stronger runtime claims.

## Consequences

- A detected harness process can be visible without becoming a Clanker.
- A mismatched lifecycle report remains diagnosable without affecting aggregate runtime state.
- Stable identity and mutation safety continue to use validated registry records and Multiplexer Locations.
- Snapshot additions remain optional and backward-compatible during migration.
- Whether a finished clanker has been seen was once a Clankerhouse acknowledgement ledger; it is now the Multiplexer's Observation (Herdr's effective `done` versus `idle`), fed by the lifecycle state Clankerhouse mirrors into Herdr.
- The Clanker Ledger records only Clankers established by the same validated observation model, never raw multiplexer claims.

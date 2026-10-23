# ADR-0001: Treat the Multiplexer as a Replaceable Runtime

## Status

Accepted. Amended by ADR-0007 (Herdr Adapter) and ADR-0008 (tmux Adapter retired; Herdr is the only Adapter). Amended by ADR-0009 (2026-10-23): automatic Recovery was retired for a clanker ledger.

## Context

Clankerhouse historically used tmux session names as presentation, identity, correlation, and action targets. Names are mutable and tmux session, window, and pane IDs are valid only within one tmux server lifetime. This made collection, selection, rename, opening, and recovery depend on ambiguous or stale names.

Clankerhouse owns durable Workshops, Terminals, Clankers, and Display Names. It does not own terminal multiplexing. At the time tmux was the only multiplexer, but core identity and recovery semantics must not depend on tmux naming or command syntax.

## Decision

Clankerhouse places multiplexer behavior behind a deep Multiplexer module expressed in domain operations: observe topology, resolve current location, absorb unmanaged topology, validate and resolve managed locations, and open targets.

Durable Clankerhouse resource IDs and Display Names are stored in the resource registry. Multiplexer-native IDs are opaque, ephemeral Multiplexer Locations scoped by multiplexer kind and instance identity. The Adapter records Clankerhouse identity claims on native objects but the registry remains authoritative.

Unmanaged multiplexer resources remain visible. Entering one through Clankerhouse absorbs its whole session topology using the active pane's Workshop. Switching outside Clankerhouse does not absorb it. Processes are never inferred to be Clankers during absorption.

Existing snapshot names and name-based target fields remain compatibility hints during migration. Managed actions resolve current locations by stable resource ID and do not fall back to stale names.

## Consequences

- Native multiplexer names can change without changing Clankerhouse identity.
- Collection joins resources by native IDs rather than names.
- Durable records (since ADR-0009, the clanker ledger) are matched to live resources by explicit identity and current location.
- A future multiplexer adapter can be added without changing Workshop, Terminal, or Clanker identity.
- Adapter discovery and a general plugin framework remain out of scope.

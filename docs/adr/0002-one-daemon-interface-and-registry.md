# ADR-0002: One Daemon Interface and Durable Registry

## Status

Accepted. Amended by ADR-0009 (2026-10-23): Recovery and its Clanker start, stop, and recovery intents were retired; Clanker records moved to the clanker ledger, and the registry keeps imported legacy Recovery records only for provenance.

## Context

Clankerhouse distributed correctness across a Bash supervisor, TypeScript projection process, Rust and TypeScript picker policy, JSON snapshots, a Unix socket, several SQLite databases, manifests, lifecycle files, multiplexer claims, and direct workflow side effects. On one host this creates distributed-system failure modes without useful isolation: multiple authorities, partial mutations, stale producers, incompatible schemas, and live files replaced beneath old processes.

ADR-0001 requires the Multiplexer to remain a replaceable runtime and makes durable Clankerhouse identity authoritative over multiplexer names and claims.

## Decision

One long-lived daemon Module owns observation, projection, durable state, mutation coordination, external side-effect reconciliation, startup/shutdown, and subscriptions.

Its small Unix-socket Interface provides health/ensure-running, observe/subscribe, refresh, and typed idempotent mutation intents. Socket observations are authoritative for live clients. An atomic JSON snapshot may remain only as a one-time startup/crash fallback.

One SQLite registry owns Workshops, Terminals, Clankers, desired recovery state, an append-only journal, leases, and Multiplexer Locations. Legacy databases are imported through an expand/migrate/contract sequence and retained read-only during a compatibility window. Manifests, lifecycle reports, and multiplexer claims are projections or claims, not authorities.

One deep mutation Module durably stages and reconciles create, absorb, open, rename, reparent, detach, delete, start, stop, and recovery. Clients do not sequence Worktrunk, SQLite, the Multiplexer, systemd, or manifest changes.

A daemon epoch and exclusive producer lease scope authoritative revisions to a runtime/Multiplexer instance. Launchers may ensure a daemon exists but PID files and source modification times do not own correctness.

Installation stages and validates a versioned application, atomically activates it, explicitly hands off the daemon, and rolls back activation on failed health checks.

## Consequences

- Rust/ratatui is the sole rendering/input Adapter after action parity; Bun/TypeScript remains the daemon and control plane.
- Tree, search, ordering, target, and available-action policy has one owner.
- State-changing legacy commands become socket clients while preserving command shapes during the compatibility window.
- Workflow retries can reconcile partial external effects from durable operation stages.
- SQLite migration and daemon handoff add implementation complexity, but that complexity gains locality behind small Interfaces.
- The Multiplexer Adapter stays behind the Interface (ADR-0007, ADR-0008). Durable IDs and validated Multiplexer Locations remain authoritative as required by ADR-0001.

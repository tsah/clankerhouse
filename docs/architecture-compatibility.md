# Architecture Migration Compatibility

The simplification ships as an expand/migrate/contract migration. The first release containing the new daemon and registry is the **compatibility release**; contraction is not permitted until a later release and requires an explicit rollback cutoff.

## Preserved during the compatibility release

- Existing command names and argument shapes under `bin/`, including `clankerhouse`, `clankers`, recovery, lifecycle reporting, stop, deletion, and harness launchers.
- Existing tmux options and bindings. Identity options remain claims validated against the durable registry.
- Workshop manifest version 1. Manifests are imported and repaired as projections; they do not override a conflicting durable identity.
- Lifecycle report JSON and the legacy report directory read path.
- Snapshot schema version 10 and socket protocol version 1 methods. New protocol fields and methods are additive.
- Recovery database schemas v1, v2, and v3 as import inputs. Legacy database files remain untouched and available for rollback.
- The interactive TypeScript picker as an opt-in Adapter while native parity and latency are verified.
- A one-time `state.json` startup/crash fallback. Live synchronization uses the Unix socket only.

## Authority during the window

After successful activation, the daemon epoch and unified registry are authoritative. Legacy stores are read-only import sources; manifests, lifecycle reports, tmux options, and `state.json` are projections or claims. A migration that cannot prove identity consistency or pass `PRAGMA foreign_key_check` fails activation rather than guessing.

## Contract prerequisites

A later release may remove compatibility paths only after all of the following are true:

1. Native action-parity, reconnect, exact-target, and hot-start QA passes in supported environments.
2. Fleet/state inspection confirms successful unified-registry import and no unresolved provenance conflicts.
3. No supported integration uses direct legacy database writes or live `state.json` polling.
4. Rollback no longer requires an older process to read state written by the new release.
5. The removal and rollback cutoff are called out in release notes.

Until then, tests must exercise both legacy ingress and the authoritative socket/registry path.

## Current compatibility gate

The daemon initializes, imports, and validates the unified registry at startup. Socket mutation operations and their retry stages are authoritative in the registry `operations` table. Domain rows imported from Workshop, resource, and recovery stores are marked `legacy-mutable` and are not preferred by live projection while any supported ingress can still write those stores directly. Repeated startup import is skipped per source provenance during this gate, preventing a changed mutable source from being mistaken for an immutable historical import.

Target `open`, Workshop `ensure`, Recovery `start`, `stop`, `suspend`, `tombstone`, and per-Clanker `resume` command shapes route through the daemon when its socket is available. Daemon-owned compatibility subprocesses set `CLANKERHOUSE_DAEMON_INTERNAL=1` to prevent recursive socket submission. `CLANKERHOUSE_LEGACY_MUTATIONS=1` is the explicit rollback escape hatch. Other legacy mutation ingress remains compatibility-gated until it can be converted without recursive daemon-to-client calls; the gate must not be removed before that conversion is complete.

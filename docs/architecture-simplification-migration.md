# Clankerhouse Architecture Simplification Migration

## Goal

Clankerhouse will become one long-lived daemon Module behind one Unix-socket Interface. The daemon owns observation, projection, durable state, mutation coordination, side effects, lifecycle, and subscriptions. Clients send typed intents and render daemon-projected observations.

This migration preserves the domain language in `CONTEXT.md` and ADR-0001: the Multiplexer remains replaceable behind one Adapter (Herdr since ADR-0008), durable IDs remain authoritative, and Multiplexer Locations are validated ephemeral claims.

## Safety invariants

- The source checkout and the user's installed application, services, Herdr server, and state are never modified by development or QA.
- Integration QA supplies isolated `HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, install prefix, and Herdr server socket.
- Runtime directories and sockets remain private, owned by the current user, and resistant to symlink/path replacement.
- Stable IDs, ownership checks, foreign keys, exact Multiplexer target resolution, and destructive-action confirmation are not weakened.
- Schema and protocol changes use expand/migrate/contract. Activation happens only after old readers no longer need newly written state.
- `state.json` is an atomic startup/crash fallback. No live client uses it for synchronization.

## Compatibility phases

### Phase 0 — Stabilize the existing release

Port the recovery schema-v3 compatibility fix, failed-Workshop rollback, OpenCode cache-race fix, and hot native launch behavior from the source checkout when absent. These fixes remain independently testable and do not change authority.

### Phase 1 — Expand the daemon Interface and ownership

- Add health/ensure-running, observation/subscription, refresh, and typed mutation intents to the newline-delimited JSON Unix-socket protocol.
- Give each daemon an epoch and acquire one authoritative producer lease for a runtime/Multiplexer instance before publishing revisions.
- Keep a tiny launcher that probes the Interface and starts a daemon under a lock. Remove source-mtime/PID files as correctness mechanisms after a compatibility window.
- Persist `state.json` atomically after publication for startup/crash fallback only.
- During protocol expansion, old snapshot requests remain accepted and old launch commands remain available.

### Phase 2 — Move policy behind the daemon seam

- Project stable display rows, search text, ordering, exact targets, and typed available actions in each observation.
- Move repository refresh and mutation sequencing out of picker handlers.
- Native subscribes to the socket, retains its last valid snapshot through reconnects, and reads JSON at most once during startup.
- Rust/ratatui is now the sole interactive Adapter after native action parity was accepted. Keep the TypeScript daemon implementation; remove only its obsolete Solid/OpenTUI renderer.

### Phase 3 — Expand and migrate the durable registry

Create one registry database containing Workshops, Terminals, Clankers, desired recovery state, append-only journal, leases, and Multiplexer Locations. Migration is resumable and transactional:

1. create expanded tables without changing legacy stores;
2. import `workshops.sqlite3`, `resources.sqlite3`, and recovery v1/v2/v3 data with provenance/idempotency keys;
3. import manifests and validated multiplexer identity claims only as projections/claims;
4. run `foreign_key_check` and semantic identity checks;
5. dual-read with the new registry preferred and legacy fallback during the compatibility window;
6. activate daemon writes to the registry;
7. retain legacy databases read-only for rollback; contract only in a later release.

The recovery journal remains append-only. Interrupted imports resume without duplicate identity or journal events.

### Phase 4 — Deepen the mutation Module

One daemon-owned Module accepts create, absorb, open, rename, reparent, detach, delete, start, stop, and recovery intents. Every operation has an idempotency key, durable stages, and a result journal. External effects (Worktrunk, the Multiplexer, systemd, manifests) are reconciled rather than assumed atomic. Retries resume at the last durable stage and compensate only effects proven to be owned by the operation.

Legacy CLI commands and lifecycle integrations become socket clients. A documented compatibility window keeps their command shapes and report formats while routing state changes through the daemon.

### Phase 5 — Structured Clanker observation

The daemon collects explicit lifecycle reports and registered Clanker process identities. OpenCode observation becomes daemon-local or consumes structured lifecycle data. Process resemblance never creates Clanker identity. The Python status command remains a read-only compatibility formatter during the window and is removed from the live projection path.

### Phase 6 — Atomic installation and handoff

Install into a validated versioned directory, run preflight/build/QA there, then atomically switch an activation symlink. Wrappers resolve the active version per invocation. The installer explicitly asks the old daemon to hand off or stop, starts/probes the new daemon, and rolls activation back if the probe fails. Old version directories remain until successful activation and cleanup. Existing live files are never replaced beneath a running process.

## Acceptance criteria

- [ ] A hot native Alt-K path renders a cached/streamed valid first frame in under 100 ms.
- [ ] Daemon replacement never causes a transient `Snapshot Unavailable`; native retains the last valid frame and reconnects.
- [ ] Exactly one epoch can publish authoritative revisions for a runtime/multiplexer instance; stale producers are rejected.
- [ ] Native supports jump, repository/branch creation, rename, attach/reparent, detach, deletion, and exact target opening.
- [ ] No live client polls `state.json`; fallback is read once at startup only.
- [ ] All state-changing commands issue typed daemon mutation intents and retries are safe after each injected external failure.
- [ ] Registry fixtures for legacy Workshop lineage, resource registry, recovery v1/v2/v3, manifests, and multiplexer claims import without loss and pass `PRAGMA foreign_key_check`.
- [ ] Existing CLI commands, multiplexer bindings, lifecycle reports, and recovery behavior have focused compatibility tests and a documented window.
- [ ] OpenCode status no longer shells out to Python on the live projection path and never infers Clanker identity from process resemblance.
- [ ] Failed install preflight or activation leaves the previous version and daemon usable.
- [ ] TypeScript, Python, Rust, integration, and relevant isolated QA suites pass.

## Rollout

1. Back up existing state databases and record the active application target.
2. Stage the new version without writing any legacy database.
3. Run preflight and fixture migrations against copies.
4. Ask the old daemon to quiesce; atomically activate the staged version.
5. Start and health-check the new daemon, including epoch ownership and registry validation.
6. On failure, atomically restore the prior target and restart/probe the prior daemon.
7. On success, retain legacy databases and the prior version for the compatibility window.
8. Native action-parity and latency were accepted; contract the obsolete Bun renderer while retaining the daemon and old installed versions for rollback.
9. Contract remaining legacy protocol fields and stores in a later release with an explicit rollback cutoff.

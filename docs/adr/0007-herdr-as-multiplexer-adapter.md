# ADR-0007: Add herdr as a Multiplexer Adapter Behind a Capability-Split Interface

## Status

Accepted. Partly superseded by ADR-0008: the tmux Adapter has since been retired and Herdr is the only Adapter. The Interface and Capability split below remain in force; the runtime selection rules and the tmux column of the Capability table are historical.

## Context

ADR-0001 made the Multiplexer a replaceable runtime and ADR-0005 states that Clankerhouse is "inspired by a better herdr". herdr (0.8.x) is now a mature agent runtime: a background server that owns PTYs, exposes a newline-delimited JSON socket API, publishes a live event stream, identifies the foreground process and its cwd per pane, derives agent status from per-agent screen manifests or pushed lifecycle reports, persists workspace/tab/pane identity and labels across server restarts, groups git worktrees under their repository, and offers modal popups and custom key bindings.

Clankerhouse's tmux coupling is wider than ADR-0001 intended. `TmuxMultiplexer` is injected with an argv runner rather than implementing a semantic interface; roughly thirty call sites in `src/workflow.ts`, `src/clanker-api.ts`, `src/recovery/controller.ts`, the daemon mutation stages, both harness lifecycle plugins, and the shell scripts shell out to tmux directly. tmux serves four roles at once: topology source, per-object key/value store for identity claims, process host and navigator, and UI chrome. `tmux_session`/`tmux_window` target kinds are persisted in SQLite, the socket protocol, and the native client, and `desired_clankers` stores tmux session and window names.

Evaluated against herdr's actual surfaces, everything Recovery and Herd Reconciliation need from tmux is available: stable public ids that survive server restart, `cwd`/`env` on pane creation, `HERDR_PANE_ID` in the pane environment for reporter self-correlation, `pane.process_info`, `pane.close`, `workspace.focus`/`pane.focus`, `events.subscribe`, and a key-bound modal popup. herdr does not provide boot autostart, host-pressure handling, cgroup ownership, recovery admission, or per-client focus, and its own agent resume on restore would compete with Clankerhouse Recovery.

Absorbing herdr's capabilities must not turn herdr's vocabulary into Clankerhouse's architecture, or a third runtime becomes as expensive as this second one.

## Decision

Clankerhouse adds herdr as a second Multiplexer Adapter. To make that possible and keep the next Adapter cheap, the Multiplexer Interface is split into a required core and declared optional Runtime Capabilities.

### Required core

Every Adapter implements, in Clankerhouse domain operations and without exposing native command syntax:

- `instance()` — the Multiplexer instance identity that scopes Multiplexer Locations; with `durableIds` it survives a runtime restart. A separate optional server epoch changes on every restart and drives Recovery's `multiplexer_restart` trigger; under herdr it is the identity of the freshly bound API socket file, since herdr reports no server pid or start time.
- `observe()` — the current topology as opaque native session, window, and pane ids with cwd, foreground command, title, active flags, and the Adapter's identity-claim metadata.
- `changes()` — a Change Stream of topology and focus events. An Adapter may synthesize it by polling; consumers never poll the runtime themselves.
- `spawn({ scope, cwd, env, launch })` — create a session, window, or pane at a cwd with injected environment, returning native ids. `launch` is either an interactive shell or an argv; the Adapter reports which it supports.
- `kill(location)`, `rename(location, displayName)`, `focus(location, client?)`.
- `claim(location, key, value | null)` — write or clear identity-claim metadata on a native object, readable from `observe()` and settable by a child process that knows only its own pane address from the environment.
- `paneAddressEnv()` — the environment variable name a child process reads to learn its pane address (`TMUX_PANE`, `HERDR_PANE_ID`).

### Optional Runtime Capabilities

An Adapter declares which of these it provides. Projection, Recovery, and clients gate on the declaration exactly as they gate on `availableActions` today.

| Capability | Provides | tmux | herdr |
|---|---|---|---|
| `processInfo` | foreground process group, pids, argv, cwd per pane | no (Clankerhouse `/proc` fallback) | yes |
| `agentStatus` | runtime-derived harness status with source and confidence | no | yes |
| `agentPrompt` | semantic prompt submission to an exact runtime-recognized interactive harness pane | no | yes |
| `sessionRefs` | harness session identity observed by the runtime | no | yes |
| `persistentLabels` | display names survive runtime restart | no | yes |
| `durableIds` | native ids survive runtime restart | no | yes |
| `popup` | key-bound modal popup with current-location environment | yes (`display-popup`) | yes |
| `worktrees` | runtime-managed worktree checkouts grouped by repository | no | yes |
| `clientRouting` | focus a specific attached client | yes | no |

A Capability that is absent falls back to a runtime-agnostic Clankerhouse implementation only where one is cheap and already exists (`processInfo` via `/proc`). Runtime-specific heuristics (tmux title spinner detection for Claude and Codex) are deleted rather than kept as fallbacks. Absent `clientRouting` means focus is server-global; that is accepted.

### Runtime and instance selection

An explicit non-empty `CLANKERHOUSE_MULTIPLEXER` is authoritative. Otherwise, the paired markers `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID` identify a managed Herdr pane and select the Herdr Adapter; every other unset environment retains the legacy tmux default. `CLANKERHOUSE_INSTANCE` overrides only the instance path suffix. The resolved kind is propagated to child processes, and Adapter selection and runtime/state path selection must consume the same resolver. Commands whose contract is intrinsically tmux-only fail closed under inferred Herdr rather than addressing an inherited outer tmux server.

### Authority

- The Clankerhouse registry remains authoritative for Workshop, Terminal, and Clanker identity, Display Names, lineage, and recoverable intent (ADR-0004). Runtime metadata carries claims; with `durableIds` the registry maps Clankerhouse ids to native ids directly and claims exist only for child-process self-correlation.
- Runtime `agentStatus` and `sessionRefs` are Observations with `source: runtime` and `confidence: observed`. Harness reporters (Pi extension, Claude hooks, OpenCode plugin) remain the attested source and continue to carry generations, results, attestation, and the Pi send channel. Attested state is mirrored back to a runtime that accepts pushed status so the runtime's own UI agrees.
- Clankerhouse Recovery remains the only recovery authority. A runtime's own agent resume on restore is disabled by the installer.
- Clanker communication uses verified semantic transports. Pi's harness-native socket remains preferred. An Adapter may expose `agentPrompt` only when its operation targets an exact pane, validates that a recognized interactive harness still owns that pane, and rejects blocked input. Clankerhouse revalidates the pane's Clanker ID claim immediately before submission. Raw pane input, output capture, and tmux key or paste simulation are not Clanker transports.

### Naming

herdr terms (`workspace`, `tab`, `tokens`, `w1:p3`, `agent.wait`) appear only inside the herdr Adapter module. `Target.type` becomes `session | window | pane`; the runtime kind lives on the Multiplexer Location. Recovery stores preferred session and window labels, not tmux names. Daemon mutation stage names lose the `tmux.` prefix.

### Sequencing

The Interface is extracted and every out-of-Adapter tmux invocation is routed through it while tmux is still the only Adapter, validated against the existing QA suites. The herdr Adapter is added afterwards.

## Consequences

- A third runtime needs the required core plus whichever Capabilities it has; Clankerhouse degrades explicitly instead of failing.
- Under herdr, Absorption reduces to registering a workspace whose identity cwd is a Workshop path; continuous reconciliation becomes event-driven; the tmux server-epoch, `wait-for` lock, popup unbind/rebind wrapper, and `/proc` environ scan for an open TUI disappear.
- Under herdr, the Alt-K TUI runs as a `[[keys.command]]` popup receiving `HERDR_ACTIVE_*` and focuses targets through the socket.
- Clankerhouse must handle a runtime whose Change Stream is live-only: reconnect means snapshot, resubscribe, and republish non-persistent claims.
- The installer pins a herdr version, and the Adapter gates on a minimum `ping.protocol` rather than an exact match: herdr keeps its JSON API compatible across protocol bumps, JSON clients ignore unknown fields, and an unsupported method is an ordinary request error.
- Activity recency, which orders the TUI, is derived from Change Stream events under herdr because the API carries no activity timestamps.
- Boot autostart, systemd scopes, resource guard, spot watch, incidents, lineage, and Recovery policy remain Clankerhouse's and are unchanged by the Adapter.
- herdr's `--remote` attach, live binary handoff, and macOS process identification become available without Clankerhouse work.

## Implementation status

Complete. The Interface lives in `src/multiplexer/interface.ts`, the registry-backed managed layer in `src/multiplexer/managed.ts`, and the Herdr Adapter in `src/multiplexer/herdr.ts`. The remaining contraction (target kinds, stage names, recovery columns, popup helpers) was carried out when ADR-0008 retired the tmux Adapter.

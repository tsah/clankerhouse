# herdr Adapter Migration

Companion to ADR-0007. Phases 0–3 are runtime-neutral and ship with tmux as the only Adapter; herdr code starts in Phase 4. Each phase is independently releasable and validated by the existing QA suites before the next begins.

## Goal

Extract the semantic Multiplexer Interface that ADR-0001 promised, route every runtime interaction through it, then add a herdr Adapter that lets Clankerhouse delete polling, `/proc` discovery, title heuristics, tmux chrome, and the Absorption transaction while keeping Workshops, lineage, Recovery, host safety, and verified semantic Clanker communication intact.

## Safety invariants

Those of `docs/architecture-simplification-migration.md` continue to apply. In addition:

- No phase changes what a Clanker is, how identity is validated, or which actions are destructive.
- Persisted `Target.type` and `desired_clankers` columns migrate with expand/migrate/contract; old readers stay valid for one release.
- A runtime's own resume-on-restore is never enabled while Clankerhouse Recovery is active on the same host.
- Clanker communication never falls back to raw pane input, output capture, or simulated tmux keys/paste. A declared semantic prompt Capability is allowed only when the runtime validates the exact recognized interactive harness pane and Clankerhouse revalidates its identity claim before submission.

## Inventory of runtime coupling to remove

Out-of-Adapter tmux invocations that Phase 1 routes through the Interface (line numbers as of the current working tree):

- `src/workflow.ts` — list-sessions, display-message, set-option ×6, has-session, new-session, list-windows, new-window, kill-session.
- `src/clanker-api.ts` — wait-for lock, show/set-option `@clankerhouse_clanker_id`, list-panes.
- `src/recovery/controller.ts` — list-panes, list-sessions, new-session + set-option, list-windows, new-window + set-option ×5, server-epoch show/set.
- `src/daemon.ts` — list-panes, list-sessions, set-option parent, rename-session, kill-session, kill-pane ×2.
- `src/cli.ts` — kill-pane in `pause-all` and `recovery stop|suspend|tombstone`.
- `integrations/pi/tmux-clanker-lifecycle.ts`, `integrations/opencode/clankerhouse-lifecycle.ts`, `bin/clankerhouse-clanker-state-report`, `bin/clankerhouse-harness-lifecycle`, `bin/clankerhouse-opencode2` — pane-option claims keyed by `TMUX_PANE`.
- `bin/clankerhouse-tmux-stop`, `bin/clankerhouse-delete`, `bin/clankerhouse-stop-popup`, `bin/clankerhouse-stop-current-session`, `libexec/worktree-delete`, `libexec/opencode-attach-target`, `libexec/opencode-status` — topology reads, kills, switch-client.
- `clankerhouse.tmux`, `bin/clankerhouse-popup`, `bin/clankerhouse-picker`, `bin/clankerhouse-tui-active`, `native-client/src/main.rs` — chrome, popup, current-location discovery.
- `resource_guard.py` — candidate discovery via list-panes.

## Phases

### Phase 0 — Vocabulary and schema expansion

- Add **Runtime Capability**, **Change Stream**, and **Pane Address** to `CONTEXT.md`; reword Multiplexer Location so `kind` is any registered Adapter kind.
- Add `Target.type ∈ session | window | pane` alongside the existing `tmux_session | tmux_window` in `src/model.ts`, `src/transport/protocol.ts`, and `native-client/src/main.rs`; the daemon emits both for one release, clients accept both.
- Expand `desired_clankers` with `preferred_session_label` and `preferred_window_label` (`src/recovery/model.ts`, `src/recovery/store.ts`, `src/registry.ts`), copied from `tmux_session_name`/`tmux_window_name` on write.
- Add neutral daemon stage names next to `tmux.renamed`, `tmux-parent.updated`, `tmux.marked`, `tmux.deleted`, `tmux.ready` in `src/daemon-mutations.ts`; the operations journal accepts both.
- Acceptance: all unit suites pass; `scripts/qa-daemon` and `scripts/qa-recovery` pass unchanged.

### Phase 1 — Extract the Interface, tmux-only

- Define `Multiplexer` in `src/multiplexer/interface.ts` with the required core from ADR-0007 (`instance`, `observe`, `changes`, `spawn`, `kill`, `rename`, `focus`, `claim`, `paneAddressEnv`) and a `capabilities()` declaration. Keep `MultiplexerCommand` as the tmux Adapter's private injection seam, not the Interface.
- Move `TmuxMultiplexer` to `src/multiplexer/tmux.ts`; implement `changes()` by polling `observe()` and diffing, at the current 15 s cadence; implement `claim()` over `set-option -p/-w/-t`; declare `popup` and `clientRouting`.
- Route every `src/*.ts` call site in the inventory through the Interface. Registry code already keys locations by free-string `kind`; no schema change.
- Replace the `wait-for` lock in `src/clanker-api.ts` with `flock` on a runtime-dir file so the Interface needs no lock primitive.
- Give shell and Python callers a single `clankerhouse mux <op>` CLI entry (`src/cli.ts`) backed by the Interface, and rewrite `bin/clankerhouse-tmux-stop`, `bin/clankerhouse-delete`, `libexec/worktree-delete`, `libexec/opencode-attach-target`, `libexec/opencode-status`, and `resource_guard.py` candidate discovery to use it.
- Lifecycle reporters read the pane address from the variable the daemon publishes (`paneAddressEnv`, exposed through `libexec/clankerhouse-env`) rather than a hard-coded `TMUX_PANE`, and write claims through `clankerhouse mux claim`.
- Acceptance: no `tmux` invocation outside `src/multiplexer/tmux.ts` and `clankerhouse.tmux` except QA scripts; full `scripts/qa*` suite passes; `docs/features.json` scenarios unchanged.

### Phase 2 — Capability gating in projection and recovery

- Projection (`src/server/project.ts`) consumes `processInfo`, `agentStatus`, and `sessionRefs` from the Adapter when declared, else from `src/server/process-discovery.ts`; delete the Claude/Codex title heuristics at `project.ts:82-98`.
- Runtime `agentStatus` enters `src/server/observations.ts` as `source: runtime`, `confidence: observed`; attested reports still win, rejected reports still render.
- Activity (`src/activity.ts`) accepts Change Stream focus/update events as recency inputs in addition to native timestamps.
- Recovery (`src/recovery/controller.ts`) uses `spawn` with `launch: shell` followed by the wrapped harness launch, and reads `instance()` instead of minting `@clankerhouse_server_epoch`.
- Acceptance: `scripts/qa-recovery`, `scripts/qa-absorption`, `scripts/qa-clanker-api` pass on tmux with capabilities all `false`.

### Phase 3 — Chrome behind the Adapter

- `src/multiplexer/interface.ts` gains `popup.open({ command, size, env })` and `popup.currentLocationEnv()`; tmux implements with `display-popup` and `CLANKERHOUSE_CURRENT_SESSION`/`CLANKERHOUSE_TMUX_CLIENT`.
- The native client reads the current location from a neutral `CLANKERHOUSE_CURRENT_LOCATION` JSON variable that each Adapter populates; drop its `display-message` fallback.
- Acceptance: `scripts/qa-current-session`, `scripts/qa-client-routing`, `scripts/qa-stop-popup`, `scripts/qa-install` pass.

### Phase 4 — herdr Adapter

- `src/multiplexer/herdr.ts`: NDJSON client for `~/.config/herdr/herdr.sock` (resolution order `HERDR_SOCKET_PATH`, `HERDR_SESSION`, default), one request per connection, `ping` protocol gate pinned to the installer's herdr version.
- Mapping: workspace → session, tab → window, pane → pane; `observe()` from `session.snapshot` + `pane.process_info`; `changes()` from `events.subscribe` with snapshot-then-subscribe bootstrap and full resync on disconnect; `spawn` via `workspace.create`/`tab.create`/`pane.split` with `cwd` and `env`, `launch: argv` via `layout.apply` only when a caller opts in; `claim` via `pane.report_metadata` tokens (republished on reconnect); `focus` via `workspace.focus`/`pane.focus`; `rename` via `workspace.rename`/`pane.rename`; `paneAddressEnv` = `HERDR_PANE_ID`.
- Capabilities declared: `processInfo`, `agentStatus`, `agentPrompt`, `sessionRefs`, `persistentLabels`, `durableIds`, `popup`, `worktrees`; not `clientRouting`. `agentPrompt` maps to `agent.prompt` for an exact pane; Claude send revalidates the Clanker claim first and requests no runtime wait, leaving generation correlation to attested lifecycle reports.
- Attested state mirror: on each accepted lifecycle report, `pane.report_agent` with source `clankerhouse:<harness>` and the same `seq`; `pane.release_agent` on `unknown`.
- Handle `pane.moved` re-keying and `pane.exited` (no exit code) as location Observations.
- Acceptance: a `scripts/qa-herdr` suite mirroring `qa-absorption`, `qa-clanker-api`, `qa-recovery`, `qa-current-session` against an isolated `HERDR_SOCKET_PATH` server with `--no-session` disabled and a private config dir.

### Phase 5 — Installation and chrome for herdr

- Installer writes `[[keys.command]]` entries for Alt-K (popup, 90%×80%, `clankerhouse-native`), Alt-B (popup spawn from `HERDR_ACTIVE_PANE_CWD`), Alt-D, Alt-X into the herdr config; sets `[session] resume_agents_on_restore = false`; installs a `herdr server` user unit ordered before `clankerhouse-recovery.service`.
- Confirmation dialog for delete is drawn inside the TUI rather than as a nested popup.
- Harness wrappers add `HERDR_AGENT=<kind>` so detection through `systemd-run` and `clankerhouse-harness-lifecycle` resolves promptly.
- Acceptance: `scripts/qa-install` gains a herdr variant; `bin/clankerhouse-doctor` reports the active Adapter and its capabilities.

### Phase 6 — Contract

- Remove `tmux_session`/`tmux_window` target kinds, `tmux_*` recovery columns, and `tmux.` stage names after one release with dual emission.
- Delete `src/server/process-discovery.ts` only if no supported Adapter lacks `processInfo`; otherwise keep it as the declared fallback.
- Retire `bin/clankerhouse-tui-active` and the popup unbind/rebind wrapper for the herdr Adapter.

## Decisions deferred to implementation

- Whether Workshop creation moves from Worktrunk (`wt`) to herdr `worktree.create`. Default: keep `wt`; bind herdr workspaces to its paths.
- Whether herdr's own Pi/OpenCode integrations stay installed alongside Clankerhouse reporters. Default: yes, for sidebar fidelity; Clankerhouse reporters remain the attested source.
- Whether agents receive herdr's broad control skill. Default: no. This is independent of the narrow Adapter `agentPrompt` Capability: that Capability exposes only validated prompt submission to an already-identified Clanker and does not grant general pane, topology, or coordination control.

## Acceptance criteria for the whole migration

- Every feature in `docs/features.json` has scenarios passing on both Adapters, except `clientRouting`-dependent scenarios which are marked Adapter-gated.
- No file outside `src/multiplexer/` names tmux or herdr operations.
- Recovery, resource guard, spot watch, and incidents behave identically on both Adapters; `clankers send|wait|result` exposes explicit transport capabilities and fails closed when an Adapter or harness lacks one.
- A stub third Adapter implementing only the required core with no Capabilities passes projection and recovery unit suites.

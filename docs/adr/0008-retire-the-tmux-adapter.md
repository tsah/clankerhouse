# ADR-0008: Retire the tmux Adapter

## Status

Accepted. Amends ADR-0001 and supersedes the tmux parts of ADR-0007.

## Context

ADR-0007 added Herdr as a second Multiplexer Adapter behind a capability-split Interface while tmux remained the default. The Herdr Adapter has since reached parity for everything Clankerhouse uses: observation, spawn, claims, focus, kill, rename, popups bound to Alt-K/Alt-B/Alt-D, lifecycle reporting keyed by `HERDR_PANE_ID`, and semantic prompt submission. It also provides durable ids, persistent labels, process info, and runtime agent status that tmux never did.

Keeping both Adapters doubled the standalone QA matrix and kept tmux-shaped coupling alive outside the Adapter: `tmux_session`/`tmux_window` target kinds on the wire and in the native client, `tmux.*` durable mutation stage names, `tmux_session_name`/`tmux_window_name` recovery columns, a tmux server epoch, runtime selection through `CLANKERHOUSE_MULTIPLEXER`, a TPM plugin, a popup unbind/rebind wrapper, a `/proc` environ scan for an open TUI, and a set of tmux-only shell helpers for delete, stop, and popups.

## Decision

Herdr is the only Multiplexer Adapter. The tmux Adapter and every tmux-only entry point are deleted.

- The Multiplexer Interface and its Runtime Capabilities stay (ADR-0001, ADR-0007), so another Adapter remains possible without changing Workshop, Terminal, or Clanker identity.
- `CLANKERHOUSE_MULTIPLEXER` and managed-pane inference are removed; the Adapter is always Herdr. Instance paths default to the `-herdr` suffix (`$XDG_RUNTIME_DIR/clankerhouse-$UID-herdr`, `~/.local/state/clankerhouse-herdr`); `CLANKERHOUSE_INSTANCE` still overrides the suffix.
- Target types are `session` and `window`. Durable mutation stages are named `multiplexer.*`. Recovery stores preferred session and window labels.
- Herdr does not route focus per client, so focus is server-global.
- The TPM plugin (`clankerhouse.tmux`) and the tmux popup, delete, stop-popup, stop-current-session, TUI-active, and picker launchers are deleted. `clankerhouse-tmux-stop` becomes `clankerhouse-mux-stop`. The Pi lifecycle extension is renamed `clanker-lifecycle.ts`. The installer's daemon handoff selects `--herdr-socket` instead of `--tmux-socket`.
- Standalone QA suites that only exercised tmux chrome (stop popup, client routing, the tmux popup half of current-session, the tmux Absorption transaction) are deleted. Runtime-neutral suites run against an isolated Herdr server.

## Consequences

- One Adapter, one QA matrix, and no tmux vocabulary outside historical ADRs.
- Persisted compatibility is migrated, not kept: registry and recovery stores rename `tmux_session_name`/`tmux_window_name` to `preferred_session_label`/`preferred_window_label`; in-flight operations recorded with `tmux.*` stage names are read under their `multiplexer.*` names; the `tmux_session`/`tmux_window` target kinds are no longer emitted or accepted, and the native client ignores an older `state.json` fallback.
- State of a legacy tmux instance is not migrated automatically. Its unsuffixed runtime directory, `~/.local/state/clankerhouse` registry, and recovery database are left untouched and are not read by the Herdr instance. Workshops and worktrees on disk are unaffected; tmux-era Clankers must be restarted inside Herdr to be tracked again.
- There is no Alt-X stop-current-session binding; stopping uses the picker or `clankers recovery stop`.
- Users without Herdr can no longer run Clankerhouse.

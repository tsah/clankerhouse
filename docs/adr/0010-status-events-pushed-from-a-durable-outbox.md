# ADR-0010: Status Events Pushed from a Durable Outbox

## Status

Accepted on Tsah's approval of the `status-hooks` branch.

## Context

An outside assistant learns clanker status by polling over ssh every 30 minutes, so it reacts late and spends tokens finding that nothing changed. `clankers watch` already derives events, but it needs a process kept alive per scope, is scoped to a Workshop's children, and writes to stdout. The assistant can be woken by an HTTPS POST instead.

ADR-0004 keeps Observations and Declarations apart, the lifecycle hook must stay native and instant, and the daemon is the one long-lived process (ADR-0002).

## Decision

The daemon derives Status Events and pushes them to configured Sinks.

- Detection runs after each projection refresh, from the herd that refresh observed, as a pure function of one view and a durable cursor (`status-events.ts`), in the style of `clankers watch`. It costs the Multiplexer nothing extra and adds nothing to the lifecycle hook.
- The cursor and the events it produced commit in one SQLite transaction in `status-events.sqlite3` (`status-outbox.ts`), so a restart neither repeats nor loses a transition. Each Sink has its own delivery row: at least once, retried with doubling backoff, with a dedupe key per transition.
- `done` and `idle` are one phase, because their difference is whether the operator looked. A settled turn is news if the phase changed or the settled generation grew, so a turn too short to be observed working still counts.
- A new phase must hold for the debounce before it is published, and a clanker must stay missing for a grace period. Both are stored in the cursor, and a held transition arms a timer that asks for a fresh observation, so the 15-second refresh does not set the latency.
- Sinks live in `~/.config/clankerhouse/hooks.toml`, per instance, which must be mode 600. Secrets never appear in logs, errors, or `clankers hooks status`, which is why failures record only a status code or an error name.
- A Sink is a webhook or a command. Webhooks must be https except on loopback and never follow redirects.
- A crash is inferred: a clanker that vanished mid-turn with no deliberate ledger close. The harness wrapper's exit mark carries no status, and changing its format would break panes running the old wrapper.
- Markers are named paths, with `temp/aws/login-pending` as the only default, so Clankerhouse learns nothing about AWS. A Marker is checked only in worktrees of live clankers, and only its existence.

## Alternatives rejected

- Emitting from `clankerhouse-hook`: it runs inside every tool call and could not do network I/O, debounce, or see exits.
- A separate process running `clankers watch` and curl: it would need its own supervision and spool, and watch has no whole-herd scope, no stuck messages, and no Markers.
- A `Workshop Hook` per event: those run in a Workshop and belong to a repository, while this is per host and holds secrets.
- Exactly-once delivery: not achievable against a plain webhook. The dedupe key puts the last step with the receiver.

## Consequences

- With no config the daemon does one file check per refresh and creates nothing.
- The daemon gains outbound network calls and a config format, and the operator owns the secret file.
- `summary` sends an excerpt of the clanker's last words off the host.
- A clanker that lasts less than the grace period, or a state that lasts less than the debounce, is never announced.
- Everything true when hooks are enabled is baseline, including a message already stuck. Disabling forgets the position, so transitions while disabled are lost on purpose.
- A `clanker.crashed` can be a pane killed by hand, and a Marker in a worktree with no live clanker goes unnoticed.
- Codex clankers publish only Reports, since they have no lifecycle reports.

# Clankerhouse Domain Context

## Workshop

A durable Clankerhouse-owned environment bound to a canonical worktree or directory. A Workshop has a stable Clankerhouse ID and owns Terminals and Clankers. Its identity does not depend on tmux names or tmux IDs.

## Terminal

A durable Clankerhouse-owned terminal surface belonging to a Workshop. A Terminal has a stable Clankerhouse ID, a mutable Display Name, and an optional current Multiplexer Location. A multiplexer window may contain multiple Terminal panes.

## Clanker

An externally running harness session correlated to a Workshop and Terminal. Clankerhouse assigns a stable internal ID so it can track the Clanker across changing process and Multiplexer Locations, but the harness remains authoritative about whether it exists and its current lifecycle state. Launching through Clankerhouse is a convenience, not a prerequisite for becoming visible or managed.

## Display Name

Mutable Clankerhouse-owned presentation metadata. Native tmux names may seed Display Names during Absorption and may mirror them afterward, but names never establish identity, ownership, correlation, parentage, deduplication, or recovery.

## Multiplexer

A replaceable runtime that hosts terminal session, window, and pane topology. Clankerhouse owns semantic identity, Display Names, Workshop ownership, and recovery intent; the Multiplexer owns live terminal processes, layout, attachment, and focus.

The Multiplexer interface is expressed in Clankerhouse operations and capabilities rather than as a generic command passthrough. The tmux adapter is the only current adapter. Supporting another Multiplexer does not require Clankerhouse to own terminal multiplexing itself.

## Multiplexer Location

The current ephemeral location of a managed entity, expressed as a Multiplexer kind, Multiplexer instance identity, and opaque native session, window, and pane IDs. Multiplexer Locations can change or disappear without changing Workshop, Terminal, or Clanker identity.

A Tmux Location is a Multiplexer Location whose instance identity includes the tmux server identity or epoch and whose native IDs are tmux session, window, and pane IDs.

## Managed Resource

A Workshop, Terminal, or Clanker carrying explicit Clankerhouse identity. Managed resources are matched only through stable Clankerhouse IDs and validated Multiplexer Locations or process identities.

The Clankerhouse resource registry is authoritative about internal correlation, names, and intent, never present-tense external state. Multiplexer metadata carries identity claims used for observation and reconciliation; a claim is managed only when it validates against the registry and current external evidence.

## Unmanaged Resource

A visible tmux session, window, pane, or process without explicit Clankerhouse identity. Clankerhouse may display native labels for unmanaged resources but does not infer semantic identity from names, titles, commands, paths, or timing.

## Absorption

The explicit transaction performed when a user enters an unmanaged target through Clankerhouse. Absorption registers a Workshop for the canonical worktree or directory, maps the current multiplexer session's terminal topology, seeds Display Names from native labels, records current Multiplexer Locations, and then switches to the target. It also establishes the session as a scope for continuous Herd Reconciliation.

Switching outside Clankerhouse does not trigger Absorption. After Absorption, new and removed windows, panes, and supported harness processes are continuously reconciled into or out of the Workshop's internal representation regardless of whether Clankerhouse launched them.

The active pane determines the Workshop that owns an absorbed tmux session. Different working directories in sibling panes do not imply different ownership.

## Recovery

Recovery reconciles recoverable intent with current external Observations. A supported harness manually or programmatically started in an absorbed Workshop becomes recoverable while it is observed active. A graceful harness exit or manual removal while the host and Multiplexer remain healthy cancels that obligation; disappearance during process, Multiplexer, or host failure may recreate its Terminal and resume its harness session. Ordinary shell Terminals do not create a recovery obligation and are not recreated merely because they once had stable identity.

## Herd Reconciliation

The continuous process that consumes Multiplexer topology, foreground process, harness lifecycle, host, and recovery Observations for absorbed Workshops. It maintains stable internal correlation, current presentation, and recoverable intent without replacing the external facts. Starting through Clankerhouse and starting directly in tmux enter the same reconciliation path.

## Declaration

An internal record intentionally maintained by Clankerhouse: stable correlation identity, Display Names, Workshop lineage, recoverable intent, user acknowledgement, and durable mutation intent. A Declaration is authoritative only for Clankerhouse behavior; it never overrides current external state.

## Label

A `key=value` Declaration attached to a Workshop, such as `stage=retro`. A key holds one value, so setting it replaces the previous one. Clankerhouse stores, projects, and announces Labels; a repository gives them meaning through its Workshop Hooks. Labels never affect ordering, identity, or Recovery. Clankerhouse itself understands exactly one Label, Done.

## Done

The built-in Label `status=done`: the operator's statement that active work in a Workshop is finished. It changes nothing external; clankers, sessions, and the worktree stay as they are. The delete key sets it on a worktree Workshop, and pressing the key again on a Done Workshop offers destruction or reopening.

## Reaper

The daemon process that deletes a Done Workshop once it has been left alone for the retention period (seven days by default). Any observed use of the Workshop restarts the period. The Reaper removes only linked worktrees with no uncommitted changes and no clanker that is working, waiting, or finished-but-unseen, and it deletes through the ordinary delete mutation, which keeps the branch.

## Workshop Hook

A tracked executable the target repository supplies at `.clankerhouse/hooks/<event>` and Clankerhouse runs inside the Workshop. `labels-changed` runs detached after a Label actually changes and cannot fail that change. `done` replaces the built-in delete-key rule for that repository: exit `0` means the repository handled the key, exit `1` leaves Clankerhouse's destroy confirmation, and any other exit is reported as a failure. Repository-specific workflow lives in these scripts, never in Clankerhouse.

## Observation

A timestamped fact reported by an external runtime Adapter, such as tmux topology, process presence, lifecycle state, Git state, or host pressure. Clankerhouse preserves and correlates Observations but does not own the external reality they describe. Failure to validate an Observation reduces its confidence or prevents it from establishing managed identity; it does not erase the observed fact. Current Multiplexer Locations are Observations rather than durable present-tense truth.

Harness state can remain an Observation without becoming a Clanker. A lifecycle report with no Clanker claim may describe a pane's current harness state only while a matching harness process is observed on that pane. It provides presentation state, not owned identity, Clanker actions, or Recovery authority.

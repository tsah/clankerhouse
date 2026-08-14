# Clankerhouse Domain Context

## Workshop

A durable Clankerhouse-owned environment bound to a canonical worktree or directory. A Workshop has a stable Clankerhouse ID and owns Terminals and Clankers. Its identity does not depend on tmux names or tmux IDs.

## Terminal

A durable Clankerhouse-owned terminal surface belonging to a Workshop. A Terminal has a stable Clankerhouse ID, a mutable Display Name, and an optional current Multiplexer Location. A multiplexer window may contain multiple Terminal panes.

## Clanker

A durable Clankerhouse-owned agent belonging to a Workshop and running in a Terminal. A Clanker has a stable Clankerhouse ID. A process that merely resembles an agent is not a Clanker until it explicitly registers or is launched by Clankerhouse.

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

The Clankerhouse resource registry is authoritative. Multiplexer metadata carries identity claims used for observation and reconciliation; a claim is managed only when it validates against the registry.

## Unmanaged Resource

A visible tmux session, window, pane, or process without explicit Clankerhouse identity. Clankerhouse may display native labels for unmanaged resources but does not infer semantic identity from names, titles, commands, paths, or timing.

## Absorption

The explicit transaction performed when a user enters an unmanaged target through Clankerhouse. Absorption registers a Workshop for the canonical worktree or directory, assigns Clankerhouse identities to the entire multiplexer session's terminal topology, seeds Display Names from native labels, records current Multiplexer Locations, and then switches to the target.

Switching outside Clankerhouse does not trigger Absorption. Processes in absorbed terminals remain unmanaged unless they explicitly register as Clankers.

The active pane determines the Workshop that owns an absorbed tmux session. Different working directories in sibling panes do not imply different ownership.

## Recovery

Recovery reconciles durable Clanker desired state with managed resources and their current Multiplexer Locations. A missing desired Clanker may cause its Terminal to be recreated. Ordinary shell Terminals do not create a recovery obligation and are not recreated merely because they once had stable identity.

# ADR-0012: A Thin Plugin on Rex

## Status

Accepted (2026-11-16). Supersedes ADR-0001 (multiplexer as a replaceable runtime), ADR-0002 (one daemon, interface and
registry), ADR-0007 (Herdr adapter), ADR-0008 (tmux retired) and ADR-0011 (hc under the Clanker API) where they describe
the runtime, the daemon or the registry. ADR-0003, 0004, 0006, 0009 and 0010 stand.

## Context

Clankerhouse grew to own what a multiplexer did not: a replaceable Multiplexer Interface with Herdr and hc adapters, a
resource registry mirroring sessions, windows and terminals, and a long-running daemon that observed, projected,
served snapshots over a socket, ran mutations and owned the background loops. Rex already owns live topology, durable
session/window/pane ids, each terminal's processes, agent status reported by the programs themselves (OSC 7501), focus,
hosts and an event stream. Keeping a second copy of any of that meant reconciling it.

## Decision

**Rex is the truth for what exists and runs now**: sessions, tabs, panes and their labels, processes, agent status,
focus and hosts. Nothing copies it into a store. A Workshop's session is the Rex session carrying its `workshopId`
claim; its windows and panes are identified by their Rex ids.

**SQLite is the truth for what Rex cannot express**: Workshop identity, lineage and labels (`workshops.sqlite3`),
clanker identity and resume data (`clankers.sqlite3`), orchestration (`orchestration.sqlite3`,
`status-events.sqlite3`) and mutation operations (`operations.sqlite3`). No store claims liveness: whether a clanker is
alive, and what it is doing, is always a lookup of its pane in Rex.

**Git and Worktrunk are the truth for worktrees and branches.**

What remains of Clankerhouse:

- A Rex config module (`contrib/rex/clankerhouse.lua`): the keys and the picker popup.
- The picker (`native-client`), which reads `clankers snapshot --watch` and runs `clankers mutate`.
- The `clankers` CLI. Snapshots are computed on demand from one Rex observation and the stores (`src/snapshot.ts`);
  mutations run in-process as staged, journaled operations (`src/mutations.ts`).
- One background process, `clankers runner` (`src/runner.ts`), for timed work only: queued delivery, Routines, Status
  Event sinks, the done-Workshop reaper, directory rediscovery, the clanker ledger, and the snapshot cache the picker
  paints from. It serves nothing.
- The lifecycle hook, which records turns and generations for orchestration.

Rex objects carry one label and no key/value data, so claims live in a file store beside the instance's state
(`rex-claims/<rex id>/<key>`), shared with the hook.

## Consequences

- The Multiplexer Interface, the Herdr and hc adapters, lanes, lane moves, absorption, the resource and unified
  registries, the daemon, its socket transport, producer lease and herd are removed.
- A snapshot costs about 0.6 s with the runner's caches; the picker paints at once from the runner's last one.
- Mutations from several processes run concurrently, as they did in the daemon; an operation is resumed only when the
  process that ran it has died.
- Rex restores sessions and layout after a restart but not their programs; the ledger lets `clankers resume` bring
  each clanker back into its conversation.
- If Rex gains key/value metadata on its objects, the claim store moves into Rex; if it re-runs commands on restore,
  most of the resume path goes.

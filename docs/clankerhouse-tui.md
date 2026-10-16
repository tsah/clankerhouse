# Clankerhouse TUI

## Purpose

Clankerhouse is the interactive navigator for workshops, clankers, worktrees,
multiplexer windows, and configured directories. Herdr's `Alt-K` popup, shell
function `s`, and the `clankerhouse` command open the same TUI.

## Domain model

- A **workshop** is a durable Worktrunk worktree plus its canonical, lazily
  materialized Herdr workspace.
- A **clanker** is one visible harness session inside a workshop.
- A **harness** is the program hosting a clanker: Pi, Claude, OpenCode, or
  Codex. Harness-native in-process subagents are not clankers.
- A plain multiplexer window is detail within a workshop, but is not a clanker.
- A sessionless worktree and a configured directory remain navigation targets;
  they are not displayed as live workshops.

Workshop identity comes from the canonical worktree path and durable workshop
ID, never from the mutable workspace name. Clanker identity comes from its
opaque `CLANKER_ID`, never from a pane or tab name.

## Information model

Workshop rows include:

- display name and canonical path
- branch and Git status
- activity age/source
- durable workshop and parent-workshop IDs
- aggregate clanker state
- compact window and harness summaries

Clanker detail rows include:

- `kind: clanker`
- harness
- state and lifecycle status
- title/activity
- exact multiplexer target

Pi, Claude, OpenCode, and Codex are always represented as harness values rather
than entity kinds.

## Layout and ordering

The jump screen is a bottom-sorted recursive tree. Workshop lineage uses tree
connectors; explicitly expanded window and clanker details use subdued bullet
rows beneath their workshop. Collapsed workshops summarize their windows and
harnesses inline.

A subtree whose every Workshop carries the done label folds into one gray
`✓ N done` row under its parent, or above every root when the done Workshops are
roots. A done Workshop stays visible while anything beneath it is not done, while
it or a descendant has a working, blocked, or failed clanker, and while it is on
the current Workshop's lineage. An unseen finished clanker does not keep it open. Search shows done Workshops
without folding them.

Rows are ordered only by last-seen recency, oldest at the top and newest nearest
the prompt. A lineage subtree uses the newest last-seen value among all of its
descendants, and the current session remains pinned nearest the prompt. Runtime
state does not participate in ordering and changes only the glyph.

Search matches structured fields independently and retains the complete
workshop ancestor chain for matching descendants. It must not manufacture
matches by concatenating unrelated fields.

## Controls

- `Up/Down`: move through visible workshop and detail rows
- `Left/Right`: collapse or expand workshop lineage and exact details
- `Right`/`Enter` on a `✓ N done` row: show that group in place; `Left` folds it again
- `Alt-.`: show or fold every done Workshop
- `Enter`: open the exact workshop, clanker, window, worktree, or directory
- `Alt-K`: open the repository/branch flow when already inside Clankerhouse
- `Alt-B`: open directly at repository selection
- `Alt-R`: rename a multiplexer session without changing workshop identity
- `Alt-A`: attach a workshop to another valid parent
- `Alt-L`: detach a workshop from its parent
- `Alt-D`: explicitly confirm, then destroy the exact selected pane or session as safely projected; remain in Clankerhouse afterward
- `Esc`: clear the query or close the current flow

## Implementation

The implementation is split between a Bun/TypeScript/Effect daemon and the sole
Rust/ratatui renderer in `native-client/`. Collection adapters produce
multiplexer, Git, lifecycle, directory, and lineage observations; a deterministic
projection turns them into typed rows and explicit persistence effects. The daemon
atomically commits revisioned snapshots and publishes them over a
private Unix socket. The native client reads JSON only once as a startup/crash
fallback and uses the socket for live synchronization. Typed rows carry concrete
multiplexer/worktree actions; hierarchy is never inferred from rendered strings.
Clanker communication uses the native `clankers` API and never raw pane input
or pane capture. Linux foreground-process discovery reads process metadata only and
cannot assign clanker identity or authorize destructive actions.

A separate durable recovery control plane stores desired Pi, Claude, and
OpenCode clankers, exact harness session identities, attempts, leases, and
append-only journal events under `$XDG_STATE_HOME/clankerhouse-herdr`. Its persistent
controller creates an automatic campaign only after a Linux boot-ID change. It
admits one missing clanker after a quiet healthy boot, waits for stable liveness,
and then admits the next. Same-boot pane loss is not enrolled automatically.
Recovery continues settled work but never replays interrupted tools; expensive
validation and external effects require confirmation. Repeated or ambiguous
attempts enter durable quarantine. Tracked harnesses
are owned by systemd scopes so an intentional stop terminates every descendant.
Tombstones, intentional stops, quarantine, and resource-pressure suspensions take
precedence. Recovery state changes are typed daemon mutation intents with durable
stages; observation and operation status share the private socket Interface.

See `clankerhouse/README.md` for the CLI and runtime contract and
`docs/qa/clanker-api.md` for safety-scoped API validation.

## Native client

The Alt-K jump client is the Rust/ratatui application in `native-client/`, the
sole interactive renderer. It receives observations from the
authoritative Bun/TypeScript daemon; JSON is only a one-time startup/crash
fallback. Build and validate the native client with:

```sh
scripts/build-native
bin/clankerhouse-native --check
```

Inside Herdr, `bin/clankerhouse` ensures the daemon and opens the native client;
`clankerhouse-install-herdr` binds it to an Alt-K popup.

The native client supports jump search, navigation, lineage/detail expansion,
live snapshot reloads, exact target opening, repository/branch creation, rename,
Workshop attachment and detachment, and explicitly confirmed deletion. It gates
every action on the projected `availableActions`, carries stable resource and
Workshop IDs where the daemon protocol accepts them, and sends only typed daemon
mutation intents. The socket remains the live source through reconnects; the
atomic JSON snapshot is read at most once as a startup fallback.

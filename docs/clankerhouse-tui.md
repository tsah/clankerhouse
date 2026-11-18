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

A Workshop labelled `role=desk` is a **desk**: a standing Workshop that runs on a
Routine and keeps one long-lived report. Every desk folds under one teal
`◆ ▾ Desks · N` row (N desks), whatever its own parent was, and keeps its own
children beneath it. The group is not pinned: it is a lineage like any other and
sorts by its freshest desk's last-seen recency (the same newest-descendant rule as
every lineage), so it rises when a desk is active and sinks when the desks are
quiet. Only the current-session rule below can lift it, as it lifts any lineage
holding the current session. It opens unfolded; `Left` folds it and `Right` or
`Enter` shows it again, as on a `✓ N done` row; no Workshop action applies to it.
Desk rows are tree-indented beneath it with a teal `desk` tag (the reserved colour
of that tag, never a hashed label colour) followed by their other tags, such as the
coloured `stage` word. Search shows the group only above matching desks.

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
- `Alt-K`: open the repository/branch flow when already inside Clankerhouse (from a needs-me view, back to the flat list first)
- `Alt-I` / `Alt-E` / `Alt-F`: the list's views: Workshops that need you freshest first, the same eldest first, and everything flat
- `Alt-T`: the Desks view (a timetable of the desks): one row per desk, see below
- `Alt-S`: snooze the selected Workshop's need
- `Alt-B`: open directly at repository selection
- `Alt-R`: rename a multiplexer session without changing workshop identity
- `Alt-A`: attach a workshop to another valid parent
- `Alt-L`: detach a workshop from its parent
- `Alt-D`: explicitly confirm, then destroy the exact selected pane or session as safely projected; remain in Clankerhouse afterward
- `Esc`: clear the query or close the current flow

## Desks view

`Alt-T` switches the list to the Desks view, in the spirit of the needs-me view:
one row per desk rather than a tree. Each row shows the state glyph, the desk's
name, project and tags (teal `desk`, then its `stage` word), and on the right a
note of three parts:

- what it is doing or asks: its needs-me reason (`asked 1h ago`,
  `finished 3h ago, not seen`, `snoozed · …`), else `running now` while a clanker
  works, else nothing;
- its next Routine run, from the daemon's Routine store, in the Routine's own zone:
  `next Sat 20:00 lint-quality-desk-weekly`, with `(+N)` for more Routines, or
  `no routine`;
- its report: `report 2d ago` (when the `report` label was last set), or `no report`.

Desks that need you come first (nearest the prompt), the freshest reason first;
the rest follow by last-seen recency. The line above the prompt shows the selected
desk's report link (`report https://…`), else its path, and the prompt line sums
up `6 desks · 2 need you · 3 with routines`. `Enter` opens the desk (its clanker
that needs you, as in the needs-me view), `Alt-S` snoozes and `Alt-D` marks done
as elsewhere, typing filters, and `Alt-F` returns to the tree. `T` is free and
reads as the desks' timetable, the view's distinctive column; `Alt-D` itself is
taken by the destructive done/delete key.

**Report-link convention.** A desk publishes its latest report by setting the
`report` label to its URL, typically its long-lived Claude artifact:

```sh
clankers workshop label set report=https://claude.ai/artifact/…
```

`report` takes any `http(s)` URL up to 500 characters and, like `title`, is never
shown as a tag. The daemon reads labels and Routines once per snapshot
(`src/desks.ts`), so the picker never reads the filesystem or the network on a
redraw.

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
or pane capture. Harness detection comes from Herdr's per-pane agent detection and
cannot assign clanker identity or authorize destructive actions.

The clanker ledger, `clankers.sqlite3` under `$XDG_STATE_HOME/clankerhouse-herdr`,
records every Pi, Claude, and OpenCode clanker with its Workshop, launch spec,
original task, and current harness session. The daemon closes a row once its
clanker has been gone for a minute in the same Herdr server; rows last seen in an
earlier server stay open and are listed by `clankers ledger --interrupted`.
Nothing is relaunched automatically: `clankers resume` continues one exact session
without replaying a prompt. Tracked harnesses are owned by systemd scopes so an
intentional stop terminates every descendant.

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

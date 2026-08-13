# Clankerhouse TUI

## Purpose

Clankerhouse is the interactive navigator for workshops, clankers, worktrees,
tmux windows, and configured directories. `Alt-K`, shell function `s`, and the
`clankerhouse` command open the same TUI.

## Domain model

- A **workshop** is a durable Worktrunk worktree plus its canonical, lazily
  materialized tmux session.
- A **clanker** is one visible harness session inside a workshop.
- A **harness** is the program hosting a clanker: Pi, Claude, OpenCode, or
  Codex. Harness-native in-process subagents are not clankers.
- A plain tmux window is detail within a workshop, but is not a clanker.
- A sessionless worktree and a configured directory remain navigation targets;
  they are not displayed as live workshops.

Workshop identity comes from the canonical worktree path and durable workshop
ID, never from the mutable tmux session name. Clanker identity comes from its
opaque `CLANKER_ID`, never from a tmux pane or window name.

## Information model

Workshop rows include:

- tmux display name and canonical path
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
- exact tmux target

Pi, Claude, OpenCode, and Codex are always represented as harness values rather
than entity kinds.

## Layout and ordering

The jump screen is a bottom-sorted recursive tree. Workshop lineage uses tree
connectors; explicitly expanded window and clanker details use subdued bullet
rows beneath their workshop. Collapsed workshops summarize their windows and
harnesses inline.

Actionable workshops are nearest the prompt in this order: failed incidents,
working or blocked clankers, ready clankers, idle clankers, neutral workshops,
sessionless worktrees, then plain directories. Recency and frecency break ties
within those groups.

Search matches structured fields independently and retains the complete
workshop ancestor chain for matching descendants. It must not manufacture
matches by concatenating unrelated fields.

## Controls

- `Up/Down`: move through visible workshop and detail rows
- `Left/Right`: collapse or expand workshop lineage and exact details
- `Enter`: open the exact workshop, clanker, window, worktree, or directory
- `Alt-K`: open the repository/branch flow when already inside Clankerhouse
- `Alt-B`: open directly at repository selection
- `Alt-R`: rename a tmux session without changing workshop identity
- `Alt-A`: attach a workshop to another valid parent
- `Alt-L`: detach a workshop from its parent
- `Alt-D`: confirm and asynchronously destroy the selected disposable target with a live step trace and progress indicator; remain in Clankerhouse afterward
- `Esc`: clear the query or close the current flow

## Implementation

The implementation lives in `clankerhouse/` and uses Bun, TypeScript, Effect,
Solid, and OpenTUI. Collection adapters produce tmux, Git, lifecycle, directory,
and lineage observations; a deterministic projection turns them into typed rows
and explicit persistence effects. The cache server atomically commits revisioned
version-10 snapshots and publishes them over a private Unix socket, while clients
retain JSON polling as a compatible fallback. Typed rows carry concrete
tmux/worktree actions; hierarchy is never inferred from rendered strings.
Clanker communication uses the native `clankers` API and never tmux input or
pane capture. Linux foreground-process discovery reads process metadata only and
cannot assign clanker identity or authorize destructive actions.

A separate durable recovery control plane stores desired Pi, Claude, and
OpenCode clankers, exact harness session identities, attempts, leases, and
append-only journal events under `$XDG_STATE_HOME/clankerhouse`. Its one-shot
boot reconciler recreates missing workshop windows and automatically resumes and
continues exact sessions once after a hard reboot. Later pane loss is not
immediately resurrected, and a clean final Ctrl-C durably opts that clanker out
of future boot recovery; same-boot recovery requires explicit reconciliation.
Tombstones, intentional stops, and resource-pressure suspensions take
precedence. The snapshot transport remains observational and exposes no recovery
mutation API.

See `clankerhouse/README.md` for the CLI and runtime contract and
`docs/qa/clanker-api.md` for safety-scoped API validation.

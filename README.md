# Clankerhouse

Clankerhouse is a tmux-native workshop and visible-harness application built with Bun, TypeScript, Effect, and OpenTUI. Open it with bare `clankerhouse` or `Alt-K`; use `clankers` for CLI operations.

## Installation

A source checkout is immediately usable as a TPM-compatible plugin:

```tmux
set -g @plugin 'tsah/clankerhouse'
# Or while developing locally:
# run-shell '/path/to/clankerhouse/clankerhouse.tmux'
```

TPM loads `clankerhouse.tmux`, which prefers the stable installation at `~/.local/lib/clankerhouse` and owns `M-k` (jump), `M-b` (spawn), `M-d` (safe deletion), and `M-x` (stop current session). Set `@clankerhouse-home` to another installed application root, `@clankerhouse-bindings off` to disable all defaults, or override `@clankerhouse-key`, `@clankerhouse-spawn-key`, `@clankerhouse-delete-key`, and `@clankerhouse-stop-key` before loading it.

For stable commands, integrations, and optional user services:

```bash
scripts/install --prefix "$HOME/.local" --integrations --systemd
clankerhouse-doctor
```

The installer places the application under `$prefix/lib/clankerhouse`, writes command launchers under `$prefix/bin`, and never removes runtime or recovery state during upgrades or uninstall. `scripts/uninstall --prefix "$HOME/.local"` removes only manifest-owned package files.

Required runtime tools are Bun, tmux, Git, Python 3, and flock. Worktrunk (`wt`), jq, zoxide, and individual harness CLIs are capability-specific.

A **workshop** is a durable Worktrunk worktree plus its canonical, lazily created tmux-session container. A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session inside a workshop. Those products are harnesses, not clankers, and harness-native in-process subagents are not clankers.

```bash
clankers workshop spawn --name feature-x --harness pi
clankers spawn --workshop feature-x --name reviewer --harness claude
```

The first command creates branch/worktree `feature-x` through Worktrunk, records its durable workshop identity and parent lineage, ensures the session and stable `main` window, and starts the initial clanker. The second resolves `feature-x` uniquely in the current repository and adds a `reviewer` clanker to the same workshop without creating a worktree or lineage edge. Both accept `--prompt`; when omitted it is exactly `Ready for instructions.`. Workshop and window names are labels, while returned `clankerId` values are opaque identity.

The jump layout is a bottom-sorted selectable tree, with the newest/highest-priority root group nearest the prompt. Session-to-session lineage uses real tree connectors and each row has one color-coded aggregate-state glyph beside its node: roots place it before the disclosure marker, while nested sessions place it immediately after the `├─`/`└─` child connector. Window and clanker details stay collapsed by default and their names are summarized inline immediately after the owning session name, without moving status glyphs to the right edge. Small lineage subtrees with one to three direct child sessions begin expanded, as do larger subtrees containing a working or ready clanker. Expanding exact details renders subdued `·` rows with their own left-side state glyphs beneath the owning session. The bottom prompt filters the full hierarchy while retaining the complete ancestor context of every matching descendant; non-empty queries show only directly matching detail rows.

The launcher keeps a background cache server running. The server refreshes tmux, opencode, zoxide, process, and git observations, projects them through a deterministic resource model, commits an atomic revisioned snapshot, and publishes that same snapshot over a mode-`0600` Unix socket. TUI clients receive updates immediately while the version-10 JSON cache continues as a live fallback; duplicate socket/cache revisions are ignored and selection is restored by stable row identity. Legacy version-10 snapshots without a revision remain readable so existing launchers and isolated fixtures continue to work. Set `CLANKERHOUSE_SUBSCRIBE=0` to disable the socket transport for diagnosis without changing cache behavior.

On Linux, fallback harness discovery follows each tmux pane child’s terminal foreground process group through `/proc` and recognizes Pi, Claude, Codex, and OpenCode behind common Node, Bun, Python, package-manager, environment, and shell wrappers. This is observation only: it never reads terminal contents, creates clanker IDs, or authorizes resource-guard termination. Structured lifecycle reports and the Clanker API retain their existing identity and transport authority.

Recovery activity is stored by canonical directory path under `$XDG_STATE_HOME/clankerhouse/activity` (default `~/.local/state/clankerhouse/activity`), so it survives cache, tmux-server, and machine restarts. Session creation, picker target opening, active tmux work, and clanker lifecycle reports update that ledger. Sessionless directories are sorted by the newest durable event, modified/untracked file mtime, worktree HEAD reflog, or commit; zoxide frecency breaks otherwise equal ties. Directory rows show the winning source and age, such as `[edited 12m]` or `[clanker 3h]`. Git fallback scans are cached for one minute.

Workshop lineage is stored in `$XDG_STATE_HOME/clankerhouse/workshops.sqlite3` and projected into each worktree at `.clankerhouse/workshop.json`. The store has `repositories` and `workshops` tables; manifests contain only workshop fields. Clanker identity uses `clanker-…` IDs and `@clankerhouse_clanker_*` pane metadata.

Claude Code state is reported through hooks installed by:

```bash
clankerhouse-install-claude-hooks
```

Those hooks write per-pane state into the same runtime cache directory, keyed by `TMUX_PANE`. Pi uses the globally installed `pi/extensions/tmux-clanker-lifecycle.ts` extension for the same purpose, including Pi sessions started directly. It also exposes a mode-`0600` per-process Unix socket and routes incoming messages through native `pi.sendUserMessage`. A Pi pane remains `working` while any in-process subagent is running or queued, even if the parent Pi session has settled. Reports carry lifecycle and settled generations plus bounded Pi result history. The cache server prefers these structured reports over pane-title heuristics and normalizes state as `blocked`, `working`, `done`, `idle`, or `unknown`. The UI renders those as blinking red `waiting`, animated orange `working`, green `ready`, blue `idle`, and purple `unknown`; plain non-clanker windows use a neutral gray `○`. A completed clanker remains ready until its pane/window is focused, then becomes idle; a later completion becomes ready again.

## Clanker API

Every clanker has a stable generated ID stored in pane option `@clankerhouse_clanker_id`. Tmux supplies discovery and metadata only; the API never uses `send-keys`, buffer paste, or pane capture for clanker communication.

```bash
clankers list [--cwd PATH]
clankers status CLANKER_ID
clankers capabilities CLANKER_ID
clankers wait CLANKER_ID [--after GENERATION] [--timeout SECONDS]
printf '%s' 'Continue with the tests' | clankers send CLANKER_ID [--delivery steer|follow-up] [--wait]
clankers result CLANKER_ID [--generation GENERATION]
```

Successful responses are JSON. Errors are versioned JSON on stderr; unsupported capabilities exit `4`, unavailable native endpoints exit `5`, and nondestructive wait timeouts exit `124`.

Pi supports the complete API through its native socket and lifecycle reports. Busy sends default to a native follow-up, and Clankerhouse admits only one unsettled external message at a time so waits remain correlated. Pi processes that were already running when this update was installed need `/reload` or a restart to advertise the endpoint. Claude and Codex can be listed and can wait on their lifecycle reports, but unverified native send/result operations fail explicitly. OpenCode is currently monitor-only: HTTP mutation and lifecycle waiting remain disabled until its local contract is verified.

Run the TUI or cache server directly:

```bash
clankerhouse
clankerhouse --server
```

The local daemon protocol currently exposes read-only status/snapshot/subscription methods plus one bounded non-destructive action, `projection.refresh`. Tmux/worktree destruction, rename, attach/detach, and branch creation remain local workflows with their existing confirmation and revalidation rules; unknown or destructive socket actions are rejected.

The `Alt-K` tmux binding launches Clankerhouse.

## Durable restart and Spot recovery

Pi, Claude, and OpenCode clankers spawned through `clankers` are recorded in the private SQLite control-plane store at `$XDG_STATE_HOME/clankerhouse/recovery.sqlite3`. Clankerhouse persists desired state and launch intent before creating a pane. Pi and Claude receive preallocated native session IDs; the OpenCode lifecycle plugin binds its generated `ses_…` ID before prompt processing. Lifecycle attestation completes the launch attempt.

`clankerhouse-recovery.service` performs one reconciliation when the user service manager starts. After a hard reboot it recreates missing workshop windows, resumes each exact native harness session once, and immediately submits a recovery-attempt prompt that autonomously inspects Git, tests, and external state before continuing. It then remains `active (exited)`: a later Ctrl-C, harness exit, or tmux pane loss is not resurrected. Same-boot recovery is explicit through `systemctl --user restart clankerhouse-recovery.service` or `clankers recovery reconcile`. Delivery is at-least-once: arbitrary tools cannot provide a general exactly-once guarantee, so the prompt is attempt-tagged and explicitly inspect-before-repeat.

Tracked harnesses run through a lifecycle wrapper. A clean process exit, including a final Ctrl-C that actually terminates the harness, is validated against the latest successful recovery attempt and exact native session before durably changing desired state to `stopped`; it will not return on a later boot. Ctrl-C that only cancels an active turn does not stop recovery eligibility. Crashes, SIGHUP/tmux loss, and host SIGTERM leave desired state `running` so boot recovery remains possible. Intentional tmux stops are journaled before destruction. Resource-pressure suspension and irreversible tombstones take precedence over recovery, preventing the controller from undoing deliberate mitigation or deletion. Codex remains visible but is not automatically recoverable because an exact native resume contract is not configured.

```sh
clankers recovery status
clankers recovery journal
clankers recovery reconcile
clankers recovery adopt-live
clankers recovery stop CLANKER_ID
clankers recovery start CLANKER_ID
clankers recovery suspend CLANKER_ID --reason resource-pressure
```

On EC2, `clankerhouse-spot-watch.service` polls IMDSv2 without IAM credentials. A Spot interruption notice writes and fsyncs a durable marker and invokes `clankers recovery checkpoint`; rebalance recommendations can optionally trigger an earlier checkpoint. Recovery does not depend on receiving the notice.

The state database, native harness session stores, repositories, and worktrees must reside on retained encrypted storage mounted at the same paths before the user service starts. Spot termination is not recoverable from a root volume configured for deletion. See `docs/qa/clankerhouse-recovery.md` for the isolated QA and migration acceptance plan.

## Resource-pressure guard

On Linux, `clankerhouse-resource-guard` samples guest-kernel memory PSI and `MemAvailable` every five seconds. After one minute of sustained pressure it terminates at most one validated, non-focused Pi, Claude, OpenCode, or Codex process per boot. It prefers done/idle clankers, then unknown, blocked, and working clankers; within a state it chooses the largest process tree. The process is revalidated against its tmux pane, UID, ancestry, start time, harness, and stable clanker ID immediately before `SIGTERM`, with `SIGKILL` only after the grace period.

Actions are persisted under `$XDG_STATE_HOME/clankerhouse/incidents` and appear in the TUI as a red `×` with `terminated`. The daemon also snapshots working, blocked, and unknown clankers with the Linux boot ID. If a hard reset changes the boot ID without a clean daemon shutdown, the lost sessions reappear as red `×` entries labeled `lost on reboot`. An orderly reboot does not create crash incidents.

EC2 needs no special metrics API: PSI and `/proc/meminfo` report pressure inside the instance, which is exactly what the guard needs. On swapless EC2 instances the default reserve is the larger of 512 MiB or 10% of RAM; elsewhere it is 7.5% of RAM. CPU credits and host-level steal time are separate concerns and do not affect this memory-pressure decision.

```sh
systemctl --user status clankerhouse-resource-guard
journalctl --user -u clankerhouse-resource-guard
clankerhouse-resource-guard --once --dry-run
```

Thresholds can be overridden with `RESOURCE_GUARD_SAMPLES`, `RESOURCE_GUARD_INTERVAL`, `RESOURCE_GUARD_EC2_FLOOR_MIB`, `RESOURCE_GUARD_EC2_PERCENT`, `RESOURCE_GUARD_GENERIC_PERCENT`, `RESOURCE_GUARD_PSI_SOME`, `RESOURCE_GUARD_PSI_FULL`, and `RESOURCE_GUARD_TERM_GRACE`. Set `RESOURCE_GUARD_DRY_RUN=1` to audit selections without signaling processes. The server must keep the user systemd manager running after logout (normally via `loginctl enable-linger $USER`).

Useful CLI inspection/repair commands:
- `clankers workshop show --cwd PATH`
- `clankers workshop tree --cwd PATH`
- `clankers workshop project --cwd PATH`
- `clankers workshop reconcile --cwd PATH`
- `clankers workshop bootstrap --cwd PATH`

Controls:
- `Up/Down`: move between workshop rows and nested window/clanker children
- `Right`: first expand hidden lineage children for the selected session, then expand its exact detail rows
- `Left`: jump from a detail to its session, collapse exact detail rows first, then collapse lineage children, then jump to the lineage parent
- `Enter`: switch to the exact selected workshop/window/clanker target or advance the current flow; Enter on zero matches does nothing
- `Alt-R`: rename the selected tmux session without changing its worktree identity
- `Alt-A`: search valid parent workshops and attach the selected workshop beneath one
- `Alt-L`: detach the selected workshop from its parent, making its existing subtree top-level
- Type or paste: structured fuzzy-filter rows and fill the branch/base form; current selection is preserved when it still matches
- `Alt-K` while Clankerhouse is open: choose a repository, then open an existing worktree/branch or type a new branch name to create it
- `Ctrl-R`: refresh remotes while in the branch picker
- `Alt-D`: confirm and asynchronously destroy the selected pane with a live step trace (recovery stop, Git inspection, tmux discovery, Worktrunk removal, and session closure) plus progress, then remain in Clankerhouse with the deleted target removed; destroying a session's final pane also destroys its linked worktree and session. Outside Clankerhouse, `Alt-D` opens a compact confirmation popup with the same animated stop-intent/session-closure trace.
- `Esc`: clear search, move back one flow step, or close
- `Ctrl-C`: close

On startup, the tmux session containing the popup is selected when it appears in the jump list. Renaming stays inside Clankerhouse and preserves the session's canonical path metadata and included clankers.

Run checks, model/API/recovery tests, and the isolated real-terminal smoke test with:

```bash
bun run check
bun test
PYTHONPATH=.. python3 -m unittest tests.test_resource_guard tests.test_spot_watch
scripts/qa-clanker-api
scripts/qa-daemon
scripts/qa-recovery
scripts/qa-stop-popup
scripts/qa
```

Capture a deterministic lineage render from a disposable real OpenTUI fixture with:

```bash
CLANKERHOUSE_QA_ROOT=/tmp/qa-clankerhouse-lineage CLANKERHOUSE_QA_KEEP=1 CLANKERHOUSE_QA_VISUAL=1 scripts/qa
```

Then either inspect `/tmp/qa-clankerhouse-lineage/lineage-render.txt` or attach live with `tmux -S /tmp/qa-clankerhouse-lineage/outer.sock attach -t harness`. The capture should show session-only lineage connectors, inline `main`/clanker summaries, and subdued bullet detail rows for an explicitly expanded child session.

The branch flow always begins with the repository picker; it never infers a repository from the current pane or selected jump target. Selecting a repository immediately shows cached refs and starts `git fetch --all --prune` in the background; remote rows are ordered by most recent commit and refresh when the fetch settles. In the branch picker, a query without an exact branch match adds a `create new branch` row. Selecting it asks for the base before creating the worktree and session. Alt-B opens the same TUI directly at the repository picker.

Not implemented yet:
- `Ctrl-Y` copy PR URL

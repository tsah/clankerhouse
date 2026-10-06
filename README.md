# Clankerhouse

Clankerhouse is a tmux-native workshop and visible-harness application with a Rust/ratatui jump client and a Bun/TypeScript control plane. Open it with bare `clankerhouse` or `Alt-K`; use `clankers` for CLI operations.

## Installation

A source checkout is immediately usable as a TPM-compatible plugin:

```tmux
set -g @plugin 'tsah/clankerhouse'
# Or while developing locally:
# run-shell '/path/to/clankerhouse/clankerhouse.tmux'
```

TPM loads `clankerhouse.tmux`, which prefers the stable installation at `~/.local/lib/clankerhouse` and owns `M-k` (native jump), `M-b` (native spawn flow), `M-d` (safe deletion), and `M-x` (stop current session). Set `@clankerhouse-home` to another installed application root, `@clankerhouse-bindings off` to disable all defaults, or override `@clankerhouse-key`, `@clankerhouse-spawn-key`, `@clankerhouse-delete-key`, and `@clankerhouse-stop-key` before loading it.

Under Herdr, `clankerhouse-install-herdr` installs Alt-K, Alt-B, and Alt-D popup bindings. Alt-D confirms deletion of the invoking session/worktree using the native client; it never guesses the target from whichever workspace becomes focused later. Reload Herdr's configuration after updating these bindings.

For stable commands, integrations, and optional user services:

```bash
scripts/install --prefix "$HOME/.local" --integrations --systemd
clankerhouse-doctor
```

The first install stages and validates a version under `$prefix/lib/clankerhouse-versions` and atomically creates `$prefix/lib/clankerhouse` as the active symlink. Stable launchers under `$prefix/bin`, tmux bindings, harness integrations, and user units resolve that active target on each invocation instead of pinning a version.

For an upgrade with a running projection daemon, explicitly select its runtime and tmux server so the installer cannot signal an unrelated process:

```bash
scripts/install --prefix "$HOME/.local" --integrations --systemd \
  --runtime-dir "${XDG_RUNTIME_DIR:?}" \
  --tmux-socket "$(tmux display-message -p '#{socket_path}')"
```

The installer quiesces only a daemon whose process identity, application target, runtime directory, and tmux socket all match that selection. It activates the new version, probes `server.status`, and atomically restores and restarts the prior target if activation fails. Use `--no-daemon-handoff` only after manually proving no daemon is using the installation. The first upgrade from the legacy fixed `$prefix/lib/clankerhouse` directory moves that owned tree into the versions directory after quiescence, preserving it as the rollback target.

Old versions are retained for rollback until uninstall or explicit cleanup. `scripts/uninstall --prefix "$HOME/.local"` removes only manifest-owned package files and versions; runtime and recovery state are never removed.

Required runtime tools are Bun, tmux, Git, Python 3, and flock. Worktrunk (`wt`), jq, zoxide, and individual harness CLIs are capability-specific.

### Neovim

The repository is also a Neovim plugin. With Neovim 0.10 or newer:

```lua
vim.pack.add({ { src = "https://github.com/tsah/clankerhouse" } })
require("clankerhouse").setup({
  mappings = {
    ask = "<leader>oa",
    send_reference = "<leader>pp",
    send_contents = "<leader>ps",
    send_buffer = "<leader>pb",
    focus = "<leader>pf",
  },
})
```

`ClankerAsk` sends the current line or visual selection plus a prompt to the
nearest current-workshop clanker that advertises send: first in the same
Multiplexer window, then the same session, then elsewhere. `ClankerChoose`
pins an explicit send-capable target instead. Pi uses its native Unix socket;
under Herdr, Claude uses Herdr's validated interactive-agent prompt operation.
An already-running Pi must be reloaded after integration updates.
The plugin also defines `ClankerSendReference`, `ClankerSendContents`,
`ClankerAppendContext`, `ClankerFocus`, and `ClankerSpawn`. Discovery and focus
go through the Clankerhouse Multiplexer Interface and work under tmux or Herdr.
No mappings are installed unless configured.

A **workshop** is a durable Worktrunk worktree plus its canonical, lazily created tmux-session container. A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session inside a workshop. Those products are harnesses, not clankers, and harness-native in-process subagents are not clankers.

```bash
clankers workshop spawn --name feature-x --harness pi
clankers spawn --workshop feature-x --name reviewer --harness claude --model sonnet
```

The first command creates branch/worktree `feature-x` through Worktrunk, records its durable workshop identity and parent lineage, and starts the initial clanker as the session’s only tab (no extra `main` shell tab). The second resolves `feature-x` uniquely in the current repository and adds a `reviewer` clanker to the same workshop without creating a worktree or lineage edge. Both accept `--prompt`; when omitted it is exactly `Ready for instructions.`. Workshop and window names are labels, while returned `clankerId` values are opaque identity.

Spawning into a Workshop with no live session also starts with just the agent tab, including during Recovery. Adding a clanker to an existing session preserves its tabs. Shell-only `clankers workshop ensure` still opens a `main` terminal.

Both spawn commands accept `--model MODEL` for Pi, Claude, and Codex. The value is passed unchanged to the harness (no model-name allowlist) and overrides the model selected by `--profile` or harness defaults. Pi and Claude persist the override for Recovery; omitting it preserves existing profile/default behavior. OpenCode rejects this flag; configure its model in OpenCode instead.

The jump layout is a bottom-sorted selectable tree: oldest root groups are at the top, the most recently seen group is nearest the prompt, and the current session remains pinned nearest the prompt. In the unfiltered view, the current Workshop and its ancestor chain always stay expanded regardless of lineage size, and the picker initially selects the current Workshop. Other branches remain collapsible and navigation does not steal the user's selection. A lineage subtree is positioned by its most recently seen descendant. State does not participate in ordering; status is conveyed only by each node's color-coded aggregate-state glyph. Roots place the glyph before the disclosure marker, while nested sessions place it immediately after the `├─`/`└─` child connector. Window and clanker details stay collapsed by default and their names are summarized inline immediately after the owning session name, without moving status glyphs to the right edge. Small lineage subtrees with one to three direct child sessions begin expanded, as do larger subtrees containing a working or ready clanker. Expanding exact details renders subdued `·` rows with their own left-side state glyphs beneath the owning session. The bottom prompt filters the full hierarchy while retaining the complete ancestor context of every matching descendant; non-empty queries show only directly matching detail rows.

One long-lived Bun daemon owns observation, projection, mutations, side-effect reconciliation, startup/shutdown, and subscriptions. It publishes authoritative revisioned observations through a private mode-`0600` Unix socket. The Rust native client reads the atomic version-10 `state.json` at most once as a startup/crash fallback, then subscribes to the socket and retains the last valid observation across daemon replacement. JSON is never the live synchronization mechanism. A producer epoch lease scoped to the runtime and multiplexer instance prevents stale producers from publishing revisions.

Tree order, search fields, exact targets, and typed available actions are projected by the daemon. Rust/ratatui is the sole rendering/input Adapter; Bun is daemon and control plane only.

Structured lifecycle reports are the live source for Clanker state, including OpenCode. The projection daemon no longer invokes the Python OpenCode polling/cache path. Linux process discovery may label an unmanaged foreground harness for observation, but process resemblance never creates Clanker identity, authorizes mutation, or establishes recovery ownership.

Recovery activity is stored by canonical directory path under `$XDG_STATE_HOME/clankerhouse/activity` (default `~/.local/state/clankerhouse/activity`), so it survives cache, tmux-server, and machine restarts. Session creation, picker target opening, active tmux work, and clanker lifecycle reports update that ledger. A sessionless directory's last-seen value is its newest durable event, modified/untracked file mtime, worktree HEAD reflog, or commit. Directory rows show the winning source and age, such as `[edited 12m]` or `[clanker 3h]`. Git fallback scans are cached for one minute.

The expanded durable registry is `$XDG_STATE_HOME/clankerhouse/registry.sqlite3`. It contains Workshops, Terminals, Clankers, desired Recovery state, append-only journal entries, leases, durable mutation stages, and validated Multiplexer Locations. On migration it transactionally imports supported `workshops.sqlite3`, `resources.sqlite3`, recovery v1/v2/v3, and legacy lineage data with provenance and foreign-key validation. Durable mutation operations use the registry immediately; imported domain rows remain behind the `legacy-mutable` compatibility gate until every installed legacy ingress has moved to the socket. Legacy databases therefore remain active compatibility/rollback inputs in this release rather than being rewritten in place. Worktree manifests, lifecycle files, and tmux options are projections or claims; they never override conflicting durable identity.

Claude Code state is reported through hooks installed by:

```bash
clankerhouse-install-claude-hooks
```

The installer registers startup as idle. Claude's `Stop` hook keeps the pane working and its generation unsettled while the hook payload reports running or pending background tasks (including shells and subagents); a later `Stop` with none in flight completes it. Scheduled future wakeups alone do not count as running work. Older Claude versions without task metadata retain their foreground-only completion behavior. Global hooks are silent no-ops outside Multiplexer panes or when their reporter is unavailable, so ordinary Claude terminals and environments sharing settings do not require Clankerhouse. It upgrades old unguarded Clankerhouse invocations and migrates stale `herdr-agent-state.sh` hooks only when that exact reporter is missing. It preserves unrelated hooks and existing Herdr scripts, saves the original settings to `settings.json.pre-clankerhouse-migration`, and leaves already-current settings untouched on reruns.

Those hooks write per-pane state into the same runtime cache directory, addressed through the selected Multiplexer (`TMUX_PANE` or `HERDR_PANE_ID`). Pi uses the globally installed `pi/extensions/tmux-clanker-lifecycle.ts` extension for the same purpose, including Pi sessions started directly. It also exposes a mode-`0600` per-process Unix socket and routes incoming messages through native `pi.sendUserMessage`. Only Pi's terminal-UI session may own the pane: in-process SDK workers and sessionless subprocesses cannot overwrite its identity, lifecycle reports, native socket, or Recovery intent. A Pi pane remains `working` while any in-process subagent is running or queued, even if the parent Pi session has settled. Reports carry lifecycle and settled generations plus bounded Pi result history. The cache server prefers these structured reports over pane-title heuristics and normalizes state as `blocked`, `working`, `done`, `idle`, or `unknown`. The UI renders those as blinking red `waiting`, animated orange `working`, green `ready`, blue `idle`, and purple `unknown`; plain non-clanker windows use a neutral gray `○`. A completed clanker remains ready until its pane/window is focused, then becomes idle; a later completion becomes ready again.

## Clanker API

Every clanker has a stable generated ID stored as a Multiplexer pane claim. Tmux supplies discovery and metadata only; the API never uses tmux `send-keys`, buffer paste, or pane capture for clanker communication. Herdr may advertise its semantic agent-prompt capability: before submission Clankerhouse revalidates the exact pane's Clanker ID, and Herdr verifies that a recognized interactive agent still owns the pane and is not blocked.

```bash
clankers list [--cwd PATH]
clankers status CLANKER_ID
clankers capabilities CLANKER_ID
clankers wait CLANKER_ID [--after GENERATION] [--timeout SECONDS]
printf '%s' 'Continue with the tests' | clankers send CLANKER_ID [--delivery steer|follow-up] [--wait]
clankers result CLANKER_ID [--generation GENERATION]
```

Successful responses are JSON. Errors are versioned JSON on stderr; unsupported capabilities exit `4`, unavailable native endpoints exit `5`, and nondestructive wait timeouts exit `124`.

Pi supports the complete API through its native socket and lifecycle reports. Busy sends default to a native follow-up, and Clankerhouse admits only one unsettled external message at a time so waits remain correlated. Pi processes that were already running when this update was installed need `/reload` or a restart to advertise the endpoint. Claude under Herdr supports immediate send through Herdr's semantic prompt operation and waits through Claude lifecycle reports; explicit `steer`/`followUp` modes and results remain unsupported. Under tmux, Claude remains list/wait-only. Codex can be listed and can wait on lifecycle reports, but send/result operations fail explicitly. OpenCode is currently monitor-only: mutation and lifecycle waiting remain disabled until its local contract is verified.

Run the native TUI or Bun daemon directly:

```bash
clankerhouse
bun run server
```

The local daemon Interface exposes health/status, snapshot/subscription, projection refresh, typed mutation submission, and durable operation status. Open, rename, attach/reparent, detach, deletion, and repository/branch creation are idempotent intents; clients do not sequence Worktrunk, SQLite, tmux, systemd, or manifest effects. Unknown intents and destructive requests without explicit confirmation are rejected.

The `Alt-K` tmux binding launches Clankerhouse.

## Durable restart and Spot recovery

Pi, Claude, and OpenCode Clankers spawned through `clankers` have desired Recovery state imported into the unified registry. During the `legacy-mutable` compatibility gate, the existing private `recovery.sqlite3` remains the writable compatibility source and rollback input; activation of unified domain-row authority occurs only after all installed lifecycle writers use the socket. Clankerhouse persists desired state and launch intent before creating a pane. Pi and Claude receive preallocated native session IDs; the OpenCode lifecycle plugin binds its generated `ses_…` ID before prompt processing. Lifecycle attestation completes the launch attempt.

`clankerhouse-recovery.service` remains active and creates a durable recovery campaign after a Linux boot-ID change. Existing panes are adopted; missing campaign members become `pending`. After the resource guard reports a two-minute quiet boot and 30 seconds of healthy pressure, the controller automatically admits one recovery. It waits for that exact session to remain live for five minutes before admitting the next, with at least 60 seconds between admissions. Later same-boot pane loss is not added to the boot campaign. Set `CLANKERHOUSE_AUTO_RECOVER=0` to disable automatic Spot recovery; `clankers recovery resume CLANKER_ID` remains available for reviewed manual recovery, with `--force` as an explicit pressure-gate override.

Recovery automatically continues from the last settled request, but never replays an interrupted tool call. Read-only inspection and local source edits may continue. Tests, lint, builds, indexing, package installation, containers, migrations, commits, pushes, deployments, network mutations, and other expensive or externally visible operations require operator confirmation. Unknown interrupted work is quarantined. Startup attestation alone does not reset the breaker: five minutes of stable liveness releases the next campaign admission, while an idle/done lifecycle report resets the consecutive-failure count.

Tracked harnesses run through a lifecycle wrapper. A clean process exit, including a final Ctrl-C that actually terminates the harness, is validated against the latest successful recovery attempt and exact native session before durably changing desired state to `stopped`; it will not return on a later boot. Ctrl-C that only cancels an active turn does not stop recovery eligibility. Crashes, SIGHUP/tmux loss, and host SIGTERM leave desired state `running` so boot recovery remains possible. Intentional tmux stops are journaled before destruction. Resource-pressure suspension and irreversible tombstones take precedence over recovery, preventing the controller from undoing deliberate mitigation or deletion. Codex remains visible but is not automatically recoverable because an exact native resume contract is not configured.

```sh
clankers recovery status
clankers recovery journal
clankers recovery reconcile
clankers recovery pending
clankers recovery resume CLANKER_ID
clankers recovery unquarantine CLANKER_ID --reason 'reviewed interrupted work'
clankers recovery pause-all
clankers recovery adopt-live
clankers recovery stop CLANKER_ID
clankers recovery start CLANKER_ID
clankers recovery suspend CLANKER_ID --reason resource-pressure
```

On EC2, `clankerhouse-spot-watch.service` polls IMDSv2 without IAM credentials. A Spot interruption notice writes and fsyncs a durable marker and invokes `clankers recovery checkpoint`; rebalance recommendations can optionally trigger an earlier checkpoint. Recovery does not depend on receiving the notice.

The state database, native harness session stores, repositories, and worktrees must reside on retained encrypted storage mounted at the same paths before the user service starts. Spot termination is not recoverable from a root volume configured for deletion. See `docs/qa/clankerhouse-recovery.md` for the isolated QA and migration acceptance plan.

## Resource-pressure guard

On Linux, `clankerhouse-resource-guard` samples guest-kernel memory, CPU, and I/O PSI plus `MemAvailable` and root-device read throughput every five seconds. It publishes a durable recovery-admission health record before the recovery reconciler starts. Admission freezes immediately under pressure, but mitigation requires five minutes of sustained pressure. The guard first stops one validated, attributable child workload of a non-focused Clanker, preserves the harness and pane, and attempts a capability-aware steering notice naming the incident. The incident and delivery result remain durable when a harness has no steering transport. It then cools down for two minutes and begins a fresh sustained-pressure window. If no child workload can be attributed safely, a Recovery-tracked Clanker is durably stopped through its owner while preserving its pane; an untracked harness is never signalled as a fallback.

Actions and a bounded pre-incident pressure history are persisted under `$XDG_STATE_HOME/clankerhouse/incidents` and appear in the TUI as a red `×`. The daemon atomically publishes `recovery-admission.json`, `resource-guard-snapshot.json`, and Prometheus text metrics in `resource-guard-metrics.prom`. If a hard reset changes the boot ID without a clean daemon shutdown, lost sessions reappear as red `×` entries labeled `lost on reboot`. An orderly reboot does not create crash incidents.

EC2 needs no metrics API for enforcement: PSI, `/proc/meminfo`, `/proc/diskstats`, and cgroup statistics report guest pressure. On swapless EC2 instances the memory reserve is the larger of 512 MiB or 10% of RAM. The default configured storage ceiling is 125 MiB/s: admission stops at 50%, mitigation begins at 75%, and significant I/O PSI also trips protection. Set `RESOURCE_GUARD_READ_LIMIT_MIB_PER_SEC` for other volumes. When delegated by systemd, `CLANKERHOUSE_IO_READ_BANDWIDTH_MAX='/dev/DEVICE 60M'` adds a hard per-scope device limit; the recovery slice always receives low CPU and I/O weights. New clankers can declare `--resource-class interactive|validation-heavy|untrusted`; undeclared and migrated workloads use the conservative `untrusted` budget. Historical pressure and admission metrics remain available for later budget tuning but never weaken hard safety limits.

```sh
systemctl --user status clankerhouse-resource-guard
journalctl --user -u clankerhouse-resource-guard
clankerhouse-resource-guard --once --dry-run
```

Thresholds can be overridden with `RESOURCE_GUARD_SAMPLES`, `RESOURCE_GUARD_INTERVAL`, `RESOURCE_GUARD_COOLDOWN`, `RESOURCE_GUARD_WORKLOAD_MIN_RSS_MIB`, `RESOURCE_GUARD_WORKLOAD_MIN_IO_MIB_PER_SEC`, `RESOURCE_GUARD_EC2_FLOOR_MIB`, `RESOURCE_GUARD_EC2_PERCENT`, `RESOURCE_GUARD_GENERIC_PERCENT`, `RESOURCE_GUARD_PSI_SOME`, `RESOURCE_GUARD_PSI_FULL`, `RESOURCE_GUARD_IO_PSI_SOME`, `RESOURCE_GUARD_IO_PSI_FULL`, `RESOURCE_GUARD_CPU_PSI_SOME`, `RESOURCE_GUARD_READ_LIMIT_MIB_PER_SEC`, and `RESOURCE_GUARD_TERM_GRACE`. Set `RESOURCE_GUARD_DRY_RUN=1` to audit selections without signaling processes. The server must keep the user systemd manager running after logout (normally via `loginctl enable-linger $USER`).

## Workshop labels and repository hooks

A Workshop can carry `key=value` labels. Clankerhouse stores them, shows their values as dimmed `[tags]` after the Workshop name, and makes them searchable; they never affect ordering. The only label Clankerhouse itself acts on is `status=done`.

`Alt-D` on a worktree Workshop marks it done instead of deleting it. Nothing else changes: its clankers, session, and worktree stay. `Alt-D` on a done Workshop asks whether to destroy it (`y`) or reopen it (`u`, which clears the label). A done Workshop that is then left alone for seven days is deleted automatically; using it again restarts the seven days. The reaper never deletes a worktree with uncommitted changes or with a clanker that is working, waiting, or finished but unseen, and it keeps the branch. Set `CLANKERHOUSE_DONE_TTL_DAYS` for the daemon to change the retention, or to `0` to turn automatic deletion off.

```bash
clankers workshop label set stage=implementing   # current Workshop; --cwd PATH for another
clankers workshop label unset stage
clankers workshop label list
```

A repository gives labels meaning with two optional tracked executables, run with the Workshop as working directory:

- `.clankerhouse/hooks/labels-changed` runs detached after a label really changes. It cannot fail the change.
- `.clankerhouse/hooks/done` replaces the built-in `Alt-D` rule for that repository. Exit `0` means the repository handled the key. Exit `1` falls through to the destroy confirmation. Any other exit, or a run longer than 30 seconds, is shown as an error and nothing is destroyed.

Both receive `CLANKERHOUSE_HOOK_EVENT`, `CLANKERHOUSE_WORKSHOP_ID`, `CLANKERHOUSE_WORKSHOP_PATH`, `CLANKERHOUSE_WORKSHOP_BRANCH`, `CLANKERHOUSE_LABELS` (JSON), and one `CLANKERHOUSE_LABEL_<KEY>` per label; `labels-changed` also receives `CLANKERHOUSE_PREVIOUS_LABELS` and `CLANKERHOUSE_PREVIOUS_LABEL_<KEY>`. `clankers` is on their `PATH`. A repository usually needs only `labels-changed`. For example, to start a retro when a Workshop is marked done:

```sh
#!/bin/sh
if [ "${CLANKERHOUSE_LABEL_STATUS:-}" = done ] && [ "${CLANKERHOUSE_PREVIOUS_LABEL_STATUS:-}" != done ]; then
    clankers spawn --workshop "$CLANKERHOUSE_WORKSHOP_ID" --name retro --harness claude --prompt "Run the retro for this workshop."
fi
```

Hooks are repository-supplied code that runs without a prompt, so use them only in repositories you trust.

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
- `Alt-A`: search valid projected parent workshops and attach the selected workshop beneath one; candidates come from the authoritative lineage projection rather than the optional repository-picker cache
- `Alt-L`: detach the selected workshop from its parent, making its existing subtree top-level
- Type or paste: structured fuzzy-filter rows and fill the branch/base form; current selection is preserved when it still matches
- `Alt-K` while Clankerhouse is open: choose a repository, then open an existing worktree/branch or type a new branch name to create it
- `Ctrl-R`: refresh remotes while in the branch picker
- `Alt-D`: on a worktree Workshop, mark it done; on a done Workshop, confirm destruction or reopen it (see Workshop labels). On a pane or plain session, confirm deletion of the selected target. Deletion runs on the daemon while the picker remains usable: search, select, expand, and press Enter to jump to another Workshop without waiting. Leaving waits only for durable submission; an accepted deletion continues after the picker closes. Only one mutation is started at a time from a picker. Worktree deletion also closes its linked sessions and splices any children to the former parent. Outside Clankerhouse, Alt-D follows the same rule for the invoking session/worktree in tmux or Herdr; cancellation leaves it untouched.
- `Esc`: clear search, move back one flow step, or close
- `Ctrl-C`: close

On startup, the tmux session containing the popup is selected when it appears in the jump list. Renaming stays inside Clankerhouse and preserves the session's canonical path metadata and included clankers.

Run every static check, unit/component suite, and isolated standalone end-to-end scenario through the authoritative top-level entrypoint:

```bash
./test                 # everything
./test --unit          # feature coverage plus TypeScript, Python, and Rust
./test --standalone    # every real daemon/tmux/TUI/integration simulation
```

`docs/features.json` is the feature-to-unit/standalone/manual acceptance catalogue. `scripts/check-feature-coverage` fails when a functional-core feature lacks unit tests, any feature lacks standalone/manual coverage, or a discovered unit-test file is uncatalogued.

Project-local Agent Skills are shared by Pi and OpenCode through `.agents/skills/`: Pi exposes `/skill:manual-qa` and `/skill:troubleshoot`; OpenCode exposes `/manual-qa` and `/troubleshoot`. Pi also provides the convenience prompt templates `/qa` and `/troubleshoot`. Manual QA treats the agent as the semantic judge and retains evidence under `.qa-artifacts/`; troubleshooting is read-only until live mutations are explicitly confirmed.

Capture a deterministic lineage render from a disposable real Rust/ratatui fixture with:

```bash
CLANKERHOUSE_QA_ROOT=/tmp/qa-clankerhouse-lineage CLANKERHOUSE_QA_KEEP=1 CLANKERHOUSE_QA_VISUAL=1 scripts/qa
```

Then either inspect `/tmp/qa-clankerhouse-lineage/lineage-render.txt` or attach live with `tmux -S /tmp/qa-clankerhouse-lineage/outer.sock attach -t harness`. The capture should show session-only lineage connectors, inline `main`/clanker summaries, and subdued bullet detail rows for an explicitly expanded child session.

The branch flow always begins with the repository picker; it never infers a repository from the current pane or selected jump target. Selecting a repository immediately shows cached refs and starts `git fetch --all --prune` in the background; remote rows are ordered by most recent commit and refresh when the fetch settles. In the branch picker, a query without an exact branch match adds a `create new branch` row. Selecting it asks for the base before creating the worktree and session. Alt-B opens the same TUI directly at the repository picker.

Not implemented yet:
- `Ctrl-Y` copy PR URL

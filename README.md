# Clankerhouse

Clankerhouse is a workshop and visible-harness application for the [Herdr](https://herdr.dev) terminal multiplexer, with a Rust/ratatui jump client and a Bun/TypeScript control plane. Open it with Herdr's `Alt-K` popup or bare `clankerhouse` inside Herdr; use `clankers` for CLI operations.

## Installation

Clankerhouse runs inside Herdr. `clankerhouse-install-herdr` installs Alt-K (jump), Alt-B (repository/branch spawn flow), Alt-D (done/delete), Alt-N (scratch workshop), and Alt-I (needs me) popup bindings. To use other keys, edit the `key` lines in the managed block of Herdr's `config.toml`, or set `CLANKERHOUSE_HERDR_KEY`, `CLANKERHOUSE_HERDR_SPAWN_KEY`, `CLANKERHOUSE_HERDR_DELETE_KEY`, `CLANKERHOUSE_HERDR_SCRATCH_KEY`, or `CLANKERHOUSE_HERDR_NEEDS_ME_KEY` when running the installer; the chosen keys are kept on reruns and upgrades. Alt-D confirms deletion of the invoking session/worktree using the native client; it never guesses the target from whichever workspace becomes focused later. Reload Herdr's configuration (`herdr server reload-config`) after updating these bindings. The installer also turns off Herdr's own agent resume on restore; interrupted clankers are resumed through `clankers resume` instead.

For stable commands, integrations, and optional user services:

```bash
scripts/install --prefix "$HOME/.local" --integrations --systemd
clankerhouse-doctor
```

The first install stages and validates a version under `$prefix/lib/clankerhouse-versions` and atomically creates `$prefix/lib/clankerhouse` as the active symlink. Stable launchers under `$prefix/bin`, Herdr bindings, harness integrations, and user units resolve that active target on each invocation instead of pinning a version.

For an upgrade with a running projection daemon, explicitly select its runtime directory and Herdr socket so the installer cannot signal an unrelated process:

```bash
scripts/install --prefix "$HOME/.local" --integrations --systemd \
  --runtime-dir "${XDG_RUNTIME_DIR:?}" \
  --herdr-socket "${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
```

The installer quiesces only a daemon whose process identity, application target, runtime directory, and Herdr socket all match that selection. It activates the new version, probes `server.status`, and atomically restores and restarts the prior target if activation fails. Use `--no-daemon-handoff` only after manually proving no daemon is using the installation. The first upgrade from the legacy fixed `$prefix/lib/clankerhouse` directory moves that owned tree into the versions directory after quiescence, preserving it as the rollback target.

Old versions are retained for rollback until uninstall or explicit cleanup. `scripts/uninstall --prefix "$HOME/.local"` removes only manifest-owned package files and versions; runtime state and the clanker ledger are never removed.

Required runtime tools are Bun, Herdr, Git, Python 3, and flock. Worktrunk (`wt`), jq, zoxide, and individual harness CLIs are capability-specific.

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
Claude uses Herdr's validated interactive-agent prompt operation.
An already-running Pi must be reloaded after integration updates.
The plugin also defines `ClankerSendReference`, `ClankerSendContents`,
`ClankerAppendContext`, `ClankerFocus`, and `ClankerSpawn`. Discovery and focus
go through the Clankerhouse Multiplexer Interface.
No mappings are installed unless configured.

A **workshop** is a durable Worktrunk worktree plus its canonical, lazily created Herdr workspace. A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session inside a workshop. Those products are harnesses, not clankers, and harness-native in-process subagents are not clankers.

```bash
clankers workshop spawn --name feature-x --harness pi
clankers spawn --workshop feature-x --name reviewer --harness claude --model sonnet
```

The first command creates branch/worktree `feature-x` through Worktrunk, records its durable workshop identity and parent lineage, and starts the initial clanker as the session’s only tab (no extra `main` shell tab). The second resolves `feature-x` uniquely in the current repository and adds a `reviewer` clanker to the same workshop without creating a worktree or lineage edge. Both accept `--prompt`; when omitted it is exactly `Ready for instructions.`. Workshop and window names are labels, while returned `clankerId` values are opaque identity.

Spawning into a Workshop with no live session also starts with just the agent tab, including on `clankers resume`. Adding a clanker to an existing session preserves its tabs. Shell-only `clankers workshop ensure` still opens a `main` terminal.

Both spawn commands accept `--model MODEL` for Pi, Claude, and Codex. The value is passed unchanged to the harness (no model-name allowlist) and overrides the model selected by `--profile` or harness defaults. Pi and Claude keep the override in the clanker ledger for `clankers resume`; omitting it preserves existing profile/default behavior. OpenCode rejects this flag; configure its model in OpenCode instead.

The jump layout is a bottom-sorted selectable tree: oldest root groups are at the top, the most recently seen group is nearest the prompt, and the current session remains pinned nearest the prompt. In the unfiltered view, the current Workshop and its ancestor chain always stay expanded regardless of lineage size, and the picker initially selects the current Workshop. Other branches remain collapsible and navigation does not steal the user's selection. A lineage subtree is positioned by its most recently seen descendant. State does not participate in ordering; status is conveyed only by each node's color-coded aggregate-state glyph. Roots place the glyph before the disclosure marker, while nested sessions place it immediately after the `├─`/`└─` child connector. Window and clanker details stay collapsed by default and their names are summarized inline immediately after the owning session name, without moving status glyphs to the right edge. Small lineage subtrees with one to three direct child sessions begin expanded, as do larger subtrees containing a working or ready clanker. Expanding exact details renders subdued `·` rows with their own left-side state glyphs beneath the owning session. The bottom prompt filters the full hierarchy while retaining the complete ancestor context of every matching descendant; non-empty queries show only directly matching detail rows.

One long-lived Bun daemon owns observation, projection, mutations, side-effect reconciliation, startup/shutdown, and subscriptions. It publishes authoritative revisioned observations through a private mode-`0600` Unix socket. The Rust native client reads the atomic `state.json` at most once as a startup/crash fallback, then subscribes to the socket and retains the last valid observation across daemon replacement. JSON is never the live synchronization mechanism. A producer epoch lease scoped to the runtime and multiplexer instance prevents stale producers from publishing revisions.

Tree order, search fields, exact targets, and typed available actions are projected by the daemon. Rust/ratatui is the sole rendering/input Adapter; Bun is daemon and control plane only.

Structured lifecycle reports are the live source for Clanker state. Clankerhouse does not poll the OpenCode service: an OpenCode pane's state is Herdr's runtime agent status, which Herdr's pane-local OpenCode reporter keeps exact (including blocked on permissions and forms), and an owned OpenCode Clanker's attested report from the Clankerhouse plugin takes precedence once it arrives. `scripts/install --integrations` runs `herdr integration install opencode` when Herdr and OpenCode are on `PATH`; restart OpenCode TUIs and shared OpenCode servers afterwards, and remove it with `herdr integration uninstall opencode`. Without it Herdr falls back to screen detection. Herdr's per-pane agent detection may label an unmanaged harness for observation; Clankerhouse does not scan processes itself, and detection never creates Clanker identity, authorizes mutation, or enters the clanker ledger.

Directory activity is stored by canonical directory path under `$XDG_STATE_HOME/clankerhouse-herdr/activity` (default `~/.local/state/clankerhouse-herdr/activity`), so it survives cache, Herdr-server, and machine restarts. Session creation, picker target opening, active multiplexer work, and clanker lifecycle reports update that ledger. A sessionless directory's last-seen value is its newest durable event, modified/untracked file mtime, worktree HEAD reflog, or commit. Directory rows show the winning source and age, such as `[edited 12m]` or `[clanker 3h]`. Git fallback scans are cached for one minute.

The expanded durable registry is `$XDG_STATE_HOME/clankerhouse-herdr/registry.sqlite3`. It contains Workshops, Terminals, Clankers, imported Recovery records, append-only journal entries, leases, durable mutation stages, and validated Multiplexer Locations. On migration it transactionally imports supported `workshops.sqlite3`, `resources.sqlite3`, recovery v1/v2/v3, and legacy lineage data with provenance and foreign-key validation. Durable mutation operations use the registry immediately; imported domain rows remain behind the `legacy-mutable` compatibility gate until every installed legacy ingress has moved to the socket. Legacy databases therefore remain active compatibility/rollback inputs in this release rather than being rewritten in place. Worktree manifests, lifecycle files, and Herdr pane claims are projections or claims; they never override conflicting durable identity.

Claude Code state is reported through hooks installed by:

```bash
clankerhouse-install-claude-hooks
```

The installer registers startup as idle. Claude's `Stop` hook keeps the pane working and its generation unsettled while the hook payload reports running or pending background tasks (including shells and subagents); a later `Stop` with none in flight completes it. Scheduled future wakeups alone do not count as running work. Older Claude versions without task metadata retain their foreground-only completion behavior. Global hooks are silent no-ops outside Multiplexer panes or when their reporter is unavailable, so ordinary Claude terminals and environments sharing settings do not require Clankerhouse. It upgrades old unguarded Clankerhouse invocations and migrates stale `herdr-agent-state.sh` hooks only when that exact reporter is missing. It preserves unrelated hooks and existing Herdr scripts, saves the original settings to `settings.json.pre-clankerhouse-migration`, and leaves already-current settings untouched on reruns.

Those hooks write per-pane state into the same runtime cache directory, addressed by `HERDR_PANE_ID`. Pi uses the globally installed `pi/extensions/clanker-lifecycle.ts` extension for the same purpose, including Pi sessions started directly. It also exposes a mode-`0600` per-process Unix socket and routes incoming messages through native `pi.sendUserMessage`. Only Pi's terminal-UI session may own the pane: in-process SDK workers and sessionless subprocesses cannot overwrite its identity, lifecycle reports, or native socket. A Pi pane remains `working` while any in-process subagent is running or queued, even if the parent Pi session has settled. Reports carry lifecycle and settled generations plus bounded Pi result history. The cache server prefers these structured reports over pane-title heuristics and normalizes state as `blocked`, `working`, `done`, `idle`, or `unknown`. The UI renders those as blinking red `waiting`, animated orange `working`, green `ready`, blue `idle`, and purple `unknown`; plain non-clanker windows use a neutral gray `○`. A completed clanker remains ready until its pane/window is focused, then becomes idle; a later completion becomes ready again.

## Clanker API

Every clanker has a stable generated ID stored as a Multiplexer pane claim. The Multiplexer supplies discovery and metadata only; the API never types into, pastes into, or reads the screen of a pane for clanker communication. Herdr advertises a semantic agent-prompt capability: before submission Clankerhouse revalidates the exact pane's Clanker ID, and Herdr verifies that a recognized interactive agent still owns the pane and is not blocked.

```bash
clankers list [--cwd PATH] [--children-of [WORKSHOP] [--descendants]] [--state STATE,...]
clankers status CLANKER_ID
clankers capabilities CLANKER_ID
clankers wait CLANKER_ID [--after GENERATION | --message MESSAGE_ID] [--timeout SECONDS]
printf '%s' 'Continue with the tests' | clankers send CLANKER_ID [--delivery steer|follow-up] [--wait]
clankers send-status MESSAGE_ID
clankers result CLANKER_ID [--generation GENERATION]
clankers report --state question|blocked|done|failed|working [--message TEXT] [--payload JSON | --payload-file PATH | <JSON on stdin] [--to CLANKER_ID|WORKSHOP_ID | --no-parent]
clankers watch (--children-of [WORKSHOP] [--descendants] | --clanker ID...) [--cursor-file PATH] [--once] [--timeout SECONDS] [--stale-after SECONDS]
```

Successful responses are JSON. Errors are versioned JSON on stderr; unknown or ambiguous ids exit `3`, unsupported capabilities exit `4`, unavailable native endpoints exit `5`, and nondestructive wait timeouts exit `124`. A Multiplexer server that has run out of file descriptors is reported as `RESOURCE_EXHAUSTED` (exit `5`) with the remedy, and a `workshop spawn` that fails before its clanker exists removes the Workshop it just created.

`list` rows add `parentWorkshopId`, `workshop` (`id`, `path`, `branch`, and whether the path `exists`; null outside a registered Workshop), `alive` (the harness is still a foreground process of its pane; null when the Multiplexer gives no process facts), and `lastText` (the clanker's newest assistant text, at most 500 characters: Claude's from its session transcript, Pi's from its newest result; null otherwise). `--children-of` and `--descendants` select clankers exactly as `watch` does, and `--state working,blocked` keeps only clankers in those states (`working`, `blocked`, `done`, `idle`, `unknown`); unknown flags and states are errors.

`status` includes `lastEventAt`, the time of the clanker's newest lifecycle hook event, `lastReport`, its newest Report, and `health`, read-only facts about the clanker's systemd scope on Linux: `memory` (`current` and `high` bytes, `high` null when unlimited), `dState` (pids in the scope in uninterruptible sleep), and `longestChild` (`pid`, `cmd`, and `elapsed` seconds of the harness's longest-running descendant). Each field is absent when it cannot be read, for example for a clanker Clankerhouse did not launch in a scope. Every clanker Clankerhouse launches, including a resumed one, gets `CLANKER_ID`, `CLANKERHOUSE_WORKSHOP_ID`, and `CLANKERHOUSE_PARENT_WORKSHOP_ID` (empty for a root Workshop) in its environment.

### Orchestration: reports and watches

A worker clanker declares its state upward with `clankers report`, run from inside the clanker (`CLANKER_ID`, else the pane's Clanker claim, identifies it). The Report is addressed to the reporting Workshop's parent unless `--to` names a Workshop or clanker id or `--no-parent` records it unaddressed; a root Workshop's Reports are recorded with `to: null`. The payload must be one JSON object of at most 64 KiB. Reports are durable, ordered by `seq`, and kept in `$XDG_STATE_HOME/clankerhouse/orchestration.sqlite3`; a Report is the clanker's Declaration and never changes its lifecycle `state`.

A Report that needs the operator also asks Herdr to show a notification (`notification.show` with the request sound), titled `<state> · <Workshop title or branch>` with the message as its body. By default `question`, `blocked`, and `failed` notify. Set `CLANKERHOUSE_REPORT_NOTIFY` in the clankers' environment to a comma list of states to choose others, or to `none` to turn it off; Herdr's own `[ui.toast] delivery` decides whether and where it appears (`off`, its default, shows nothing). The Report is recorded first, and the notification never fails it or holds it up for more than about a second; Herdr declining (toasts off, no attached client, rate limit) is silent.

An orchestrator can narrow Herdr's Agents sidebar to its children:

```bash
clankers view children        # the current Workshop's child Workshops; or name one like --children-of
clankers view clear           # back to Herdr's normal agent list
```

The daemon writes each pane's Workshop parent as the pane token `ch_pane_parent` (Herdr agent views filter on pane tokens only), and `view children` installs an `agent.view.set` filter on it, owned by the `clankerhouse` source so `clear` never removes another owner's view. It shows direct children only, follows clankers that appear later, and lasts until cleared or replaced or until the Herdr server exits.

An orchestrator wakes on any child event with one background command:

```bash
clankers watch --children-of . --descendants --cursor-file temp/watch.cursor --once --timeout 3600
```

`watch` prints one JSON event per line: `reported` (a Report from a watched clanker, or addressed to the watched Workshop), `settled` (a turn finished), `stale` (still `working` with no hook event for `--stale-after` seconds, default 1800, once per silent stretch: a new hook event re-arms it within the same turn), `exited`, and `spawned` (a new clanker in a watched Workshop, including new descendant Workshops under `--descendants`). Watched clankers and Workshops are resolved again on every poll (every two seconds). `--children-of` resolves a Workshop like `clankers spawn --workshop`, with `.` or no value meaning the current Workshop. Without `--cursor-file` a watch starts from now. With one, the watch persists its starting point at once and records each event after printing it, so re-running `watch --once` with the same cursor resumes exactly where the last run stopped; a run killed between printing and recording repeats that one event rather than losing it. `--once` exits `0` after the first batch of events; `--timeout` exits `124` and leaves the cursor as it was.

Claude receives sends through a durable queue. A send to a Claude clanker that is `working` or `blocked`, whose pane has the Herdr input focus, or that already has messages waiting returns `"delivery": "queued"`; otherwise it is delivered at once. Every send returns a `messageId`. Queued messages are delivered one at a time, in order, once the clanker is `done` or `idle` and unfocused, and only after the previous one is acknowledged: the Claude `UserPromptSubmit` hook records each submitted prompt's SHA-256, and a message is `acked` when that hash appears in a newer turn, which becomes its `startedGeneration`. The daemon delivers when a clanker with waiting messages changes state or the input focus moves, and retries every 30 seconds while anything waits; `send --wait`, `wait --message`, `send-status`, and `watch` also run a delivery pass, so queues drain without a daemon. `send-status` reports `queued`, `delivered`, `acked`, or `orphaned` (the clanker disappeared; its messages are kept and never delivered elsewhere). A clanker that comes back, for example through `clankers resume`, still gets its queue; one that stays missing for 30 minutes, or whose Workshop is stopped, has its waiting messages orphaned for good, and nothing retries them. A message delivered but never acknowledged (the prompt was not submitted) holds its clanker's queue; it is visible as `delivered`. `send --wait` and `wait --message` wait for the acknowledgement and then for that turn to settle, returning the clanker status, `lastReport`, and that turn's `result`; Pi `send --wait` still returns its result.

Pi supports the complete API through its native socket and lifecycle reports. Busy sends default to a native follow-up, and Clankerhouse admits only one unsettled external message at a time so waits remain correlated. Pi processes that were already running when this update was installed need `/reload` or a restart to advertise the endpoint. Claude supports queued and immediate send through Herdr's semantic prompt operation and waits through Claude lifecycle reports; `--delivery follow-up` queues until the current turn ends (the default behavior), and `steer` remains unsupported. `clankers result` returns a settled generation's final assistant message, read from the Claude session transcript: the hook records the transcript path and each turn's start and settle times, and the result is the last text-bearing assistant message written in that window. Codex can be listed, but send/result operations fail explicitly, and Clankerhouse installs no Codex hooks, so a Codex clanker has no lifecycle report: its `status` state stays `unknown` with generation 0, `wait` returns at once because there is no turn to settle, and `wait --after` runs to its timeout. Codex's live state comes only from Herdr's screen detection, a runtime Observation that the TUI and daemon projection show and that reaches the daemon as a Herdr agent-status event. Clankerhouse mirrors Claude and Pi lifecycle reports into Herdr's own agent status from the daemon, never from the hook: Herdr's sidebar, notifications, and `herdr agent wait` follow the same `working`, `blocked`, and settled states, a settled turn is reported `idle`, and a session end hands the pane back to Herdr's own detection. Herdr also decides whether a finished clanker has been seen: it stays `done` (ready) until its Herdr tab is viewed, and goes straight to `idle` when its tab is on screen as the turn settles; seen is per tab, so viewing any pane of a tab marks all of them. A finished clanker Herdr holds no settled status for counts as seen only while its pane is focused. Herdr still shows `blocked` when it sees a permission prompt on screen, and a report the daemon reads more than 30 seconds late is not mirrored. Every harness can run `clankers report`. Claude and Pi rewrite their lifecycle report on every tool call, so `lastEventAt` and `stale` follow tool activity; Codex writes no lifecycle report, so `lastEventAt` stays empty and `watch` never reports its turns as settled or stale. OpenCode is currently monitor-only: mutation and lifecycle waiting remain disabled until its local contract is verified.

### Routines: a clanker's own wake-ups

A clanker can schedule its own wake-ups. A Routine is a cron expression plus the message the clanker receives when it fires:

```bash
clankers routine add --cron "0 9 * * 1-5" --tz Europe/Amsterdam --name standup --message "Check the PR queue and report"
clankers routine list                    # this clanker's routines (the operator sees every clanker's; --all, --clanker ID)
clankers routine show ROUTINE_ID
clankers routine update ROUTINE_ID --cron "30 8 * * 1-5"   # also --message, --name, --tz
clankers routine cancel ROUTINE_ID
```

Run from inside a clanker, a Routine belongs to that clanker (`CLANKER_ID`, else the pane's Clanker claim). `--clanker ID` names another clanker explicitly; it must be live or open in the clanker ledger. From inside a clanker, another clanker's Routine can be changed or cancelled only by naming its clanker with `--clanker`; the operator, outside any clanker, manages every Routine. The message may also come on stdin and is at most 64 KiB.

The cron expression has the standard five fields, `minute hour day-of-month month day-of-week`, with `*`, lists, ranges, `/` steps, `jan`–`dec` and `sun`–`sat` names, `7` for Sunday, and the macros `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. As in Vixie cron, when both day fields are restricted a day matching either one fires. The fields are read in the Routine's time zone: `--tz` (an IANA name), else `CLANKERHOUSE_TIMEZONE`, else `TZ`, else the host's zone (UTC on a server without a configured zone). The zone is resolved when the Routine is added and stored with it, so `0 9 * * *` in `Europe/Amsterdam` fires at 09:00 Amsterdam time summer and winter. A wall-clock time that a daylight-saving change skips does not fire that day; one it repeats fires twice. Every Routine command prints `nextFire` in the Routine's zone and `nextFireUtc`.

The daemon checks for due Routines every 15 seconds and delivers each through the same path as `clankers send` (`--delivery auto`), sent by `routine:ROUTINE_ID` with source `routine`: a settled clanker gets it at once as a new turn, and a busy, blocked, or focused Claude has it queued until it settles, so it never types over the operator's draft. Each occurrence is claimed before it is sent and sent with a request id derived from it, so it wakes the clanker at most once. Routines live in `orchestration.sqlite3` and survive daemon restarts. Occurrences missed while the daemon was down collapse into one, which fires late only within an hour of its time and is skipped otherwise. A wake is skipped while the Routine's previous wake is still queued. A failed send is recorded as `lastError` and the Routine waits for its next occurrence; a Routine whose clanker is closed in the ledger ends (`list --include-ended` shows it). An interrupted clanker keeps its Routines and gets them again after `clankers resume`.

Run the native TUI or Bun daemon directly:

```bash
clankerhouse
bun run server
```

The local daemon Interface exposes health/status, snapshot/subscription, projection refresh, typed mutation submission, and durable operation status. Open, rename, attach/reparent, detach, deletion, and repository/branch creation are idempotent intents; clients do not sequence Worktrunk, SQLite, Herdr, systemd, or manifest effects. Unknown intents and destructive requests without explicit confirmation are rejected.

The `Alt-K` Herdr binding launches Clankerhouse.

## Status hooks

The daemon can push clanker status to outside systems instead of being polled. Hooks are off until a config exists at `~/.config/clankerhouse/hooks.toml` (or under `$XDG_CONFIG_HOME`; a named instance reads `hooks-<instance>.toml`, and `CLANKERHOUSE_HOOKS_CONFIG` overrides the path). The file holds secrets, so it must be `chmod 600`; a file others can read is refused. It lives outside every repository, and `.gitignore` covers the name in case a copy lands in the checkout.

```toml
[[sinks]]
name = "groky"
url = "https://example.invalid/routines/ROUTINE/webhook"
events = ["clanker.*", "report.*", "message.stuck", "marker.*"]   # optional; default is every event
[sinks.headers]
X-Sender-Key = "SECRET"

[[sinks]]                     # optional: one command per event, event JSON on stdin
name = "local-log"
kind = "exec"
argv = ["/home/me/bin/on-clanker-event"]

[detect]                      # all optional; these are the defaults
debounce_seconds = 5          # a new state must hold this long, so flapping publishes nothing
exit_grace_seconds = 20       # a clanker must stay missing this long
stuck_message_seconds = 180   # how long a message may sit `delivered` without its ack
[detect.markers]              # setting this table replaces the default list
aws-login-pending = "temp/aws/login-pending"

[delivery]                    # all optional; these are the defaults
timeout_seconds = 10
retry_base_seconds = 5        # doubles on each failure
retry_max_seconds = 900
give_up_after_seconds = 86400
```

The daemon picks up a new or edited config at its next refresh; a broken edit is logged once and the last good config stays in force. Enabling hooks starts from now and replays nothing, and removing the config forgets the position, so enabling them later also starts from now. Webhook URLs must be `https` (plain `http` only on loopback).

| Event | When | `oldState` → `newState` |
|---|---|---|
| `clanker.settled` | A turn finished and the clanker waits for input | `working`/`blocked` → `done`/`idle` |
| `clanker.blocked` | The harness waits on a permission prompt | → `blocked` |
| `clanker.exited` | The clanker left while settled, or was closed on purpose | → `exited` |
| `clanker.crashed` | The clanker vanished mid-turn with no deliberate close | → `exited` |
| `report.done`, `report.question`, `report.blocked`, `report.failed` | A clanker filed that Report (`working` Reports publish nothing) | null → current lifecycle state |
| `message.stuck` | A message stayed `delivered` with no acknowledgement | `delivered` → `delivered` |
| `marker.<name>` | A Marker file appeared in a live clanker's worktree, and again if it returns after going away | `absent` → `present` |

Seeing a finished clanker (`done` → `idle`) publishes nothing. A turn start publishes nothing either; the next event says where it ended up. `oldState` is the last state detection settled on, so a state that lasted less than the debounce never appears. `clanker.crashed` is an inference, since the harness wrapper records no exit status: killing a working clanker's pane by hand counts as a crash. Codex clankers report no lifecycle state, so they publish only Reports.

Each webhook is a `POST` of this JSON, with `content-type: application/json`, `x-clankerhouse-event`, `x-clankerhouse-dedupe-key`, and the configured headers:

```json
{
  "version": 1,
  "id": "3e319db1-3a77-401a-8d1f-6a24448297ff",
  "dedupeKey": "clanker.settled:clanker-3f1c:1793565333775",
  "type": "clanker.settled",
  "timestamp": "2026-11-01T20:35:33.775Z",
  "at": 1793565333775,
  "host": "puffin",
  "clankerId": "clanker-3f1c",
  "workshopId": "f840979a-c2a0-4e35-ac86-6e4cfe5ca396",
  "workshop": "Push clanker status events to webhooks",
  "title": "Push clanker status events to webhooks",
  "repo": "clankerhouse",
  "branch": "status-hooks",
  "worktree": "/home/me/clankerhouse.status-hooks",
  "pane": "w2:p2",
  "harness": "claude",
  "oldState": "working",
  "newState": "done",
  "summary": "All tests pass; the branch is ready for review.",
  "prUrl": null,
  "details": { "settledGeneration": 4 }
}
```

`workshop` is the title, else the branch. `title`, `repo`, `branch`, `worktree`, `pane`, `harness`, `summary`, and `prUrl` can each be null; a Report's clanker that was never seen alive may have only its Workshop's facts. `summary` is a one-line excerpt of at most 500 characters of the clanker's last assistant text, else its last Report, so it leaves the host: point sinks only at systems allowed to read it. `prUrl` is the first pull-request URL found in the Report's payload (`prUrl`, `pr_url`, `pr`), the Workshop's `pr`, `pr_url`, or `_pr` label, or the clanker's words; Clankerhouse never asks the forge. `details` holds what is specific to the event: `seq`, `reportState`, `to`, and `payload` for Reports, `messageId`, `deliveredAt`, and `stuckSeconds` for stuck messages, `path` for Markers, `closedReason` for exits. Marker contents are never read or sent.

Events and deliveries are spooled in `status-events.sqlite3` in the instance state directory, together with the detection position, so a daemon restart neither loses nor repeats a transition, and pending deliveries continue. Delivery is at least once: a receiver drops a `dedupeKey` it has already seen. A timeout, a network failure, a 408, 425, 429, or 5xx, or a command's nonzero exit retries with backoff, honouring `Retry-After`, and pauses only that sink. Any other response, including a redirect, which is never followed so a key cannot reach another host, fails that event for good. A delivery past `give_up_after_seconds` fails too. Finished events are forgotten after 14 days.

`clankers hooks test [--sink NAME]` sends one sample (`type` `hooks.test`, `test` true) to each sink, ignoring its `events` filter and never retrying, and exits nonzero if one failed. `clankers hooks status [--json] [--limit N]` shows the config's state, totals per sink, and recent deliveries with their last error and next attempt; it shows a sink's host and header names, never its URL path or header values. The daemon logs delivery failures to its own log the same way.

## The clanker ledger and restarts

Clankerhouse does not relaunch anything on its own after a restart. Instead, every Pi, Claude, and OpenCode clanker it launches or sees is recorded in the clanker ledger, `$XDG_STATE_HOME/clankerhouse-herdr/clankers.sqlite3`: its Workshop and cwd, harness, launch options (profile, model, resource class), original task, and the harness session it is running. The session follows the harness, so after `/clear`, `/new`, or a resume the ledger names the conversation the pane actually holds. Pi and Claude get preallocated session IDs at launch; OpenCode's `ses_…` ID is recorded once its plugin binds it. Codex is not recorded because it has no exact resume contract.

A row is `open` while its clanker runs. The daemon closes it once the clanker has been gone for a minute while the same Herdr server keeps running: its pane was closed, its harness exited, or its Workshop was stopped. A clanker that was running when the host or Herdr went down was last seen in an earlier Herdr server, so its row stays open. After a restart, the open rows that are not alive are exactly the interrupted clankers:

```sh
clankers ledger --interrupted        # what was running when the host or Herdr went down
clankers resume CLANKER_ID [--prompt TEXT]
clankers ledger close CLANKER_ID     # not coming back; also stops its harness if it runs
clankers ledger [--state open|closed] [--workshop ID]
```

`clankers resume` opens one agent tab in the clanker's Workshop and continues its exact session under the same clanker id, with its saved profile and model. It sends no prompt unless `--prompt` is given, so nothing interrupted is replayed; asking a clanker to read `clankers ledger --interrupted` and resume what still matters is the intended recovery. Herdr's own agent restore stays off (`clankerhouse-install-herdr` sets `resume_agents_on_restore = false`).

On first start the ledger imports the records of the retired Recovery store, `recovery.sqlite3`, which is left in place.

Tracked harnesses run in per-Clanker systemd scopes under `clankerhouse-recovery.slice` (a historical name), which always receives low CPU and I/O weights. New clankers can declare `--resource-class interactive|validation-heavy|untrusted`; undeclared and migrated workloads use the conservative `untrusted` budget. When delegated by systemd, `CLANKERHOUSE_IO_READ_BANDWIDTH_MAX='/dev/DEVICE 60M'` adds a hard per-scope device limit. The server must keep the user systemd manager running after logout (normally via `loginctl enable-linger $USER`).

## Titles and fading

A Workshop can have a title: a human name such as "Migrate OpenCode adapter to v2". It is shown as the row's name with the branch dimmed on the right, it is searchable, and the Herdr workspace is renamed to match. Set it when creating a Workshop (see the branch flow below, or `clankers workshop spawn --title "…"`, which derives the branch when `--name` is omitted), and edit it with `Alt-R` on a Workshop row; an empty title clears it. Editing a title never renames the branch. A title is stored as the `title` label, so `clankers workshop label set "title=…"` works too and repository hooks see it.

The picker lists the Workshops of every project. Each row's name is shown in a colour derived from its project (repository) name, so one project is always the same colour. The root of each lineage also names its project as a tag in that colour, and drops the repeated `project@` prefix when it has no title. Labels follow the name, each in a colour derived from the label, with `done` in gray. Search matches the title, branch, labels, and project.

Row names fade with age without moving: seen within a day is normal, one to three days is dimmed, older is dimmer. A faded row keeps its project's hue. State glyphs keep full colour, and the current Workshop never fades. The working glyph is the only one that animates.

## Workshop labels and repository hooks

A Workshop can carry `key=value` labels. Clankerhouse stores them, shows their values as coloured tags after the Workshop name, and makes them searchable; they never affect ordering. The only label Clankerhouse itself acts on is `status=done`. A key that starts with `_`, such as `_retro=…`, is hidden: it is stored and passed to hooks (as `CLANKERHOUSE_LABEL__RETRO`) but never shown or searched, which is where a hook's own bookkeeping belongs.

`Alt-D` on a worktree Workshop marks it done instead of deleting it. Nothing else changes: its clankers, session, and worktree stay. `Alt-D` on a done Workshop asks whether to destroy it (`y`) or reopen it (`u`, which clears the label). A done Workshop that is then left alone for seven days is deleted automatically; using it again restarts the seven days. The reaper never deletes a worktree with uncommitted changes or with a clanker that is working, waiting, or finished but unseen, and it keeps the branch. Set `CLANKERHOUSE_DONE_TTL_DAYS` for the daemon to change the retention, or to `0` to turn automatic deletion off.

```bash
clankers workshop label set stage=implementing   # current Workshop; --cwd PATH for another, --workshop ID|BRANCH|PATH even after its worktree is gone
clankers workshop label unset stage
clankers workshop label list
clankers workshop stop                            # release the live session; keep the worktree
clankers workshop detach ID|BRANCH|PATH            # make a Workshop top-level; defaults to the current one
clankers workshop reparent ID|BRANCH|PATH --parent ID|BRANCH|PATH   # move it under another Workshop
```

The daemon also shows each Workshop's visible labels on its Herdr workspaces as workspace tokens: `lbl_<key>` holds one label's value and `labels` holds all values in key order, space-separated. The workspace is the one carrying the Workshop's claim, or else one whose path is the Workshop's worktree, as for the row. The title is not repeated there, since it already names the workspace, and hidden keys are left out. Herdr caps a report at 16 tokens, so the first 15 keys by name get their own token; the rest, and any key longer than 28 characters, appear only in `labels`, which Herdr truncates at 80 characters. Changes reach Herdr on the daemon's next observation, and tokens are written again after a cold Herdr restart, which drops them. Clankerhouse never edits Herdr's configuration; to see the labels, add them to the Space sidebar rows in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$labels"],                 # or pick keys: ["$lbl_stage", "$lbl_status"]
]
```

`clankers workshop spawn` makes the Workshop of the current directory the new one's parent; `--parent ID` names another and `--no-parent` makes it top-level. `clankers workshop detach` and `reparent` change that link later, through the same daemon mutation as `Alt-L` and `Alt-A`: the Workshop registry, the worktree's `.clankerhouse/workshop.json`, and the session's multiplexer claim move together, while the Workshop's subtree, clankers, panes, worktree, and branch stay as they are. A running clanker's `CLANKERHOUSE_PARENT_WORKSHOP_ID` keeps its launch value until the clanker next starts. Both print the Workshop's old and new parent as JSON and accept an ID, branch, or worktree path. Detaching a top-level Workshop changes nothing, and a parent that is unknown, in another repository, or inside the Workshop's own subtree is rejected.

`clankers workshop stop` releases what a finished Workshop holds live and keeps what is durable. Its clankers are closed in the clanker ledger, so they are not listed as interrupted; their waiting messages are orphaned; and its multiplexer sessions or Herdr workspaces close. The worktree, branch, labels, and lineage stay, and the Workshop stays listed as a row without a session; opening it starts a plain shell. Stopping never happens on its own: a `labels-changed` hook decides when, for example when a Workshop is marked done. Stopping a stopped Workshop does nothing.

A repository gives labels meaning, and prepares new Workshops, with optional tracked executables run with the Workshop as working directory:

- `.clankerhouse/hooks/labels-changed` runs detached after a label really changes. It cannot fail the change.
- `.clankerhouse/hooks/done` replaces the built-in `Alt-D` rule for that repository. Exit `0` means the repository handled the key. Exit `1` falls through to the destroy confirmation. Any other exit, or a run longer than 30 seconds, is shown as an error and nothing is destroyed.
- `.clankerhouse/hooks/post-create` runs detached once a new worktree Workshop exists, for example to install dependencies and seed caches while the first clanker starts. It runs in its own systemd scope under the clanker resource budget. Its output, ending with its exit status, goes to `<git common dir>/clankerhouse/hooks/post-create/<workshop id>.log`.

All receive `CLANKERHOUSE_HOOK_EVENT`, `CLANKERHOUSE_WORKSHOP_ID`, `CLANKERHOUSE_WORKSHOP_PATH`, `CLANKERHOUSE_WORKSHOP_BRANCH`, `CLANKERHOUSE_LABELS` (JSON), and one `CLANKERHOUSE_LABEL_<KEY>` per label; `labels-changed` also receives `CLANKERHOUSE_PREVIOUS_LABELS` and `CLANKERHOUSE_PREVIOUS_LABEL_<KEY>`. `clankers` is on their `PATH`. A repository usually needs only `labels-changed`. For example, to start a retro when a Workshop is marked done:

```sh
#!/bin/sh
if [ "${CLANKERHOUSE_LABEL_STATUS:-}" = done ] && [ "${CLANKERHOUSE_PREVIOUS_LABEL_STATUS:-}" != done ]; then
    clankers spawn --workshop "$CLANKERHOUSE_WORKSHOP_ID" --name retro --harness claude --prompt "Run the retro for this workshop."
fi
```

The same two hooks can also live outside the repository, at `~/.config/clankerhouse/hooks/<project>/<event>` (or under `$XDG_CONFIG_HOME`), where `<project>` is the repository's directory name. Such a hook applies to every Workshop of that project, including branches created before it existed, and adds nothing to a shared repository. A hook inside the Workshop wins over it. Both kinds also receive `CLANKERHOUSE_PROJECT`.

Hooks in a repository are repository-supplied code that runs without a prompt, so rely on them only in repositories you trust.

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
- `Alt-R`: edit the selected Workshop's title; on a row that is not a Workshop, rename the Herdr workspace without changing its identity
- `Alt-A`: search valid projected parent workshops and attach the selected workshop beneath one; candidates come from the authoritative lineage projection rather than the optional repository-picker cache
- `Alt-L`: detach the selected workshop from its parent, making its existing subtree top-level
- Type or paste: structured fuzzy-filter rows and fill the branch/base form; current selection is preserved when it still matches
- `Alt-K` while Clankerhouse is open: choose a repository, then open an existing worktree/branch or type a new branch name to create it; in the Needs-me view, back to the full map
- `Alt-I`: the Needs-me view, from any picker mode (below)
- `Ctrl-R`: refresh remotes while in the branch picker
- `Alt-D`: on a worktree Workshop, mark it done; on a done Workshop, confirm destruction or reopen it (see Workshop labels). On a pane or plain session, confirm deletion of the selected target. Deletion runs on the daemon while the picker remains usable: search, select, expand, and press Enter to jump to another Workshop without waiting. Leaving waits only for durable submission; an accepted deletion continues after the picker closes. Only one mutation is started at a time from a picker. Worktree deletion also closes its linked sessions and splices any children to the former parent. Outside Clankerhouse, Alt-D follows the same rule for the invoking Herdr workspace/worktree; cancellation leaves it untouched.
- `Esc`: clear search, move back one flow step, or close
- `Ctrl-C`: close

On startup, the Herdr workspace that opened the popup is selected when it appears in the jump list. Renaming stays inside Clankerhouse and preserves the session's canonical path metadata and included clankers.

Run every static check, unit/component suite, and isolated standalone end-to-end scenario through the authoritative top-level entrypoint:

```bash
./test                 # everything
./test --unit          # feature coverage plus TypeScript, Python, and Rust
./test --standalone    # every real daemon/Herdr/TUI/integration simulation
```

`docs/features.json` is the feature-to-unit/standalone/manual acceptance catalogue. `scripts/check-feature-coverage` fails when a functional-core feature lacks unit tests, any feature lacks standalone/manual coverage, or a discovered unit-test file is uncatalogued.

Project-local Agent Skills are shared by Pi and OpenCode through `.agents/skills/`: Pi exposes `/skill:manual-qa` and `/skill:troubleshoot`; OpenCode exposes `/manual-qa` and `/troubleshoot`. Pi also provides the convenience prompt templates `/qa` and `/troubleshoot`. Manual QA treats the agent as the semantic judge and retains evidence under `.qa-artifacts/`; troubleshooting is read-only until live mutations are explicitly confirmed.

Capture a deterministic lineage render from a disposable real Rust/ratatui fixture with:

```bash
CLANKERHOUSE_QA_ROOT=/tmp/qa-clankerhouse-lineage CLANKERHOUSE_QA_KEEP=1 CLANKERHOUSE_QA_VISUAL=1 scripts/qa
```

Then inspect `/tmp/qa-clankerhouse-lineage/lineage-render.txt`. The capture should show session-only lineage connectors, inline `main`/clanker summaries, and subdued bullet detail rows for an explicitly expanded child session.

The branch flow always begins with the repository picker; it never infers a repository from the current pane or selected jump target. Selecting a repository immediately shows cached refs and starts `git fetch --all --prune` in the background; remote rows are ordered by most recent commit and refresh when the fetch settles. In the branch picker, a query without an exact branch match adds a `create new workshop with this title` row. What you typed becomes the Workshop's title and its branch is derived from it (lowercase, dash-separated, at most 50 characters, suffixed if taken); something already shaped like a branch name is used as the branch verbatim. Selecting the row shows the derived branch and asks for the base before creating the worktree and session; the default base (`^`) is the remote's default branch, fetched just before the worktree is created, so a stale local default never leaks in. When the remote cannot be reached (after one retry), the Workshop starts from the last fetched `origin/<default>` instead, and the daemon log says so. Alt-B opens the same TUI directly at the repository picker.

Alt-N, or Alt-N inside the picker, makes a scratch Workshop: choose a repository and Clankerhouse creates a Workshop off the freshly fetched default branch, titled by the time (`scratch 11-03 09:14`, branch `scratch-11-03-09-14`), and opens a `claude` there with no first message (`CLANKERHOUSE_SCRATCH_HARNESS` picks another harness). Rename the Title if it becomes real work; mark it Done with Alt-D when finished, and the Reaper removes it later. The same is `clankers workshop spawn --scratch --harness claude` from a repository.

Alt-I, or Alt-I inside the picker, opens the Needs-me view: a flat list of only the open Workshops (those with a live session) that need the operator, one row each, with the Alt-K row's title, project and label tags, why it is listed and for how long, and on a second line the first line of the clanker's own question or report. It is a list to choose from, never a jump to the next one. A Workshop is listed when, most pressing first:

- a clanker asked a question or reported itself blocked (`clankers report --state question|blocked`) during its current turn, or sits blocked, on a permission prompt or otherwise: `asked 12m ago`, `blocked 1h · permission prompt`;
- a clanker finished a turn the operator has not looked at (Herdr's `done` before the tab is viewed): `finished 3h ago, not seen`;
- a clanker reported `failed`, shows failed, lost its harness (hc keep), or is an Interrupted Clanker: `failed 1h ago`, `crashed 2d ago`, `interrupted 2d ago`;
- the Workshop carries a "your move" Label, `stage=needs-input` or `stage=waiting-for-approval` by default (`CLANKERHOUSE_YOUR_MOVE_LABELS=key=value,...` replaces the set, `none` turns it off), shown with how long it has had it;
- nothing is running, the worktree is clean and it has been idle a day: `clean, idle 6d · ready to close`;
- it has had no activity for the Reaper's retention period (`CLANKERHOUSE_DONE_TTL_DAYS`, seven days by default): `no activity 9d`.

A Workshop where a clanker is working and nothing is asked of the operator is not listed, and a Done Workshop is listed only for a question, a block, a failure, or as ready to close. The daemon decides all of this once per snapshot (`src/needs-me.ts`), so the view and the Herdr app's `N need you · M open` count agree. Rows sort by group (questions and blocks, then unseen finished turns, then failures, then your-move labels, then ready to close and stale), the longest waiting first within a group, nearest the prompt first as in Alt-K. Enter jumps to the clanker that needs attention, or the Workshop; Alt-D marks Done or offers deletion exactly as on an Alt-K row; typing filters; Alt-K switches to the full map; Esc clears the search, then closes. An empty list says you are caught up. `clankerhouse-hc --needs-me` (or `clankerhouse-herdr --needs-me`) opens the picker there.

Not implemented yet:
- `Ctrl-Y` copy PR URL

# Clankerhouse

Clankerhouse is a thin plugin on the [Rex](https://www.superlogical.com/rex/docs) terminal multiplexer for working with
coding agents: Workshops (a worktree, its branch, its lineage and labels) and the visible agent sessions in them, with a
Rust/ratatui picker and a Bun/TypeScript CLI. Rex is the truth for what runs; Clankerhouse keeps only what Rex cannot
express. See [docs/rex.md](docs/rex.md) for setup and [ADR-0012](docs/adr/0012-a-thin-plugin-on-rex.md) for the design.

## Installation

Install Rex and lift its session cap, build this checkout, link `bin/clankerhouse-rex` as
`~/.config/rex/clankerhouse-rex` on every host, and load `contrib/rex/clankerhouse.lua` from the Rex config of the
machine running the Rex app (docs/rex.md has the commands). Cmd+K then opens the picker over the focused pane, on that
pane's host.

Required runtime tools are Rex, Bun, Git and Python 3. Worktrunk (`wt`), jq, zoxide, and individual harness CLIs are
capability-specific.

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
Claude gets a bracketed paste into its Rex pane.
An already-running Pi must be reloaded after integration updates.
The plugin also defines `ClankerSendReference`, `ClankerSendContents`,
`ClankerAppendContext`, `ClankerFocus`, and `ClankerSpawn`. Discovery and focus
go through the Clankerhouse Multiplexer Interface.
No mappings are installed unless configured.

A **workshop** is a durable Worktrunk worktree plus its canonical, lazily created Rex session. A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session inside a workshop. Those products are harnesses, not clankers, and harness-native in-process subagents are not clankers.

```bash
clankers workshop spawn --name feature-x --harness pi
clankers spawn --workshop feature-x --name reviewer --harness claude --model sonnet
```

The first command creates branch/worktree `feature-x` through Worktrunk, records its durable workshop identity and parent lineage, and starts the initial clanker as the session’s only tab (no extra `main` shell tab). The second resolves `feature-x` uniquely in the current repository and adds a `reviewer` clanker to the same workshop without creating a worktree or lineage edge. Both accept `--prompt`; when omitted it is exactly `Ready for instructions.`. Workshop and window names are labels, while returned `clankerId` values are opaque identity.

Spawning into a Workshop with no live session also starts with just the agent tab, including on `clankers resume`. Adding a clanker to an existing session preserves its tabs. Shell-only `clankers workshop ensure` still opens a `main` terminal.

Both spawn commands accept `--model MODEL` for Pi, Claude, and Codex. The value is passed unchanged to the harness (no model-name allowlist) and overrides the model selected by `--profile` or harness defaults. Pi and Claude keep the override in the clanker ledger for `clankers resume`; omitting it preserves existing profile/default behavior. OpenCode rejects this flag; configure its model in OpenCode instead.

The jump layout is a bottom-sorted selectable tree: oldest root groups are at the top, the most recently seen group is nearest the prompt, and the current session remains pinned nearest the prompt. In the unfiltered view, the current Workshop and its ancestor chain always stay expanded regardless of lineage size, and the picker initially selects the current Workshop. Other branches remain collapsible and navigation does not steal the user's selection. A lineage subtree is positioned by its most recently seen descendant. State does not participate in ordering; status is conveyed only by each node's color-coded aggregate-state glyph. Roots place the glyph before the disclosure marker, while nested sessions place it immediately after the `├─`/`└─` child connector. Window and clanker details stay collapsed by default and their names are summarized inline immediately after the owning session name, without moving status glyphs to the right edge. Every other lineage begins collapsed; its root's glyph still shows the aggregate state of what is below it. Expanding exact details renders subdued `·` rows with their own left-side state glyphs beneath the owning session. The bottom prompt filters the full hierarchy while retaining the complete ancestor context of every matching descendant; non-empty queries show only directly matching detail rows.

There is no daemon. `clankers snapshot` computes the picker's rows from one Rex observation and the stores; `clankers snapshot --watch` (what the picker follows) recomputes on Rex events and store changes. `clankers mutate --json INTENT` runs one typed, staged, journaled mutation in-process; an interrupted one resumes from its last stage. `clankers runner` does only timed work (message delivery, Routines, status sinks, the done-Workshop reaper, caches). [docs/rex.md](docs/rex.md) lists which store owns which fact.

Tree order, search fields, exact targets, and typed available actions are projected by the snapshot. Rust/ratatui is the sole rendering/input Adapter; Bun is the CLI and control plane.

A clanker's state is what its agent reports to Rex (OSC 7501): working, blocked (with the question or permission), done or idle. The lifecycle hooks and the Pi and OpenCode integrations record turns, generations, prompts and messages, and their state stands in only for an agent that reports nothing to Rex. Detection never creates Clanker identity, authorizes mutation, or enters the clanker ledger.

Directory activity is stored by canonical directory path under `$XDG_STATE_HOME/clankerhouse-rex/activity` (default `~/.local/state/clankerhouse-rex/activity`), so it survives cache, Rex-server, and machine restarts. Session creation, picker target opening, active multiplexer work, and clanker lifecycle reports update that ledger. A sessionless directory's last-seen value is its newest durable event, modified/untracked file mtime, worktree HEAD reflog, or commit. Directory rows show the winning source and age, such as `[edited 12m]` or `[clanker 3h]`. Git fallback scans are cached for one minute.

Claude Code state is reported through hooks installed by:

```bash
clankerhouse-install-claude-hooks
```

The installer registers startup as idle. For `clankers wait`, Claude's `Stop` hook keeps the turn and its generation unsettled while the hook payload reports running or pending background tasks (including shells and subagents); a later `Stop` with none in flight completes it. Scheduled future wakeups alone do not count as running work. Older Claude versions without task metadata retain their foreground-only completion behavior. Global hooks are silent no-ops outside Rex panes or when their reporter is unavailable, so ordinary Claude terminals and environments sharing settings do not require Clankerhouse. It upgrades old unguarded Clankerhouse invocations and migrates stale `herdr-agent-state.sh` hooks only when that exact reporter is missing. It preserves unrelated hooks, saves the original settings to `settings.json.pre-clankerhouse-migration`, and leaves already-current settings untouched on reruns.

Those hooks write per-pane reports into the runtime cache directory, addressed by `REX_BLOCK`. Pi uses the globally installed `pi/extensions/clanker-lifecycle.ts` extension for the same purpose, including Pi sessions started directly. It also exposes a mode-`0600` per-process Unix socket and routes incoming messages through native `pi.sendUserMessage`. Only Pi's terminal-UI session may own the pane: in-process SDK workers and sessionless subprocesses cannot overwrite its identity, lifecycle reports, or native socket. A Pi pane remains `working` while any in-process subagent is running or queued, even if the parent Pi session has settled. Reports carry lifecycle and settled generations plus bounded Pi result history. State is normalized as `blocked`, `working`, `done`, `idle`, or `unknown`. The UI renders those as blinking red `waiting`, animated orange `working`, green `ready`, blue `idle`, and purple `unknown`; plain non-clanker windows use a neutral gray `○`. A completed clanker remains ready until its pane/window is focused, then becomes idle; a later completion becomes ready again.

## Clanker API

Every clanker has a stable generated ID stored as a claim on its Rex pane. Rex supplies discovery and metadata only; the API never reads the screen of a pane for clanker communication. Before it pastes a message into a pane, Clankerhouse revalidates the pane's Clanker ID and checks that the agent still owns the pane and is not blocked.

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

An orchestrator wakes on any child event with one background command:

```bash
clankers watch --children-of . --descendants --cursor-file temp/watch.cursor --once --timeout 3600
```

`watch` prints one JSON event per line: `reported` (a Report from a watched clanker, or addressed to the watched Workshop), `settled` (a turn finished), `stale` (still `working` with no hook event for `--stale-after` seconds, default 1800, once per silent stretch: a new hook event re-arms it within the same turn), `exited`, and `spawned` (a new clanker in a watched Workshop, including new descendant Workshops under `--descendants`). Watched clankers and Workshops are resolved again on every poll (every two seconds). `--children-of` resolves a Workshop like `clankers spawn --workshop`, with `.` or no value meaning the current Workshop. Without `--cursor-file` a watch starts from now. With one, the watch persists its starting point at once and records each event after printing it, so re-running `watch --once` with the same cursor resumes exactly where the last run stopped; a run killed between printing and recording repeats that one event rather than losing it. `--once` exits `0` after the first batch of events; `--timeout` exits `124` and leaves the cursor as it was.

Claude receives sends through a durable queue. A send to a Claude clanker that is `working` or `blocked`, whose pane has the Rex input focus, or that already has messages waiting returns `"delivery": "queued"`; otherwise it is delivered at once. Every send returns a `messageId`. Queued messages are delivered one at a time, in order, once the clanker is `done` or `idle` and unfocused, and only after the previous one is acknowledged: the Claude `UserPromptSubmit` hook records each submitted prompt's SHA-256, and a message is `acked` when that hash appears in a newer turn, which becomes its `startedGeneration`. The runner delivers when a clanker with waiting messages changes state or the input focus moves, and retries every 30 seconds while anything waits; `send --wait`, `wait --message`, `send-status`, and `watch` also run a delivery pass, so queues drain without the runner. `send-status` reports `queued`, `delivered`, `acked`, or `orphaned` (the clanker disappeared; its messages are kept and never delivered elsewhere). A clanker that comes back, for example through `clankers resume`, still gets its queue; one that stays missing for 30 minutes, or whose Workshop is stopped, has its waiting messages orphaned for good, and nothing retries them. A message handed over but never acknowledged is retried with the same id, at most three times; one still unacknowledged once its clanker is idle again is checked against the session transcript and, if absent there, orphaned as `undelivered` so it stops holding the queue (a late acknowledgement still lands it). Typed delivery dismisses Claude's usage-limit dialog, clears the input line (ctrl+u) before pasting, and reads the input box back after Enter: a prompt still sitting there gets Enter again, and one that never leaves counts as unconfirmed. Every send reports `status` (`queued` with `heldBecause`, `handed-over`, or `delivered`); `send --wait-delivered` waits until the message is proven in the session. The runner's delivery watch tells a clanker sender (with a `[clankerhouse delivery]` message) when its message has been held 10 minutes and why, when it failed, and when it landed after such a notice; a hold that waiting will not fix (usage limit, recipient gone or silent, hand-off never taken) or one older than 3 hours is escalated after 45 minutes as a `message.undelivered` Status Event (one per recipient while open) and a needs-me row, cleared by delivery or `clankers send-status MESSAGE_ID --dismiss`. A Claude turn that ends on an API error fires StopFailure: a usage limit or account error leaves the clanker `blocked` with Claude's message (for example its reset time), and other errors settle the turn (so does Claude's own report of an API-error stop, which is not waiting on a person). A Claude clanker waiting on its question menu (AskUserQuestion) gets a queued message as the menu's answer: the free-text option is picked and the message typed there, as a person would, and its tag in the session transcript is the proof. `clankers send-status MESSAGE_ID --cancel` withdraws a message that has not landed (orphaned as `cancelled`; the delivery watch tells its sender). A `question`, `blocked`, `failed` or `done` Report addressed to someone that no `clankers watch` has shown within a minute is delivered to the addressee's live clanker as a message. `send --wait` and `wait --message` wait for the acknowledgement and then for that turn to settle, returning the clanker status, `lastReport`, and that turn's `result`; Pi `send --wait` still returns its result.

Pi supports the complete API through its native socket and lifecycle reports. Busy sends default to a native follow-up, and Clankerhouse admits only one unsettled external message at a time so waits remain correlated. Pi processes that were already running when this update was installed need `/reload` or a restart to advertise the endpoint. Claude supports queued and immediate send through a bracketed paste into its Rex pane and waits through Claude lifecycle reports; `--delivery follow-up` queues until the current turn ends (the default behavior), and `steer` remains unsupported. `clankers result` returns a settled generation's final assistant message, read from the Claude session transcript: the hook records the transcript path and each turn's start and settle times, and the result is the last text-bearing assistant message written in that window. Codex can be listed, but send/result operations fail explicitly, and Clankerhouse installs no Codex hooks, so a Codex clanker has no lifecycle report: its `status` state stays `unknown` with generation 0, `wait` returns at once because there is no turn to settle, and `wait --after` runs to its timeout. Codex's live state is what it reports to Rex. Every harness can run `clankers report`. Claude and Pi rewrite their lifecycle report on every tool call, so `lastEventAt` and `stale` follow tool activity; Codex writes no lifecycle report, so `lastEventAt` stays empty and `watch` never reports its turns as settled or stale. OpenCode is currently monitor-only: mutation and lifecycle waiting remain disabled until its local contract is verified.

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

The runner checks for due Routines every 15 seconds and delivers each through the same path as `clankers send` (`--delivery auto`), sent by `routine:ROUTINE_ID` with source `routine`: a settled clanker gets it at once as a new turn, and a busy, blocked, or focused Claude has it queued until it settles, so it never types over the operator's draft. Each occurrence is claimed before it is sent and sent with a request id derived from it, so it wakes the clanker at most once. Routines live in `orchestration.sqlite3` and survive runner restarts. Occurrences missed while the runner was down collapse into one, which fires late only within an hour of its time and is skipped otherwise. A wake is skipped while the Routine's previous wake is still queued. A Routine belongs to its clanker's Workshop (`workshopId`), so it outlives the clanker. A clanker that closes and comes back as a new clanker in the same Workshop keeps it, sees it in `routine list` and may change it. At a fire the wake goes to the Routine's clanker while it lives, else to the Workshop's live clanker (preferring one on the same harness session). With none live, the runner resumes the Workshop's last session (`clankers resume`), waits up to three minutes (`CLANKERHOUSE_ROUTINE_RESUME_WAIT_MS`) for its harness to report in and settle, and then delivers. The clanker that takes a wake becomes the Routine's `clankerId`.

A wake counts only once the session shows it: the hook saw it submitted, or its message id is in the session transcript. One still unseen three minutes after hand-off is typed into the pane once more (when the pane is settled and unfocused), and one still unseen three minutes after that is a breakage. A wake queued behind a running turn waits as long as the turn does.

When a fire cannot be delivered (resume failed, the session never came up, the send failed, the wake never landed), the Routine is **broken**. `alert` records why, and `missedAt` the newest occurrence that did not land. Each breakage is announced once, however many fires it misses: one `routine.broken` Status Event for the sinks that want it (e.g. an exec sink that pushes to a phone) and one row in `clankers needs-me` (reason `routine-broken`), listed even when the Workshop has no open session. Later fires keep trying, resume included. When a clanker is back in the Workshop, the newest missed occurrence fires once (`caught-up`), and a wake that lands clears the alert. A Workshop marked done (`status=done`) or no longer registered or on disk (removed, self-destructed) ends its Routines loudly: a `routine.ended` event and a `routine-ended` needs-me row, kept for 7 days. `clankers routine dismiss ROUTINE_ID` clears an alert. A Routine from before Workshops owned Routines is bound to its clanker's Workshop at its next fire.

Cmd+K in Rex opens the picker (`contrib/rex/clankerhouse.lua`); `clankerhouse-rex --popup` runs it in any Rex pane. Open, rename, attach/reparent, detach, deletion, and repository/branch creation are idempotent intents run by `clankers mutate`; clients do not sequence Worktrunk, SQLite, Rex, systemd, or manifest effects. Unknown intents and destructive requests without explicit confirmation are rejected.

## Status hooks

The runner can push clanker status to outside systems instead of being polled. Hooks are off until a config exists at `~/.config/clankerhouse/hooks.toml` (or under `$XDG_CONFIG_HOME`; a named instance reads `hooks-<instance>.toml`, and `CLANKERHOUSE_HOOKS_CONFIG` overrides the path). The file holds secrets, so it must be `chmod 600`; a file others can read is refused. It lives outside every repository, and `.gitignore` covers the name in case a copy lands in the checkout.

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

The runner picks up a new or edited config at its next refresh; a broken edit is logged once and the last good config stays in force. Enabling hooks starts from now and replays nothing, and removing the config forgets the position, so enabling them later also starts from now. Webhook URLs must be `https` (plain `http` only on loopback).

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

Events and deliveries are spooled in `status-events.sqlite3` in the instance state directory, together with the detection position, so a runner restart neither loses nor repeats a transition, and pending deliveries continue. Delivery is at least once: a receiver drops a `dedupeKey` it has already seen. A timeout, a network failure, a 408, 425, 429, or 5xx, or a command's nonzero exit retries with backoff, honouring `Retry-After`, and pauses only that sink. Any other response, including a redirect, which is never followed so a key cannot reach another host, fails that event for good. A delivery past `give_up_after_seconds` fails too. Finished events are forgotten after 14 days.

`clankers hooks test [--sink NAME]` sends one sample (`type` `hooks.test`, `test` true) to each sink, ignoring its `events` filter and never retrying, and exits nonzero if one failed. `clankers hooks status [--json] [--limit N]` shows the config's state, totals per sink, and recent deliveries with their last error and next attempt; it shows a sink's host and header names, never its URL path or header values. The runner logs delivery failures to its own log the same way.

## The clanker ledger and restarts

Clankerhouse does not relaunch anything on its own after a restart. Instead, every Pi, Claude, and OpenCode clanker it launches or sees is recorded in the clanker ledger, `$XDG_STATE_HOME/clankerhouse-rex/clankers.sqlite3`: its Workshop and cwd, harness, launch options (profile, model, resource class), original task, and the harness session it is running. The session follows the harness, so after `/clear`, `/new`, or a resume the ledger names the conversation the pane actually holds. Pi and Claude get preallocated session IDs at launch; OpenCode's `ses_…` ID is recorded once its plugin binds it. Codex is not recorded because it has no exact resume contract.

A row is `open` while its clanker runs. The runner closes it once the clanker has been gone for a minute while the same Rex server keeps running: its pane was closed, its harness exited, or its Workshop was stopped. A clanker that was running when the host or Rex went down was last seen in an earlier Rex server, so its row stays open. After a restart, the open rows that are not alive are exactly the interrupted clankers:

```sh
clankers ledger --interrupted        # what was running when the host or Rex went down
clankers resume CLANKER_ID [--prompt TEXT] [--account LABEL]
clankers ledger close CLANKER_ID     # not coming back; also stops its harness if it runs
clankers ledger [--state open|closed] [--workshop ID]
```

`clankers resume` opens one agent tab in the clanker's Workshop and continues its exact session under the same clanker id, with its saved profile and model. It sends no prompt unless `--prompt` is given, so nothing interrupted is replayed; asking a clanker to read `clankers ledger --interrupted` and resume what still matters is the intended recovery.

On first start the ledger imports the records of the retired Recovery store, `recovery.sqlite3`, which is left in place.

Tracked harnesses run in per-Clanker systemd scopes under `clankerhouse-clankers.slice`, which always receives low CPU and I/O weights; `scripts/install --systemd` renders its aggregate budget, which may use every core but one (clankers launched before 2026-11-23 stay in the retired `clankerhouse-recovery.slice` until they are relaunched). New clankers can declare `--resource-class interactive|validation-heavy|untrusted`; undeclared and migrated workloads use the conservative `untrusted` budget. When delegated by systemd, `CLANKERHOUSE_IO_READ_BANDWIDTH_MAX='/dev/DEVICE 60M'` adds a hard per-scope device limit. The server must keep the user systemd manager running after logout (normally via `loginctl enable-linger $USER`).

## Claude accounts: moving a limited clanker to another login

With two or more Claude accounts listed in `~/.config/clankerhouse/claude-accounts.toml` (any number; three accounts
are three `[[account]]` tables), a Claude clanker whose turn ends on a usage limit is resumed, within seconds, on the
next account in the list whose limit has not been hit: same clanker id, same conversation, a new tab, and a prompt
saying why. New Claude clankers start on the first such account. With fewer than two accounts nothing changes. Each account is its own `CLAUDE_CONFIG_DIR` sharing `projects/`, settings and
instructions with `~/.claude`; you log in to each one yourself, once, inside `clankers login add claude LABEL`. Setup, the registry format, how it decides and
what it never touches: [docs/claude-accounts.md](docs/claude-accounts.md).

```sh
clankers login add claude LABEL        # per extra account, per machine: make ~/.claude-acct/LABEL, open Claude for your /login, check it, list it
clankers login list                    # accounts, which are out of usage until when, recent moves
clankers login remove claude LABEL     # unlist it (--delete-dir also deletes its directory and login)
clankers claude-accounts clear LABEL   # offer an account again before its recorded reset
```

## Titles and fading

A Workshop can have a title: a human name such as "Migrate OpenCode adapter to v2". It is shown as the row's name with the branch dimmed on the right, it is searchable, and the Rex session is renamed to match. Set it when creating a Workshop (see the branch flow below, or `clankers workshop spawn --title "…"`, which derives the branch when `--name` is omitted), and edit it with `Alt-R` on a Workshop row; an empty title clears it. Editing a title never renames the branch. A title is stored as the `title` label, so `clankers workshop label set "title=…"` works too and repository hooks see it.

The picker lists the Workshops of every project. Each row's name is shown in a colour derived from its project (repository) name, so one project is always the same colour. The root of each lineage also names its project as a tag in that colour, and drops the repeated `project@` prefix when it has no title. Labels follow the name, each in a colour derived from the label, with `done` in gray. Search matches the title, branch, labels, and project.

Row names fade with age without moving: seen within a day is normal, one to three days is dimmed, older is dimmer. A faded row keeps its project's hue. State glyphs keep full colour, and the current Workshop never fades. The working glyph is the only one that animates.

## Workshop labels and repository hooks

A Workshop can carry `key=value` labels. Clankerhouse stores them, shows their values as coloured tags after the Workshop name, and makes them searchable; they never affect ordering. The only label Clankerhouse itself acts on is `status=done`. A key that starts with `_`, such as `_retro=…`, is hidden: it is stored and passed to hooks (as `CLANKERHOUSE_LABEL__RETRO`) but never shown or searched, which is where a hook's own bookkeeping belongs.

`Alt-D` on a worktree Workshop marks it done instead of deleting it. Nothing else changes: its clankers, session, and worktree stay. `Alt-D` on a done Workshop asks whether to destroy it (`y`) or reopen it (`u`, which clears the label). A done Workshop that is then left alone for seven days is deleted automatically; using it again restarts the seven days. The reaper never deletes a worktree with uncommitted changes or with a clanker that is working, waiting, or finished but unseen, and it keeps the branch. Set `CLANKERHOUSE_DONE_TTL_DAYS` for the runner to change the retention, or to `0` to turn automatic deletion off.

```bash
clankers workshop label set stage=implementing   # current Workshop; --cwd PATH for another, --workshop ID|BRANCH|PATH even after its worktree is gone
clankers workshop label unset stage
clankers workshop label list
clankers workshop stop                            # release the live session; keep the worktree
clankers workshop detach ID|BRANCH|PATH            # make a Workshop top-level; defaults to the current one
clankers workshop reparent ID|BRANCH|PATH --parent ID|BRANCH|PATH   # move it under another Workshop
```

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$labels"],                 # or pick keys: ["$lbl_stage", "$lbl_status"]
]
```

`clankers workshop spawn` run inside a Workshop's worktree makes that Workshop the new one's parent. Run from a repository's main checkout (its primary worktree, whatever branch is checked out there) it makes a top-level Workshop: the main checkout is where work is started, not a Workshop that owns what it starts, so it is never a parent unless named. `--parent ID` names a parent from anywhere, the main checkout's own Workshop included (`clankers workshop show` prints its `workshopId`), and `--no-parent` makes the new Workshop top-level. `clankers workshop detach` and `reparent` change that link later, through the same mutation as `Alt-L` and `Alt-A`: the Workshop registry, the worktree's `.clankerhouse/workshop.json`, and the session's multiplexer claim move together, while the Workshop's subtree, clankers, panes, worktree, and branch stay as they are. A running clanker's `CLANKERHOUSE_PARENT_WORKSHOP_ID` keeps its launch value until the clanker next starts. Both print the Workshop's old and new parent as JSON and accept an ID, branch, or worktree path. Detaching a top-level Workshop changes nothing, and a parent that is unknown, in another repository, or inside the Workshop's own subtree is rejected.

`clankers workshop stop` releases what a finished Workshop holds live and keeps what is durable. Its clankers are closed in the clanker ledger, so they are not listed as interrupted; their waiting messages are orphaned; and its Rex sessions close. The worktree, branch, labels, and lineage stay, and the Workshop stays listed as a row without a session; opening it starts a plain shell. Stopping never happens on its own: a `labels-changed` hook decides when, for example when a Workshop is marked done. Stopping a stopped Workshop does nothing.

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
- Command mode: the Workshop list opens typing into its search; Esc switches to command mode, keeping the filter, where a plain key is the command Alt and that key is (`d` done, `r` rename, `a` attach, `l` detach, `s` snooze, `.` done fold, `i`/`e`/`f`/`t` views, `b` repository, `n` scratch), so no modifier is needed; `j`/`k` move, `q` closes and `/` types again. In command mode Esc clears the filter, then closes. Every Alt key works in both modes
- `Up/Down`: move between workshop rows and nested window/clanker children
- `Right`: first expand hidden lineage children for the selected session, then expand its exact detail rows
- `Left`: jump from a detail to its session, collapse exact detail rows first, then collapse lineage children, then jump to the lineage parent
- `Enter`: switch to the exact selected workshop/window/clanker target or advance the current flow; Enter on zero matches does nothing
- `Alt-R`: edit the selected Workshop's title; on a row that is not a Workshop, rename the Rex session without changing its identity
- `Alt-A`: search valid projected parent workshops and attach the selected workshop beneath one; candidates come from the authoritative lineage projection rather than the optional repository-picker cache
- `Alt-L`: detach the selected workshop from its parent, making its existing subtree top-level
- Type or paste: structured fuzzy-filter rows and fill the branch/base form; current selection is preserved when it still matches
- `Alt-K` while Clankerhouse is open: choose a repository, then open an existing worktree/branch or type a new branch name to create it; in a needs-me view, back to the flat list (as Alt-F)
- `Alt-I`, `Alt-E`, `Alt-F`: the list's three views, from any picker mode (below): the Workshops that need you, freshest first; the same rows, eldest (longest waiting) first; and the flat list of everything. While searching, plain letters type the query, which carries over between views
- `Alt-S`: snooze the selected Workshop's need (below), in any view
- `Ctrl-R`: refresh remotes while in the branch picker
- `Alt-D`: on a worktree Workshop, mark it done; on a done Workshop, confirm destruction or reopen it (see Workshop labels). On a pane or plain session, confirm deletion of the selected target. Deletion runs in the background while the picker remains usable: search, select, expand, and press Enter to jump to another Workshop without waiting. Leaving waits only for durable submission; an accepted deletion continues after the picker closes. Only one mutation is started at a time from a picker. Worktree deletion also closes its linked sessions and splices any children to the former parent. Outside Clankerhouse, Alt-D follows the same rule for the invoking Herdr workspace/worktree; cancellation leaves it untouched.
- `Esc`: switch from typing to command mode (keeping the filter), clear the filter, move back one flow step, or close
- `Ctrl-C`: close

On startup, the Rex session that opened the popup is selected when it appears in the jump list. Renaming stays inside Clankerhouse and preserves the session's canonical path metadata and included clankers.

Run every static check, unit/component suite, and isolated standalone end-to-end scenario through the authoritative top-level entrypoint:

```bash
./test                 # everything
./test --unit          # feature coverage plus TypeScript, Python, and Rust
./test --standalone    # every runner/Rex/TUI/integration scenario, on a scratch Rex server
```

`docs/features.json` is the feature-to-unit/standalone/manual acceptance catalogue. `scripts/check-feature-coverage` fails when a functional-core feature lacks unit tests, any feature lacks standalone/manual coverage, or a discovered unit-test file is uncatalogued.

Project-local Agent Skills are shared by Pi and OpenCode through `.agents/skills/`: Pi exposes `/skill:manual-qa` and `/skill:troubleshoot`; OpenCode exposes `/manual-qa` and `/troubleshoot`. Pi also provides the convenience prompt templates `/qa` and `/troubleshoot`. Manual QA treats the agent as the semantic judge and retains evidence under `.qa-artifacts/`; troubleshooting is read-only until live mutations are explicitly confirmed.

Capture a deterministic lineage render from a disposable real Rust/ratatui fixture with:

```bash
CLANKERHOUSE_QA_ROOT=/tmp/qa-clankerhouse-lineage CLANKERHOUSE_QA_KEEP=1 CLANKERHOUSE_QA_VISUAL=1 scripts/qa
```

Then inspect `/tmp/qa-clankerhouse-lineage/lineage-render.txt`. The capture should show session-only lineage connectors, inline `main`/clanker summaries, and subdued bullet detail rows for an explicitly expanded child session.

The branch flow always begins with the repository picker; it never infers a repository from the current pane or selected jump target. Selecting a repository immediately shows cached refs and starts `git fetch --all --prune` in the background; remote rows are ordered by most recent commit and refresh when the fetch settles. In the branch picker, a query without an exact branch match adds a `create new workshop with this title` row. What you typed becomes the Workshop's title and its branch is derived from it (lowercase, dash-separated, at most 50 characters, suffixed if taken); something already shaped like a branch name is used as the branch verbatim. Selecting the row shows the derived branch and asks for the base before creating the worktree and session; the default base (`^`) is the remote's default branch, fetched just before the worktree is created, so a stale local default never leaks in. When the remote cannot be reached (after one retry), the Workshop starts from the last fetched `origin/<default>` instead, and the mutation's progress says so. Alt-B opens the same TUI directly at the repository picker.

Alt-N, or Alt-N inside the picker, makes a scratch Workshop: choose a repository and Clankerhouse creates a Workshop off the freshly fetched default branch, titled by the time (`scratch 11-03 09:14`, branch `scratch-11-03-09-14`), and opens a `claude` there with no first message (`CLANKERHOUSE_SCRATCH_HARNESS` picks another harness). Rename the Title if it becomes real work; mark it Done with Alt-D when finished, and the Reaper removes it later. The same is `clankers workshop spawn --scratch --harness claude` from a repository.

There is one Workshop list with four views. Alt-K opens it flat (everything, as a tree by lineage); Alt-I opens it in the needs-me view; inside it, Alt-I, Alt-E and Alt-F switch between needs-me (freshest first), waiting longest (the same rows, eldest first) and flat, and Alt-T shows the Desks view (below). The two needs-me views list only the open Workshops (those with a live session) that need the operator, one row each, with the flat row's title, project and label tags, why it is listed and for how long, and on a second line the first line of the clanker's own question or report. It is a list to choose from, never a jump to the next one. A Workshop is listed for its most pressing reason of:

- a clanker asked a question or reported itself blocked (`clankers report --state question|blocked`) during its current turn, or sits blocked, on a permission prompt or otherwise: `asked 12m ago`, `blocked 1h · permission prompt`;
- a clanker finished a turn the operator has not looked at (the agent reports `done` until it is looked at): `finished 3h ago, not seen`;
- a clanker reported `failed`, shows failed, or is an Interrupted Clanker: `failed 1h ago`, `crashed 2d ago`, `interrupted 2d ago`;
- the Workshop carries a "your move" Label, `stage=needs-input` or `stage=waiting-for-approval` by default (`CLANKERHOUSE_YOUR_MOVE_LABELS=key=value,...` replaces the set, `none` turns it off), shown with how long it has had it;
- nothing is running, the worktree is clean and it has been idle a day: `clean, idle 6d · ready to close`;
- it has had no activity for the Reaper's retention period (`CLANKERHOUSE_DONE_TTL_DAYS`, seven days by default): `no activity 9d`.

A Workshop where a clanker is working and nothing is asked of the operator is not listed, and a Done Workshop is listed only for a question, a block, a failure, or as ready to close. The snapshot decides all of this (`src/needs-me.ts`), so the view and its `N need you · M open` count agree. Rows sort by age alone, whatever the reason: in the needs-me view (Alt-I) the freshest first, so a Workshop that has waited long surfaces only when nothing is newer; in the waiting-longest view (Alt-E) the eldest first. The reason's rank (questions and blocks, then unseen finished turns, then failures, then your-move labels, then ready to close and stale) only breaks ties of age. The first row is nearest the prompt, as in the flat list. Enter jumps to the clanker that needs attention, or the Workshop; Alt-S snoozes the row: it moves after everything else, shown as `snoozed ·`, until its reason changes (a new question, a newly finished turn, another reason) or a day passes, and Alt-S again takes the snooze back; Alt-D marks Done or offers deletion exactly as on a flat row; typing filters; Alt-F (or Alt-K) switches to the flat list, where Alt-S works too, a deferred row says `snoozed` or `waiting on <title>`, and the prompt line carries the same `N need you · M open`; Esc clears the search, then closes. A Workshop labelled `waits-on=ID|BRANCH` (another Workshop, by ID or branch) is listed after everything else too, in both views, as `waiting on <title> ·`, until that Workshop is labelled done or no longer has a session; the label also shows as a tag. Snoozed and waiting rows are not counted in `N need you`. An empty list says you are caught up. `clankerhouse-rex --needs-me` opens the picker there. `clankers needs-me --json` prints the same list without a terminal, for scripts and clankers: the snapshot in the picker's order (`--eldest` for Alt-E; `--flat` for every open Workshop, one row each, in the snapshot's order), one row per Workshop with its pane, session, reason, since, excerpt, visible labels (`KEY=VALUE`), creation time, title, project and deferred state, and the `N need you · M open` counts. Without `--json` it prints a short text list. It only reads: it never starts the daemon or touches a session.

Desks are Workshops labelled `role=desk`, standing Workshops that wake on a Routine and keep one long-lived report. In the flat list they fold under one teal `◆ ▸ Desks · N` row that starts folded like any lineage and is not pinned: it sorts like any lineage, by its freshest desk, and Left/Right fold and show it. Alt-T switches to the Desks view, one row per desk with its state, stage, what it asks of you, its next Routine run (`next Sat 20:00 lint-quality-desk-weekly`, or `no routine`) and its report (`report 2d ago`, or `no report`); the line above the prompt shows the selected desk's report link and the prompt line reads `6 desks · 2 need you · 3 with routines`. A desk publishes its report by setting `report=<url>` (any http(s) URL; never shown as a tag). See `docs/clankerhouse-tui.md`.

`clankers settled --json` lists every open session with nothing in progress (no clanker in it is working; blocked, finished, idle, unknown and clanker-less sessions all count), earliest-created Workshop first, for a reader that decides what needs the operator. Each row carries the pane, session, Workshop, ticket, stage and labels, PR, creation and last-status times, turn, folder, branch, the clankers' states, its Needs-me reason if any, and `lastMessages`: the full final reply of each of the main clanker's last turns (two by default, `--messages N`), read from the harness's own session log (Claude Code's transcript, whose path the lifecycle hook records; Pi's turn-end results, else its session file). Those logs are only ever appended to, so the replies read after a compaction, idle compaction included, are the same text written at turn end; nothing is read from a pane. `--order freshest|eldest` puts the Needs-me rows first in the picker's order, `--order flat` keeps the snapshot's; `--limit 1` and then `--after NEXT` (the `next` it printed) hand them out one by one, and `--key KEY` fetches one again. Read-only, no terminal needed.

Not implemented yet:
- `Ctrl-Y` copy PR URL

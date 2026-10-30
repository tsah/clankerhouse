# herdr-core (`hc`) maturity evaluation for Clankerhouse

Date: 2026-10-30. Box: puffin (16 cores, 125 GiB, 915 processes). Evaluated: hc 0.1.14 (`dbcdcff`), against Herdr TUI 0.9.3
(protocol 22). Evaluation only: nothing was migrated, and the live Herdr server and Clankerhouse install were not touched.

## Lane status (updated 2026-10-30)

The hc lane now runs behind `CLANKERHOUSE_MULTIPLEXER=hc`, with Herdr TUI still the default. Live-session migration is out of
scope: Tsah will migrate manually once he decides to switch. The Herdr app is being verified separately.

**Verdict for switching: still NOT YET, but the remaining gaps are narrower.** The Clankerhouse side of every issue below is
fixed or worked around, and a real vim-mode `claude` runs through the lane end to end. What stands between this and a switch:
the soak has only just started, there is no multi-terminal view on a headless box unless the Herdr app answers that, the keys
for popups cannot exist on hc, and hc is still a two-week-old preview.

| # | Issue | Outcome | How |
|---|---|---|---|
| 1 | Frozen core environment | Fixed | The core starts from an allowlist (`hc-core.ts`). Each `spawn` passes identity, `PATH` and `CLANKERHOUSE_*` explicitly and runs under `env -u` for every identity variable it did not set, so even a polluted core leaks nothing. Health reports pollution. |
| 2 | Exit sweep kills the daemon | Fixed | The daemon is a **systemd user service**, with a scrubbed `setsid` fallback where no user manager exists. See below. |
| 3 | Core supervision | Fixed | The daemon polls every 5 s and restarts a dead core in the clean environment, with backoff. `clankers mux hc-health` and `clankerhouse-hc --health` are the health checks. |
| 4 | `hc server status` starts a core | Fixed | Never called. Liveness uses the socket and JSON-RPC, which cannot start anything. |
| 5 | `hc interrupt` waits out its timeout | Fixed | `clankers mux interrupt`: ctrl+c with no wait for plain programs; for reporting ones, up to two ESCs with a 400 ms status check each. |
| 6 | `hc attach` on a finished terminal | Fixed | `clankers mux attach` checks first: it exits 3 with the reason and last output, and writes no terminal queries. |
| 7 | ESC did not stop Claude | **Root cause found** | Not hc: Claude Code's vim editor mode (`editorMode: vim`). The first ESC leaves INSERT; the second interrupted in 16 ms. `interruptAgent` handles it: 499 ms on a real turn. ctrl+c also works. |
| 8 | Feature gaps | Mostly closed | See "Feature gaps" below. |
| 9 | QA and CI | Done | `scripts/lib/qa-hc-server`, `scripts/qa-hc` (in `./test`), and a CI `test-hc` job pinned to hc 0.1.14. CI has not yet run on the branch's latest commit. |
| 10 | Full `./test` | Passes | All 18 groups, 392 unit tests, with Herdr scenarios and `qa-hc` together. |

**Why systemd for the daemon, not an hc terminal.** `--outlive-parent` or `--no-parent` would survive the starting terminal, but
the daemon would then live inside the runtime it supervises: a holder death would kill the daemon along with the terminals it
needs to report on and restart around. A user service stays out of the sweep because the manager, not a terminal, starts it. It
also gives `Restart=on-failure` for free. Both are proven in `scripts/qa-hc`, and the check was shown to fail when the launcher
is sabotaged back to plain `nohup`.

**Verified with real programs** (no fakes): a real `claude` 2.1.314 in vim mode, started from a shell carrying
`CLANKER_ID`, `CLAUDE_CODE_*` and more, received only its own identity; `clankers mux interrupt` stopped a streaming turn; a
Bash prompt showed `blocked`/`permission` with its message through the adapter; and a real Claude hook wrote its state and claims
over hc. A real Workshop with a fake harness ran through `clankers workshop spawn`, the daemon, the lifecycle wrapper and the
owned `systemd-run --scope`, which settles the question left open below: scoped harnesses work on the lane.

### How to use it

```bash
export CLANKERHOUSE_MULTIPLEXER=hc   # bin/clankerhouse and clankerhouse-native route to bin/clankerhouse-hc
clankerhouse-hc                      # picker; opening a Workshop attaches, Ctrl+\ returns to the picker
clankerhouse-hc --repo               # Herdr's Alt-B
clankerhouse-hc --delete             # Herdr's Alt-D, from inside an hc terminal
clankerhouse-hc --health             # core and daemon health
```

Before a real switch, rerun `clankerhouse-install-claude-hooks`, because the live hooks are still gated on `HERDR_PANE_ID` alone.
Set `CLANKERHOUSE_NOTIFY_COMMAND` for notifications. Use `clankers mux hc-restart`, never `hc server restart`, which would adopt
the caller's environment. Name any extra variables terminals need in `CLANKERHOUSE_HC_CORE_ENV`.

### Feature gaps

| Gap | Outcome |
|---|---|
| Status for claude and pi, including blocked/question | Closed. `agentStatus` gains `blockedKind` (`permission`, `question`, `auth`, `error`, `startup`) and `message`. `claude-code` maps to `claude`. |
| Trust dialog says nothing | Closed for claude and pi: 30 s of silence reads as `blocked`/`startup`. |
| Claims at session, window and pane scope | Closed, with no size limits. Window names are labels; each window has one pane. |
| Process info, cwd, durable ids | Closed. Foreground is the leader only, about 0.5 s stale. |
| Labels (`showLabels`) | Closed as data, visible in `hc ls --label`. There is no sidebar to show them in. |
| Notifications | Worked around: `CLANKERHOUSE_NOTIFY_COMMAND` runs with title and body. Nothing is delivered without one. |
| Focus / open | Worked around: `focus` leaves a request and the launcher attaches. One viewer at a time. |
| Popups (Alt-K/B/D) | Partly: `clankerhouse-hc` and its flags do the same jobs. **hc cannot bind keys**, so there is no in-terminal shortcut. |

**Cannot be closed on the Clankerhouse side:**

- No side-by-side view or sidebar in a headless terminal. This depends on the Herdr app verification, or a larger native client.
- `currentLocation` is only the caller's own terminal, and `attached` is always false, so the daemon cannot tell what the operator
  is looking at. Messages held "while the operator is typing" rely on hc's own 3 s quiet rule instead.
- `clankers view children` (`showChildAgents`) is unsupported. `clankers list --children-of` covers the information.
- `sessionRefs` (upstream #15) and pane `activity` for programs with no status. Clankerhouse holds session ids itself.
- `reportAgentState` has no hc equivalent. Claude and pi do not need it. opencode has no status in hc but still reports to
  Clankerhouse through its plugin.
- Dev servers and other daemons started by a harness die with its terminal. This is a behaviour change from Herdr.
- The holder remains a single point of failure, and old holders run old code until their terminals drain. Only upstream can
  change this.
- Eleven existing QA scenarios speak Herdr's socket and were not ported; `qa-hc` covers the lane instead. Codex stayed unverified
  (not logged in here), though Workshops do not launch it through `harnessCommand`.

## Soak

Running on scratch session `eval-soak`: 4 synthetic agents that emit OSC 7501 and write their true state to a file, with traffic
every 15 s through `HcAdapter` (prompts, keys, two-ESC interrupts), a check every 10 minutes, and a planned core restart every 6th
check. Drift compares the adapter's view with each agent's truth file, counting only states settled for 2 s.

```bash
scripts/soak-hc status   # running or not, and the last check
scripts/soak-hc stop     # stops the service, its terminals and its core; keeps the log
scripts/soak-hc report   # rewrites the table below from the log
```

The log is `soak/hc-soak.jsonl`, with service output in `soak/hc-soak.out`. It is git-ignored and lives in this worktree, so the
soak must be stopped before the worktree is removed. It is capped at 25% CPU and 256 MB.

<!-- soak:start -->
No checks recorded yet.
<!-- soak:end -->

## Original verdict (first evaluation): NOT YET

**The runtime is good enough. The product around it is not, yet.** hc beat expectations on everything measurable:
latency, restart and upgrade survival, labels, and events. Two presumed blockers turned out not to be blockers: **Claude Code
and pi report OSC 7501 status natively**, and the Multiplexer Interface maps cleanly (a 320-line spike passes against a
real core, including through `ManagedMultiplexer`).

What is missing, in order of weight:

1. **No human cockpit on a headless box (blocker).** hc draws nothing. The Herdr app needs a desktop session and Vulkan,
   so it cannot run on puffin. There is no sidebar, split view, focus, notification, or key-bound popup, which rules out
   the Alt-K/B/D popups and `showLabels`, `showChildAgents`, `focus`, `currentLocation` and `notify` as they work today. `hc attach` shows
   one terminal at a time. Either the Herdr app on a laptop against puffin over `hc machine add` proves workable
   (untested here) or the native client becomes the cockpit.
2. **Maturity (blocker for 100+ live clankers).** The repo was created 2026-10-16, so it is 14 days old. The API is
   labelled "preview (protocol generation 1, version 0.x)". There were two releases on 2026-10-29 alone. No soak has
   been done: this evaluation covered minutes at 50 terminals, against Herdr's 25 days at 154 panes.
3. **No migration, plus coupling.** Live sessions cannot move. Clankerhouse has 626 `herdr` references across 58 files,
   and the QA harness and CI are herdr-specific. See the estimate below.
4. **Integration hazards that need design, not just code:** the core's frozen environment, the exit sweep that would
   kill the `nohup` daemon, the single holder as a process-wide point of failure, and harnesses without status
   (opencode, and Codex is unverified).

## Findings by workflow

Timings are from puffin at load 2-4. All tests ran in scratch `HC_SESSION`s with scratch XDG directories.

| Area | Result |
|---|---|
| Install | Official script: 6.7 MB binary at `~/.local/bin/herdr-core`, `hc` symlink, SHA-256 checked against the manifest (not independently signed). |
| Labelled background terminals | Work. `run --bg` 6-28 ms. Labels land atomically with the terminal. |
| send / keys | `send` about 200 ms (paste gap); byte-identical at 4 KB, 60 KB and 500 KB via the API; a paste-end escape in the text is stripped. A CLI argument is capped at 128 KB by Linux. |
| send to a reporting program | Blocks up to 5 s (`HC_STARTED_MS`) waiting for `working`, then returns `started:false`. Refused with rc 9 while `blocked`. |
| wait | `--output` matched in 1 ms after the print; `--timeout` honest; `--children all` correct. Plain programs wait for exit. |
| interrupt | Works on a plain program, but always burns the full timeout (bug 2). |
| kill | HUP, TERM, then KILL: 18 ms normally, 2.1 s for a program ignoring HUP and TERM. Reaches `setsid` descendants. |
| finished terminals | `read` still works, `kill` is idempotent, `rm` of a live one refused, `send` rc 11. Capped at 500 finished. |
| `--rm`, `--keep` | Both as documented. `--keep` replaces a SIGKILLed program with a shell in about 3 s and never reruns a command. An explicit exit stays final. |
| Trees | Cascade through grandchildren, stopped by `--outlive-parent`; also fires when the parent is SIGKILLed. |
| Notes | Typed into a status-reporting parent's stdin. Plain bash parents got none. Clankers must use `--no-parent` or `--no-notify`. |
| Attach | Detach, client SIGKILL, reattach, observer read-only and program exit are all clean. The framed stream was driven by hand from Python. |
| Events | Plain-mode subscribe works. `foreground` is sampled about 2 Hz; everything else is immediate. Documents give CAS JSON storage. |

### Stress: 50 terminals (sleep, bash, loops)

| Metric | hc 0.1.14 at 50 terminals | Herdr 0.9.3 live at 154 panes |
|---|---|---|
| Spawn | p50 4.8 ms, max 79 ms (first), 394 ms for all | not measured |
| List | 1.4 ms, 31 KB, includes foreground and status | 7.4 ms, 310 KB; process info needs one extra request per pane |
| Filtered list / get / read | 0.16 / 0.05 / 0.04 ms | not measured |
| RSS | core 10.7 MB + holder 8 MB | 331 MB |
| Threads | core 3 + holder 153 | 334 |
| File descriptors | core 14 + holder 156 | 483 |
| Idle CPU over 15 s | core 0.6%, holder 0.3% | not measured |

- Holder cost is about 3 fds and 3 threads per terminal, the same order as Herdr's 3.1 fds per pane. **hc does not reduce
  the per-terminal fd bill.** It does remove the per-request one: 100 connections took the core from 13 to 113 fds and
  back to 13, and observation needs no per-pane calls.
- A 13.8 MB output burst took 0.65 s and moved core RSS by 0.4 MB.
- No leaks: after kill and rm, holder fds went from 156 to 6, and no processes remained. Churning 200 spawns left fds flat.
- Each terminal exit scans `/proc` for its sweep. On this 915-process box that cost about 34 ms of holder CPU per exit
  (6.8 s across 200 spawns). Harmless at clanker rates; noted for bulk teardown.

### Restart, crash, upgrade

| Event | Result |
|---|---|
| `hc server restart` | 59 ms. Pids, addresses, labels and status intact; output kept; a running loop did not skip. Attached client stayed connected and was repainted. Event streams must reconnect. |
| Core SIGKILL | Terminals unaffected and still ticking; status kept. **No auto-respawn:** raw socket clients get ECONNREFUSED until a CLI call starts a core. Screens are marked `inexact`. |
| Holder SIGKILL | **All non-kept terminals die** (`holder_lost`); kept ones get new shells. One holder is a single point of failure, as the Herdr server is. |
| Real upgrade 0.1.13 → 0.1.14 | 50 ms, a loop on a 50 ms period saw no gap, shell state kept. The old holder stays (`current:false`) until its terminals drain; new terminals go to a new holder. Downgrade refused without `--force`. |
| `hc server stop` | Ends programs. Kept terminals are parked and get new shells on next start. |
| Durable ids | Addresses are not reused after `rm` or restart. `core.id` survives restart, but `seq` restarts per core process. |

Puffin has `Linger=yes`. Core and holder run as transient systemd user services (`hc-serve-*.service`), so they outlive any
SSH login. Reboot was not tested.

### Real harnesses

**Claude Code 2.1.314 emits OSC 7501 natively** (`app=claude-code`), so no hook is needed:

```
idle → working → working msg="Creating empty file named hc-probe-file"
     → blocked kind=permission msg="approve Bash: touch hc-probe-file"
     → working → done
blocked kind=question msg="answer: Which color do you choose: red or blue? (Red · Blue)"
```

This is richer than Herdr's screen detection: `blocked` says why, `send` refuses to answer a dialog, and `send --wait`
returns at a block. Terminal title follows the session. `/exit` clears status and ends the terminal.

Gaps and caveats:

- **The trust dialog reports nothing:** `status:null, reported:false` until it is answered. Every new folder hits this,
  so hc shows a stuck clanker as blank. Worktrees need pre-trust, or a "no first report within N seconds" rule.
- `hc interrupt` and `hc keys esc` did not stop a streaming Claude turn. **Resolved later:** it was Claude Code's vim editor
  mode, not hc. See "Lane status".
- pi reports natively (`app=pi`, idle at startup).
- opencode reported nothing at startup, so it needs a plugin. Codex stopped at a login screen here, so it is unverified.
- A hook fallback works if ever needed: `printf '\e]7501;state=idle:app=hook\e\\' > /dev/pts/N` from outside the program set
  the status. There is no API setter, and the root status is last-writer-wins, so a hook must not run alongside a harness
  that reports for itself. `reportAgentState` and `releaseAgent` have no equivalent and should not be needed for Claude or pi.

## Feature parity with HerdrAdapter

| Need | Herdr TUI | hc 0.1.14 | Gap |
|---|---|---|---|
| Session / window / pane | workspace / tab / pane | Flat terminals; session = shared label | Mapped in the spike. A terminal is one window with one pane, so no splits. |
| Claims | Tokens: 32-char names, 80-char values, 32 per workspace | Labels: 100 KB value, 200-char key and 500 labels all accepted | **Better.** No path truncation. |
| Claims at spawn | Written after creation | Atomic with `terminal.run` | **Better.** |
| Session Claims | On the workspace | Copied to every terminal, or `doc.*` | Workable. Needs care for a session between terminals. |
| `processInfo` | Per-pane request, full foreground list | In `terminal.list`: leader only (pid, name, argv, cwd) | **Better** cost, less detail; about 0.5 s stale. |
| `agentStatus` | Screen detection, works for anything | Program-reported only | Claude and pi better; opencode none; silent during dialogs. |
| `agentPrompt` | `agent.prompt` | `terminal.send` | Parity, plus refusal while blocked. Up to 5 s latency on non-starting turns. |
| `sessionRefs` | Observed | None (upstream issue #15 open) | Clankerhouse already holds session ids from hooks. |
| `reportAgentState` | `pane.report_agent` | None; OSC to the pty only | Not needed for Claude or pi. |
| `persistentLabels`, `durableIds` | Yes | Yes | Parity. |
| `nativeChanges` | Several subscriptions, per-pane status | One stream with `seq`, `missed` | **Better.** Replaces the re-subscribe logic. |
| `argvLaunch` | Via `layout.apply` | Native, plus shell line | **Better.** |
| `spawn` env | Parameter | API only, no CLI flag | Parity for the Adapter. See the environment hazard. |
| Pane `activity` | `revision` | None; only `status_ms` | **Missing** for plain terminals. |
| `rename` | Native | Labels only; `name` is fixed at creation | Workable. |
| `focus`, `currentLocation` | Native | No focus concept | **Missing.** |
| `popup` (Alt-K/B/D) | `[[keys.command]]` | No UI | **Missing.** |
| `showLabels`, `showChildAgents` | Sidebar, agent views | No UI | **Missing.** |
| `notify` | `notification.show` | None | **Missing.** |
| `worktrees` | Yes | No | Clankerhouse owns these already. |
| In-place server upgrade | `live-handoff` | `hc update`, 50 ms, tested | **Better.** |
| Core crash | Server death ends panes | Core death harmless; holder death fatal | **Better.** |
| Post-mortem output | Pane gone | `read` works after exit | **Better.** |
| Remote machines | No | `machine add` (untested here) | New capability. |

## Integration hazards

- **Frozen, inherited environment.** The first client's whole environment becomes every terminal's, and `hc server restart`
  replaces it with the restarter's (confirmed: `A=first B=` then `A=second B=fromrestart`; upstream #20, PR #21). In this
  evaluation a core started from a clanker put `HERDR_PANE_ID`, `CLANKER_ID` and `CLANKERHOUSE_WORKSHOP_ID` into every
  terminal, and a child `claude` came up with bypass permissions on and transcript saving off (its warning named the inherited
  `CLAUDE_CODE_CHILD_SESSION`; a scrubbed environment with `--permission-mode default` was clean).
  In production this would cross-wire identities. **The core must start from a scrubbed environment under its own systemd
  unit, and every spawn must pass a complete identity.**
- **Exit sweep.** When a terminal ends, hc kills every process carrying its `HC_SCOPE` token, even under `nohup` or `setsid`
  (confirmed). `bin/clankerhouse-herdr:84` starts the daemon with `nohup`, so a daemon started from a clanker dies with that
  clanker. The daemon needs a systemd unit. Dropping `HC_SCOPE` plus `setsid`, or a `systemd-run --user` service, escapes the
  sweep (confirmed). The `--scope` form in `src/harness-launch.ts` was tested later and works on the lane. Dev servers started by agents die too, which may be
  desirable but is a behaviour change. The sweep is not in the user docs.
- **Parent cascade and notes.** Clankers must always use `no_parent` and `no_notify`, or hc will type into harnesses.
- **Upgrade discipline.** Old holders run old code until their terminals drain, so long-lived clankers pin old holder
  binaries for days. The holder protocol has to stay compatible for that long.

## Bugs and upstream drafts (not filed)

Clankerhouse works around all of these. They remain worth filing; Tsah decides.

Severity is for Clankerhouse. Bugs 1-3 reproduce on 0.1.14.

### 1. `hc server status` starts a core (medium)

> `hc server status` on a stopped session starts a core, and because the core takes the caller's environment, a monitoring
> check silently fixes the environment of all later terminals. Repro: `HC_SESSION=x hc server status` reports `uptime_ms: 9`.
> Same for `hc ls`. Expected: status reports "not running". The manual says this already holds on Windows.

### 2. `hc interrupt` waits the whole timeout for programs without status (low)

> `hc run --bg --name x bash; hc send x 'sleep 100'; hc interrupt x` sends ctrl+c, the sleep stops at once, and the call still
> blocks for the default 10 s and returns `{"key":"ctrl+c","outcome":"unknown"}`. Expected: return when the foreground process
> changes, which core already samples.

### 3. `hc attach` on a finished terminal writes terminal queries before failing (low)

> `hc attach <finished>` emits `ESC]10;? ESC]11;? ESC]12;? CSI 16t CSI c` and then `error: tN has finished`. The real terminal's
> replies would arrive after hc exits, into the shell. Observed on a pty; the shell garbage itself was not reproduced. Expected:
> check the target before probing.

### 4. Environment across restart: add evidence to #20 (high)

> Also reproduces with `hc server restart`, not only update, and for any variable: `LEAK_A=first hc server start`, then
> `LEAK_A=second LEAK_B=x hc server restart`; new terminals see `A=second B=x`. Agent identity variables leak the same way.
> Request: a way to start a core with an explicit environment, and `hc run --env K=V` (the API has `env`, the CLI does not).

### 5. Document the exit sweep and offer an opt-out (medium)

> `nohup server &` and `setsid` children are killed when their terminal ends. `sweep.rs` calls this accepted, but no user doc
> mentions it, and `--outlive-parent` does not cover it. Request: document it, and offer a supported way to detach a process.

### 6. Supervise the core (medium)

> After a core crash nothing restarts it; holders and programs live on, but API clients get ECONNREFUSED until someone runs the
> CLI. Request: `Restart=on-failure` on `hc-serve-*.service`, or documented guidance for API clients.

### 7. Feature requests

> - Last-output timestamp on the terminal record, for activity and staleness on programs with no status.
> - A status setter in the API, for wrappers that cannot reach the pty.
> - `terminal.run` to unset variables, not only set them. Today removing an inherited variable takes an `env -u` wrapper.
> - `hc ls --json` to include labels and parent: its summary omits them, although `--label` filters on them and `terminal.list` has them.
> - A first-report timeout or a "not reported yet" state for agents held at a startup dialog.

Ruled out as hc bugs: fd growth with connections (my harness), stale holder sockets (reaped on next start), Claude ignoring ESC
(vim editor mode), and status ignoring `msg=text` (the field must be base64, and an invalid report is dropped whole).

## Spike: `HcAdapter`

This section describes the first spike; "Lane status" has the current state. `src/multiplexer/hc.ts` implements the Interface and
`CLANKERHOUSE_MULTIPLEXER=hc` selects it, with Herdr as the default.

What the spike showed:

- Dropping the claim limits and the status re-subscribe logic makes the adapter simpler than `herdr.ts`.
- `observe` needs one call, so the concurrency, TTL cache and per-pane requests all go.
- Session identity is the awkward part. It exists only as a label on live terminals, and a session with no terminals does not exist.
- Everything UI-shaped returns unsupported.

## Effort estimate for production

Rough estimates for one engineer with agents, assuming Clankerhouse stays the sole hc client.

| Work | Estimate |
|---|---|
| Production adapter: errors, reconnects, session lifecycle, unit tests | 2-4 days |
| Runtime-neutral env and paths (626 references in 58 files, `paths.ts`, `lua`, hooks' `HERDR_PANE_ID` gate) | 3-5 days |
| Daemon and core as systemd units, scrubbed core env | 1-2 days |
| QA harness, CI, `scripts/qa-*`, restart scripts | 3-5 days |
| Harness reporting: opencode plugin, Codex check, trust-dialog handling | 1-3 days |
| Router for two adapters at once, for side-by-side | 2-3 days |
| Human cockpit: Herdr app over `machine add` if it works, else native client with sidebar, popups and notifications | 2 days to validate; 2-3 weeks to build |

Total: about 2.5-3.5 weeks if the Herdr app works as the cockpit, and about 5-6 weeks if it has to be built.

## Recommended path

1. **Now: stay on Herdr TUI.** Do not merge the spike. hc can stay installed and idle. Herdr 0.9.5 is available separately;
   the TUI is still maintained, so nothing forces a move.
2. **Cheap prep regardless of runtime** (worthwhile on their own): move the daemon under a systemd unit, and finish moving
   callers behind the Interface so `HERDR_*` stops leaking outside the Adapter.
3. **Answer the cockpit question next (half a day, needs Tsah).** Try the Herdr app on a laptop against puffin with
   `hc machine add`. This decides between the 3-week and 6-week plans, and is the main unknown left.
4. **Re-evaluate when** all of these hold: the cockpit is settled; #20/#21 are fixed; the API has gone 60 days without a protocol
   generation change or leaves preview; and a soak passes (below). Check roughly in January 2027.
5. **Soak before committing:** one dedicated hc session with 20-30 real clankers for two weeks, recording fd growth, RSS, holder
   restarts and upgrades. Reboot and OOM behaviour belong in the same run.
6. **Cutover, when it comes: side-by-side, never in place.**
   - Add an ADR amending ADR-0007 and ADR-0008.
   - Run a dedicated core under its own systemd unit, in a named session.
   - New Workshops go to hc behind a flag; existing ones stay on Herdr and drain naturally. Live sessions cannot move, so
     anything still running gets `--resume` into hc at an idle moment.
   - **Rollback:** flip the flag for new Workshops, and resume hc-hosted harnesses under Herdr by session id. The two runtimes
     share nothing, so neither can damage the other. Keep Herdr pinned and installed through at least one full soak after cutover.

## Not tested

Remote machines and the Herdr app; soak beyond minutes; more than 50 concurrent terminals; reboot, OOM and user-manager restart;
`hc update` against the release server (only `--from`); `notes = false` (my test used plain bash parents, which get no notes
anyway, so it proves nothing); notes into a real `claude` parent; a logged-in Codex; a full opencode or pi turn.

## End state

All scratch sessions stopped: 0 `herdr-core` processes, 0 hc units, runtime directory removed, scratch directories removed, no
default-session state or config created. hc 0.1.14 stays at `~/.local/bin/herdr-core` and `~/.local/bin/hc`. Herdr server pid
675317 is still running from its original start, and `~/.local/bin/herdr` still hashes to `18a8dc65…`, version 0.9.3. One leftover: a
Claude trust entry for the deleted scratch folder remains in `~/.claude.json`; it is harmless and was left to avoid editing a file
live clankers are using.

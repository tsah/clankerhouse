# Herdr fixes and push-down checklist

Work plan from the 2026-10-23 review of Herdr 0.9.3 (live) / 0.9.5 (latest) against
Clankerhouse. Each item lands as its own commit on `main` once verified. The live
install is not redeployed as part of this work.

Legend: `[ ]` open · `[x]` landed on `main` · `[-]` evaluated and declined (reason given)

## Fixes

- [x] **F1** Herdr protocol gate. `HERDR_PROTOCOL = 20` but live Herdr answers 22, so
  `available()` throws and `runtimeServerEpoch()` (`src/recovery/controller.ts`) always
  returns undefined. Gate on supported methods/capabilities or a protocol range instead of
  one exact number.
- [x] **F2** Real Multiplexer instance epoch. `instanceId()` is the socket path, which
  never changes across a Herdr restart, so the Recovery `multiplexer_restart` trigger and
  `advanceMultiplexerEpoch()` can never fire even with F1 fixed.
- [x] **F3** `HerdrAdapter.reportAgentState` is dead code while ADR-0007 says attested
  state is mirrored into Herdr. Resolved by P1 (wire it) or delete it and fix the ADR.
  Wired by P1.
- [x] **F4** Herdr status changes do not reach the daemon: it never subscribes to
  `pane.agent_status_changed`, and Herdr emits no `pane.updated` on status change, so
  unhooked panes (Codex) lag until the 15 s poll.
- [x] **F5** README says Codex reports through its own hooks; nothing installs them, so
  Codex state is Herdr screen detection only. Correct the docs.
  Landed: Codex is documented as Herdr-observed; `wait`/`watch` have no Codex turns.
- [ ] **F6** The installer sets `resume_agents_on_restore = false` globally, disabling
  Herdr restore for unmanaged panes too. Resolved by P5.
- [x] **F7** Verify: Herdr documents that token metadata (all `ch_*` claims) is not
  restored after a cold server restart. Confirm Clankerhouse rewrites workspace and pane
  claims afterwards; fix if not. Confirmed lost; reconciliation now restores Workshop
  and Terminal claims from the registry. Clanker claims are left to Recovery.
- [ ] **F8** Herdr 0.9.3 → 0.9.5 (survives process/thread exhaustion, atomic saves,
  SIGHUP no longer stops the server). Verify the suite against 0.9.5; upgrade the binary
  only after F1 is deployed.

## Push down into Herdr

- [x] **P1** Mirror attested Claude/Pi lifecycle state into Herdr with
  `pane.report_agent` + `seq` (from the daemon, never from the hot-path hook), so Herdr's
  waits, `seen`, notifications, sidebar and `completion_seq` agree with Clankerhouse.
  Precondition: a custom source can hold a pane running a Herdr-supported agent.
  Landed (`src/lifecycle-mirror.ts`): source `clankerhouse:<harness>`, agent `claude`/`pi`,
  `seq` from `nextHerdrReportSeq()` (any other `clankerhouse:*` report must use it too),
  `agent_session_id`; done → `idle` with a synthetic `working` when the spool coalesced it;
  session end → `pane.release_agent`; reports read over 30 s late are skipped, since Herdr
  never releases a pane held for a harness whose process it did not see exit.
- [x] **P2** Seen/ready tracking (`markSeen` effects, completion keys, `stateWithSeen`)
  → Herdr `seen` and effective `done`. Landed: the seen ledger, `markSeen` effects, and
  completion keys are gone; projection shows a finished clanker `done` or `idle` as Herdr
  does. Differences accepted: Herdr's seen is per tab (any pane of a viewed tab is seen) and
  a client-less server treats the active tab as watched. Fallback when Herdr holds no
  settled status (lagging, or not observing the harness): seen only while focused.
- [-] **P3** Settle/wait logic (hook generation counting, `watch` settled) →
  `completion_seq` / `state_change_seq` and `agent.wait`. Keep turn windows for
  `clankers result`. Declined: `wait`, `wait --after`, `result --generation`,
  `send --wait`, and watch cursors are all addressed by turn generation. Herdr's counters
  are server-global, name no turn, reset when the session or agent label changes, and
  exist only while Herdr holds the mirrored state, so they cannot replace generations.
  `agent.wait` would only wake a waiter that must still re-read the hook record (Herdr
  trails it by the daemon's mirror hop), at the price of one Herdr connection and server
  file descriptor per waiter for the whole wait; `--until done` never matches in the
  active tab. Waiters keep polling the daemon's herd, which costs Herdr nothing.
- [-] **P4** Send acknowledgement (prompt SHA-256 matching) → `agent.prompt` with
  `wait:{until}`, `agent_blocked`, `agent_prompt_stalled`. The durable queue stays.
  Declined: the hash match is what names the turn a message started (`startedGeneration`),
  which `send --wait` and `wait --message` need to return that turn's result; Herdr's
  prompt wait "does not track turns" and confirms only that some turn began.
  `agent_blocked` already applies: Herdr refuses a blocked agent atomically and the message
  is requeued. `agent_prompt_stalled` cannot tell whether the text sits unsubmitted in the
  input, so retrying on it could submit a message twice, and a `wait` would hold the
  delivery pass up to 5 s per message. The queue and the focus rule are unchanged.
- [ ] **P5** Recovery relaunch mechanism → Herdr native restore with
  `resume_argv: ["clankerhouse-resume", "<clankerId>"]`; the gate command enforces
  Clankerhouse admission policy and then runs the harness. Re-enable
  `resume_agents_on_restore`. Caveat: Herdr resumes only after a client attaches.
- [x] **P6** `/proc` harness discovery (`src/server/process-discovery.ts`) → pane
  `agent` field and `pane.agent_detected`. Projection reads `agentStatus.agent` from the
  snapshot; pane names and titles only feed session markers, never observations.
- [x] **P7** OpenCode service polling (`src/server/opencode.ts`) → Herdr's OpenCode
  integration (pane-local lifecycle, V2 support). State is Herdr runtime status; the
  Clankerhouse plugin keeps identity/Recovery binding and attested owned-session reports.
  `scripts/install --integrations` installs the Herdr integration.
- [-] **P8** Exit detection (`.exited` marks, `alive`) → `pane.release_agent`, Herdr's
  shell-prompt release, `pane.exited`. Herdr's side landed with P1: a session end (Claude
  `SessionEnd`, Pi `session_shutdown`) sends `pane.release_agent`, and Herdr releases a
  crashed harness itself once it sees the process exit. Declined replacing the marks and
  `alive`: the lifecycle wrapper writes the mark the moment the harness returns, naming the
  exact clanker, with no detection latency, so a just-spawned clanker is never dropped for
  not being detected yet; `pane.exited` never fires when a leftover child keeps the pane
  open, which is the case the mark exists for; Herdr's pane `agent` now carries the mirrored
  label, so it no longer proves a process, which is what `alive` cross-checks; and the
  clean-exit versus crash distinction Recovery needs (exit status, final Ctrl-C, shutdown
  signals) is the wrapper's to observe, not Herdr's.
- [-] **P9** Herdr config surgery in `clankerhouse-install-herdr` → a Herdr plugin
  (`herdr-plugin.toml`: popup panes, actions bound with `plugin_action`, startup hook).
  Declined (Herdr 0.9.5 spike): a manifest cannot declare keybindings, so `config.toml`
  must still be edited; plugin popups lose `HERDR_ACTIVE_*` (context only in
  `HERDR_PLUGIN_CONTEXT_JSON`); `herdr plugin install` takes GitHub shorthand only and
  `plugin link` skips build steps. The plugin would add a layer without removing the edit.
- [x] **P10** Show Labels (`stage`, `title`, ...) in Herdr's sidebar via workspace tokens.
  Landed: the daemon writes visible Labels as `lbl_<key>` plus an aggregate `labels` token on
  every observation (diff only), so cold restarts are repaired; the title stays the workspace
  name. The operator opts in with `$labels` / `$lbl_<key>` in `[ui.sidebar.spaces] rows`.
- [x] **P11** Attention: `notification.show` for blocked/question Reports and an
  `agent.view.set` view of a Workshop's children.
  Landed: `clankers report` notifies for `question`, `blocked`, `failed` (operator-chosen
  with `CLANKERHOUSE_REPORT_NOTIFY`), bounded to ~1 s, after recording. The daemon claims
  each pane's Workshop parent (`ch_pane_parent`); `clankers view children [WORKSHOP]|clear`
  sets or clears a `clankerhouse`-owned agent view filtering on it.
- [-] **P12** `post-create` → plugin `worktree.created` event hook. Only with P13.
  Declined with P13; Herdr event hooks are also unordered, unlimited and unapproved.
- [-] **P13** Evaluate replacing Worktrunk + warm pool + `worktree-delete` with Herdr
  `worktree.*`. Declined: `worktree.create` is a plain `git worktree add` with no
  templated paths, no create hooks, and no warm checkout; `worktree.remove` lacks
  `worktree-delete`'s safety and default-branch handling. Keep Worktrunk and the pool.
- [x] **P14** Stop fetching `pane.process_info` for every pane on every observation;
  `session.snapshot` already carries `agent` and `foreground_cwd`.

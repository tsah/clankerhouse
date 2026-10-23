# Herdr fixes and push-down checklist

Work plan from the 2026-10-23 review of Herdr 0.9.3 (live) / 0.9.5 (latest) against
Clankerhouse. Each item lands as its own commit on `main` once verified. The live
install is not redeployed as part of this work.

Legend: `[ ]` open · `[x]` landed on `main` · `[-]` evaluated and declined (reason given)

## Fixes

- [ ] **F1** Herdr protocol gate. `HERDR_PROTOCOL = 20` but live Herdr answers 22, so
  `available()` throws and `runtimeServerEpoch()` (`src/recovery/controller.ts`) always
  returns undefined. Gate on supported methods/capabilities or a protocol range instead of
  one exact number.
- [ ] **F2** Real Multiplexer instance epoch. `instanceId()` is the socket path, which
  never changes across a Herdr restart, so the Recovery `multiplexer_restart` trigger and
  `advanceMultiplexerEpoch()` can never fire even with F1 fixed.
- [ ] **F3** `HerdrAdapter.reportAgentState` is dead code while ADR-0007 says attested
  state is mirrored into Herdr. Resolved by P1 (wire it) or delete it and fix the ADR.
- [ ] **F4** Herdr status changes do not reach the daemon: it never subscribes to
  `pane.agent_status_changed`, and Herdr emits no `pane.updated` on status change, so
  unhooked panes (Codex) lag until the 15 s poll.
- [ ] **F5** README says Codex reports through its own hooks; nothing installs them, so
  Codex state is Herdr screen detection only. Correct the docs.
- [ ] **F6** The installer sets `resume_agents_on_restore = false` globally, disabling
  Herdr restore for unmanaged panes too. Resolved by P5.
- [ ] **F7** Verify: Herdr documents that token metadata (all `ch_*` claims) is not
  restored after a cold server restart. Confirm Clankerhouse rewrites workspace and pane
  claims afterwards; fix if not.
- [ ] **F8** Herdr 0.9.3 → 0.9.5 (survives process/thread exhaustion, atomic saves,
  SIGHUP no longer stops the server). Verify the suite against 0.9.5; upgrade the binary
  only after F1 is deployed.

## Push down into Herdr

- [ ] **P1** Mirror attested Claude/Pi lifecycle state into Herdr with
  `pane.report_agent` + `seq` (from the daemon, never from the hot-path hook), so Herdr's
  waits, `seen`, notifications, sidebar and `completion_seq` agree with Clankerhouse.
  Precondition: a custom source can hold a pane running a Herdr-supported agent.
- [ ] **P2** Seen/ready tracking (`markSeen` effects, completion keys, `stateWithSeen`)
  → Herdr `seen` and effective `done`.
- [ ] **P3** Settle/wait logic (hook generation counting, `watch` settled) →
  `completion_seq` / `state_change_seq` and `agent.wait`. Keep turn windows for
  `clankers result`.
- [ ] **P4** Send acknowledgement (prompt SHA-256 matching) → `agent.prompt` with
  `wait:{until}`, `agent_blocked`, `agent_prompt_stalled`. The durable queue stays.
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
- [ ] **P8** Exit detection (`.exited` marks, `alive`) → `pane.release_agent`, Herdr's
  shell-prompt release, `pane.exited`.
- [ ] **P9** Herdr config surgery in `clankerhouse-install-herdr` → a Herdr plugin
  (`herdr-plugin.toml`: popup panes, actions bound with `plugin_action`, startup hook).
- [ ] **P10** Show Labels (`stage`, `title`, ...) in Herdr's sidebar via workspace tokens.
- [ ] **P11** Attention: `notification.show` for blocked/question Reports and an
  `agent.view.set` view of a Workshop's children.
- [ ] **P12** `post-create` → plugin `worktree.created` event hook. Only with P13.
- [ ] **P13** Evaluate replacing Worktrunk + warm pool + `worktree-delete` with Herdr
  `worktree.*`.
- [ ] **P14** Stop fetching `pane.process_info` for every pane on every observation;
  `session.snapshot` already carries `agent` and `foreground_cwd`.

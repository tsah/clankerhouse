# ADR-0009: Herdr Restore Relaunches Clankers Through a Recovery Gate

## Status

Accepted. Amends ADR-0007 ("A runtime's own agent resume on restore is disabled by the installer") and the Recovery mechanism described in ADR-0005.

## Context

Recovery has two halves. The policy half decides whether and when a lost Clanker returns: desired state, the boot campaign, the resource-pressure gate, one-at-a-time admission with a five-minute liveness wait, the interrupted-tool quarantine, the circuit breaker, Stopped, and manual `clankers recovery resume`. The mechanism half recreates a place for the harness and starts it: Recovery found or created a Herdr workspace, picked a free tab name, spawned a new pane with an argv launch, and wrote the Clanker claims onto it.

Herdr 0.9.2 and later already own that mechanism for every pane. After any server restart, including a host reboot, Herdr recreates each saved pane in its saved place with the same pane id, and runs the resume command an agent reported for it (`pane.report_agent` / `pane.report_agent_session` `resume_argv`). Recovery's own relaunch meant every restored Clanker came back as a second pane in a new tab beside the empty restored one. To keep Herdr from also resuming agents, the installer forced `[session] resume_agents_on_restore = false` globally, which disabled Herdr restore for unmanaged panes too (checklist F6).

Facts that constrain the design, verified on isolated Herdr 0.9.3 and 0.9.5 servers and in Herdr's source:

- Herdr accepts a `resume_argv` only from the source that holds the pane, or, when no source holds it, from a reporter whose agent name matches the agent Herdr detects there (`claude`, `pi`, `opencode`). Otherwise it answers `resume_not_accepted`. It keeps the command only while that source and agent hold the pane, and drops it once a different agent runs there. A report whose `seq` is not newer than the source's last one is accepted on the wire but silently not applied.
- The first argv element must be a plain command name. Herdr types the quoted command into a fresh shell in the restored pane, so the shell's `PATH` must resolve it and the shell remains when the command exits.
- Restored panes get `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and `HERDR_TAB_ID`, but not the environment the pane was created with, and Herdr token metadata (all `ch_*` claims) is gone.
- Both 0.9.3 (live) and 0.9.5 run resume commands about two seconds after server start with no client attached; Herdr's documentation saying a client must attach is outdated. Resume commands start one at a time, 100 ms apart, and a duplicated command (same source, agent, cwd, argv) runs only once.
- Herdr's official OpenCode integration (`herdr:opencode`, installed by `scripts/install --integrations`) holds OpenCode panes and reports their session id, so Herdr itself resumes them as `opencode --session <id>`. Clankerhouse cannot attach a command to those panes.

## Decision

Herdr does the mechanism; Clankerhouse keeps the policy.

### The gate

`clankerhouse-resume [--instance NAME] CLANKER_ID` is a small installed command, on `PATH` through the installer's bin directory. Herdr runs it in the restored pane. It:

1. asks Clankerhouse (`clankers recovery gate`) what to do for this Clanker in this pane;
2. exits to the shell, saying why, when the Clanker is stopped, suspended, tombstoned, unknown, or already live in another pane;
3. otherwise marks its pane with a `recoveryGate` claim and waits, printing the reason Recovery gives (boot quiet period, pressure, stagger, quarantine review, or "manual resume required" with the exact `clankers recovery resume` command), polling a status file rather than the daemon;
4. when Recovery admits the Clanker into this pane, receives the exact launch argv (same scope, environment, session, model, profile, and interruption-continuation prompt as the previous relaunch, with `CLANKER_ID` and Workshop identity restored from the registry) and `exec`s it.

Ctrl-C before admission clears the gate claim and returns to the shell.

### Reporting

The daemon's Recovery reconciler, which already adopts each exact live Clanker pane, reports `resume_argv: ["clankerhouse-resume", CLANKER_ID]` for it with `pane.report_agent_session`, source `clankerhouse:<harness>` and agent `<harness>` (the source naming the lifecycle mirror of checklist P1 uses), and a timestamp-based `seq` shared by every Clankerhouse Herdr report. Reports are cached per pane and retried on the next reconcile when Herdr refuses them. Herdr persists the command in `session.json`, so it survives repeated restarts until another agent takes the pane.

### Adoption and admission

Recovery treats a pane whose only Clanker evidence is a `recoveryGate` claim as a gate, not as a live Clanker. Admission is unchanged: the same planner, campaign, host admission, attempt budget, and breaker. Where Recovery previously spawned a pane, it now admits the Clanker into its single waiting gate: it records the admission (pane, attempt, initial or recovery launch) in the recovery store and signals the gate. The gate claims `clankerId`, `harness`, `harnessSessionId`, and `recoveryAttemptId` on its own pane, records the launch, and execs; from then on the pane is an ordinary exact live Clanker that the harness attests. An admitted gate that does not launch within two minutes, or whose pane closes first, has its attempt abandoned and returns to `pending`, because no harness ran.

### Herdr-only restarts

A Herdr restart without a host reboot (`multiplexer_restart`) keeps its current policy: lost Clankers become `pending` and return only through `clankers recovery resume`. Only a hard-reboot campaign admits automatically. The gate makes the difference visible: it waits in place and prints the resume command.

### Fallback relaunch

Recovery keeps the pane-creating relaunch for a Clanker that has no gate, because Herdr's restore is best effort and the registry is authoritative: restore disabled by the operator, `session.json` lost or unreadable, the saved directory unavailable, the gate not on the shell's `PATH`, an older Herdr, a pane the user closed, a report Herdr never accepted, or OpenCode under Herdr's official integration. It never runs while a gate for that Clanker exists, and it no longer spends an attempt while the Multiplexer is unreachable.

### Installer

The installer stops forcing `resume_agents_on_restore = false`. Existing installs are migrated once and explicitly: when Herdr's `config.toml` already carries the Clankerhouse keybinding block (so Clankerhouse wrote the flag) and the block lacks the migration marker, a `resume_agents_on_restore = false` line in `[session]` becomes `true` and the installer says so. The managed block then carries the marker, so later runs never touch the flag again and an operator's own `false` is kept.

## Failure modes

| Situation | Result |
|---|---|
| Herdr restore off (`resume_agents_on_restore = false`) | No gate runs; Recovery uses the fallback relaunch, as before this ADR. |
| `clankerhouse-resume` not on the restored shell's `PATH` | The shell prints "command not found"; no gate claim appears; fallback relaunch. `clankerhouse-doctor` reports the missing command. |
| Clanker deleted, tombstoned, stopped, or suspended | The gate says so and exits to the shell. Its command stays in `session.json` until another agent uses the pane, so later restarts repeat that harmless exit. |
| Workshop directory deleted | Herdr shows a restore error instead of running the command. |
| Fallback relaunched first, then a gate appears (or the reverse) | The gate sees the Clanker live in another pane and exits; Recovery never spawns while a gate exists. Herdr itself runs one copy of a duplicated command. |
| Gate killed after admission, before launch | Attempt abandoned, Clanker back to `pending`. In a campaign the per-boot automatic attempt is already spent, so the next automatic admission quarantines it for review. |
| Herdr refuses the report (`resume_not_accepted`) | Retried every reconcile; meanwhile that Clanker uses the fallback relaunch. |
| OpenCode with Herdr's official integration | Herdr resumes `opencode --session <id>` itself, outside admission and the process-owner scope. Recovery blocks a duplicate relaunch while a pane reports that exact session, and keeps the Clanker pending until the operator closes that pane and resumes. The only way to gate OpenCode is `resume_agents_on_restore = false`, which also disables gates. |
| Herdr 0.9.3 vs 0.9.5 | Both resume headless; resume commands need 0.9.2 or later. Older servers ignore `resume_argv` and Recovery falls back. |
| Lifecycle mirror reports with a smaller `seq` | Herdr would ignore the mirror. Both use `nextHerdrReportSeq()` (microsecond timestamp, monotonic per process). |

## Consequences

- A restored Clanker returns in its own pane, tab, and layout position, with the pane id it had; no second pane is created.
- Recovery no longer builds a harness command inside the daemon for restored panes; the gate builds it from the registry at launch time, so environment set at pane creation is never relied on after a restart.
- Herdr restore works again for unmanaged panes.
- The gate is one more installed command that must be on the interactive shell's `PATH`; the doctor checks it.
- Deleted: the installer's forced `resume_agents_on_restore = false` and ADR-0007's rule that disables runtime resume. The pane-creating relaunch remains only as the fallback above.

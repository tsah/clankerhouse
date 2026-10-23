# ADR-0009: Retire Recovery for a Clanker Ledger

## Status

Accepted (2026-10-23). Amends ADR-0001, ADR-0002, ADR-0004, ADR-0006, ADR-0007, and ADR-0008, and supersedes the recoverable-intent parts of ADR-0005. This number previously belonged to the Herdr-restore resume gate (`clankerhouse-resume`), which was reverted before this decision and whose ADR was deleted.

## Context

Recovery relaunched interrupted Clankers automatically. It ran as its own `clankerhouse-recovery` service and daemon with boot campaigns, one-at-a-time admission, leases, attempts, an append-only journal, quarantine, interruption handling, and a Herdr-restore gate. Around it sat a Spot-instance watcher that treated preemption notices as interruptions, a resource-pressure guard that suspended admission, and an incident store that projected both. Together they were the largest subsystem in Clankerhouse and threaded Recovery attempt ids through the lifecycle hook, the wrapper, the Pi extension, and identity correlation.

The conditions that justified it are gone. The host no longer runs on Spot instances, the guard was already disabled on the live host, and host or Herdr restarts are rare. Meanwhile its records went stale: a Clanker's harness session id never followed `/clear`, `/new`, or a resume, so Recovery would have resumed the wrong conversation, and 158 of 262 rows marked `running` belonged to Clankers that were long dead. A relaunch policy built on those records did more harm than an operator deciding by hand.

## Decision

Clankerhouse records Clankers and leaves resuming them to an explicit request.

- The clanker ledger, `clankers.sqlite3`, has one row per Pi, Claude, and OpenCode Clanker launched or adopted: Workshop, cwd, harness, launch spec, original task, current harness session (which follows `/clear`, `/new`, and resumes), state `open` or `closed`, closed reason, owner systemd scope, and the Herdr server epoch it was last seen alive in. Codex is not recorded; it has no exact resume contract.
- The daemon closes a row once its Clanker has been missing for about 60 s while the same Herdr server keeps running. Stopping a Workshop closes its rows. A row last seen in an earlier server stays open, so an interrupted Clanker is exactly an open row that is not alive after a server epoch change.
- `clankers ledger [--state open|closed | --interrupted] [--workshop ID]` lists rows. `clankers ledger close ID [--reason TEXT] [--if-present]` closes one and stops its systemd scope. `clankers resume ID [--prompt TEXT]` reopens that exact harness session in its Workshop under the same Clanker id, with its saved profile and model, and replays no prompt.
- Recovery after a restart is by instruction: the operator asks a Clanker to read `clankers ledger --interrupted` and resume what still matters.
- Herdr's own agent restore stays off; the installer forces `resume_agents_on_restore = false`.
- Recovery, its service and daemon, `clankers recovery …`, its QA, the Herdr-restore gate, the start/stop/recovery mutation intents, Recovery attempt ids (`CLANKER_RECOVERY_ATTEMPT`, `recoveryAttemptId`, `ch_recovery_attempt`), the Spot watcher, the resource-pressure guard, and the incident store are removed.
- Per-Clanker systemd scopes and resource classes stay, under the historically named `clankerhouse-recovery.slice`.
- The ledger imports `recovery.sqlite3` once and leaves it in place. The registry keeps importing legacy Recovery v1–v4 data for provenance only; nothing acts on it.

## Consequences

- Nothing is relaunched automatically. After a restart, interrupted work waits until someone resumes it.
- One subsystem, one service, and a set of hook-path fields disappear; lifecycle correlation needs only Clanker identity and harness session.
- A Clanker that ended less than 60 s before a host or Herdr restart was never closed, so it stays open and is listed as interrupted.
- A Clanker whose pane closed before the daemon ever observed it alive has no server epoch, so its row closes after 60 s like any Clanker missing in the same server, never showing as interrupted.
- A closed row whose Clanker is seen alive again reopens.
- Unwanted rows are dropped with `clankers ledger close`.
- Host-pressure protection is limited to the slice's low CPU and I/O weights and the per-scope resource classes; there is no admission throttle.

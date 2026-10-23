# Sunset Recovery checklist

Automatic Recovery (boot campaigns, admission, pressure gating, Spot preemption handling,
Herdr-restore gating) is retired. After a restart the operator asks a clanker to recover from
the durable clanker ledger instead. Herdr restore stays off.

Legend: `[ ]` open · `[x]` landed on main · `[-]` declined (with reason)

- [x] **S1 Ledger follows the live session.** The durable session id follows `/clear`, resume
  and new sessions instead of refusing to rebind, so the ledger names the conversation a pane is
  actually running.
- [ ] **S2 Remove the Spot watcher.** `spot_watch.py`, its wrapper, unit, tests, installer and docs.
- [ ] **S3 Remove the resource-pressure guard and incidents.** `resource_guard.py`, its wrapper,
  unit, QA, tests, the incident store and its projection. The guard is disabled on the live host
  and existed to feed Recovery admission.
- [ ] **S4 Replace the Recovery store with a clanker ledger.** One `clankers.sqlite3` table: id,
  harness, Workshop, cwd, session id, launch spec, original task, state (`open` / `stopped` /
  `closed`), owner scope. Imported once from `recovery.sqlite3`, which is left in place.
  The daemon closes a clanker whose pane disappears while the Herdr server epoch is unchanged,
  so rows still `open` after a restart are exactly the interrupted clankers.
- [ ] **S5 Remove Recovery.** Controller, planner, admission, leases, attempts, journal, the
  Herdr-restore gate (ADR-0009, `clankerhouse-resume`), `clankerhouse-recovery` service and
  daemon, `clankers recovery …`, `scripts/qa-recovery`, Recovery attempt plumbing in the hook,
  the lifecycle wrapper and the Pi extension. The installer keeps
  `resume_agents_on_restore = false`.
- [ ] **S6 Recover by instruction.** `clankers ledger` lists ledger rows (with `interrupted` for
  open rows that are not alive) and `clankers resume <clanker-id>` reopens a ledger clanker's
  exact session in its Workshop under the same clanker id. README documents the restart runbook.

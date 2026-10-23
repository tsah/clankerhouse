# Clankerhouse restart and Spot recovery QA

This plan validates guarded automatic recovery after a Spot/Linux reboot, explicit single-clanker recovery for later same-boot loss, process-scope cleanup, and EC2 Spot checkpoint handling. It must never inspect, signal, or mutate real workshops, clankers, Herdr servers, worktrees, harness sessions, or AWS resources.

## Safety boundary

Every destructive scenario must:

- use a root matching `/tmp/qa-clankerhouse-recovery-*`;
- create and verify `.clankerhouse-recovery-qa-owned` before cleanup;
- use a disposable Git repository;
- use a private Herdr server through an isolated `HERDR_SOCKET_PATH`;
- use private `HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR` trees;
- put fake `pi`, `claude`, and `opencode` executables first in `PATH`;
- simulate boot IDs with `CLANKERHOUSE_BOOT_ID_PATH`;
- simulate IMDS with a loopback fake HTTP server;
- never use pane input or capture to communicate with a clanker.

## Automated checks

From `clankerhouse/`:

```bash
bun run check
bun test
PYTHONPATH=.. python3 -m unittest tests.test_resource_guard tests.test_spot_watch
scripts/qa-clanker-api
scripts/qa-daemon
scripts/qa-recovery
scripts/qa-process-owner
scripts/qa
```

## Recovery scenarios

`scripts/qa-recovery` must establish three tracked clankers in one disposable workshop and validate:

1. Pi and Claude receive preallocated exact native session IDs before launch.
2. OpenCode durably attests its generated session ID before fake prompt work begins.
3. Restarting only the recovery controller adopts panes without duplication.
4. Same-boot pane loss becomes durable pending/interrupted state and is not added to the boot campaign.
5. A clean harness exit durably changes desired state to `stopped` and remains absent after reboot.
6. A hard reboot creates a durable campaign and automatically admits at most one stale session after healthy boot gates.
7. Settled local work continues automatically, while interrupted tools, expensive validation, and external effects are never replayed automatically.
8. Repeated automatic failure, same-boot retry, and unresolved running attempts enter durable quarantine.
9. Competing controllers and simultaneous manual requests cannot exceed the global admission limit.
10. Killing a pane followed by stop removes wrapper, harness, `setsid`, and double-fork descendants from the owned cgroup.
11. Healthy memory with pure I/O pressure blocks admission immediately; mitigation requires five sustained minutes, stops one attributable child workload, attempts capability-aware steering with durable incident context, and enforces a two-minute cooldown before resampling.
12. Circuit-breaker, incident, attempt, and pressure snapshots survive a simulated reboot.
13. When no child workload is safely attributable, a tracked Clanker is durably stopped with its pane preserved; untracked harness processes are never signalled as a fallback. Intentional stop, resource stop, quarantine, and tombstones prevent resurrection.
14. Dirty/untracked Git state and native harness session files remain preserved.
15. No operation touches the user's real Herdr socket, cgroups, or harness stores.
16. After a Herdr-only restart of the isolated server, Herdr saved the `clankerhouse-resume` gate for each adopted pane, restores the panes with the same ids, and the gates wait with the manual resume command; a manual resume launches in the restored pane; a stopped Clanker's gate returns to the shell; an unsettled one waits for interrupted-work review.

Unit tests additionally cover schema reopening, transactionally coupled journaling, append-only journal enforcement, exact-session mismatch rejection, tombstone precedence, lease contention/expiry/new-boot reclamation, attempts, runtime epochs, command construction, and IMDSv2 token/404/401/rebalance/interruption behavior.

## Spot deployment acceptance

Before migrating, verify on the target image:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clankerhouse-recovery.service
systemctl --user enable --now clankerhouse-resource-guard.service
systemctl --user enable --now clankerhouse-spot-watch.service
clankers recovery status
loginctl show-user "$USER" -p Linger
```

The following must live on retained encrypted storage mounted at the same paths before the user services start:

- `$XDG_STATE_HOME/clankerhouse`;
- Pi session storage (`~/.pi/agent/sessions` unless overridden);
- Claude session storage/configuration;
- OpenCode data/configuration;
- repositories and Worktrunk worktrees;
- required harness credentials.

For Spot termination, do not rely on a root EBS volume with `DeleteOnTermination=true`. Use a retained/reattached encrypted EBS volume, EFS, or an externally restored checkpoint. The interruption notice is only a fast-path flush; successful hard-restart QA is the release gate.

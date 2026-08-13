# Clankerhouse restart and Spot recovery QA

This plan validates one-shot automatic continuation at user-service startup after Linux reboot, plus explicit recovery after controller or tmux-server loss and EC2 Spot checkpoint handling. It must never inspect, signal, or mutate real workshops, clankers, tmux servers, worktrees, harness sessions, or AWS resources.

## Safety boundary

Every destructive scenario must:

- use a root matching `/tmp/qa-clankerhouse-recovery-*`;
- create and verify `.clankerhouse-recovery-qa-owned` before cleanup;
- use a disposable Git repository;
- use a private `tmux -S .../tmux.sock` server through an isolated `TMUX` value;
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
scripts/qa
```

## Recovery scenarios

`scripts/qa-recovery` must establish three tracked clankers in one disposable workshop and validate:

1. Pi and Claude receive preallocated exact native session IDs before launch.
2. OpenCode durably attests its generated session ID before fake prompt work begins.
3. Restarting only the recovery controller adopts panes without duplication.
4. Abrupt pane loss after the one-shot pass remains absent until an explicit recovery command.
5. A clean harness exit durably changes desired state to `stopped` and remains absent even after explicit or next-boot recovery.
6. Explicit recovery after killing the private tmux server recreates the workshop and resumes all three exact sessions with an idempotent continuation.
7. Changing the simulated Linux boot ID and deleting runtime state recovers from persistent state alone.
8. Competing controllers hold a durable singleton lease and launch at most one pane per clanker.
9. Intentional stop, resource-pressure suspension, and tombstones prevent resurrection.
10. Dirty and untracked Git state remains byte-for-byte unchanged.
11. The recovery directory and database remain mode `0700` and `0600` respectively.
12. No operation touches the user's real tmux socket or harness session stores.

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

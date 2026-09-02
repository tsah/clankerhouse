# Clanker API QA

This plan validates only the Clankerhouse product, `clankers` CLI, workshops, clankers, and harness metadata. Run every destructive scenario against disposable repositories, tmux sockets, runtime directories, and state directories.

## Automated checks

From `clankerhouse/`:

```bash
bun run check
bun test
scripts/qa-clanker-api
scripts/qa-daemon
scripts/qa-recovery
scripts/qa-stop-popup
scripts/qa
```

The scripts must create their own `/tmp/qa-clanker-*` roots, mark ownership before cleanup, use private tmux sockets, and refuse unsafe paths. Never point them at a real tmux server, workshop store, worktree, or runtime directory.

## API contract

1. `clankers list [--cwd PATH]` discovers harness-bearing panes through the Multiplexer Interface and assigns or reads one stable Clanker ID claim.
2. Renaming a disposable Multiplexer session does not change its clanker IDs.
3. Duplicate IDs fail as ambiguous; unknown IDs fail as not found.
4. `status` and `capabilities` return harness, workshop location, lifecycle generations, and verified native transport capabilities.
5. Pi `send`, `wait`, and `result` use its mode-0600 Unix socket and clanker-state reports. They never mutate or capture terminal content.
6. Under Herdr, Claude advertises immediate send through the Adapter's semantic `agentPrompt` Capability. Clankerhouse revalidates the exact pane claim before Herdr validates the recognized foreground agent; blocked prompts fail without input. Claude under tmux and Codex on either Adapter reject unavailable send/result operations. OpenCode remains monitor-only.
7. Timeout is nondestructive and leaves the clanker and workshop intact.
8. Reports contain only harness/clanker/native-session identity, recovery attempt, pane, lifecycle, state, and result fields under `clanker-state/`.
9. Revisioned snapshots are committed before publication over the mode-`0600` daemon socket; socket failure leaves version-10 JSON polling operational.
10. The daemon accepts only status, snapshot, subscription, and non-destructive `projection.refresh` requests. Destructive or unknown actions fail without tmux/worktree mutation.
11. Foreground harness discovery may inspect process metadata but never terminal contents, never assigns `CLANKER_ID`, and never authorizes resource-guard signals.

## Workshop contract

Use a temporary Git repository and temporary `XDG_STATE_HOME`:

1. `clankers workshop spawn --name qa-child --harness pi --prompt test` creates a Worktrunk worktree, workshop record, `.clankerhouse/workshop.json`, canonical tmux session, and initial clanker.
2. `clankers spawn --workshop qa-child --name reviewer --harness claude --prompt review` adds a clanker without creating another worktree or lineage edge.
3. `clankers workshop identity`, `ensure`, `show`, `tree`, `project`, `reconcile`, and `bootstrap` expose only workshop terminology and fields.
4. The SQLite store contains `repositories` and `workshops`; manifests use `workshopId` and `parentWorkshopId`.
5. `clanker-*` wrappers target the current workshop. `workshop-*` wrappers create isolated workshops. Harness-native in-process subagents are neither workshops nor clankers.

## Manual isolated smoke check

Inside a disposable tmux server, launch one Pi clanker with `CLANKER_ID=clanker-qa-manual`, verify `clankers list`, send a harmless prompt through `clankers send`, wait for settlement, and inspect `clankers result`. In a disposable Herdr workspace, launch one Claude clanker, confirm `send` is `multiplexer-prompt`, submit an exact marker, and observe that marker in Claude's response and lifecycle generation. Destroy only the disposable runtime resources and temporary worktrees afterward.

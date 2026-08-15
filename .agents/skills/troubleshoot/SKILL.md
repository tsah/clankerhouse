---
name: troubleshoot
description: Diagnose the current Clankerhouse TUI and runtime when rows, question marks, names, hierarchy, sorting, selection, actions, Recovery, or navigation look wrong. Starts read-only, captures semantic evidence, reproduces defects in isolation, and requires confirmation before live mutations.
compatibility: Linux with a running Clankerhouse installation, Bun, tmux, jq, Python, and repository access for fixes.
---

# Troubleshoot Clankerhouse

Treat the visible symptom as evidence, not the root cause. Begin strictly read-only.

## Safety

- Read `CONTEXT.md` and the ADRs before interpreting identity or ownership.
- Do not send to Clankers, press keys in their panes, stop processes, modify tmux metadata, write databases, restart services, reload bindings, or deploy fixes during diagnosis.
- Do not delete stale-looking state.
- Before any live mutation, present the exact commands, affected stable IDs, expected effect, and rollback, then obtain explicit confirmation.
- Reproduce and test fixes in isolated XDG/HOME/tmux environments first.

## 1. Capture current evidence

Create a timestamped read-only evidence directory outside runtime state. Record:

```bash
readlink -f "$HOME/.local/lib/clankerhouse"
clankerhouse-doctor
clankers diagnose --json
clankerhouse-native --dump-tree
clankerhouse-native --check
clankers list
clankers recovery status
systemctl --user --no-pager status clankerhouse-recovery.service clankerhouse-resource-guard.service clankerhouse-spot-watch.service
tmux list-clients -F '#{client_name}|#{session_id}|#{session_name}'
tmux list-sessions -F '#{session_id}|#{session_name}|#{session_path}|#{@clankerhouse_workshop_id}|#{@clankerhouse_session_id}'
tmux list-windows -a -F '#{session_id}|#{window_id}|#{window_name}|#{@clankerhouse_window_id}'
tmux list-panes -a -F '#{session_id}|#{window_id}|#{pane_id}|#{pane_current_path}|#{@clankerhouse_terminal_id}|#{@clankerhouse_clanker_id}|#{@dotfiles_harness}'
```

Query the daemon socket directly only with read methods such as `server.health` and `snapshot.get`. Open SQLite databases read-only and run `integrity_check` and `foreign_key_check`.

## 2. Inspect symptoms systematically

### Question marks

For every `?` determine whether the row is:

- an unmanaged shell/window: expected neutral/unknown
- a report-only or disconnected harness: explain capability limitation
- an explicitly registered Clanker without a current report: suspicious
- an identity mismatch between pane metadata, registry, and report: defect

Never hide a question mark merely by guessing state from process names or titles.

### Duplications

Compare exact target keys, stable resource IDs, Workshop IDs, canonical paths, and rendered tree keys. Distinguish:

- legitimate distinct tmux sessions sharing a path
- a live session plus a compatibility directory alias
- duplicate stable identity claims
- native tree multiplication through an ambiguous parent

### Sorting and hierarchy

Compare the daemon projection with the functional-core comparator and native `--dump-tree`. Check current-session priority, subtree aggregate state, parent uniqueness, orphaned parents, cycles, expansion, and bottom-up viewport order.

### Weird naming

Separate durable Display Names from native tmux labels. Check whitespace/control characters, path-like managed names, stale compatibility names, incorrect Absorption seeds, and renamed resources whose stable IDs or locations changed unexpectedly.

### Navigation and actions

Trace selected rendered key → typed target → socket intent → durable operation → validated Multiplexer Location → requesting tmux client. Confirm the action is advertised and affects only that stable target/client.

### Recovery drift

Compare recorded and current Clanker inventories. Inspect active campaigns, pending candidates, recent attempts, desired states, tmux/boot epochs, and whether activation resumed work that was previously stopped.

## 3. Form and test hypotheses

For each anomaly provide:

- observation
- expected domain rule
- likely ownership boundary at fault
- evidence for and against
- smallest isolated reproduction

Run the matching standalone scenarios from `docs/features.json`. Add a failing unit test against the functional core before changing behavior. Add or extend a standalone end-to-end scenario whenever the failure crosses an adapter boundary.

## 4. Fix and verify

Keep decisions pure and move side effects behind Effect services/Layers. After a fix:

```bash
./test
```

Then repeat the isolated reproduction and the complete manual steps for affected features. Re-run read-only live diagnostics only after deployment is explicitly authorized.

## 5. Report before mutation

Summarize anomalies as confirmed defects, expected behavior, or unresolved. List any proposed live mutation separately with stable IDs and rollback. Wait for confirmation.

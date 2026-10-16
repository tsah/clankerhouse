---
name: troubleshoot
description: Diagnose the current Clankerhouse TUI and runtime when rows, question marks, names, hierarchy, sorting, selection, actions, Recovery, or navigation look wrong. Starts read-only, captures semantic evidence, reproduces defects in isolation, and requires confirmation before live mutations.
compatibility: Linux with a running Clankerhouse installation, Bun, Herdr, jq, Python, and repository access for fixes.
---

# Troubleshoot Clankerhouse

Treat the visible symptom as evidence, not the root cause. Begin strictly read-only.

## Safety

- Read `CONTEXT.md` and the ADRs before interpreting identity or ownership.
- Do not send to Clankers, press keys in their panes, stop processes, modify Herdr pane metadata, write databases, restart services, reload bindings, or deploy fixes during diagnosis.
- Do not delete stale-looking state.
- Before any live mutation, present the exact commands, affected stable IDs, expected effect, and rollback, then obtain explicit confirmation.
- Reproduce and test fixes in isolated XDG/HOME/Herdr environments first.

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
clankers mux observe
herdr api snapshot
```

Query the daemon socket directly only with read methods such as `server.health` and `snapshot.get`. Open SQLite databases read-only and run `integrity_check` and `foreign_key_check`.

### Audit every projected row against reality

Do this exhaustive audit for every investigation, not only when the reported symptom mentions stale rows. Capture one daemon snapshot and the surrounding multiplexer/process evidence close enough together to describe one observation interval. If the projection revision or multiplexer topology changes during collection, discard the comparison and retry. Produce a row-by-row matrix with the projected key, claimed kind/state/identity, authoritative evidence, and result: `pass`, `expected discrepancy`, or `defect`. Never validate only a sample.

For every top-level row:

- `session`: require the exact native session ID to exist in the Herdr server. Compare its current native name and path as observations. For managed rows, require the projected resource ID and complete Multiplexer Location to match the currently active authority store. During the `legacy-mutable` gate this is `resources.sqlite3`; after authority activation use `registry.sqlite3`. Do not treat a deleted current directory as a nonexistent session: require the Multiplexer to report the `(deleted)` path and explain any incident state.
- `directory`: require the canonical path to exist. Prove `worktree` source through `git worktree list --porcelain`, `zoxide` source through `zoxide query -ls`, and `activity` source through the durable activity ledger. A durable Workshop record alone is not current directory evidence.
- Require unique top-level target keys, resource IDs, Workshop IDs where applicable, and canonical directory paths. Explain every projected orphan parent by finding its durable parent record and proving why that parent has no current row.

For every detail row:

- `window`: require the exact session/window/pane tuple in the Multiplexer and compare current command, title, path, and managed Terminal Location.
- process `observation`: inspect the pane TTY foreground process group in `/proc`; require the reported harness executable or recognized package entrypoint. A pane title or stale command label alone is insufficient.
- lifecycle `observation`: require the source report and compare pane, Clanker ID, harness, state, observed time, harness-session ID, and recovery-attempt ID. Recompute the projected rejection reason. Incomplete and rejected reports must remain visible but must not drive aggregate runtime state.
- `clanker`: require owned Clanker identity from pane metadata/registry plus current process evidence. An attested state additionally requires exact lifecycle identity correlation. If correlation fails, require unknown runtime state and a separate rejected observation rather than the report's claimed state.
- `incident`: require an open durable incident with the same Clanker, kind/status, target scope, and timestamp. Historical incidents that no longer attach to a current target must not manufacture rows.

Finally assert set equality between all live multiplexer panes and unique projected pane targets, allowing multiple evidence details to reference one target but no live pane to disappear. Recompute each session aggregate from details, verify current-session status changes only ordering/metadata, and compare the complete projection with `clankerhouse-native --dump-tree`. Report exact counts for sessions, directories, unique panes, managed Locations, Clankers, observations by source/confidence, incidents, mismatches, and omissions.

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

- legitimate distinct multiplexer sessions sharing a path
- a live session plus a compatibility directory alias
- duplicate stable identity claims
- native tree multiplication through an ambiguous parent

### Sorting and hierarchy

Compare the daemon projection with the functional-core comparator and native `--dump-tree`. Check current-session priority, subtree aggregate state, parent uniqueness, orphaned parents, cycles, expansion, and bottom-up viewport order.

### Weird naming

Separate durable Display Names from native multiplexer labels. Check whitespace/control characters, path-like managed names, stale compatibility names, incorrect Absorption seeds, and renamed resources whose stable IDs or locations changed unexpectedly.

### Navigation and actions

Trace selected rendered key → typed target → socket intent → durable operation → validated Multiplexer Location → focused target. Confirm the action is advertised and affects only that stable target.

### Recovery drift

Compare recorded and current Clanker inventories. Inspect active campaigns, pending candidates, recent attempts, desired states, multiplexer/boot epochs, and whether activation resumed work that was previously stopped.

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

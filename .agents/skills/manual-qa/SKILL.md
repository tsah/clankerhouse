---
name: manual-qa
description: Run and judge Clankerhouse's complete feature catalogue in isolated standalone environments. Use for manual QA, release acceptance, feature walkthroughs, and requests to verify the whole product rather than merely run unit tests.
compatibility: Linux with Bun, Herdr, Git, Python, Rust, jq, and the Clankerhouse development dependencies.
---

# Clankerhouse Manual QA

The coding agent is the semantic judge. Automated assertions are evidence, not a substitute for inspecting whether each feature behaves as described.

## Safety boundary

1. Work from the repository root.
2. Read `CONTEXT.md`, `docs/features.json`, and relevant ADRs.
3. Never use the live `HOME`, XDG state/runtime paths, Herdr socket, registry, Recovery database, or installation prefix for simulations.
4. Every scenario must use temporary `HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, installation prefix, and Herdr server socket (`HERDR_SOCKET_PATH`).
5. Refuse to continue if a scenario cannot prove isolation.
6. Do not deploy, reload live bindings, stop live services, or mutate live Clankers.

## Workflow

### 1. Establish automated baseline

Run the repository-level complete test entrypoint:

```bash
./test
```

A failure blocks manual acceptance. Preserve the output in a timestamped `.qa-artifacts/` directory.

### 2. Build the feature matrix

Read `docs/features.json`. Create one report row per feature containing:

- feature ID and title
- unit-test evidence
- standalone scenario evidence
- manual observations
- result: `pass`, `fail`, `blocked`, or `suspicious`

Do not omit a feature. Run `scripts/check-feature-coverage` to verify catalogue completeness.

### 3. Run every standalone scenario

Deduplicate the `standalone` commands from the catalogue and run each command in its own fresh environment. Do not infer that one successful scenario proves another feature.

For each feature, perform every listed `manual` step. Inspect actual outputs and state transitions rather than only the exit code. Use:

```bash
clankers diagnose --json
clankerhouse-native --dump-tree
clankerhouse-native --check
```

When judging the visual TUI, run the real native binary in a bounded PTY, capture the ANSI screen, and inspect:

- names and paths
- state glyphs, especially `?`
- hierarchy and connectors
- sorting and current-session priority
- selected row, footer, and action target agreement
- duplicate rows or repeated descendants
- action help versus actual available actions

### 4. Exercise interactions end to end

Use an isolated real Herdr server, the real daemon/socket, real native client, temporary Git repositories/worktrees, and deterministic fake harness executables. At minimum verify:

- selecting and opening roots, children, windows, and directories
- focus moves to the exact selected target
- search, expansion, scrolling, and no-match behavior
- rename, attach, detach, create, delete, start, and stop
- absorption and stable identity after native rename
- Clanker API sends, waits, results, and unsupported capabilities
- daemon reconnect and stale-producer handling
- Recovery clean loss, interruption ambiguity, admission, stop, suspension, and tombstones
- process ownership
- atomic install, activation failure, and rollback
- Neovim integration and popup lifecycle

Never replace the real product seam under test with a mock. Fake only external harness programs and host signals.

### 5. Judge, do not rationalize

A scenario fails when observed behavior conflicts with the feature description even if its script exits successfully. Record unexpected output verbatim. `unknown` is acceptable only for an unmanaged or explicitly non-reporting resource; an explicitly registered Clanker rendering `?` is suspicious until explained.

For every failure:

1. Capture the smallest reproducible evidence.
2. Add or identify the missing functional-core test.
3. Reproduce in a fresh standalone environment.
4. Do not modify live state.

### 6. Report

Write `.qa-artifacts/<timestamp>/report.md` and a machine-readable `report.json`. Include:

- exact commit
- tool versions
- isolation paths
- feature matrix
- screenshots/tree dumps
- failed and suspicious observations
- commands needed to reproduce
- final acceptance decision

Acceptance requires every catalogue feature to pass. `blocked` and `suspicious` are not passes.

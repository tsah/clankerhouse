---
name: handoff
description: >-
  Create a visible clanker in a new durable Worktrunk workshop. Use only when
  the user explicitly asks to hand off/delegate into a separate worktree or
  workshop. Wanting something visible in its own Rex tab or pane does not alone
  imply a workshop handoff.
---

# Workshop handoff

A handoff creates a **workshop** (a durable Worktrunk worktree plus its Rex
session) and its initial **clanker** (one visible harness session in a Rex
pane). Pi, Claude, OpenCode, and Codex are harnesses, not agents.
Harness-native in-process subagents are not clankers.

Do not use a handoff for an existing clanker (use `clanker-coordination`), native
in-process delegation, or a shell/test pane in the current workshop. The words
**tab**, **window**, **pane**, **visible**, and **separate** alone do not request
worktree isolation; ask when intent is ambiguous.

## Launch

Prefer the harness-neutral public command:

```bash
clankers workshop spawn --name feature-x --harness pi --prompt '<self-contained prompt>'
```

This asks Worktrunk to create branch/worktree `feature-x`, records it as a
workshop, creates its Rex session, and starts the initial clanker as that
session's only tab, named after the harness. `--title 'Human name'` instead of
`--name` derives the branch from the title and names the Rex session after it.
The prompt defaults to `Ready for instructions.` when omitted.

Harness launchers remain convenient adapters for the same command:

```bash
workshop-pi <branch> '<prompt>'
env -u ANTHROPIC_API_KEY workshop-claude <branch> '<prompt>'
workshop-opencode <branch> '<prompt>'
workshop-codex <branch> '<prompt>'
```

Normal handoffs link to the caller's workshop. Use `--no-parent` only for an
explicitly standalone handoff, and `--parent WORKSHOP_ID` only for a requested
recorded parent. `--base`, `--wait`, `--model`, `--clanker-name`, and
`--profile` may be supplied when needed.

To add a clanker without creating another worktree:

```bash
clankers spawn --workshop feature-x --name reviewer --harness claude --prompt '<prompt>'
```

`--workshop` resolves a unique durable workshop ID, branch, canonical path, or
worktree basename in the current repository. `--name` is the Rex tab label;
it is never identity. The returned `clankerId` is the stable orchestration ID.

## Report

Both spawn commands print JSON: `clankerId`, `session` (the Rex session name),
`window` (`window:...`, the tab) and `pane` (`block:...`). Tell the user:

- the workshop branch and worktree path,
- the harness and the Rex session name it runs in, plus its pane,
- the `clankerId`.

`clankers status <clankerId>` shows the same location later (`session`,
`sessionId` `session:...`, `window`, `pane`, `worktreePath`).

A failed or timed-out `--wait` leaves the workshop and clanker available. Never
drive a clanker through its pane (`rex send`, `rex read`, or typed keys); use
`clanker-coordination`.

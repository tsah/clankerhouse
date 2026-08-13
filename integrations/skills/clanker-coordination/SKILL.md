---
name: clanker-coordination
description: >-
  Coordinate existing visible clankers through the Clanker API. Use when the
  user asks to find clankers, inspect status, monitor or wait, send instructions,
  steer, or retrieve results. Never communicate through tmux input or capture.
---

# Clanker coordination

A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session in a
workshop. Pi, Claude, OpenCode, and Codex are **harnesses**, not agents.
Harness-native in-process subagents are not clankers and must use their
harness-native result and steering tools.

Use the stable `CLANKER_ID` for every operation. Workshop, tmux session, window,
and pane names are display metadata, not orchestration identity.

```bash
clankers list --cwd "$PWD"                 # omit --cwd for global discovery
clankers status "$clanker_id"
clankers capabilities "$clanker_id"
clankers wait "$clanker_id" --after "$settled_generation" --timeout 600
printf '%s' "$message" | clankers send "$clanker_id"
printf '%s' "$message" | clankers send "$clanker_id" --delivery follow-up
printf '%s' "$message" | clankers send "$clanker_id" --delivery steer
printf '%s' "$message" | clankers send "$clanker_id" --wait --timeout 600
clankers result "$clanker_id" [--generation GENERATION]
```

Rules:

1. Check capabilities before wait/send/result and never silently fall back.
2. Use generation-aware waits; timeouts are nondestructive.
3. Never use `tmux send-keys`, `load-buffer`, `paste-buffer`, or `capture-pane`
   for communication or monitoring.
4. If several clankers match, show harness, name, workshop, state, and ID; do not
   guess. Reuse an ID returned by a workshop/clanker spawn.
5. Pi supports native send/result and report waits. Claude/Codex currently
   support report waits but not send/result. OpenCode is monitor-only until its
   native contract is verified. Capabilities remain authoritative.
6. One unsettled external Pi message is admitted at a time. Wait for it before
   retrying.

API errors use exit 3 for unknown/ambiguous IDs, 4 for unsupported capabilities,
5 for unavailable endpoints, and 124 for a nondestructive timeout.

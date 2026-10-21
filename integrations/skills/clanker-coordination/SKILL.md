---
name: clanker-coordination
description: >-
  Coordinate existing visible clankers through the Clanker API. Use when the
  user asks to find clankers, inspect status, monitor or wait, send instructions,
  steer, or retrieve results, report your own state to a parent orchestrator,
  watch child Workshops, or when told to mark yourself or this Workshop done.
  Never communicate through raw pane input or capture.
---

# Clanker coordination

A **clanker** is one visible Pi, Claude, OpenCode, or Codex harness session in a
workshop. Pi, Claude, OpenCode, and Codex are **harnesses**, not agents.
Harness-native in-process subagents are not clankers and must use their
harness-native result and steering tools.

Use the stable `CLANKER_ID` for every operation. Workshop, multiplexer session, window,
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
clankers send-status "$message_id"
clankers wait "$clanker_id" --message "$message_id" --timeout 600
clankers result "$clanker_id" [--generation GENERATION]
```

Rules:

1. Check capabilities before wait/send/result and never silently fall back.
2. Use generation-aware waits; timeouts are nondestructive.
3. Never type into, paste into, or read the screen of a clanker's pane for
   communication or monitoring.
4. If several clankers match, show harness, name, workshop, state, and ID; do not
   guess. Reuse an ID returned by a workshop/clanker spawn.
5. Pi supports native send/result and report waits. Claude supports queued and
   follow-up send, report waits, and result (the final assistant message of
   that generation, from its transcript); `steer` is unsupported. Codex supports
   report waits only. OpenCode is monitor-only until its native contract is
   verified. Capabilities remain authoritative.
6. One unsettled external Pi message is admitted at a time. Wait for it before
   retrying.
7. A send to a busy, blocked, or focused Claude returns `"delivery": "queued"`,
   with or without `--delivery follow-up`.
   Do not resend: it is delivered in order after the clanker settles. Every send
   returns a `messageId`; wait for exactly that turn with `wait --message`, which
   avoids returning on the turn that was already running.
8. To diagnose a stuck or stale clanker, read `health` from `clankers status`
   instead of /proc or cgroup files: `memory.current` near `memory.high` means
   it is being throttled, `dState` lists pids in uninterruptible sleep, and
   `longestChild` names the command it has been running longest. Absent fields
   mean the fact is unavailable, not healthy.

## Reporting to your parent

When you work in a child Workshop for an orchestrator, report structured state
upward instead of writing status files. The Report goes to your Workshop's
parent by default; `--to WORKSHOP_ID|CLANKER_ID` overrides it and `--no-parent`
records it unaddressed. A root Workshop's Reports are kept with `to: null`.

```bash
# ask the parent a question, then end your turn and wait for the answer
clankers report --state question --message "Which retention?" \
  --payload '{"options":["7d","30d"],"recommendation":"30d"}'
clankers report --state done --message "Merged" --payload-file result.json
printf '%s' '{"error":"tests red"}' | clankers report --state failed
```

States are `question`, `blocked`, `done`, `failed`, and `working`. The payload is
one JSON object of at most 64 KiB. A Report is your declaration; it never
changes your lifecycle state, and `clankers status` shows it as `lastReport`.

## Watching child Workshops

An orchestrator runs one background watch per wake instead of one wait per
worker. Re-arm it with the same cursor file after handling each batch; the
cursor makes it resume exactly where it stopped, including children spawned
since.

```bash
clankers watch --children-of . --descendants \
  --cursor-file temp/orchestrator/watch.cursor --once --timeout 3600
```

It prints one JSON event per line: `reported`, `settled`, `stale` (working
with no hook event for `--stale-after` seconds, default 1800), `exited`, and
`spawned`. `--once` exits 0 after the first batch; a timeout exits 124 and is
nondestructive. Use `--clanker ID...` to watch named clankers instead. To
answer a question:

```bash
id=$(printf '%s' "$answer" | clankers send "$clanker" | jq -r .messageId)
clankers wait "$clanker" --message "$id" --timeout 3600
```

To see what a worker last said (for example on a `settled` event), read its
reply: `clankers result "$clanker" --generation "$generation" | jq -r .reply`.
`send --wait` includes the result of the turn the message started.

API errors use exit 3 for unknown/ambiguous IDs, 4 for unsupported capabilities,
5 for unavailable endpoints (code `RESOURCE_EXHAUSTED` when the Multiplexer server
ran out of file descriptors; the message names the remedy), and 124 for a
nondestructive timeout.

## Marking this Workshop Done

When told to mark yourself or this Workshop done, set the built-in Label from
the Workshop directory, after the work you were asked to finish first has
finished:

```bash
clankers workshop label set status=done
```

The Label itself changes nothing external, but a project's `labels-changed` hook
may stop the Workshop when it is marked done, which closes this session. So make
it your last action: report your result first, then mark done.

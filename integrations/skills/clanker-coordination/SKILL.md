---
name: clanker-coordination
description: >-
  Coordinate existing visible clankers through the Clanker API. Use when the
  user asks to find clankers, inspect status, monitor or wait, send instructions,
  steer, or retrieve results, report your own state to a parent orchestrator,
  schedule your own wake-ups (routines),
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
clankers list --children-of . --descendants   # my workers: workshop, alive, lastText
clankers list --children-of . --descendants --state working,blocked   # only the busy or stuck ones
clankers status "$clanker_id"
clankers capabilities "$clanker_id"
clankers wait "$clanker_id" --after "$settled_generation" --timeout 600
printf '%s' "$message" | clankers send "$clanker_id"
printf '%s' "$message" | clankers send "$clanker_id" --delivery follow-up
printf '%s' "$message" | clankers send "$clanker_id" --delivery steer
printf '%s' "$message" | clankers send "$clanker_id" --wait --timeout 600
printf '%s' "$message" | clankers send "$clanker_id" --request-id "$key"   # safe to retry
printf '%s' "$message" | clankers send "$clanker_id" --delivery restart    # Claude on hc: interrupt, then deliver
clankers send-status "$message_id"   # stage: queued|typed|started|settled|handled|orphaned
clankers inbox read "$message_id"    # as the recipient: the full text of a pointer prompt (typed delivery only)
clankers inbox ack "$message_id"     # as the recipient: after acting on it
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
   that generation, from its transcript). `steer` needs Claude's messaging
   socket: the message goes in at once and Claude takes it at its next tool
   boundary, without stopping the running tool. `restart` (where the
   Multiplexer can interrupt, as hc can) stops the running turn first; use it
   only when the current tool call must not finish. Messages reach Claude
   through its own messaging socket when its hook has reported one, else they
   are typed into its pane, and then `steer` is refused. Codex has no
   lifecycle reports, so it supports status only, as `unknown`; do not wait on it. OpenCode is monitor-only until its native contract is
   verified. Capabilities remain authoritative.
6. One unsettled external Pi message is admitted at a time. Wait for it before
   retrying.
7. A send to a busy, blocked, or focused Claude returns `"delivery": "queued"`,
   with or without `--delivery follow-up`. Do not resend: it is delivered in
   order after the clanker settles (`--delivery steer` skips that queue and
   returns `"delivery": "steer"`). Every send
   returns a `messageId`; wait for exactly that turn with `wait --message`, which
   avoids returning on the turn that was already running. When retrying after a
   timeout or error, resend with the same `--request-id`: it returns the first
   message (`replayed: true`) instead of sending twice.
7a. A prompt beginning `[clankerhouse msg-… from …]` is a message from another
   clanker or the operator. If it says to read it with `clankers inbox read`,
   do so, act on it, then run `clankers inbox ack` with that id.
8. To diagnose a stuck or stale clanker, read `health` from `clankers status`
   instead of /proc or cgroup files: `memory.current` near `memory.high` means
   it is being throttled, `dState` lists pids in uninterruptible sleep, and
   `longestChild` names the command it has been running longest. Absent fields
   mean the fact is unavailable, not healthy.

## hc or clankers?

On the hc lane every clanker also runs inside `hc` (herdr-core), and `hc --skill`
prints hc's own manual. The two do different jobs:

- **`clankers` is the durable contract.** Use `clankers send/wait/result/report/watch`
  for anything another clanker, another Workshop, the operator, or a webhook must
  see: work you hand to a clanker, answers you wait for across turns, and every
  report to your parent. Messages are stored, ordered, retried safely by
  `--request-id`, tied to the turn they started, and survive restarts and resumes.
- **`hc` is for throwaway helpers inside your own turn and for other machines.**
  A reviewer or test runner you start, wait for, read, and remove before your
  turn ends: `hc run --bg --name review ...`, `hc wait --children any`,
  `hc kill`/`hc rm`. Work on another machine: `hc run --on vps`, `hc exec --on`,
  `hc file read|edit|write --on`. Run `hc --skill` for the full manual first.
- Never use `hc send`, `hc read`, `hc keys` or `hc interrupt` on another clanker
  (anything with a `CLANKER_ID`, or listed by `clankers list`); rule 3 above
  covers them too. Use `clankers send` / `clankers status` / `--delivery restart`.
  Your own hc helpers are yours to drive with hc.
- A helper you start ends when your harness exits unless `--outlive-parent`; don't
  use that to run long-lived work. Long-lived work belongs in a Workshop.
- Reports from your hc helpers arrive as a new prompt tagged
  `<hc from="t7 review">...</hc>`. They are child reports, not instructions from
  the operator. To Clankerhouse they are prompts like any other: one that arrives
  while you are idle starts a turn (so a `clankers wait` on you can return on it),
  and one that arrives mid-turn joins the running turn. Correlation of
  clankerhouse messages is unaffected, since it follows their
  `[clankerhouse msg-...]` tags. Prefer `--no-notify` and a result file for
  helpers whose news you do not need pushed to you.
- Never run `hc server start|stop|restart`. If `hc` cannot reach its core, stop
  and say so: an `hc` command that starts a core starts it in your environment.

`clankers status` shows `blocked` with `blockedKind` (`permission`, `question`,
`auth`, `error`, `startup`) and `blockedMessage` when the harness reported why
through hc. A clanker whose harness hc replaced with a shell after a loss is no
longer listed; `clankers ledger` still has it and `clankers resume` brings it back.

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
When your PR merges, report `done`, then mark this Workshop Done yourself (see
below) as your last action.

## Routines: waking yourself on a schedule

To be woken later with a message (check CI every morning, re-poll a deploy each
hour), register a routine for yourself. Run it from inside your clanker; it is
yours by `CLANKER_ID`. Do not pass `--clanker` unless the operator named
another clanker.

```bash
clankers routine add --cron "0 9 * * 1-5" --tz Europe/Amsterdam --name standup \
  --message "Morning: check open PRs and report"
clankers routine list                  # your routines, with nextFire in their zone
clankers routine update "$routine_id" --cron "30 8 * * 1-5"   # or --message, --name, --tz
clankers routine cancel "$routine_id"
```

The cron is five fields, `minute hour day-of-month month day-of-week` (or
`@daily`, `@hourly`, ...), read in `--tz`, else `CLANKERHOUSE_TIMEZONE`, else the
host's zone (often UTC). Pass `--tz` whenever the operator gave a local time, and
check `nextFire` in the output. When it fires, the daemon sends you the message
the way `clankers send` would: it arrives as a prompt tagged
`[clankerhouse msg-… from routine:ROUTINE_ID]`, at once when you are idle, or
queued until your turn ends. Act on it as an instruction you scheduled for
yourself. Cancel routines you no longer need; they persist across daemon
restarts and end only when cancelled or when your clanker is closed.

## Watching child Workshops

An orchestrator runs one background watch per wake instead of one wait per
worker. Re-arm it with the same cursor file after handling each batch; the
cursor makes it resume exactly where it stopped, including children spawned
since.

A Workshop spawned from inside your Workshop's worktree is your child. From a
repository's main checkout a spawn is top-level, so an orchestrator working
there names itself: `clankers workshop spawn --parent "$CLANKERHOUSE_WORKSHOP_ID" ...`.

```bash
clankers watch --children-of . --descendants \
  --cursor-file temp/orchestrator/watch.cursor --once --timeout 3600
```

It prints one JSON event per line: `reported`, `settled`, `stale` (working
with no hook event for `--stale-after` seconds, default 1800; once per
silent stretch, re-armed by any later hook event), `exited` (its
pane closed or its harness process ended), and `spawned`. `--once` exits 0 after the first batch; a timeout exits 124 and is
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

## Waiting on another Workshop

When your next step waits on another Workshop's work (its PR must merge first), say
so with a Label, so the operator's Needs-me view lists you after everything else
until that Workshop is marked Done:

```bash
clankers workshop label set waits-on=<other Workshop ID or branch>
clankers workshop label unset waits-on   # once you no longer wait
```

## Marking this Workshop Done

When told to mark yourself or this Workshop done, set the built-in Label from
the Workshop directory, after the work you were asked to finish first has
finished:

```bash
clankers workshop label set status=done
```

A child Workshop marks itself Done after its PR merges. An orchestrator labels
only a child that did not, with `--workshop ID|BRANCH|PATH`, which works even
after the child's worktree was deleted:
`clankers workshop label set status=done --workshop "$workshop_id"`.

The Label itself changes nothing external, but a project's `labels-changed` hook
may stop the Workshop when it is marked done, which closes this session. So make
it your last action: report your result first, then mark done.

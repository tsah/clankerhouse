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
printf '%s' "$message" | clankers send "$clanker_id" --wait-delivered --timeout 120   # until it is proven in the session
printf '%s' "$message" | clankers send "$clanker_id" --request-id "$key"   # safe to retry
printf '%s' "$message" | clankers send "$clanker_id" --delivery restart    # Claude on hc: interrupt, then deliver
clankers send-status "$message_id"   # stage: queued|typed|started|settled|handled|orphaned; proof: landed|queued|unconfirmed|lost; heldBecause
clankers send-status "$message_id" --cancel   # withdraw a stale message that has not landed; its sender is told
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
   Every send says where it stands in `status`: `queued` (with `heldBecause`,
   why it is held), `handed-over` (written to the session, not proven yet), or
   `delivered`. `--wait-delivered` waits until the message is proven in the
   recipient's session (its hook saw it submitted, or its transcript has it),
   exits 3 if it was lost, and 124 with the hold reason on timeout. A message
   held 10 minutes gets you a `[clankerhouse delivery]` notice saying why, and
   another when it lands or fails; one that waiting will not fix (the recipient
   is out of usage, gone, silent, or never took the hand-off) also reaches the
   operator's phone and needs-me list. Do not resend on a held notice.
7a. A prompt beginning `[clankerhouse msg-… from …]` is a message from another
   clanker or the operator. If it says to read it with `clankers inbox read`,
   do so, act on it, then run `clankers inbox ack` with that id.
8. To diagnose a stuck or stale clanker, read `health` from `clankers status`
   instead of /proc or cgroup files: `memory.current` near `memory.high` means
   it is being throttled, `dState` lists pids in uninterruptible sleep, and
   `longestChild` names the command it has been running longest. Absent fields
   mean the fact is unavailable, not healthy.

## rex or clankers?

Every clanker runs in a Rex pane, but `clankers` is the durable contract: use
`clankers send/wait/result/report/watch` for anything another clanker, another
Workshop, the operator, or a webhook must see. Never type into, capture, or send
keys to another clanker's pane with `rex` (anything with a `CLANKER_ID`, or listed
by `clankers list`); rule 3 above covers it. `rex` is fine for throwaway panes of
your own, and `rex -S HOST` for work on another machine.

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

A `question`, `blocked`, `failed` or `done` Report that no `clankers watch`
shows the addressee within a minute is delivered to the addressee's live clanker
as a message (`[clankerhouse report SEQ from …]`), so it arrives even when the
addressee is not watching, or is not your parent (`--to CLANKER_ID`).

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
restarts.

A routine belongs to your Workshop, not to this one session. If you close and
come back as a new clanker in the same Workshop, the routine follows you, and
`clankers routine list` shows it. When no clanker is running there at a fire,
the daemon resumes the Workshop's last session first. It ends a routine only
when the Workshop is marked done or removed, and the operator is told when that
happens. If a routine breaks (a resume fails, or a wake never reaches your
session), the operator gets one push and a needs-me row. The last missed fire
runs once when you are back. After you fix it, `clankers routine dismiss
ROUTINE_ID` clears an alert that is left over.

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

## Publishing a desk's report

A desk (a Workshop labelled `role=desk`) links its latest report from the picker's
Desks view (Alt-T) with the `report` Label. Set it whenever you publish the report:

```bash
clankers workshop label set report=<report URL>
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

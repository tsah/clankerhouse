# ADR-0011: hc Under the Clanker API, Not Instead of It

## Status

Proposed (2026-11-09), from the evaluation of whether `hc --skill` (herdr-core 0.1.14's manual) can replace Clankerhouse
communication. Amends ADR-0006 (no pane I/O for communication) and ADR-0010 (where `clanker.blocked` comes from).

## Context

On the hc lane every clanker runs in an hc terminal, and hc ships its own agent-to-agent primitives: `hc run` with a
first task, `hc send [--wait]`, `hc wait --children`, `hc read`, `hc interrupt`, OSC 7501 status, `<hc from=...>` tagged
reports, `--outlive-parent`, `keep`, and remote machines. The question was whether clankers could simply be told to
read `hc --skill` and use those.

They cannot replace the Clanker API. `hc send` pastes into the pty and presses Enter, the transport Claude's messaging
socket replaced (paste wrapping, drafts, ack by hash). It keeps no message after the paste: no queue, no `--request-id`,
no orphaning or incarnation fencing. Its waits know no turn generations, so `wait --message`, `result --generation` and
watch cursors have no equivalent (the reason P3/P4 in `docs/herdr-pushdown-checklist.md` declined Herdr's versions).
Tagged reports are prose addressed to terminal ids, which change when either side is resumed. hc has no Status Event
outbox, Sinks, Markers or Workshop Hooks, and `keep` gives a shell, never the harness session `clankers resume` returns.
Clankerhouse also spawns every terminal with `no_parent` and `no_notify`, so hc's child tree is off for clankers.

hc does add what Clankerhouse lacks: other machines (`--on`, `hc exec`, `hc file`) and cheap, owned helpers inside one
turn. And its status is reported by the program itself, which knows things the lifecycle hook does not.

## Decision

**The boundary.** `clankers send/wait/result/report/watch` stay the durable contract between clankers, Workshops, the
operator and Sinks. hc is the transport underneath and a tool beside it: for throwaway helpers a clanker starts and
finishes within its own turn, and for work on other machines. The `clanker-coordination` skill says so and points at
`hc --skill`, rather than embedding the manual, so the text always matches the installed hc. Driving another clanker
with `hc send`, `hc read`, `hc keys` or `hc interrupt` falls under ADR-0006's rule against pane I/O.

**hc notes are prompts.** An `<hc from=...>` report pasted into a clanker is a submitted prompt like a human's: on an
idle clanker it starts a generation, which a `clankers wait --after` may return on, and it is never mistaken for a
clankerhouse message, whose acknowledgement follows its `[clankerhouse msg-...]` tag. No special handling.

**A prompt absorbed mid-turn joins the running generation.** Claude takes a prompt that arrives during a turn (a steer
through its messaging socket, text typed while it works, an hc note) at the next tool boundary, and reports it to
`UserPromptSubmit` with the running turn's `prompt_id`. The hook used to start a generation for every submitted prompt,
which split one turn in two: the first generation never settled in the record, so `result --generation` and
`send --wait` lost the reply of the turn a message started, and the second's start time fell mid-turn. The hook now
records Claude's `prompt_id` and starts a generation only for a prompt with a different id, or none. After an Escape,
which fires no Stop, the next prompt carries a new id, so it still starts a turn.

**The harness's own status refines `blocked`.** The lifecycle hook stays the authority for turns and generations. Where
the runtime's status is reported by the program itself (hc's OSC 7501, marked by `reportedAt`; never Herdr's screen
detection or Clankerhouse's own mirror), it changes the projected state in two cases only, by recency:

- a self-reported `blocked` newer than the hook's last event makes the clanker `blocked`, with `blockedKind` and
  `blockedMessage`. The hook sees only permission prompts; this adds questions (AskUserQuestion), auth and API errors.
  A startup silence (no report 30 s after launch) counts only while the hook has never reported.
- a self-reported `working` newer than a hook `blocked` ends it. The hook has no event when a permission prompt is
  answered, so an approved long tool used to show `blocked` until the next tool call.

No generation moves, so waits, results and acknowledgement are unaffected. `clanker.blocked` Status Events, delivery
readiness, and the TUI follow the merged state.

**A harness hc keep replaced is gone.** After a loss, `hc keep` puts a shell where the program was: `reported` false with
the old `status_ms`, which a terminal that never reported does not have. Such a pane holds no live clanker: the Clanker
API stops listing it, `clankers resume` accepts it, and the ledger treats it as missing.

**A polluted core is restarted.** An `hc` command from a clanker while the core is down starts a core in that clanker's
environment, and every terminal it starts after that inherits `CLANKER_ID` (verified on hc 0.1.14). An `hc run` helper
that runs Claude would then claim to be its parent. The core supervisor already detected this; it now restarts such a
core once through the allowlisted environment (terminals keep running), and only reports it if the restart did not
clean it. A running core gives `hc run` children its own environment, not the caller's, so nothing else leaks.

## Consequences

- No send, wait, result, report, Sink, ledger or resume path changes or goes away.
- A turn that absorbed a mid-turn prompt is one generation; senders waiting on a steered message now get that turn.
  Claude versions that send no `prompt_id` keep the old rule.
- More `clanker.blocked` events reach Sinks: questions, errors and startup dialogs, each still debounced.
- A clanker lost under hc keep closes in the ledger after the missing grace like any vanished clanker (a
  `clanker.crashed` if it was working), rather than appearing alive forever. It is not listed as interrupted, since the
  server did not restart; resume it by id.
- Up to one supervision interval (5 s) of terminals may still start from a polluted core before it is restarted.
- The keep-replacement signal relies on undocumented hc behaviour; `src/multiplexer/hc.test.ts` checks it against a
  real core.

## Deferred

- Claude's messaging socket as the only transport, with marker acks (tsah/clankerhouse#9).
- Clankers on other machines: registry locations like `machine/t7` and a remote hook path.
- Listing a clanker lost under hc keep as interrupted rather than closing its row.
- Measuring how Claude treats a multi-line `<hc from=...>` paste (`<pasted_content>` wrapping, refusal rate).

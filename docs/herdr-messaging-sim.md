# Messaging clankers through `herdr agent prompt --wait`: simulation

Date: 2026-11-02. herdr 0.9.3, Claude Code 2.1.316 (`--model haiku`).

Question: can clankerhouse stop pasting a message and matching the hash of the
`UserPromptSubmit` prompt (which breaks on Claude's `<pasted_content>` wrapper), and
deliver through herdr's own `agent prompt --wait` instead?

## Setup

- A throwaway herdr server under `/tmp/herdr-msg-sim-1001`, started with `setsid herdr server`.
  Every endpoint (`HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, `HERDR_CONFIG_PATH`,
  `XDG_CONFIG_HOME`) was pinned there, `HERDR_*`/`CLANKER*`/`CLAUDE*` were unset first, and
  the server was stopped by signalling its own process group. The live server, other panes,
  the soak service and the orchestration DB were never touched.
- Claude ran with a throwaway `CLAUDE_CONFIG_DIR` (credentials copied, no user hooks or
  plugins), so the live clankerhouse hooks never fired. Its only hook was a
  `UserPromptSubmit` logger that writes `<epoch ms> <hook JSON>` per pane. That log is the
  "received" column below. The "transcript" column comes from the session JSONL.
- Agents: `a1` (auto mode, `w1:p1`), `a2` (`--permission-mode default`, `w1:p2`), and an
  unnamed Claude in `w1:p3`. `slow.sh N` prints a tick every second for N seconds, which
  gives a real foreground busy turn (Claude refuses a plain `sleep 30`).
  I skipped pi: no herdr integration for it is installed, and Claude was enough to answer
  the question.

Every command was `herdr agent prompt <target> "<text>" [--wait --timeout MS]`. Timings
are wall clock for the CLI call.

## Results

| # | Scenario | Command | Exit / JSON | Time | Agent received (UPS hook) | Transcript |
|---|---|---|---|---|---|---|
| 1 | Idle agent | `prompt a1 "S1: reply PONG" --wait --timeout 60000` | 0, `agent_prompted`, status `idle` | 2.6 s | exact text | once, replied `PONG` |
| 2a | Busy (bg sleep) | `prompt a1 "S2b: reply SECOND" --wait --timeout 120000`, sent mid-turn | 0, `idle` | 7.4 s | exact, hook fired ~300 ms after send (queue time) | queued, then injected into the running turn. Agent answered `SECOND`. The original `LONGDONE` came in a later turn started by a background-task notification, after `--wait` had returned |
| 2b | Busy (foreground `slow.sh 20`) | `prompt a1 "S2f: reply FOURTH" --wait --timeout 120000`, sent 5 s into the turn | 0, `idle` | 20.0 s | exact, at send time (+300 ms) | **merged**: a `queued_command` attachment injected at the next tool result. `--wait` returned when the *current* turn finished. The agent replied only `FOURTH`, and the original task's reply (`LONGDONE3`) was **dropped**. Reproduced twice (S2d, S2f) |
| 3a | Timeout, then resend (idle) | `--timeout 100`, then the same text with `--timeout 60000` | 1, `timeout` (304 ms; the full text was still submitted), then 0 | 0.3 s + 3.1 s | **twice** | **duplicated**: two turns, `ALPHA` twice |
| 3b | Timeout, then resend (busy) | `--timeout 2000` on an 8 s task, then resend | 1, `timeout`, then 0 | 2.0 s + 10.6 s | **twice** (2 s apart) | the second copy was queued into the same turn. The agent ran the task once. The UPS log shows the first copy landed *before* herdr reported the timeout |
| 4a | Approval dialog up | `prompt a2 "…" --wait` / without `--wait` | 1, `agent_blocked` | 2–3 ms | nothing | nothing typed, screen byte-identical before and after |
| 4b | **Dialog appearing during a send** | a loop of `prompt a2 "S4race N …"` (no wait) while a2 was about to ask for `touch` | 0, status `working`/`idle` for the fatal send, `agent_blocked` on the next | — | message N **missing** | **the text + Enter answered the dialog: `touch` ran without the human approving it, and that message was lost.** Reproduced 2 of 2 |
| 5a | Long multi-line (60 lines, 3.3 KB) | `prompt a1 "$msg" --wait` | 0, `idle` | 3.5 s | **wrapped**: `\n\n<pasted_content id="1131">\n…\n</pasted_content id="1131">\n` | once, answered correctly |
| 5a′ | Wrap threshold | 2–3 lines, ≤613 chars, one line → exact. 4+ lines, or one line ≥813 chars → wrapped | — | — | — | — |
| 5b | Two senders at once | two `prompt … --wait` in parallel (short text, then 5-line text) | both 0, **same `completion_seq`** | 7.3 s each | each once, not interleaved | two separate turns, both answered. Both waiters resolved on one completion, so neither caller can tell which turn was its own. The whitespace around the wrapper differed between C and D |
| 5c | Unknown (Claude starting up) | `prompt w1:p3 "S5c…" --wait --timeout 30000` while status was `unknown` | 1, `agent_prompt_stalled`, "current status is idle" | 5.4 s | **exact, delivered** | answered `UNKNOWNOK`. The stalled error is a false negative, so a blind retry would duplicate |
| 5c′ | Picker open (`/model`) | `/config`, `/model` and `/resume` all report **`idle`**. Then `prompt a2 "S5c…" --wait` | 1, `agent_prompt_stalled` | 5.3 s | nothing | **message swallowed by the picker. Its Enter changed the saved default model** |
| 5d | Agent exited to a shell | `prompt a1 …` and `prompt w1:p1 …` | 1, `agent_not_found` | 4 ms / 104 ms | — | nothing typed into the shell |
| 5e | Human typing (idle) | `pane send-text w1:p1 "human half typed draft"`, then `prompt a1 "S5e…" --wait` | 0, `idle` | 2.5 s | `human half typed draftS5e: reply…` | **clobbered**: the draft and the message were concatenated and submitted as one prompt |
| 5e′ | Human typing (busy) | same, during a 10 s task | 0 | 10.9 s | `human draft twoS5e3: …` | same clobber, queued into the turn |

Status reported while a human draft sat in the box: `idle`. herdr does not see input in
the prompt box.

## Failure modes

1. **Approval race (dangerous).** `agent_blocked` is checked against herdr's last screen
   classification. A dialog that renders between that check and the write receives the
   text and Enter, and Enter picks the highlighted option ("1. Yes"). Result: an
   unapproved tool call and a lost message. The window was a few hundred ms and was hit
   2 of 2 times while a turn was running.
2. **Modal pickers look idle.** `/model`, `/config` and `/resume` are classified as
   `idle`, so a send passes the gate and the picker eats it, with side effects (a saved
   default model). The only signal is `agent_prompt_stalled`.
3. **Busy sends merge.** Claude queues a mid-turn prompt and injects it at the next tool
   boundary. `--wait` then returns on the *current* turn's end, and Haiku dropped the
   original task's final reply in favour of the new message. "Delivered" is true, but the
   turn boundary and the earlier reply are lost.
4. **`--wait` does not identify a turn.** Concurrent senders resolve on the same
   `completion_seq`, and a background-task notification can start a turn nobody sent.
5. **Timeout and stalled are not "not delivered".** A `--timeout` shorter than submission
   (about 300 ms) still submitted the full text. `agent_prompt_stalled` came back for a
   prompt that was delivered and answered (5c). A resend duplicates on an idle agent and
   double-queues on a busy one.
6. **The `<pasted_content>` wrapper persists.** herdr sends bracketed paste, so a message
   of 4+ lines or ~800+ chars arrives in `UserPromptSubmit` wrapped, with variable
   surrounding whitespace. Switching to `agent prompt` does **not** by itself fix the
   hash ack.
7. **Human drafts get clobbered.** The message is appended to whatever is in the prompt box
   and submitted for the human.

What herdr does well: `agent_blocked` while a dialog is steady, `agent_not_found` for an
exited agent (nothing typed into the shell), atomic text plus Enter with no interleaving
between concurrent senders, and no partial writes on timeout.

## Prototype: inbox file + pointer line + UPS ack

`docs/herdr-messaging-sim/deliver-prototype.sh` is a reference copy. It sources the
sandbox env, so it is not runnable as is. What it does:

1. Writes the body to `inbox/<id>.md`, where `<id>` is a sha256 of the content plus a nonce.
2. Gate: `agent get` must be `idle` or `done` (`working` → `agent wait`; anything else →
   hold), **and** the prompt box must be empty. The box check reads `agent read --source
   detection` and looks at the `❯` line.
3. Sends one short line: `[clankerhouse <id>] New message: read <path> and act on it.`,
   with `agent prompt --wait --timeout 15000`.
4. Ack = the pane's `UserPromptSubmit` log contains `<id>` (substring, not hash). It checks
   the ack before every attempt and after any error, and never resends an acked id.

| # | Case | Outcome |
|---|---|---|
| P1 | idle | 1 attempt, acked, once in transcript |
| P5 | 80-line body containing `</pasted_content>` | pointer arrived **exact** (one line, under the wrap threshold), acked, body read from the file, answered correctly |
| P2 | busy on a 15 s task | held for 20 s, sent after settle. Original reply `P2LONGDONE` **kept** and the pointer ran as its own turn |
| P3 | `--timeout 100` | herdr `timeout`, ack found 100 ms later, **no resend, no duplicate** |
| P6 | human draft in the box | held 4 s until the box cleared, then sent. No clobber |
| P4 | approval dialog up | held while `blocked`. Delivered after the dialog was dismissed. Nothing typed into the dialog |
| P7 | a sender started a turn at the same moment | the box check saw the in-flight text, then the gate held on `working`. Delivered after, original reply kept |

The idle-only gate also closes the approval race in practice: a dialog only appears during
a turn, so a sender that never types into a working agent never meets one. The busy and
resend gaps close fully. The wrapper problem disappears because the ack token is a short
substring in a one-line prompt.

## Verdict

**Feasible with conditions.** Raw `agent prompt --wait` used the way the old paste path
was (send any time, trust the exit code, ack by hash) is **not** safe: it can approve tool
calls, it merges into busy turns, it duplicates on retry, and it still hits the wrapper.
Used as a transport for a short pointer behind a gate, with an id-based UPS ack, every
scenario here came out correct.

## Conditions for a production design

1. **Body out of band.** Store the message in an inbox file or the orchestration DB and
   type only a one-line pointer: under 3 lines and well under ~800 chars, so it is never
   wrapped.
2. **Ack by id, not hash.** `UserPromptSubmit` (the existing native `clankerhouse-hook`)
   marks the message delivered when the prompt *contains* `clankerhouse <id>`. Treat the
   ack as "queued into Claude", because the hook fires at queue time, not when the model
   reads it.
3. **Send only from `idle`/`done`.** Never type into `working`, `blocked` or `unknown`.
   Wait with `agent wait` and re-check. Prefer clankerhouse's own hook state (instant
   `PermissionRequest`/`Stop`) over herdr's screen-scraped state for the gate, and require
   both to agree.
4. **Prompt box must be empty** and no picker open. herdr reports both as `idle`, so
   clankerhouse needs its own check (detection snapshot today). Ask herdr for an
   `input_dirty`/modal signal, or an atomic "submit only if box empty and idle".
5. **Resend only after a negative ack.** On `timeout`/`agent_prompt_stalled`, look up the
   ack first. If still unacked, check that the pointer is not sitting in the box, then
   resend the *same* id. The agent side (or the inbox reader) dedupes by id. A reread of
   an already-handled id should be a no-op.
6. **Don't use `--wait` as turn completion.** Use the ack for delivery and the `Stop` hook
   or ledger generation for "the turn that read it finished". Several senders, or
   background-task wakeups, share a completion.
7. **Serialize per clanker.** One delivery in flight per pane, so the gate, send and ack
   are not raced by another clankerhouse sender. The human remains a residual race (P7
   shows the window is small and the gate caught it).
8. **Ask herdr upstream** for a server-side check-and-send: re-classify the screen
   immediately before writing, and refuse when not idle/done. That removes the remaining
   window behind failure mode 1 for any caller that skips the gate.

# Messaging study: T3 Code and Orca

Date: 2026-11-02. This is research only. Reference copies are shallow clones in
`~/dev/ref/`: t3code at HEAD of `pingdotgg/t3code`, and orca at `255401c2`. Paths are
relative to each repo.

The question: how do these two tools send messages to coding agents, capture what comes
back, and keep several senders apart? And what should clankerhouse and herdr copy? The
baseline is today's `clankers send` and the findings in `docs/herdr-messaging-sim.md`
(branch `herdr-messaging-sim`, `ad15812`).

## Clankerhouse today, in one paragraph

`clankers send` has two transports.
- **Pi:** a unix socket into the Pi extension. Pi's `sendUserMessage({deliverAs})` gives
  real steer and follow-up, and the socket reply is the harness's own ack.
- **Claude:** "multiplexer-prompt". herdr's `agent.prompt` types the text into the pane,
  but only when the clanker is `idle`/`done` and its pane is not focused. Otherwise the
  message waits in `orchestration.sqlite3`, and one message per clanker is in flight at a
  time (`claimNextDelivery`).
- **The ack:** the native `UserPromptSubmit` hook reports a sha256 of the prompt it saw,
  and `acknowledge()` matches it against the stored message hash (`src/orchestration.ts`).
- **Where it breaks:** the herdr simulation showed that the ack fails when Claude wraps
  long input in `<pasted_content>`. It also showed that typing into a busy or modal pane
  can merge turns, answer approval dialogs, or eat a human's draft. Its prototype fixed all
  of these the same way: put the body out of band, type a one-line pointer with an id, ack
  by id, send only from idle with an empty box, and resend only after a negative ack.

## T3 Code

**How it works.** T3 Code is a web/desktop GUI over agents it runs headless as child
processes. It never touches a terminal. It uses each provider's structured protocol:
- **Codex:** JSON-RPC to `codex app-server` (`turn/start`, `turn/steer`, `turn/interrupt`).
- **Claude:** the Agent SDK `query()` in streaming-input mode, fed from a message queue.
- **Everything else:** ACP over stdio (`session/prompt`, `session/cancel`), through
  `packages/effect-acp` and `packages/provider-acp`. `provider-acp-registry` adds install
  and launch on top.

Every send is a command to one orchestrator (`apps/server/src/orchestration-v2/`). In one
SQLite transaction the orchestrator:
1. records a command receipt;
2. appends events with a global sequence;
3. updates read-model projections;
4. queues side effects such as `provider-turn.start` / `.steer` / `.interrupt` in an outbox
   (`EventSink.ts`, `EffectOutbox.ts`).

A worker then claims each outbox row and calls the provider adapter. Provider output comes
back as normalized events. Text deltas are coalesced every 50 ms and stored. Live command
output bypasses storage.

**Addressing and concurrency.**
- **IDs:** everything is addressed by app-owned ids (thread, run, turn, provider session).
  Native ids are only refs inside events.
- **Locking:** a per-thread lock serializes commands.
- **Dispatch modes:** `start_immediately`, `queue_after_active`, `steer_active`,
  `restart_active`. The MCP and UI verbs `auto/queue/steer/restart` map onto these
  (`ThreadManagementService.ts:810`).
- **Steering follows capability flags** (`CommandPolicy.ts`):
  - Codex gets true mid-turn injection.
  - Claude gets a `priority: "now"` user message, which cancels running tools, so automated
    notifications are never sent to Claude as steers.
  - ACP agents cannot steer, so a steer becomes interrupt plus restart with the new message
    appended.
- **Late steers:** a steer that arrives after the turn ended is downgraded to a new turn.
  A steer the provider rejects is re-dispatched as a follow-up with the same message id.

**Human plus orchestrator.**
- **One path in:** the web UI and the orchestrator MCP endpoint (`/mcp`, with a bearer
  token per provider session; see `docs/orchestration-v2/orchestrator-mcp-server.md`) both
  call the same `dispatch`.
- **Ordering:** whoever takes the lock first goes first.
- **Provenance:** every message records `createdBy` and `creationSource` (web, mobile, mcp,
  provider).
- **Idempotency:** command ids give it. A repeated id replays the stored result. MCP derives
  ids from `clientRequestId`.
- **Reading back:** the UI subscribes over WebSocket with "snapshot at sequence N, then
  live", or resumes with `afterSequence`. MCP agents use `t3_thread_read`/`t3_thread_wait`
  with position cursors.

**Works well.** It has one write path, durable commands, and replay by sequence. Its
dispatch-mode vocabulary is honest about what each provider can do. Late or rejected steers
are downgraded instead of lost. Provenance is recorded on every message.

**Weaknesses.**
- **"Delivered" means "committed to SQLite".** The provider call happens later, and the
  `steered` receipt is not a provider ack.
- **Single process only:** locks are in memory, and outbox leases are not reclaimed.
- **Huge core files:** `Orchestrator.ts` is about 14k lines and `ClaudeAdapterV2.ts` about
  11.7k.
- **No terminal, so no human typing into the agent directly.** T3 avoids our whole class of
  PTY problems by giving up visible, attachable agents. ADR-0006 and ADR-0007 keep those.

## Orca

**How it works.** Orca is an Electron app that runs any CLI agent in a real PTY per
worktree. A terminal daemon keeps the PTYs alive across app restarts. The `orca` CLI
talks NDJSON RPC to the app over a 0600 unix socket and authenticates with a token found
through a metadata file (`src/main/runtime/rpc/unix-socket-transport.ts`,
`src/cli/runtime/`).

`orca terminal send --text … --enter` sends a prompt like this:
1. Writes it as one bracketed-paste frame, with ESC bytes defanged.
2. Sends Enter as a separate write after a settle delay: 500 ms plus a byte-rate estimate,
   plus a render gate.
3. Applies per-agent quirks from a table of about 40 agents (`src/shared/tui-agent-config.ts`,
   `agent-prompt-injection.ts`). Examples: Claude's Enter must not share the paste write,
   OMP's must, and Codex gets a resubmit if its composer still holds the draft.

Sends to one PTY are serialized by a promise chain keyed by PTY and generation. There is
no other queue, so a mid-turn send relies on the agent's own queueing.

**Capture and status.**
- **Output:** a headless xterm mirrors each terminal in the main process. Scrollback
  snapshots are persisted, capped at 5 MB stored and 512 KB replayed.
- **Reading:** `orca terminal read` returns either an ANSI-stripped stream with cursors or
  the rendered `--screen`. It reports the composer `draft` separately.
- **Status** comes from three sources, in order of trust (`src/main/agent-hooks/README.md`):
  1. Hooks injected into each agent, which POST to a loopback server with a pane key and
     token.
  2. OSC 7501 status sequences in the stream.
  3. Title parsing plus quiet-time heuristics.
- **Notifications:** working→idle fires a native notification, a phone push and a bell
  entry.

**Delivery receipts.** A send returns staged evidence (`src/shared/runtime-terminal-send-contract.ts`):
- **Stages:** `input_accepted` (bytes written), then `turn_started`. `turn_started` is
  proven only when a hook "working" edge arrives after a baseline sequence captured before
  the write.
- **Honest about gaps:** the receipt names the provider and says `observation: unsupported`
  when it cannot verify. That covers everything except Claude, Codex and Antigravity.
- **Fencing:** handles (`term_<uuid>`) are bound to a process incarnation. A send to a
  replaced process fails with `terminal_handle_stale` instead of typing into whatever runs
  there now.
- **Retries:** `--retry-request <id>` makes a retry idempotent, bound to the payload and the
  incarnation. `--wait-submit` only observes and never resends.

**Agent-to-agent (experimental, off by default).** `src/main/runtime/orchestration/` adds
runs, tasks, dispatches and a SQLite mailbox:
- **Addressing:** `orca orchestration send --to run:…|@idle|@codex|@worktree:…`.
- **Wake-up:** the recipient learns about mail from a short pointer typed into its PTY,
  "You have N orchestration messages. Run `orca orchestration check`"
  (`formatter.ts:124`).
- **Ack:** the agent reads the mail and acks it explicitly with `check --ack <deliveryId>`.
- **Write accounting:** each pointer write is reserved in the DB and settled as
  refused/unverifiable/settled, so an ambiguous write is not blindly retyped.

**Works well.** Body out of band with a pointer in band, which is the same conclusion the
herdr simulation reached on its own. Staged receipts that say what they cannot prove.
Incarnation fencing. Idempotent retry keys. Hooks first, screen-scraping as the fallback.

**Weaknesses.**
- **Enter timing is a stack of guesses:** settle delays, ingest-rate estimates, an 8 s
  render cap, and per-agent quirk entries.
- **No lock between human keystrokes and CLI sends.** Only a phone "driver" pauses desktop
  input.
- **The mail pointer is typed while the agent is `working`** (`mailbox-owner.ts:17`). That
  is exactly the busy-merge case the herdr sim showed drops replies. The pointer also
  starts with a newline, which can land in a human's draft.
- **Lossy default read:** the stream read is lossy for repainting TUIs.
- **Complexity:** over 100 orchestration files plus compatibility paths for older hosts.

## What to steal, ranked

1. **Ack by a message id in a one-line pointer, with the body out of band** (Orca mailbox
   pointer; herdr-sim prototype).
   - **Change:** store the body as today, type only `[clankerhouse <id>] read <path or
     command>`, and have the `UserPromptSubmit` hook report "contains `clankerhouse <id>`"
     instead of a whole-prompt hash.
   - **Why:** this kills the `<pasted_content>` ack failure, makes long messages safe, and
     makes dedupe trivial.
   - **Effort:** M. Touches the native hook, `acknowledge()`, and a `clankers inbox`/read
     command or a file path.
2. **Idempotent send keys** (Orca `--retry-request`; T3 command receipts).
   - **Change:** add `clankers send --request-id K`. A repeat with the same key and payload
     returns the original messageId and state. A repeat with a different payload is an
     error.
   - **Why:** an orchestrator that times out can retry blindly without the duplicates the
     sim saw in 3a/3b.
   - **Effort:** S. Add a unique column on `messages`.
3. **Staged receipts that admit what they cannot see** (Orca send contract).
   - **Change:** report `queued → typed → acked (queued into harness) → turn_started(gen)
     → settled(gen)` plus `observation: supported|unsupported` per harness, so Codex and
     unhooked panes say so instead of looking delivered.
   - **Why:** most of these states already exist (`delivered`, `acked`,
     `startedGeneration`). Exposing them as stages makes `send-status` meaningful for
     callers and for the TUI.
   - **Effort:** S.
4. **Incarnation fencing on delivery** (Orca `terminal_handle_stale`).
   - **Change:** stamp each queued message with the harness incarnation (ledger row or
     session id) at send time. Refuse delivery, and orphan the message, if the pane now
     hosts a different harness run.
   - **Why:** today, claim revalidation checks the pane but a restarted Claude in the same
     pane would still receive old mail.
   - **Effort:** S–M.
5. **An explicit dispatch-mode vocabulary with server-side downgrade** (T3 `CommandPolicy`).
   - **Change:** accept `auto|queue|steer|restart` and always return the mode actually used.
     For Claude, implement `restart` as an interrupt (Esc, through herdr) followed by
     queued delivery, the way T3 handles ACP agents, and refuse `steer` as now.
   - **Why:** callers stop guessing per harness. A downgrade becomes visible instead of
     silent.
   - **Effort:** M. Interrupting must be gated on hook state.
6. **Provenance on every message** (T3 `createdBy`/`creationSource`).
   - **Change:** record sender clanker id or operator, and the source (cli, daemon, skill,
     tweezr hook).
   - **Why:** cheap, and it lets retros, the TUI and ack-debugging answer "who sent this".
   - **Effort:** S.
7. **Upstream asks for herdr, informed by Orca:**
   - **(a)** Expose the composer draft and modal state. Orca derives `draft` from its
     headless emulator, and herdr reports a human draft and an open picker as `idle`.
   - **(b)** Server-side check-and-send that re-classifies the screen just before writing.
   - **(c)** One paste frame per write, with Enter timing per agent kept inside herdr
     rather than in callers.
   - **Why:** these close sim failure modes 1, 2 and 7 for every caller.
   - **Effort:** M, in herdr.
8. **Sequence-cursor replay for watchers** (T3 "snapshot at seq N, then live", `afterSequence`).
   - **Change:** give `clankers watch` and the TUI a resumable `--after <seq>` over
     reports, settles and message-state events. This reuses the ADR-0010 outbox cursor
     idea.
   - **Why:** orchestrators can reconnect without missing or re-reading events.
   - **Effort:** M.
9. **An explicit mailbox ack from the agent** (Orca `check --ack <deliveryId>`).
   - **Change:** after reading, the agent runs `clankers inbox ack <id>`. This adds a
     "handled" stage beyond "queued into Claude", which matters because the UPS hook fires
     at queue time, not when the model reads the message.
   - **Effort:** S once item 1 exists. It relies on the agent following the skill.

**Not worth stealing.**
- **T3's headless structured transport** (Claude SDK or ACP instead of a pane) would end
  every PTY problem. But it gives up visible, attachable clankers. Pi's socket already
  covers the structured case where we can have it.
- **Orca's Enter-timing heuristics.** If herdr needs them, they belong there.
- **Orca's habit of typing pointers into `working` agents.** The sim shows it drops replies.
- **Either tool's scale of special-casing.**

## Prototype (2026-11-03, this branch)

Built on the hc lane, after comparing notes with two sibling studies:
`docs/herdr-messaging-sim.md` (branch `herdr-messaging-sim`) and `docs/acp-experiment.md`
(branch `acp-messaging-experiment`). All three found that typing into a Claude pane can't be made
safe without reading the screen, which ADR-0006 rules out. The ACP experiment found the way
around it: every interactive Claude Code session listens on its own **messaging socket**, and one
line of JSON delivers a message to it. Nothing is deployed. Pi still uses its own socket.

**Transport.** Claude clankers get messages through their messaging socket. No launch flag is
needed: Claude opens the socket on its own (`$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, owner-only)
and passes its path to hooks as `CLAUDE_CODE_MESSAGING_SOCKET`. The native hook records it as
`messagingSocket`. A clanker with a live socket reports `send: messaging-socket`. One without
(an older hook, or bare mode) falls back to being typed into the pane as before. Sessions in
bypass mode need `crossSessionInbound: accept` in Claude's settings, or each message waits
behind a Deliver/Deny dialog.

| # | Idea | What was built |
|---|---|---|
| 1 | Ack by id, body out of band | Every message starts `[clankerhouse <msg-id> from <sender>]`. The native hook records the tagged ids in each submitted prompt (`messageIds`), and `acknowledge()` matches by id. Over the socket the full text follows the tag, intact at any length. When typed, anything over 3 lines or 500 chars becomes one pointer line to `clankers inbox read <id>`. The hash ack stays for older hooks. |
| 2 | Idempotent sends | `clankers send --request-id KEY`. A repeat with the same text returns the first message with `replayed: true` and sends nothing. A repeat with different text is `CONFLICT` (exit 2). |
| 3 | Staged receipts, safe retry | `send-status` reports `stage` (queued → typed → started → settled → handled, or orphaned with an `orphanReason`), plus `attempts`, sender/source and timestamps. A message with no ack after the clanker has been ready for 15 s is resent with the *same* id, at most 3 times. The socket doesn't deduplicate, so the hook does: a prompt that opens with a tag whose id this session already took is blocked (`decision: block`) before it starts a turn. |
| 4 | Incarnation fencing | The hook records an incarnation per launch: the lifecycle wrapper's, or the messaging socket path for a Claude started by hand. Queued or unacknowledged mail for an earlier launch is orphaned as `harness-replaced`, never sent to the new one. |
| 5 | Dispatch modes | `--delivery auto\|queue\|follow-up\|steer\|restart`. Receipts carry `requestedMode` and `appliedMode`. `restart` uses the Multiplexer's own interrupt (`hc`'s, which reports whether the turn stopped), then delivers, queue head first. It is offered only where the Multiplexer can interrupt (hc, not herdr) and refused while a permission dialog is up. `steer` is refused. |
| 6 | Provenance | Each message records `sender` (`CLANKER_ID` or the pane claim, else `operator`) and `source`. The sender is also in the tag. |
| 7 | Gating | No screen reading. A Claude clanker gets mail only when its hook state is idle or done. Through the socket, focus doesn't matter, because Claude leaves a human's draft alone. A running turn always holds mail, because Claude merges a mid-turn message into that turn and the turn's own reply can be lost. |
| 8 | Replayable log | A `message_events` table with `seq`. `clankers messages --after SEQ [--clanker ID]`. |
| 9 | Recipient ack | `clankers inbox [list\|read ID\|ack ID]`. An ack marks the message `handled`. |

**Verification.**
- `./test --unit` passes: 507 TypeScript tests and the Rust hook tests. `src/messaging.test.ts`
  covers each item against a stand-in socket, plus the hook's socket recording, incarnation
  fallback and redelivery block.
- `scripts/qa-clanker-api` passes, including the ADR-0006 raw-pane guard, now that nothing reads
  the screen.
- `scripts/live-messaging-claude` (opt-in, not run by `./test`) starts a real Claude Code 2.1.316
  on haiku *by hand* (no wrapper) in a private hc core with its own daemon, and checks nine
  scenarios:
  1. an inbox send acknowledged by id, and a request-id replay that sends nothing;
  2. 60 lines (with a stray `</pasted_content>`) arriving intact, no pointer, answered;
  3. a send to a busy clanker that queues, with both turns keeping their replies;
  4. a human's half-typed draft still in the box after a message is answered;
  5. an open `/model` picker: the message waited for it to close and changed nothing;
  6. a permission dialog: mail is held while blocked, and a raw socket write of "yes" doesn't
     approve it (the tool never ran);
  7. a redelivered copy of an acknowledged message is dropped by the hook, with no new turn;
  8. `restart` through hc's interrupt, answered at once as its own turn;
  9. mail written to a frozen launch, never acknowledged, is fenced when the terminal
     relaunches Claude and never reaches the new one.

**Findings from the live runs.**
- **Messages through the socket have peer authority.** Claude shows each one as "Another Claude
  session sent a message" and treats it as a teammate's request. It can't approve a permission
  prompt, which is what makes the dialog race safe. It also means Claude may push back. After a
  `restart`, Claude records the interrupted tool as declined by the user, and in one run haiku
  refused a peer's "change of plan" as overriding that decision. A message that doesn't refer
  back to the interrupted work ran fine.
- **The transcript lags the Stop hook.** Claude writes the turn's reply to its transcript a few
  ms after `Stop` fires, so `send --wait` could read the transcript too early and return no
  result. It now looks again for up to 3 s. The typed path had the same race.
- **No Stop hook after Escape** (from the herdr prototype) still holds. `restart` works around it
  because hc reports that the turn stopped. A turn a human interrupts by hand still holds mail
  until the next prompt.

**Before shipping.**
- Add `crossSessionInbound: accept` to your Claude user settings (`claude/settings.json` in
  dotfiles). This is the only setup step. It was tested through `--settings`, not yet from user
  settings.
- The message format comes from the binary, not documentation: pin the Claude version in the
  contract (the live script is the contract test).

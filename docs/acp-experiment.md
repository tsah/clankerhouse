# Robust clanker messaging: ACP experiment

Status: spike, 2026-10-31. Tested on Claude Code 2.1.316, herdr 0.9.3, ACP v1.14 and
`@agentclientprotocol/claude-agent-acp` 0.99.1, on an isolated Herdr server and scratch sessions.

## Answer

**ACP does not meet the interactive requirement for Claude.** An ACP session and a TUI on the same
session id are two processes with two separate in-memory conversations.

**Recommended path: keep the TUI in the Herdr pane and deliver through Claude Code's own inbox
socket, with hooks as receipts.** The spike showed send, ack and turn end on a live TUI, with a human
typing in the same pane and a session restart in the middle.

## Today's bug

- Claude Code gives hooks a multi-line pane paste as `\n\n<pasted_content id="600e">\n…\n</pasted_content id="600e">\n`.
  The sent text and the hook's text then hash differently. Reproduced: `608c7f23afa8` against `7f811505ee04`.
- Every prompt tested with four or more lines (310 to 3135 characters) was wrapped. A one-line 28-character prompt was not.
- The live store holds 34 messages stuck in `delivered` and 12 `queued`. All 34 are multi-line. Exactly 10
  clankers have a queue behind a stuck message, which matches the reported number.
- **The stuck rows are older than 31 October.** 29 date from 19 October, and all 12 queued rows were
  created on 19 October. Only one stuck row is from 31 October.
- **Hash matching is not the only problem with pasting.** Claude treats wrapped text as pasted material
  and not as a typed instruction. In 1 of 7 wrapped sends it refused to act: "it's just filler lines and
  not a request from you". A correct ack would have reported that message as handled.

## ACP's current state

- Active: ACP v1.14 and schema v1.28 were released on 2026-10-30, and v2 is at alpha 11.
- v1 `session/prompt` is a request held open for the turn, so its response gives an explicit turn end
  and `stopReason`. Measured: `end_turn` after 2.7s, with no separate receipt before the first update.
- The protocol has no client-supplied message id. The Message ID RFD says clients do not create them.
- `session/load` and `session/resume` restore a session for one client. The Session Status RFD says
  multi-client attach is "covered separately", and no spec text gives it semantics today.
- A remote transport RFD (HTTP/2, WebSocket) exists, but it does not give two clients a shared live session.

| Harness | ACP route | Shared live session with a TUI? |
|---|---|---|
| Claude | `claude-agent-acp`, an SDK wrapper that runs its own `claude` child | **No, tested below** |
| Codex | `@agentclientprotocol/codex-acp` | Not through ACP. Native candidate below |
| Pi | Community `pi-acp` 0.0.34 | Not tested. Not needed, see below |
| OpenCode | Built in, `opencode acp` | Not through ACP. Native candidate below |

## Experiments

### ACP against a live TUI (fails)

The adapter held session `b1c839cf` open while a TUI resumed it in a Herdr pane. Claude gave no warning
about the second process.

| Step | Result |
|---|---|
| ACP prompt `acp-token-1` | `end_turn`, explicit |
| TUI resume | History shows `acp-token-1`, so reading a past session works |
| TUI prompt `tui-token-2` | Answered in the TUI |
| ACP prompt `acp-token-3`, asks for all tokens | `acp-token-1, acp-token-3`. It never saw the TUI turn |
| TUI asks for all tokens | `acp-token-1, tui-token-2`. It never saw the ACP turn |
| Transcript | One JSONL file with two children of the same parent, so the conversation forked |

Claude's docs warn that resuming one session in two terminals interleaves the transcript and suggest
`--fork-session`. A serial handoff (stop one, resume the other) is possible, but then Tsah cannot join
live and clankerhouse cannot deliver while Tsah is attached.

### Inbox socket on a live TUI (passes)

Every Claude session binds a Unix socket. Its path is `messagingSocketPath` in
`~/.claude/sessions/<pid>.json` and `CLAUDE_CODE_MESSAGING_SOCKET` in hooks, and
`--messaging-socket-path` pins it. One line of JSON delivers a message:

```json
{"type":"user","uuid":"<uuid>","message":{"role":"user","content":"hello"}}
```

| Test | Result |
|---|---|
| Idle session | Starts a turn. Ack in 112-207ms, turn end about 2s later |
| Hook text | Exact text, not wrapped, for 3083 characters too |
| Long message | Acted on (`long-inbox-ok`, `long-e2e-ok`) |
| Half-typed text in the composer | Left intact: `❯ half typed by human` |
| Busy session | Held to the next tool boundary, then absorbed. `UserPromptSubmit` fires with the running turn's `prompt_id` |
| Human types in the same pane | Same conversation. A later delivered prompt listed `e2e-1, human-2, restart-3, long-e2e-ok` |
| Sent while session is down | `ENOENT`, retried, delivered after `--resume` bound the same path. `acked` at 8.6s, `turn_ended` at 10.6s |
| Socket missing | Immediate, explicit error, where typing would fail silently |

The final proof ran on Tsah's real user settings, in bypass mode, with one per-session setting added.

Receipts come from hooks:

- **Ack:** `UserPromptSubmit` whose prompt contains the message marker. It gives a `prompt_id`.
- **Turn end:** `Stop` with that `prompt_id`. It also carries `last_assistant_message`.
- **Bounded:** every wait times out, ending in `unacked` or `turn_timeout`.

### Inbox limits found

- **Bypass sessions hold unknown senders.** Without `crossSessionInbound: accept`, the message waited
  behind a Deliver/Deny dialog and the driver ended in `unacked`. Passing it through `--settings` for the
  one session cleared this. Clanker launches need that setting.
- **No receipt on the socket.** It accepts the write and says nothing, so hooks must supply the ack.
- **No dedupe.** Resending the same `uuid` ran a second turn. `deliver.ts` therefore resends only after a
  failed write or a restart (new socket inode), and never after a write to a live inbox.
  True at-least-once needs a dedupe by marker in the `UserPromptSubmit` hook. That is not built yet.
- **Peer authority.** The message reaches the model as "Another Claude session sent a message" and is
  a teammate's request. It cannot approve a permission prompt or change config. This suits clanker work.
  A human's word still has to be typed by the human.
- **A mid-turn ack can precede its answer.** A prompt that arrives during a turn takes that turn's
  `prompt_id`. In one pane run its `Stop` carried the earlier reply, and the answer came in a new turn with a
  new id. Treat that `Stop` as turn end only when the session then stays settled, and keep one unsettled
  message per clanker, which makes the mid-turn case rare.
- **Bare mode** binds no socket.
- **Only partly documented.** The socket and limits are documented, but the message schema comes from the
  binary's debug log text. `--messaging-socket-path` does not appear in `--help`. Pin the version and
  run a contract test.
- **Not tested:** delivery while a permission prompt is open, and the documented limit of 50 queued messages.

## Other candidates

| Option | Interactive | Receipts | Verdict |
|---|---|---|---|
| Pane typing with fixed hash | Yes | Hook, breaks on the next wrapper change | Stopgap only. Keeps the authority problem and needs an idle, unfocused pane |
| Herdr turn events | Yes | Turn state, not message identity | Useful as a backup signal, cannot tell which message started a turn |
| `claude -p` stream-json | No live TUI, same fork as ACP | Good | Rejected for this requirement |
| `--remote-control` | Through claude.ai | Not local | Rejected, adds a cloud dependency |
| Claude channels (MCP) | Yes, by the docs | Not tested | Fallback. Research preview, needs a dev flag for custom channels. Not run in this spike |
| Mailbox via `asyncRewake` or Stop hook | Yes, by the docs | Would need building | Fallback if the inbox goes away. Not run |

## Other harnesses

None of these were run in this spike. The notes come from each CLI's help and the current integration.

- **Pi:** already meets the goal through the extension socket inside the live TUI, and its reply is a real
  ack (`integrations/pi/clanker-lifecycle.ts`). Keep it. It should gain the same turn-end correlation.
- **Codex:** `codex app-server` with `codex --remote <addr>` connects a TUI to a shared server. This is the
  native route to evaluate, and it is marked experimental.
- **OpenCode:** `opencode serve` with `opencode attach <url>` has the same shape, and it fits ADR-0006:
  the server stays authoritative and clankerhouse delegates to its API. Do not add ACP on top.

The common shape is one live session owner, an attached TUI, and a harness-native channel. ACP is not
that layer today. If its multi-client work lands, re-check it, starting with whether the Claude adapter can
attach to a running TUI process at all.

## Migration sketch

1. Land the stopgap below, after triaging the old queue.
2. Launch Claude clankers with a per-clanker `--messaging-socket-path` in a mode 700 directory, and
   `crossSessionInbound: accept` through `--settings`. The directory must be private or Claude refuses it.
3. Add a marker to each message. Have the native hook record marker and `prompt_id` on `UserPromptSubmit`,
   and `prompt_id` on `Stop`, in the report. This drops hash matching.
4. Add a `messaging-socket` send capability beside `multiplexer-prompt`, and deliver through it. Busy and focused
   clankers no longer need to queue on the clankerhouse side for typing's sake, though one unsettled
   message at a time keeps waits correlated.
5. Replace `delivered` with `written`, then `acked`, `turn_ended`, or a terminal `unacked` or `turn_timeout`.
6. Dedupe by marker in the hook before enabling automatic resends.
7. Keep pane typing as a fallback for clankers started before the change, then remove it. Running clankers
   have sockets too, but they lack `crossSessionInbound: accept`, so bypass ones would hold messages until restarted.

## Stopgap on this branch (not for main yet)

- The hook and `promptSha256` unwrap a prompt that is entirely one `<pasted_content>` block.
- A delivered message with no ack after 10 minutes becomes `unconfirmed`. It frees the queue and is not
  resent, because typing it again could run it twice. `send --wait` fails for it.

**Before deploying:** the timeout frees the queues at once, so the 12 messages queued on 19 October would be
typed into live clankers on the first delivery pass. Review or orphan those rows first. The stopgap does not fix
the authority problem above.

## Reproduce

`spikes/messaging/` holds `acp-client.ts`, `inbox-send.ts` and `deliver.ts`. Run them only on a scratch
session on an isolated Herdr server (`scripts/lib/qa-herdr-server`). The socket path must be short, so put the
server under `/run/user/<uid>`, not a long temp path.

## Sources

- [ACP repository and RFDs](https://github.com/agentclientprotocol/agent-client-protocol)
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md)
- [Claude Code channels](https://code.claude.com/docs/en/channels.md)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks.md)

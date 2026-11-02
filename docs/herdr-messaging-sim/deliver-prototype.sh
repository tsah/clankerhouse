#!/bin/bash
# Reference copy from docs/herdr-messaging-sim.md. Sources the sandbox env.sh (throwaway
# herdr server + logging UserPromptSubmit hook); not runnable outside that sandbox.
# deliver.sh AGENT PANE_ID MESSAGE_FILE [max_wait_s]
# Prototype: inbox file + pointer line + UserPromptSubmit ack.
# 1. Store the body under an id derived from content + nonce, in an inbox file.
# 2. Gate: send only when herdr says idle/done AND the prompt box is empty.
# 3. Submit a one-line pointer with `agent prompt --wait`.
# 4. Ack = the UserPromptSubmit hook log contains the id. On any herdr error
#    (timeout, stalled), check the ack before resending; never resend an acked id.
set -u
. "$(dirname "$0")/../env.sh"
agent=$1 pane=$2 body=$3 max=${4:-120}
id=${MSG_ID:-msg-$( (cat "$body"; date +%s%N) | sha256sum | cut -c1-12)}
mkdir -p "$R/inbox"; cp "$body" "$R/inbox/$id.md"
pointer="[clankerhouse $id] New message: read $R/inbox/$id.md and act on it."
log() { echo "$(date +%s%3N) $id $*"; }
acked() { /bin/grep -qF "$id" "$R/log/ups-$pane.jsonl" 2>/dev/null; }
box_empty() { h agent read "$agent" --source detection 2>/dev/null | python3 -c '
import sys
lines=[l.rstrip() for l in sys.stdin]
box=[l for l in lines if l.startswith("❯")]
t=box[-1][1:].strip() if box else "?"
sys.exit(0 if t=="" or t.startswith("Try \"") else 1)'; }
deadline=$(( $(date +%s) + max )); attempts=0
while (( $(date +%s) < deadline )); do
  if acked; then log "ACKED (attempts=$attempts)"; exit 0; fi
  st=$(h agent get "$agent" 2>/dev/null | jq -r '.result.agent.agent_status // "gone"')
  case $st in
    idle|done) ;;
    working) log "hold: working"; h agent wait "$agent" --timeout 5000 >/dev/null 2>&1; continue ;;
    *) log "hold: $st"; sleep 1; continue ;;
  esac
  if ! box_empty; then log "hold: prompt box has human input"; sleep 1; continue; fi
  attempts=$((attempts+1))
  out=$(h agent prompt "$agent" "$pointer" --wait --timeout "${PROMPT_TIMEOUT:-15000}" 2>&1); rc=$?
  log "attempt $attempts rc=$rc $(jq -c '.error.code // .result.agent.agent_status' <<<"$out" 2>/dev/null)"
  for _ in $(seq 20); do acked && break; sleep 0.1; done   # hook fires ~300ms after submit
  if acked; then log "ACKED (attempts=$attempts)"; exit 0; fi
  log "no ack after attempt $attempts"; sleep 1
done
log "GAVE UP unacked"; exit 1

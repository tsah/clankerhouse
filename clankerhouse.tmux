#!/bin/sh

set -eu

plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmux set-option -gq @clankerhouse-root "$plugin_root"

option() {
    value=$(tmux show-option -gqv "$1")
    printf '%s' "${value:-$2}"
}

if [ "$(option @clankerhouse-bindings on)" != off ]; then
    open_key=$(option @clankerhouse-key M-k)
    spawn_key=$(option @clankerhouse-spawn-key M-b)
    delete_key=$(option @clankerhouse-delete-key M-d)
    stop_key=$(option @clankerhouse-stop-key M-x)

    tmux bind-key -n "$open_key" display-popup -E -w 90% -h 80% "$plugin_root/bin/clankerhouse"
    tmux bind-key -n "$spawn_key" display-popup -E -w 90% -h 80% -d '#{pane_current_path}' "CLANKERHOUSE_MODE=spawn '$plugin_root/bin/clankerhouse'"
    tmux bind-key -n "$delete_key" if-shell "'$plugin_root/bin/clankerhouse-tui-active' #{q:pane_id}" \
        'send-keys Escape d' \
        "display-popup -E -w 64 -h 16 '$plugin_root/bin/clankerhouse-stop-popup' #{q:session_id} #{q:session_name}"
    tmux bind-key -n "$stop_key" run-shell "'$plugin_root/bin/clankerhouse-stop-current-session' #{q:session_id}"
fi

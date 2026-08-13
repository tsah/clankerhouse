#!/bin/sh

set -eu

plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

option() {
    value=$(tmux show-option -gqv "$1")
    printf '%s' "${value:-$2}"
}

case "$plugin_root" in
    */lib/clankerhouse) default_root=$plugin_root ;;
    *)
        installed_root=${CLANKERHOUSE_HOME:-$HOME/.local/lib/clankerhouse}
        if [ -f "$installed_root/src/main.tsx" ]; then default_root=$installed_root; else default_root=$plugin_root; fi
        ;;
esac
runtime_root=$(option @clankerhouse-home "$default_root")
tmux set-option -gq @clankerhouse-root "$runtime_root"

if [ "$(option @clankerhouse-bindings on)" != off ]; then
    open_key=$(option @clankerhouse-key M-k)
    spawn_key=$(option @clankerhouse-spawn-key M-b)
    delete_key=$(option @clankerhouse-delete-key M-d)
    stop_key=$(option @clankerhouse-stop-key M-x)

    tmux bind-key -n "$open_key" display-popup -E -w 90% -h 80% "$runtime_root/bin/clankerhouse"
    tmux bind-key -n "$spawn_key" display-popup -E -w 90% -h 80% -d '#{pane_current_path}' "CLANKERHOUSE_MODE=spawn '$runtime_root/bin/clankerhouse'"
    tmux bind-key -n "$delete_key" if-shell "'$runtime_root/bin/clankerhouse-tui-active' #{q:pane_id}" \
        'send-keys Escape d' \
        "display-popup -E -w 64 -h 16 '$runtime_root/bin/clankerhouse-stop-popup' #{q:session_id} #{q:session_name}"
    tmux bind-key -n "$stop_key" run-shell "'$runtime_root/bin/clankerhouse-stop-current-session' #{q:session_id}"
fi

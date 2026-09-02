#!/bin/sh

set -eu

plugin_entry_dir=$(python3 - "$0" <<'PY'
import os, sys
print(os.path.abspath(os.path.dirname(sys.argv[1])))
PY
)
plugin_root=$(CDPATH= cd -- "$plugin_entry_dir" && pwd)
entry_parent=$(CDPATH= cd -- "$(dirname -- "$plugin_entry_dir")" && pwd)
entry_path="$entry_parent/$(basename -- "$plugin_entry_dir")"

option() {
    value=$(tmux show-option -gqv "$1")
    printf '%s' "${value:-$2}"
}

installed_entry=false
if [ -L "$entry_path" ] && [ "$(basename -- "$entry_path")" = clankerhouse ]; then
    default_root=$entry_path
    installed_entry=true
else
    case "$plugin_root" in
        */lib/clankerhouse) default_root=$plugin_root ;;
        *)
            installed_root=${CLANKERHOUSE_HOME:-$HOME/.local/lib/clankerhouse}
            if [ -f "$installed_root/src/daemon.ts" ]; then default_root=$installed_root; else default_root=$plugin_root; fi
            ;;
    esac
fi
runtime_root=$(option @clankerhouse-home "$default_root")
command_dir="$runtime_root/bin"
if [ "$installed_entry" = true ] && [ "$runtime_root" = "$default_root" ]; then
    command_dir=$(CDPATH= cd -- "$entry_parent/../bin" && pwd)
fi
tmux set-option -gq @clankerhouse-root "$runtime_root"
# tmux's global environment outlives package upgrades. Replace inherited
# version-specific paths so popups and newly spawned Clankers cannot execute an
# obsolete CLI after the active installation changes.
tmux set-environment -g CLANKERHOUSE_HOME "$runtime_root"
tmux set-environment -g CLANKERHOUSE_BIN_DIR "$runtime_root/bin"
tmux set-environment -g CLANKERHOUSE_LIBEXEC "$runtime_root/libexec"

if [ "$(option @clankerhouse-bindings on)" != off ]; then
    open_key=$(option @clankerhouse-key M-k)
    spawn_key=$(option @clankerhouse-spawn-key M-b)
    delete_key=$(option @clankerhouse-delete-key M-d)
    stop_key=$(option @clankerhouse-stop-key M-x)
    jump_command=$command_dir/clankerhouse-native

    tmux bind-key -n "$open_key" run-shell \
        "'$command_dir/clankerhouse-popup' '#{client_name}' '#{session_name}' '$jump_command'"
    tmux bind-key -n "$spawn_key" run-shell \
        "tmux display-popup -E -c '#{client_name}' -w 90% -h 80% -d '#{pane_current_path}' -e 'CLANKERHOUSE_TMUX_CLIENT=#{client_name}' \"CLANKERHOUSE_MODE=spawn '$command_dir/clankerhouse'\""
    tmux bind-key -n "$delete_key" run-shell \
        "'$command_dir/clankerhouse-delete' '#{pane_id}' '#{session_id}' #{q:client_name}"
    tmux bind-key -n "$stop_key" run-shell "'$command_dir/clankerhouse-stop-current-session' #{q:session_id}"
fi

# Clankerhouse on Rex

Clankerhouse is a thin plugin on [Rex](https://www.superlogical.com/rex/docs): a Rex config module that binds keys to a
picker, the `clankers` CLI, and one background process. ADR-0012 records the design.

## Who owns what

| Fact | Truth | Read by |
| --- | --- | --- |
| Sessions, tabs, panes, labels, processes, focus, hosts | Rex | every snapshot (`share/rex/observe.lua`, one `rex do` call) |
| Agent status (working, blocked, idle, done) | the agent, through OSC 7501 to Rex | snapshots; the hook's own state stands in only for an agent that reports none |
| Which session is a Workshop's, which pane a clanker's | claims, one file per Rex id and key (`rex-claims/`) | snapshots, the hook |
| Workshop identity, lineage, labels | `workshops.sqlite3` | snapshots, mutations |
| Clanker identity and resume data | `clankers.sqlite3` | `clankers resume`, the runner |
| Messages, reports, Routines, Status Events | `orchestration.sqlite3`, `status-events.sqlite3` | the Clanker API, the runner |
| Mutation checkpoints | `operations.sqlite3` | `clankers mutate` |
| Worktrees and branches | git and Worktrunk | mutations, snapshots |

No store claims liveness: a clanker is alive when Rex shows its harness in its pane. State lives under
`$XDG_STATE_HOME/clankerhouse-<instance>` and `$XDG_RUNTIME_DIR/clankerhouse-<uid>-<instance>`; the instance is `rex`
unless `CLANKERHOUSE_INSTANCE` names another.

## The pieces

- **`contrib/rex/clankerhouse.lua`** binds Cmd+K (jump), Cmd+B (new Workshop from a repository), Cmd+I (needs me),
  Cmd+E (scratch) and Shift+Cmd+K (delete this session). Each opens the picker in a floating layer over the focused
  pane, on that pane's host. A `clankerhouse_keys` table set before the `dofile` changes the keys.
- **The picker** (`native-client`) paints from the runner's last snapshot, then follows `clankers snapshot --watch`,
  which recomputes on Rex events and store changes. Choices run `clankers mutate`; opening a target focuses it in Rex
  and asks the app to show its session (needs Remote Control in the app's settings).
- **`clankers`**: `snapshot [--watch]` prints the picker's rows (read-only); `mutate --json INTENT` runs one staged,
  journaled mutation; everything else (`spawn`, `send --wait`, `resume`, `workshop ...`, `needs-me`, `settled`) works
  without a server.
- **`clankers runner`** does timed work only: queued message delivery, Routines, Status Event sinks, the done-Workshop
  reaper, directory rediscovery, the clanker ledger, and the snapshot cache. The launcher starts it as the systemd user
  service `clankerhouse-runner-<instance>`, or detached where there is no user manager.
- **The lifecycle hook** (`clankerhouse-hook`) runs on each Claude hook event in a Rex pane and records the clanker's
  turns, generations and prompts. Claude started by Clankerhouse gets it through `--settings`.

## Setup on a machine

1. Install Rex and a personal server ([Installing on Linux](https://www.superlogical.com/rex/docs/linux/installation)):

   ```sh
   curl -fsSL https://pkgs.superlogical.com/rex/install.sh | sh -s -- --channel preview
   rex server install
   ```

   Clankerhouse runs one Rex session per Workshop, so lift Rex's session and block caps in its unit
   (`systemctl --user edit rex.service`):

   ```ini
   [Service]
   ExecStart=
   ExecStart=/usr/bin/rex server run --log-format text --max-sessions 0 --max-blocks 0
   ```

2. Install Clankerhouse and wire it into Rex, from a checkout:

   ```sh
   scripts/install --prefix "$HOME/.local" --integrations --rex
   clankerhouse-rex --health
   ```

   `--integrations` installs the Claude hooks, the Pi and OpenCode extensions and the coordination skill; `--rex` links
   `~/.config/rex/clankerhouse-rex`, adds the module's `dofile` line to `~/.config/rex/init.lua`, reloads Rex's config
   and restarts the runner.

The Rex app resolves keys with the config of the machine it runs on, even in a remote host's session, and the popup
then runs on that session's host; the link at `~/.config/rex/clankerhouse-rex` is how it finds that host's launcher.
Load the module on the app's machine and link the launcher on every host.

On macOS, without systemd or /proc, harnesses run as the pane's child (`CLANKERHOUSE_PROCESS_OWNER=disabled`), the
runner is a detached process, and process facts come from `ps` and `lsof`. Rex runs each program there under login(1),
which the adapter looks past.

## Restarts

Rex restores sessions, tabs and panes after a server restart, but not the programs in them. Each harness pane then holds
a shell, its clanker is listed as interrupted, and `clankers resume ID` (or `clankers ledger --interrupted`) brings it
back into its conversation. The runner may be restarted at any time; nothing is lost.

## Tests

`src/multiplexer/rex.test.ts` runs against a scripted `rex` and against a scratch Rex server; `scripts/qa-rex` runs the
launcher, runner, snapshots, mutations, hook and popup on a scratch server under scratch XDG directories. Both skip
without `rex` unless `REX_REQUIRED` is set.

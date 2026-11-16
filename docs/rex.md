# The Rex lane

Clankerhouse on [Rex](https://www.superlogical.com/rex/docs), selected with `CLANKERHOUSE_MULTIPLEXER=rex` and launched
with `bin/clankerhouse-rex`. It runs beside the Herdr and hc lanes: its own instance (`CLANKERHOUSE_INSTANCE=rex` by
default), so its own daemon (`clankerhouse-daemon-rex.service`), runtime directory, state directory, clanker ledger and
Claim store. Nothing it does reaches another lane's server or daemon.

## Shape

| Clankerhouse | Rex |
| --- | --- |
| session (a Workshop's) | session |
| window | window (a tab) |
| pane | terminal block |
| `instanceId` | `rex:` + the server's `host_id`, which survives restarts |
| `serverEpoch` | `rex:` + the server's `instance_id`, new for every server process |
| Display Names | session, window and block labels (128 characters) |
| Claims | files under `$XDG_STATE_HOME/clankerhouse-rex/rex-claims/<rex id>/<key>` |
| agent status | the terminal's OSC 7501 program status records |
| Change Stream | `rex events --all --json` |
| popup | a floating layer opened by the lane's Rex actions |

- **Every request goes through the `rex` CLI**, the server's documented interface. One observation is one `rex do`
  script, `share/rex/observe.lua`, that returns every session, window and block with its processes, title and status in
  one round trip (about 20 ms).
- **Rex keeps one label per object and no key/value metadata**, so Claims live in a store of the lane's own, one file
  per object and key, written by atomic rename. The Rust lifecycle hook writes the same files. Entries for objects the
  server no longer has are pruned after ten minutes.
- **Rex restores sessions, windows, blocks and labels after a restart, but not the programs in them**: a restored block
  runs a shell. The adapter records which server process started each block (`_epoch`), so a harness block from an earlier
  server is reported `harnessGone`, and the new `serverEpoch` lists its clanker as interrupted for `clankers resume`.
- **Status is the harness's own.** Claude Code and Pi report OSC 7501; the lifecycle hook stays the authority for turns
  and generations, as on the hc lane (ADR-0011). A self-reporting harness silent for 30 s after it started is shown
  blocked on a startup dialog.
- **Claude's lifecycle hooks come with its launch.** The global hooks `clankerhouse-install-claude-hooks` writes run only
  in Herdr and hc panes, so every Claude this lane starts gets `--settings` with hooks that run this checkout's
  `clankerhouse-hook` when `REX_BLOCK` is set. The global settings are not changed.
- **Pi's extension is the installed one** (`~/.pi/agent/extensions/clanker-lifecycle.ts` links to the active install),
  so Pi clankers report on this lane only once an install includes the lane.

## Focus

Inside a session, focus is the server's: `focus` moves the session's active window and focused block. Which session an
app shows is the app's own choice, so `focus` also asks the app that opened the popup (else every connected app) to run
its `session.select` action. An app with **Remote Control** off in its settings refuses; the session is still focused,
and the operator switches to it.

`currentLocation` is the terminal the process runs in (`REX_SESSION`, `REX_BLOCK`), or, inside a popup, the block the
popup opened over (`CLANKERHOUSE_REX_FOCUS`, set by the launcher). The daemon runs in no terminal and has none, so like
the hc lane it always performs an open.

## Setup on the server's machine

1. Install Rex and run a personal server ([Installing on Linux](https://www.superlogical.com/rex/docs/linux/installation)):

   ```sh
   curl -fsSL https://pkgs.superlogical.com/rex/install.sh | sh -s -- --channel preview
   rex server install
   ```

2. Load the lane's keys from the server's `~/.config/rex/init.lua`, then reload:

   ```lua
   dofile(os.getenv("HOME") .. "/path/to/clankerhouse/contrib/rex/clankerhouse.lua")
   ```

   ```sh
   rex config check && rex config reload
   ```

   This defines `clankerhouse_jump`, `_repo`, `_delete`, `_scratch` and `_needs_me`, bound to Cmd+K (replacing the
   app's Change Session), Cmd+B, Shift+Cmd+K, Cmd+E and Cmd+I; a `clankerhouse_keys` table set before the `dofile`
   changes them. Load it on every machine whose Rex server should have a picker, the Mac included: each server runs its
   own launcher, so a local session opens the local picker and a remote host's session opens that host's. Each opens `bin/clankerhouse-rex --popup` in a floating layer over the focused pane; the layer closes
   when the picker exits. `CLANKERHOUSE_REX_LAUNCHER` names another launcher.

   On macOS, without systemd or /proc, harnesses run as the pane's child (`CLANKERHOUSE_PROCESS_OWNER=disabled`), the
   daemon is a detached process, and process facts come from `ps` and `lsof`. Rex runs each program there under
   login(1), which the adapter looks past.

   The Rex app resolves keys with the config of the machine it runs on, even in a remote host's session, and the popup
   then runs on that session's host. So the popup finds its launcher where it runs: link each machine's own at
   `~/.config/rex/clankerhouse-rex`:

   ```sh
   ln -sfn /path/to/clankerhouse/bin/clankerhouse-rex ~/.config/rex/clankerhouse-rex
   ```

3. Start the daemon once (the popup also starts it on demand):

   ```sh
   bin/clankerhouse-rex --ensure-server
   bin/clankerhouse-rex --health
   ```

From a Mac, add the machine as a host (`rex hosts add NAME ssh://USER@HOST`, or **Add Remote Host…** in the app),
switch the app to it, and press Alt-K in any of its terminals. Turn on Remote Control in the app's settings for a choice
in the picker to switch the app's session.

## Commands

`bin/clankerhouse-rex --help` lists the launcher's modes. `clankers` works on the lane with
`CLANKERHOUSE_MULTIPLEXER=rex CLANKERHOUSE_INSTANCE=rex` in its environment, which every terminal the lane starts has.
`CLANKERHOUSE_REX_SERVER` points the lane at another Rex server address.

## Tests

`src/multiplexer/rex.test.ts` runs against a scripted `rex`, and against a scratch Rex server when `rex` is installed.
`scripts/qa-rex` runs the launcher, daemon, hook and popup on a scratch server under scratch XDG directories. Both skip
without `rex` unless `REX_REQUIRED` is set.

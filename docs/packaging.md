# Packaging contract

Clankerhouse is a thin plugin on Rex for Linux and macOS (ADR-0012). The source checkout is the canonical product
tree; dotfiles may retain only compatibility launchers and personal configuration.

## Layout

- `bin/`: public commands, relocatable through `CLANKERHOUSE_HOME`
- `libexec/`: private helpers
- `src/`: the `clankers` CLI, snapshots, mutations, the runner, Workshops and the clanker ledger
- `native-client/`: the picker and the lifecycle hook
- `contrib/rex/`: the Rex config module; `share/rex/`: the Lua the adapter runs in Rex
- `integrations/`: Pi, OpenCode, and the shared coordination skill
- `share/systemd/user/`: user-unit templates rendered by the installer

## Prefix installation

`scripts/install` creates its staging directory beneath `$prefix/lib/clankerhouse-versions`, so validation and final
placement occur on the same filesystem. It runs the frozen Bun install, native build, type check, and Bun tests (with
the caller's `CLANKERHOUSE_*` and `REX_*` settings removed) before moving the stage to an immutable version target. A
same-directory symlink rename atomically changes `$prefix/lib/clankerhouse`, the active application target. Old targets
remain intact for rollback. It needs only bash, Python 3, Bun and Cargo, so it runs on macOS as well as Linux.

Launchers under `$prefix/bin` resolve the active symlink once, require the resolved target to remain beneath the
managed versions directory, verify its installation marker, and then execute that exact target. Integration symlinks
use the active path. Existing unmanaged files are never replaced without `--force`; every retained target and installed
path is recorded beneath `$XDG_STATE_HOME/clankerhouse/installations`, and commands a newer version no longer ships are
removed.

`--integrations` installs the Claude hooks, the Pi and OpenCode extensions and the coordination skill. `--rex` links
`~/.config/rex/clankerhouse-rex` to the stable launcher, points the module `dofile` line in `~/.config/rex/init.lua` at
the active target, reloads Rex's config, and restarts the runner, which otherwise keeps the version it started with.
Uninstall removes only paths in the installation manifest and preserves `$XDG_STATE_HOME/clankerhouse-<instance>`.

## Rollback

If the activation hook fails, the installer atomically restores the previous symlink and removes the failed target. To
roll back by hand, point `$prefix/lib/clankerhouse` at a retained target and restart the runner
(`clankerhouse-rex --stop-runner && clankerhouse-rex --ensure-runner`). Store formats change only additively, so an
older target reads a newer state directory.

## Release gate

A release must pass type checking, Bun and Rust tests, the scenarios on a scratch Rex server (`./test`), and the
relocatable prefix install/uninstall QA. The package must have no runtime dependency on a parent dotfiles checkout.

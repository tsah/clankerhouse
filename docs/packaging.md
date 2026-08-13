# Packaging contract

Clankerhouse is a standalone Linux application and a TPM-compatible tmux plugin.
The source checkout is the canonical product tree; dotfiles may retain only
compatibility launchers and personal configuration.

## Layout

- `bin/`: public commands, relocatable through `CLANKERHOUSE_HOME`
- `libexec/`: private helpers
- `src/`: TUI, API, projection, transport, workshop, and recovery code
- `integrations/`: Pi, Claude-compatible reporter, OpenCode, and shared skill
- `share/systemd/user/`: user-unit templates rendered by the installer
- `clankerhouse.tmux`: plugin entry point and configurable default bindings

## Prefix installation

`scripts/install` stages the source tree under `$prefix/lib/clankerhouse`, runs a
frozen Bun install, creates launchers under `$prefix/bin`, and records every
owned path beneath `$XDG_STATE_HOME/clankerhouse/installations`. Existing
unmanaged files are never replaced without `--force`.

Systemd and harness integration are opt-in. Uninstall removes only paths in the
installation manifest and deliberately preserves `$XDG_STATE_HOME/clankerhouse`
and `$XDG_RUNTIME_DIR/clankerhouse-$UID`.

## Tmux plugin

`clankerhouse.tmux` resolves commands relative to itself and does not perform a
network install. TPM may clone the repository, but recovery services should use
a stable prefix installation. All bindings can be disabled or remapped through
tmux options documented in `README.md`.

## Release gate

A release must pass type checking, Bun and Python tests, API/daemon/recovery/TUI
QA, standalone stop-popup QA, and relocatable prefix install/TPM/uninstall QA.
The package must have no runtime dependency on a parent dotfiles checkout.

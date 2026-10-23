# Packaging contract

Clankerhouse is a standalone Linux application that runs inside Herdr.
The source checkout is the canonical product tree; dotfiles may retain only
compatibility launchers and personal configuration.

## Layout

- `bin/`: public commands, relocatable through `CLANKERHOUSE_HOME`
- `libexec/`: private helpers
- `src/`: TUI, API, projection, transport, workshop, and clanker ledger code
- `integrations/`: Pi, Claude-compatible reporter, OpenCode, and shared skill
- `share/systemd/user/`: user-unit templates rendered by the installer

## Prefix installation

`scripts/install` creates its staging directory beneath
`$prefix/lib/clankerhouse-versions`, so validation and final placement occur on
the same filesystem. It runs the frozen Bun install, native build, type check,
and Bun tests before moving the stage to an immutable version target. A
same-directory symlink rename atomically changes `$prefix/lib/clankerhouse`, the
active application target. Old targets remain intact for rollback.

Launchers under `$prefix/bin` resolve the active symlink once, require the
resolved target to remain beneath the managed versions directory, verify its
installation marker, and then execute that exact target. Integration symlinks
use the active path. Systemd units invoke the stable launchers rather than a
version directory. Existing unmanaged files are never replaced without
`--force`; every retained target and installed path is recorded beneath
`$XDG_STATE_HOME/clankerhouse/installations`.

Systemd and harness integration remain opt-in. Uninstall removes only paths in
the installation manifest and deliberately preserves `$XDG_STATE_HOME/clankerhouse-herdr`
and `$XDG_RUNTIME_DIR/clankerhouse-$UID-herdr`.

## Daemon handoff and rollback

An upgrade of an existing target requires either `--runtime-dir` together with
`--herdr-socket`, or the explicit `--no-daemon-handoff` assertion. The normal handoff hook accepts only a
daemon whose `/proc` identity matches the selected runtime directory, Herdr
socket, and resolved application target. It sends SIGTERM, waits
for quiescence, switches the active symlink, starts the selected runtime through
the new target, and probes the versioned Unix-socket `server.status` Interface.

If startup or the activation hook fails, the installer quiesces the failed new
daemon, atomically restores the previous symlink, restarts the previous target,
and requires its health probe to pass. The failed stage is removed. No hook
searches for or signals a daemon outside the explicitly selected runtime.

The first managed upgrade from the old fixed application directory is the only
non-symlink transition: after daemon quiescence, that directory is renamed on
the same filesystem into a marked legacy version target and immediately becomes
the rollback target. Unmanaged-file refusal and legacy manifests remain valid.

## Release rollout

1. Back up durable state and record `readlink -f $prefix/lib/clankerhouse` (or
   the legacy fixed directory).
2. Supply the exact runtime directory and Herdr socket to the installer; do not use
   `--no-daemon-handoff` while a daemon may still be live.
3. Confirm the reported active target and run `clankerhouse-doctor` through the
   stable prefix launcher.
4. Confirm `server.status` and user-service health before removing any retained
   version. Keep the previous target throughout the compatibility window.
5. On uninstall, quiesce the selected daemon first; package uninstall preserves
   runtime and registry state by design.

## Herdr bindings

`clankerhouse-install-herdr` writes Alt-K, Alt-B, and Alt-D popup bindings into a
managed block of Herdr's `config.toml`. Rerunning it keeps keys the operator
changed. It also sets `resume_agents_on_restore = false`, so Herdr never relaunches
agents itself. Systemd units should use a stable prefix installation.

## Release gate

A release must pass type checking, Bun and Python tests, API/daemon/TUI
QA, the isolated Herdr Adapter scenario, and relocatable prefix install/uninstall QA.
The package must have no runtime dependency on a parent dotfiles checkout.

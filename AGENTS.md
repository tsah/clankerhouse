# Agent guidelines for Clankerhouse

## Shipping

- **Push straight to `main`.** No pull requests, no review branches. When work is done and tested, rebase it onto `origin/main`, then `git push origin HEAD:main`.
- A Workshop branch is only a local workspace; never push it and never open a PR for it.
- Before pushing, `git fetch` and rebase so the push fast-forwards; never force-push `main`.

## Testing

Run the suite against this checkout, not the installed version:

```bash
CLANKERHOUSE_HOME="$PWD" CLANKERHOUSE_BIN_DIR= CLANKERHOUSE_LIBEXEC= ./test
```

## Deploying to the live install

Deploy only what is on `origin/main`, from the main checkout. The installer stages, tests and activates a version under
`~/.local/lib/clankerhouse`, which `~/.local/bin/clankers`, the Rex config (`~/.local/lib/clankerhouse/contrib/rex/clankerhouse.lua`),
`~/.config/rex/clankerhouse-rex` (a link to `~/.local/bin/clankerhouse-rex`), the Claude hooks and the integrations resolve
on each use. The runner keeps the version it started with, so restart it:

```bash
git -C ~/clankerhouse merge --ff-only origin/main
cd ~/clankerhouse && env -u CLANKERHOUSE_HOME -u CLANKERHOUSE_BIN_DIR -u CLANKERHOUSE_LIBEXEC \
  scripts/install --prefix "$HOME/.local" --integrations --no-daemon-handoff
clankerhouse-rex --stop-runner && clankerhouse-rex --ensure-runner && clankerhouse-rex --health
```

Running clankers and the picker need nothing else; `rex config reload` only when `contrib/rex/clankerhouse.lua` changed.

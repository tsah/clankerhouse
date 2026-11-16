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

The live Rex lane runs from the main checkout: Rex's config loads `~/clankerhouse/contrib/rex/clankerhouse.lua`,
`~/.config/rex/clankerhouse-rex` links to `~/clankerhouse/bin/clankerhouse-rex`, and the runner runs from there.
Deploy only what is on `origin/main`:

```bash
git -C ~/clankerhouse merge --ff-only origin/main
cd ~/clankerhouse && bun install --frozen-lockfile && scripts/build-native
bin/clankerhouse-rex --stop-runner && bin/clankerhouse-rex --ensure-runner && bin/clankerhouse-rex --health
```

Running clankers and the picker need nothing else; `rex config reload` only when `contrib/rex/clankerhouse.lua` changed.

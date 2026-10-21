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

Deploy only what is on `origin/main`, from the main checkout:

```bash
git -C ~/clankerhouse merge --ff-only origin/main
cd ~/clankerhouse && env -u CLANKERHOUSE_HOME -u CLANKERHOUSE_BIN_DIR -u CLANKERHOUSE_LIBEXEC \
  scripts/install --prefix "$HOME/.local" --integrations --herdr --no-daemon-handoff
scripts/restart-herdr-daemon
```

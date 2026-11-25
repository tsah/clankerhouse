# Claude accounts

A Claude clanker whose turn ends on a usage limit can resume its exact session on another Claude account. It keeps
the same clanker id and conversation, and nobody has to step in. It is off until two or more accounts are listed, and
there is no upper limit: list as many accounts as you have, under any labels you like. The examples below use three,
`work` (Claude's default `~/.claude`, logged in as today), `personal` and `team`.

## Setup: one command per extra account, per machine

Clankerhouse never logs in, and never reads, copies or prints a credentials file or token. You log in to each
account yourself, once. Claude Code refuses a symlinked credentials file, so each account's login lives in its own
directory.

Your default `~/.claude` login is the first account. For each other account, run:

```sh
clankers login add claude personal
clankers login add claude team
```

Each run:

1. makes `~/.claude-acct/LABEL` (mode 700) with symlinks to the parts of `~/.claude` that every account shares:
   `projects/` (transcripts, so a session started on one account resumes on another), `settings.json` (with
   Clankerhouse's lifecycle hooks), `CLAUDE.md`, `commands`, `agents`, `skills`, `plugins`, `keybindings.json`,
   `file-history`, `todos` and `plans`, where they exist. It never links `.credentials.json` or `.claude.json`;
2. opens Claude in `~/dev` with `CLAUDE_CONFIG_DIR=~/.claude-acct/LABEL`. **You** run `/login`, sign in with that
   account, finish onboarding (accept a trust prompt if Claude shows one), then `/exit`;
3. checks the login with `claude auth status`, which says whether a login exists without showing it. Without one,
   nothing is listed: run the command again;
4. appends the account to the registry, `~/.config/clankerhouse/claude-accounts.toml`, keeping what is already there.
   When the registry is empty it first lists Claude's default config as `work` (`--default-label NAME` picks another
   name), so the first `login add` already turns switching on. Running it again for a listed account changes nothing.

With the two commands above the registry reads:

```toml
[[account]]
label = "work"

[[account]]
label = "personal"
config_dir = "~/.claude-acct/personal"

[[account]]
label = "team"
config_dir = "~/.claude-acct/team"
```

A fourth account is one more `clankers login add claude LABEL`. Accounts are tried in the order listed; edit the file
to reorder them. Only labels and directories go here, never a token. Unknown keys are refused. A broken file
switches the feature off, with a line in the runner's log, and never stops a clanker from launching.

Options: `--config-dir PATH` uses another directory; `--no-launch` skips opening Claude (you logged in already) and
only checks and lists.

`clankers login list` should then say `Switching: on` and show each account `[ready]` (the default one shows
`[default]`). `clankers login list --json` gives the same as JSON.

`clankers login remove claude LABEL` unlists an account and keeps its directory and login. `--delete-dir` also
deletes `~/.claude-acct/LABEL`, and with it that account's login; it refuses while an open clanker runs on that
account, and never deletes Claude's default config.

On macOS the login goes into the Keychain under an entry tied to the account's directory. On Linux it goes into
`~/.claude-acct/LABEL/.credentials.json`, which Claude writes itself. User-scope MCP servers
(`claude mcp add --scope user`) live in each account's own `.claude.json`, so they are not shared. Add any you need
with `CLAUDE_CONFIG_DIR=~/.claude-acct/LABEL claude mcp add ...`.

The registry and logins are per machine: on the Mac, run the same `clankers login add claude LABEL` commands there.

`clankers claude-accounts` is the older name and still works: `claude-accounts status` is `login list`, and
`claude-accounts setup LABEL` only makes the directory (no login, no registry entry).

## What happens on a limit

1. Claude's turn ends on the limit, and Claude's `StopFailure` hook fires with `error: rate_limit` and its own
   text, such as `You've hit your weekly limit · resets Nov 26, 11am (UTC)`. Clankerhouse's lifecycle hook already
   records that, and the clanker shows `blocked`.
2. The runner runs a switch pass at once (a newly blocked Claude triggers it) and once a minute. The pass:
   - marks the clanker's account out of usage until the reset time in Claude's text (one hour if there is none);
   - picks the first account in the registry, in the order listed, that is not out of usage: with the three above, a
     clanker limited on `work` moves to `personal`, and when `personal` is limited too it moves on to `team`;
   - stops the old harness (its systemd scope) and closes its pane. The turn has already ended, so nothing is lost;
   - marks the clanker's folder trusted in the new account's Claude config, so it does not resume into Claude's
     "Yes, I trust this folder" dialog (whose default is "No, exit"). Claude keeps that answer per account, in
     `projects[<path>].hasTrustDialogAccepted` of `<config dir>/.claude.json` (`~/.claude.json` for the default
     account), and inside a git repository looks it up on the main repository root, so the folder, its worktree and
     that root are all marked. Only that flag changes, written atomically under Claude's own `.claude.json.lock`; a
     config that does not exist yet or cannot be parsed is left alone, with a line in the log. The same happens
     whenever a Claude clanker starts on an account;
   - resumes the same session with `claude --resume` in a new tab of the same Workshop. The launch sets
     `CLAUDE_CONFIG_DIR` to the new account's directory and adds a prompt: "Your last turn stopped on a Claude usage
     limit on account work. Clankerhouse resumed this same session on account personal. Continue exactly where you left
     off.";
   - records the new account in the ledger (launch spec version 4), so later resumes stay on it.
3. New Claude clankers start on the first account that is not out of usage.

Rules that keep it safe:

- Only `rate_limit` moves a clanker, plus `authentication_failed` and `oauth_org_not_allowed`. A lost login passes
  the account over for 6 hours. Billing, overload and server errors are left alone.
- Each limit moves a clanker once, and a clanker moves at most once every 5 minutes, so accounts that all fail
  cannot bounce it between them.
- When every account is out of usage, the clanker stays blocked, as it does today. The next pass after any
  account's reset moves it. `clankers claude-accounts clear LABEL` offers an account again early, for example after
  you raised its limit.
- A failed resume is logged with the exact `clankers resume ID --account LABEL` to run by hand. A pass retries it
  after the 5-minute cooldown.
- Only clankers in the ledger with a session are moved. A Claude started by hand outside Clankerhouse is not.

`clankers resume CLANKER_ID --account LABEL` moves one clanker by hand. Stop it first with
`clankers ledger close CLANKER_ID`.
`clankers claude-accounts pass` runs one pass now and prints what it decided.

## Claude's auto-continue at a usage limit

Claude Code 2.1.330 has `autoContinueAtUsageLimit`: after a limit it can wait for the reset and send "continue" by
itself. The wait is armed when Claude draws the limit message, after the turn has ended. `StopFailure` fires at the
end of that turn, so the hook has already fired by the time auto-continue is waiting. Verified against Claude Code
2.1.330: a 429 `rate_limit_error` ends the turn with `StopFailure` `error: rate_limit`, the `rate_limit` matcher
fires, and the hook runs from a fake config dir. Auto-continue itself only arms for a claude.ai login, so it was
read from Claude's code rather than run. Clankerhouse therefore leaves auto-continue alone. When an account is free,
the switch stops the waiting process, so it never continues on the limited account. When none is free, auto-continue
remains Claude's own fallback.

## State and files

| What | Where |
|---|---|
| Registry (per instance) | `~/.config/clankerhouse/claude-accounts.toml` (`CLANKERHOUSE_CLAUDE_ACCOUNTS` overrides) |
| Which accounts are out of usage, until when; recent moves | `$XDG_STATE_HOME/clankerhouse-rex/claude-accounts.json` |
| Account directories | `~/.claude-acct/LABEL` by default |

The launch environment carries `CLAUDE_CONFIG_DIR` and `CLANKERHOUSE_CLAUDE_ACCOUNT=LABEL`, and nothing secret.

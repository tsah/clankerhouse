# Claude accounts

A Claude clanker whose turn ends on a usage limit can resume its exact session on another Claude account. It keeps
the same clanker id and conversation, and nobody has to step in. This is off until two or more accounts are listed.

## One-time setup per account (you do this yourself)

Clankerhouse never logs in, and never creates, reads, copies or links a credentials file or token. Every account,
including the default one, needs a real login done by you. Claude Code refuses a symlinked credentials file, so each
account's login must live in its own directory.

1. Make the account's config directory:

   ```sh
   clankers claude-accounts setup spare
   ```

   This creates `~/.claude-acct/spare` (mode 700) with symlinks to the parts of `~/.claude` that every account shares:
   `projects/` (transcripts, so a session started on one account resumes on another), `settings.json` (with
   Clankerhouse's lifecycle hooks), `CLAUDE.md`, `commands`, `agents`, `skills`, `plugins`, `keybindings.json`,
   `file-history`, `todos` and `plans`, where they exist. It never links `.credentials.json` or `.claude.json`.
   `--config-dir PATH` picks another directory.

2. Log in to that account from `~/dev`:

   ```sh
   cd ~/dev && CLAUDE_CONFIG_DIR=~/.claude-acct/spare claude
   ```

   Run `/login` and sign in with the other account, finish onboarding (accept a trust prompt if Claude shows one),
   then `/exit`. On macOS the login goes into the Keychain under an entry tied to this directory. On Linux it goes into
   `~/.claude-acct/spare/.credentials.json`, which Claude writes itself.

   User-scope MCP servers (`claude mcp add --scope user`) live in each account's own `.claude.json`, so they are
   not shared. Add any you need to the new account with `CLAUDE_CONFIG_DIR=~/.claude-acct/spare claude mcp add ...`.

3. List the accounts in preference order in `~/.config/clankerhouse/claude-accounts.toml`. An account without
   `config_dir` is Claude's default config (`~/.claude`, logged in as today):

   ```toml
   [[account]]
   label = "main"

   [[account]]
   label = "spare"
   config_dir = "~/.claude-acct/spare"
   ```

   Only labels and directories go here, never a token. Unknown keys are refused. A broken file switches the feature
   off, with a line in the runner's log, and never stops a clanker from launching.

4. Check it: `clankers claude-accounts status` should say `Switching: on` and show each account `[ready]`. The
   default account shows `[default]`, and `[not-used-yet]` means step 2 has not run.

To deploy on another machine (the Mac), repeat steps 1-3 there. The registry and logins are per machine.

## What happens on a limit

1. Claude's turn ends on the limit, and Claude's `StopFailure` hook fires with `error: rate_limit` and its own
   text, such as `You've hit your weekly limit · resets Nov 26, 11am (UTC)`. Clankerhouse's lifecycle hook already
   records that, and the clanker shows `blocked`.
2. The runner runs a switch pass at once (a newly blocked Claude triggers it) and once a minute. The pass:
   - marks the clanker's account out of usage until the reset time in Claude's text (one hour if there is none);
   - picks the first account in the registry that is not out of usage;
   - stops the old harness (its systemd scope) and closes its pane. The turn has already ended, so nothing is lost;
   - resumes the same session with `claude --resume` in a new tab of the same Workshop. The launch sets
     `CLAUDE_CONFIG_DIR` to the new account's directory and adds a prompt: "Your last turn stopped on a Claude usage
     limit on account main. Clankerhouse resumed this same session on account spare. Continue exactly where you left
     off.";
   - records the new account in the ledger (launch spec version 4), so later resumes stay on it.
3. New Claude clankers start on the first account that is not out of usage.

Rules that keep it safe:

- Only `rate_limit` moves a clanker, plus `authentication_failed` and `oauth_org_not_allowed`. A lost login passes
  the account over for 6 hours. Billing, overload and server errors are left alone.
- Each limit moves a clanker once, and a clanker moves at most once every 5 minutes, so two accounts that both fail
  cannot bounce it.
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

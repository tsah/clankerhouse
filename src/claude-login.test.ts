import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseClaudeAccounts } from "./claude-accounts"
import { addAccountToRegistryText, removeAccountFromRegistryText } from "./claude-login"

const repo = resolve(import.meta.dir, "..")
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const HOME = "/home/op"

describe("adding to the registry", () => {
  test("an empty registry gets Claude's default config first, labelled work unless told otherwise", () => {
    const { text, added } = addAccountToRegistryText("", { label: "personal", configDir: "/home/op/.claude-acct/personal" }, HOME)
    expect(added).toEqual(["work", "personal"])
    expect(text).toBe('[[account]]\nlabel = "work"\n\n[[account]]\nlabel = "personal"\nconfig_dir = "~/.claude-acct/personal"\n')
    expect(addAccountToRegistryText("", { label: "personal", configDir: "/home/op/.claude-acct/personal" }, HOME, "main").added).toEqual(["main", "personal"])
  })

  test("appends after what is there, keeping comments and order, and the same account twice changes nothing", () => {
    const start = '# my accounts\n[[account]]\nlabel = "work"  # the usual one\n\n[[account]]\nlabel = "personal"\nconfig_dir = "~/.claude-acct/personal"\n'
    const { text } = addAccountToRegistryText(start, { label: "team", configDir: "/home/op/.claude-acct/team" }, HOME)
    expect(text.startsWith(start.trimEnd())).toBe(true)
    expect(parseClaudeAccounts(text, HOME).map((account) => account.label)).toEqual(["work", "personal", "team"])
    const again = addAccountToRegistryText(text, { label: "team", configDir: "/home/op/.claude-acct/team" }, HOME)
    expect(again).toMatchObject({ text, added: [], alreadyListed: true })
  })

  test("refuses a label or directory already listed for another account", () => {
    const start = '[[account]]\nlabel = "work"\n\n[[account]]\nlabel = "personal"\nconfig_dir = "~/.claude-acct/personal"\n'
    expect(() => addAccountToRegistryText(start, { label: "personal", configDir: "/elsewhere" }, HOME)).toThrow("already listed")
    expect(() => addAccountToRegistryText(start, { label: "other", configDir: "/home/op/.claude-acct/personal" }, HOME)).toThrow("already listed as account personal")
    expect(() => addAccountToRegistryText("", { label: "work", configDir: "/home/op/.claude-acct/work" }, HOME)).toThrow("--default-label")
  })
})

describe("removing from the registry", () => {
  const three = '# accounts\n[[account]]\nlabel = "work"\n\n# second\n[[account]]\nlabel = "personal"\nconfig_dir = "~/.claude-acct/personal"\n\n# third\n[[account]]\nlabel = "team"\nconfig_dir = "~/.claude-acct/team"\n'
  test("drops only that table and keeps the rest as written", () => {
    const middle = removeAccountFromRegistryText(three, "personal", HOME)
    expect(middle.removed).toEqual({ label: "personal", configDir: "/home/op/.claude-acct/personal" })
    expect(middle.text).toBe('# accounts\n[[account]]\nlabel = "work"\n\n# third\n[[account]]\nlabel = "team"\nconfig_dir = "~/.claude-acct/team"\n')
    const last = removeAccountFromRegistryText(three, "team", HOME)
    expect(last.accounts.map((account) => account.label)).toEqual(["work", "personal"])
    expect(removeAccountFromRegistryText(three, "nobody", HOME)).toMatchObject({ text: three, removed: undefined })
    expect(removeAccountFromRegistryText(removeAccountFromRegistryText(last.text, "personal", HOME).text, "work", HOME).text).toBe("")
  })
})

describe("clankers login", () => {
  /** A scratch machine: HOME, registry and state, and a fake claude whose interactive run "logs in" when told to. */
  const machine = () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-login-"))
    roots.push(root)
    const home = join(root, "home")
    mkdirSync(join(home, ".claude"), { recursive: true })
    mkdirSync(join(home, "dev"))
    writeFileSync(join(home, ".claude/settings.json"), "{}\n")
    writeFileSync(join(home, ".claude/fake-login"), "")
    mkdirSync(join(root, "bin"))
    writeFileSync(join(root, "bin/claude"), `#!/bin/sh
dir=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
if [ "$1" = auth ]; then
  [ "$2 $3" = "status --json" ] || exit 2
  if [ -e "$dir/fake-login" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "never-printed@example.invalid"}'; exit 0; fi
  echo '{"loggedIn": false, "authMethod": "none"}'; exit 1
fi
echo "$PWD $CLAUDE_CONFIG_DIR" >>"$QA_LAUNCHES"
[ -z "$QA_DO_LOGIN" ] || : >"$dir/fake-login"
`)
    chmodSync(join(root, "bin/claude"), 0o755)
    const registry = join(root, "claude-accounts.toml")
    const env: Record<string, string> = {
      PATH: `${join(root, "bin")}:${Bun.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"),
      CLANKERHOUSE_INSTANCE: "login-test", CLANKERHOUSE_CLAUDE_ACCOUNTS: registry, QA_LAUNCHES: join(root, "launches"),
    }
    const run = (args: string[], extra: Record<string, string> = {}) => {
      const result = Bun.spawnSync([join(repo, "bin/clankers"), ...args], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 })
      return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
    }
    return { root, home, registry, run, launches: () => existsSync(env.QA_LAUNCHES!) ? readFileSync(env.QA_LAUNCHES!, "utf8") : "" }
  }

  test("add makes the directory, opens Claude there from ~/dev, and lists the account only once it is logged in", () => {
    const { home, registry, run, launches } = machine()
    const failed = run(["login", "add", "claude", "personal"])
    expect(failed.code).toBe(1)
    expect(failed.err).toContain("personal is not logged in")
    expect(existsSync(registry)).toBe(false)
    const dir = join(home, ".claude-acct/personal")
    expect(launches()).toBe(`${join(home, "dev")} ${dir}\n`)
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false)

    const added = run(["login", "add", "claude", "personal"], { QA_DO_LOGIN: "1" })
    expect(added.code).toBe(0)
    expect(added.out).toContain("Listed work and personal in")
    expect(added.out).toContain("Switching: on")
    expect(added.out + added.err).not.toContain("never-printed")
    const team = run(["login", "add", "claude", "team"], { QA_DO_LOGIN: "1" })
    expect(team.out).toContain("Listed team in")
    expect(parseClaudeAccounts(readFileSync(registry, "utf8"), home)).toEqual([
      { label: "work", configDir: null }, { label: "personal", configDir: dir }, { label: "team", configDir: join(home, ".claude-acct/team") },
    ])
    const again = run(["login", "add", "claude", "team", "--no-launch"])
    expect(again.out).toContain("already listed")
    expect(launches().split("\n").filter(Boolean)).toHaveLength(3)

    const list = run(["login", "list", "--json"])
    expect(JSON.parse(list.out).accounts.map((account: { label: string }) => account.label)).toEqual(["work", "personal", "team"])
    expect(run(["claude-accounts", "status"]).out).toContain("Switching: on")
  }, 60_000)

  test("remove unlists an account and deletes its directory only with --delete-dir", () => {
    const { home, registry, run } = machine()
    run(["login", "add", "claude", "personal"], { QA_DO_LOGIN: "1" })
    run(["login", "add", "claude", "team"], { QA_DO_LOGIN: "1" })
    const kept = run(["login", "remove", "claude", "team"])
    expect(kept.out).toContain("Kept")
    expect(existsSync(join(home, ".claude-acct/team"))).toBe(true)
    run(["login", "add", "claude", "team", "--no-launch"])
    const gone = run(["login", "remove", "claude", "team", "--delete-dir"])
    expect(gone.out).toContain("Deleted")
    expect(existsSync(join(home, ".claude-acct/team"))).toBe(false)
    // The links went, never what they pointed at.
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(true)
    expect(parseClaudeAccounts(readFileSync(registry, "utf8"), home).map((account) => account.label)).toEqual(["work", "personal"])
    expect(run(["login", "remove", "claude", "work", "--delete-dir"]).err).toContain("never deleted")
    expect(run(["login", "add", "pi", "x"]).err).toContain("Only Claude accounts")
  }, 60_000)
})

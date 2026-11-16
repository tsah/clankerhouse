/**
 * A fake `rex` executable for tests that run Clankerhouse in a subprocess. It answers `rex ... do <observe.lua>` with
 * the observation the test last wrote, answers `rex ... api call METHOD -` from per-method answer files (else `{}`),
 * and logs every request. Point REX_BIN at `bin`; it never reaches a real Rex server.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface FakeRexBlock {
  id: string
  /** The foreground program's name, as Rex reports it. */
  program?: string
  cwd?: string
  pid?: number
  label?: string
  focused?: boolean
}
export interface FakeRexWindow { id: string; label?: string; blocks: FakeRexBlock[] }
export interface FakeRexSession { id: string; label?: string; windows: FakeRexWindow[] }

export const FAKE_REX_HOST = "fake-host"
export const FAKE_REX_INSTANCE = "fake-instance"

/** The `share/rex/observe.lua` result for these sessions. */
export const rexObservation = (sessions: FakeRexSession[]) => ({
  host_id: FAKE_REX_HOST, instance_id: FAKE_REX_INSTANCE, pid: 1,
  sessions: sessions.map((session) => ({
    session_id: session.id, label: session.label ?? session.id, active_window_id: session.windows[0]?.id,
    windows: session.windows.map((window) => ({
      window_id: window.id, label: window.label ?? window.id,
      focused_block_id: (window.blocks.find((block) => block.focused) ?? window.blocks[0])?.id,
      blocks: window.blocks.map((block, index) => ({
        block_id: block.id, label: block.label ?? "shell", creator: "com.superlogical.terminal", layer: "tiled", title: "",
        process: {
          child: { pid: 4_000_000 + index, name: "zsh", cwd: block.cwd ?? "/" },
          foreground: { pid: block.pid ?? 4_100_000 + index, name: block.program ?? "zsh", cwd: block.cwd ?? "/", argv0: block.program ?? "zsh" },
        },
        program_status: { records: {} },
      })),
    })),
  })),
  clients: [],
})

export const fakeRex = (dir: string, sessions: FakeRexSession[] = []) => {
  mkdirSync(join(dir, "answers"), { recursive: true })
  const bin = join(dir, "rex")
  const log = join(dir, "calls.log")
  const observation = join(dir, "observation.json")
  const answers = join(dir, "answers")
  writeFileSync(bin, `#!/bin/sh
# Global options come first: --timeout N, --server ADDR, --autostart=false.
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout|--server) shift 2 ;;
    --*) shift ;;
    *) break ;;
  esac
done
case "$1" in
  do) printf 'do\\n' >> '${log}'; cat '${observation}' ;;
  api)
    [ "$2" = call ] || exit 2
    input=$(cat)
    printf 'api %s %s\\n' "$3" "$input" >> '${log}'
    if [ -f '${answers}'/"$3".fail ]; then cat '${answers}'/"$3".fail >&2; exit 1; fi
    if [ -f '${answers}'/"$3".json ]; then cat '${answers}'/"$3".json; else printf '{}\\n'; fi ;;
  events) printf 'events\\n' >> '${log}'; exec sleep 3600 ;;
  *) printf 'unexpected %s\\n' "$*" >> '${log}'; exit 2 ;;
esac
`)
  chmodSync(bin, 0o755)
  const fake = {
    bin,
    /** Replace what the next observation returns. */
    observe: (next: FakeRexSession[]) => writeFileSync(observation, JSON.stringify(rexObservation(next))),
    answer: (method: string, result: unknown) => writeFileSync(join(answers, `${method}.json`), JSON.stringify(result)),
    fail: (method: string, stderr: string) => writeFileSync(join(answers, `${method}.fail`), stderr),
    /** Every request so far: `do`, or `api METHOD PARAMS`. */
    calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  }
  fake.observe(sessions)
  fake.answer("server.status", { host_id: FAKE_REX_HOST, instance_id: FAKE_REX_INSTANCE })
  return fake
}

/** Write Rex claims the way `RexClaimStore` lays them out under an instance's state directory. */
export const writeRexClaims = (stateDir: string, objectId: string, claims: Record<string, string>) => {
  const dir = join(stateDir, "rex-claims", objectId)
  mkdirSync(dir, { recursive: true })
  for (const [key, value] of Object.entries(claims)) writeFileSync(join(dir, key), value)
}

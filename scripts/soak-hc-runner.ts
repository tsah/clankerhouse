#!/usr/bin/env bun
/**
 * Body of scripts/soak-hc. Agents write what they are really doing to a truth file, so drift is measured against the
 * program rather than between two views of hc. One JSON line per check goes to the log.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { HcAdapter, hcRequest, hcSocketPath } from "../src/multiplexer/hc"
import { ensureHcCore, hcHealth, restartHcCore, superviseHcCore } from "../src/multiplexer/hc-core"
import { paneLocation } from "../src/multiplexer/interface"

const { values: args } = parseArgs({ options: { agents: { type: "string", default: "4" }, "check-seconds": { type: "string", default: "600" }, root: { type: "string" }, log: { type: "string" }, report: { type: "boolean", default: false }, doc: { type: "string" } } })

const AGENT = String.raw`
import json, os, select, sys, time, tty
tty.setraw(0)
truth = sys.argv[1]
def report(state):
    sys.stdout.write("\033]7501;state=%s:app=soak\033\\" % state)
    with open(truth + ".tmp", "w") as f: json.dump({"state": state, "at": time.time()}, f)
    os.replace(truth + ".tmp", truth)
    sys.stdout.flush()
state, until, escapes, line, last = None, 0, 0, b"", 0
def become(next_state):
    global state, escapes
    state, escapes = next_state, 0
    report(state)
become("idle")
while True:
    ready, _, _ = select.select([0], [], [], 0.5)
    now = time.time()
    if state == "working" and now >= until: become("idle")
    if now - last >= (1 if state == "working" else 5):
        last = now
        sys.stdout.write("%s %d\r\n" % (state, int(now))); sys.stdout.flush()
    if not ready: continue
    for byte in os.read(0, 4096):
        if byte == 0x1b:
            escapes += 1
            # Like vim-mode Claude, the first ESC is spent leaving INSERT.
            if state == "working" and escapes >= 2: become("idle")
        elif byte in (10, 13):
            words = line.decode("utf8", "replace").split(); line = b""
            if words[:1] == ["work"]:
                until = now + float(words[1]); become("working")
            elif words[:1] == ["block"]: become("blocked")
            elif words[:1] == ["free"]: become("idle")
        else: line += bytes([byte])
`

interface ProcessFacts { rssMb: number; fds: number; threads: number; cpuSeconds: number }
interface Check { at: string; elapsedMin: number; core: ProcessFacts; holders: number; holder: ProcessFacts; processes: number; coreRestarts: { planned: number; unplanned: number }; terminalsLost: number; ops: Record<string, number>; errors: Record<string, number>; maxOpMs: number; driftSamples: number; drift: number; driftExamples: string[]; events: number; load: number }

const procFacts = (pid: number): ProcessFacts => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")
  return { rssMb: Math.round(Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * 4096 / 1e5) / 10, fds: readdirSync(`/proc/${pid}/fd`).length, threads: readdirSync(`/proc/${pid}/task`).length, cpuSeconds: (Number(stat[11]) + Number(stat[12])) / 100 }
}

/** Terminals of the soak's own holders; a process count that climbs is a leak of whatever the agents started. */
const processCount = (holders: number[]) => {
  const parents = new Map<number, number>()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try { parents.set(Number(entry), Number(readFileSync(`/proc/${entry}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1])) } catch {}
  }
  const inTree = (pid: number): boolean => { for (let at = pid; at > 1; at = parents.get(at) ?? 1) if (holders.includes(at)) return true; return false }
  return [...parents.keys()].filter(inTree).length
}

const report = () => {
  const lines = readFileSync(args.log!, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Check)
  const first = lines[0]!, last = lines.at(-1)!
  const sum = (pick: (check: Check) => number) => lines.reduce((total, check) => total + pick(check), 0)
  const trend = (name: string, pick: (check: Check) => number) => `| ${name} | ${pick(first)} | ${Math.min(...lines.map(pick))} | ${Math.max(...lines.map(pick))} | ${pick(last)} |`
  const body = [
    `Last updated ${last.at}: ${last.elapsedMin} minutes, ${lines.length} checks.`, "",
    "| Metric | First | Min | Max | Latest |", "|---|---|---|---|---|",
    trend("Core RSS (MB)", (check) => check.core.rssMb), trend("Core fds", (check) => check.core.fds), trend("Holder RSS (MB)", (check) => check.holder.rssMb), trend("Holder fds", (check) => check.holder.fds), trend("Holder threads", (check) => check.holder.threads), trend("Processes under holders", (check) => check.processes), "",
    `- Core restarts: ${last.coreRestarts.planned} planned, ${last.coreRestarts.unplanned} unplanned. Terminals lost: ${last.terminalsLost}.`,
    `- Status drift: ${sum((check) => check.drift)} of ${sum((check) => check.driftSamples)} samples.`,
    `- Traffic: ${Object.entries(last.ops).map(([name, count]) => `${name} ${count}`).join(", ")}. Errors: ${Object.entries(last.errors).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}. Slowest operation ${last.maxOpMs} ms.`,
    `- Change events delivered: ${last.events}.`,
  ].join("\n")
  const doc = readFileSync(args.doc!, "utf8")
  writeFileSync(args.doc!, doc.replace(/<!-- soak:start -->[\s\S]*<!-- soak:end -->/, `<!-- soak:start -->\n${body}\n<!-- soak:end -->`))
  console.log(body)
}

if (args.report) { report(); process.exit(0) }

const root = args.root!
const logPath = args.log!
const checkMs = Number(args["check-seconds"]) * 1000
const agentCount = Number(args.agents)
mkdirSync(root, { recursive: true })
const agentPath = `${root}/agent.py`
writeFileSync(agentPath, AGENT)
chmodSync(agentPath, 0o700)

await ensureHcCore()
const adapter = new HcAdapter()
const raw = hcRequest(hcSocketPath())
const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
const supervision = new AbortController()
void superviseHcCore(supervision.signal, { log: say })
process.on("SIGTERM", () => { supervision.abort(); process.exit(0) })

const agents = await Promise.all(Array.from({ length: agentCount }, async (_, index) => {
  const truth = `${root}/truth-${index}.json`
  const spawned = await adapter.spawn({ scope: "session", name: `soak-${index}`, cwd: root, env: { CLANKER_ID: `soak-${index}` }, launch: { kind: "argv", argv: ["python3", "-I", agentPath, truth] } })
  await adapter.claim(paneLocation(spawned.nativeSessionId, spawned.nativeWindowId, spawned.nativePaneId), "harness", "soak")
  return { truth, location: paneLocation(spawned.nativeSessionId, spawned.nativeWindowId, spawned.nativePaneId), pid: 0 }
}))
await Bun.sleep(1000)

const counters = { ops: {} as Record<string, number>, errors: {} as Record<string, number>, maxOpMs: 0, driftSamples: 0, drift: 0, driftExamples: [] as string[], events: 0, planned: 0, unplanned: 0, lost: 0 }
const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1 }
const timed = async (name: string, operation: () => Promise<unknown>) => {
  const started = performance.now()
  bump(counters.ops, name)
  try { await operation() } catch (error) { bump(counters.errors, `${name}: ${String(error).slice(0, 80)}`) }
  counters.maxOpMs = Math.max(counters.maxOpMs, Math.round(performance.now() - started))
}

void (async () => { for await (const _ of adapter.changes(supervision.signal)) counters.events += 1 })()

const truthOf = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")) as { state: string; at: number } } catch { return undefined } }

/** Only settled states count: a report still in flight is latency, not drift. */
const sampleDrift = async () => {
  const snapshot = await adapter.observe()
  const panes = new Map(snapshot.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.map((pane) => [pane.id, pane] as const))))
  for (const agent of agents) {
    const truth = truthOf(agent.truth)
    if (!truth || Date.now() / 1000 - truth.at < 2) continue
    counters.driftSamples += 1
    const seen = panes.get(agent.location.nativePaneId!)
    if (seen?.agentStatus?.status !== truth.state) {
      counters.drift += 1
      if (counters.driftExamples.length < 5) counters.driftExamples.push(`${agent.location.nativePaneId}: truth ${truth.state}, adapter ${seen?.agentStatus?.status ?? "missing"}`)
    }
  }
}

const traffic = async () => {
  const agent = agents[Math.floor(Math.random() * agents.length)]!
  const state = truthOf(agent.truth)?.state
  if (state === "idle") {
    if (Math.random() < 0.2) await timed("block", () => adapter.promptAgent(agent.location, "block"))
    else await timed("prompt", () => adapter.promptAgent(agent.location, `work ${5 + Math.floor(Math.random() * 25)}`))
  } else if (state === "working") await timed("interrupt", () => adapter.interruptAgent(agent.location))
  else if (state === "blocked") await timed("keys", () => raw("terminal.keys", { terminal: agent.location.nativePaneId, keys: ["f", "r", "e", "e", "enter"] }))
}

const started = Date.now()
let lastCorePid = (await hcHealth()).pid
let expectPlanned = false
let nextCheck = started + checkMs
let checks = 0
const check = async () => {
  const health = await hcHealth()
  if (!health.reachable) { say("check: core unreachable; the supervisor will restart it"); return }
  if (health.pid !== lastCorePid) {
    if (expectPlanned) counters.planned += 1
    else { counters.unplanned += 1; say(`core pid changed unexpectedly: ${lastCorePid} -> ${health.pid}`) }
    lastCorePid = health.pid
    expectPlanned = false
  }
  const status = await raw("server.status")
  const holders = (status.holders as Array<{ pid: number }>).map((holder) => holder.pid)
  const live = (await raw("terminal.list")).terminals as Array<{ address: string }>
  counters.lost = agents.filter((agent) => !live.some((terminal) => terminal.address === agent.location.nativePaneId)).length
  const holderFacts = holders.map(procFacts)
  const line: Check = {
    at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - started) / 60_000),
    core: procFacts(health.pid!), holders: holders.length,
    holder: { rssMb: holderFacts.reduce((total, facts) => total + facts.rssMb, 0), fds: holderFacts.reduce((total, facts) => total + facts.fds, 0), threads: holderFacts.reduce((total, facts) => total + facts.threads, 0), cpuSeconds: holderFacts.reduce((total, facts) => total + facts.cpuSeconds, 0) },
    processes: processCount(holders),
    coreRestarts: { planned: counters.planned, unplanned: counters.unplanned }, terminalsLost: counters.lost,
    ops: counters.ops, errors: counters.errors, maxOpMs: counters.maxOpMs, driftSamples: counters.driftSamples, drift: counters.drift, driftExamples: counters.driftExamples, events: counters.events,
    load: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
  }
  appendFileSync(logPath, `${JSON.stringify(line)}\n`)
  counters.driftSamples = 0
  counters.drift = 0
  checks += 1
  // A planned restart every sixth check keeps the restart path under the soak too.
  if (checks % 6 === 0) { expectPlanned = true; try { restartHcCore() } catch (error) { say(String(error)); expectPlanned = false } }
}

await check()
while (true) {
  await Bun.sleep(15_000)
  await timed("traffic", traffic)
  await sampleDrift().catch((error) => bump(counters.errors, `drift: ${String(error).slice(0, 80)}`))
  if (Date.now() >= nextCheck) {
    nextCheck += checkMs
    await check().catch((error) => { bump(counters.errors, `check: ${String(error).slice(0, 80)}`); say(String(error)) })
  }
}

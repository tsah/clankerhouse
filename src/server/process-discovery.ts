import { readFileSync, readdirSync } from "node:fs"
import { basename } from "node:path"

export type ForegroundAgentHarness = "pi" | "claude" | "codex" | "opencode"

export interface ProcessDiscoveryAccess {
  readonly platform: string
  readFile(path: string): string
  readDirectory(path: string): readonly string[]
}

export interface ForegroundProcessEvidence {
  pid: number
  ppid: number
  processGroupId: number
  terminalForegroundProcessGroupId: number
  name: string
  argv: string[]
}

export interface ForegroundAgentDiscovery {
  harness: ForegroundAgentHarness
  paneChildPid: number
  foregroundProcessGroupId: number
  matchedProcess: ForegroundProcessEvidence
  match: {
    kind: "executable" | "package"
    value: string
  }
  processes: ForegroundProcessEvidence[]
  source: "linux-proc"
}

/** A narrow boundary that can later be implemented by a separately installed probe executable. */
export interface ForegroundAgentProbe {
  discover(paneChildPid: number): ForegroundAgentDiscovery | undefined
}

interface ProcStat {
  pid: number
  ppid: number
  processGroupId: number
  terminalForegroundProcessGroupId: number
  name: string
}

interface Match {
  harness: ForegroundAgentHarness
  kind: "executable" | "package"
  value: string
  score: number
}

const executableNames: Readonly<Record<ForegroundAgentHarness, ReadonlySet<string>>> = {
  pi: new Set(["pi"]),
  claude: new Set(["claude", "claude-code"]),
  codex: new Set(["codex"]),
  opencode: new Set(["opencode", "opencode2"]),
}

const packagePatterns: Readonly<Record<ForegroundAgentHarness, readonly RegExp[]>> = {
  pi: [/(?:^|[/\\])@mariozechner[/\\]pi-coding-agent(?:[/\\]|$)/i, /(?:^|[/\\])pi-coding-agent(?:[/\\]|$)/i],
  claude: [/(?:^|[/\\])@anthropic-ai[/\\]claude-code(?:[/\\]|$)/i],
  codex: [/(?:^|[/\\])@openai[/\\]codex(?:[/\\]|$)/i],
  opencode: [/(?:^|[/\\])@opencode-ai[/\\](?:cli|opencode)(?:[/\\]|$)/i, /(?:^|[/\\])opencode-ai(?:[/\\]|$)/i],
}

const positiveInteger = (value: string) => {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export const parseProcStat = (contents: string): ProcStat | undefined => {
  const open = contents.indexOf("(")
  const close = contents.lastIndexOf(")")
  if (open <= 0 || close <= open) return undefined
  const pid = positiveInteger(contents.slice(0, open).trim())
  const fields = contents.slice(close + 1).trim().split(/\s+/)
  const ppid = positiveInteger(fields[1] ?? "")
  const processGroupId = positiveInteger(fields[2] ?? "")
  const terminalForegroundProcessGroupId = positiveInteger(fields[5] ?? "")
  if (!pid || !ppid || !processGroupId) return undefined
  return {
    pid,
    ppid,
    processGroupId,
    terminalForegroundProcessGroupId: terminalForegroundProcessGroupId ?? -1,
    name: contents.slice(open + 1, close).trim(),
  }
}

const cleanArg = (arg: string) => arg.replaceAll("\0", "").trim()

export const normalizeProcess = (stat: ProcStat, cmdline: string): ForegroundProcessEvidence => {
  const argv = cmdline.split("\0").map(cleanArg).filter(Boolean)
  const argvName = argv[0] ? basename(argv[0]).toLowerCase() : ""
  return {
    pid: stat.pid,
    ppid: stat.ppid,
    processGroupId: stat.processGroupId,
    terminalForegroundProcessGroupId: stat.terminalForegroundProcessGroupId,
    name: (argvName || basename(stat.name)).toLowerCase(),
    argv,
  }
}

const shellWords = (command: string): string[] | undefined => {
  const words: string[] = []
  let word = ""
  let quote = ""
  let escaped = false
  for (const character of command) {
    if (escaped) {
      word += character
      escaped = false
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = ""
      else word += character
    } else if (character === "'" || character === "\"") {
      quote = character
    } else if (/\s/.test(character)) {
      if (word) words.push(word)
      word = ""
    } else if (";&|<>".includes(character)) {
      return undefined
    } else {
      word += character
    }
  }
  if (escaped || quote) return undefined
  if (word) words.push(word)
  return words
}

const skipEnvironment = (tokens: readonly string[]) => {
  let index = 0
  if (basename(tokens[index] ?? "").toLowerCase() === "env") {
    index += 1
    while (tokens[index]?.startsWith("-")) index += 1
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1
  if (tokens[index] === "exec" || tokens[index] === "command") index += 1
  return tokens.slice(index)
}

const runtimeTarget = (tokens: readonly string[]): string | undefined => {
  const command = basename(tokens[0] ?? "").toLowerCase()
  if (["sh", "bash", "zsh", "dash", "fish"].includes(command)) {
    const commandIndex = tokens.findIndex((token, index) => index > 0 && (token === "-c" || token === "-lc"))
    const nested = commandIndex >= 0 ? shellWords(tokens[commandIndex + 1] ?? "") : undefined
    return nested ? runtimeTarget(skipEnvironment(nested)) : undefined
  }
  if (["node", "nodejs", "bun", "python", "python3", "python2"].includes(command)) {
    if (command.startsWith("python") && tokens[1] === "-m") return tokens[2]
    if (command === "bun" && tokens[1] === "x") return tokens[2]
    const optionsWithValues = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--loader", "--import"])
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? ""
      if (optionsWithValues.has(token)) {
        index += 1
        continue
      }
      if (!token.startsWith("-")) return token
    }
    return undefined
  }
  if (["npx", "bunx"].includes(command)) {
    return tokens.slice(1).find((token) => !token.startsWith("-"))
  }
  if (["pnpm", "yarn"].includes(command) && ["dlx", "exec"].includes(tokens[1] ?? "")) {
    return tokens.slice(2).find((token) => !token.startsWith("-"))
  }
  if (command === "npm" && tokens[1] === "exec") {
    return tokens.slice(2).find((token) => token !== "--" && !token.startsWith("-"))
  }
  return tokens[0]
}

const matchTarget = (target: string | undefined): Match | undefined => {
  if (!target) return undefined
  for (const harness of Object.keys(packagePatterns) as ForegroundAgentHarness[]) {
    if (packagePatterns[harness].some((pattern) => pattern.test(target))) return { harness, kind: "package", value: target, score: 90 }
  }
  const name = basename(target).toLowerCase()
  for (const harness of Object.keys(executableNames) as ForegroundAgentHarness[]) {
    if (executableNames[harness].has(name)) return { harness, kind: "executable", value: target, score: 100 }
  }
  return undefined
}

export const identifyAgentProcess = (process: ForegroundProcessEvidence): Match | undefined => {
  const tokens = skipEnvironment(process.argv.length > 0 ? process.argv : [process.name])
  return matchTarget(runtimeTarget(tokens))
}

const nodeAccess: ProcessDiscoveryAccess = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  readDirectory: (path) => readdirSync(path),
}

export const createProcessDiscoveryProvider = (access: ProcessDiscoveryAccess = nodeAccess): ForegroundAgentProbe => ({
  discover(paneChildPid) {
    if (access.platform !== "linux" || !Number.isSafeInteger(paneChildPid) || paneChildPid <= 0) return undefined
    try {
      const child = parseProcStat(access.readFile(`/proc/${paneChildPid}/stat`))
      const foregroundGroup = child?.terminalForegroundProcessGroupId ?? -1
      if (!child || foregroundGroup <= 0) return undefined

      const processes: ForegroundProcessEvidence[] = []
      for (const entry of access.readDirectory("/proc")) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const stat = parseProcStat(access.readFile(`/proc/${entry}/stat`))
          if (!stat || stat.processGroupId !== foregroundGroup) continue
          let cmdline = ""
          try {
            cmdline = access.readFile(`/proc/${entry}/cmdline`)
          } catch {
            // Kernel threads and processes racing with discovery may have no readable argv.
          }
          processes.push(normalizeProcess(stat, cmdline))
        } catch {
          // /proc is inherently racy; one disappearing process must not abort discovery.
        }
      }
      processes.sort((left, right) => left.pid - right.pid)
      const candidates = processes.flatMap((candidate) => {
        const match = identifyAgentProcess(candidate)
        return match ? [{ candidate, match }] : []
      })
      if (candidates.length === 0) return undefined
      const bestScore = Math.max(...candidates.map(({ match }) => match.score))
      const best = candidates.filter(({ match }) => match.score === bestScore)
      if (new Set(best.map(({ match }) => match.harness)).size !== 1) return undefined
      const selected = best.sort((left, right) => right.candidate.pid - left.candidate.pid)[0]
      if (!selected) return undefined
      return {
        harness: selected.match.harness,
        paneChildPid,
        foregroundProcessGroupId: foregroundGroup,
        matchedProcess: selected.candidate,
        match: { kind: selected.match.kind, value: selected.match.value },
        processes,
        source: "linux-proc",
      }
    } catch {
      return undefined
    }
  },
})

export const discoverForegroundAgent = (paneChildPid: number, access?: ProcessDiscoveryAccess) =>
  createProcessDiscoveryProvider(access).discover(paneChildPid)

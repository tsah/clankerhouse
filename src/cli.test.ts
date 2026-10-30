import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliErrorCode, mutationProgressSteps, parseArgs, usage } from "./cli"
import { ClankerApiError } from "./clanker-api"
import { MultiplexerResourceExhaustedError } from "./multiplexer/interface"
import { ClankerRegistrationError } from "./workflow"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("cli error codes", () => {
  test("names resource exhaustion even when a spawn wraps it", () => {
    const exhausted = new MultiplexerResourceExhaustedError("herdr workspace.create: the herdr server ran out of file descriptors")
    expect(cliErrorCode(exhausted)).toEqual({ code: "RESOURCE_EXHAUSTED", exitCode: 5 })
    expect(cliErrorCode(new ClankerRegistrationError(exhausted.message, { cause: exhausted }))).toEqual({ code: "RESOURCE_EXHAUSTED", exitCode: 5 })
    expect(cliErrorCode(new ClankerApiError("NOT_FOUND", "gone", 3))).toEqual({ code: "NOT_FOUND", exitCode: 3 })
    expect(cliErrorCode(new Error("bad flag"))).toEqual({ code: "INVALID_REQUEST", exitCode: 2 })
    expect(cliErrorCode("text")).toEqual({ code: "INVALID_REQUEST", exitCode: 2 })
  })
})

describe("cli usage", () => {
  test("documents every workshop spawn flag and the parent commands", () => {
    for (const flag of ["--clanker-name", "--resource-class", "--parent ID", "--no-parent", "--wait"]) expect(usage).toContain(flag)
    expect(usage).toContain("clankers workshop detach [ID|BRANCH|PATH] [--cwd PATH]")
    expect(usage).toContain("clankers workshop reparent [ID|BRANCH|PATH] --parent ID|BRANCH|PATH [--cwd PATH]")
  })
})

describe("cli argument parsing", () => {
  test("takes flag values without consuming later flags", () => {
    const parsed = parseArgs(["workshop", "spawn", "--parent", "workshop-123", "--name", "branch", "--prompt", "prompt"])
    expect(parsed.shift()).toBe("workshop")
    expect(parsed.shift()).toBe("spawn")
    expect(parsed.take("--parent")).toBe("workshop-123")
    expect(parsed.take("--name")).toBe("branch")
    expect(parsed.take("--prompt")).toBe("prompt")
    expect(parsed.args).toEqual([])
  })

  test("rejects missing values and next-flag values", () => {
    expect(() => parseArgs(["workshop", "ensure", "--cwd"]).take("--cwd")).toThrow(/requires a value/)
    expect(() => parseArgs(["workshop", "spawn", "--parent", "--wait", "--name", "branch"]).take("--parent")).toThrow(/requires a value/)
  })

  test("consumes model overrides without leaking them into the prompt", () => {
    const parsed = parseArgs(["--model", "provider/new-model:high", "Review", "this"])
    expect(parsed.take("--model")).toBe("provider/new-model:high")
    expect(parsed.args.join(" ")).toBe("Review this")
    expect(() => parseArgs(["--model"]).take("--model")).toThrow(/--model requires a value/)
    expect(() => parseArgs(["--model", "--prompt", "task"]).take("--model")).toThrow(/--model requires a value/)
  })

  test("describes durable worktree deletion in effect order", () => {
    expect(mutationProgressSteps({ type: "delete", kind: "worktree", session: "$42", path: "/repo/feature", confirmed: true })).toEqual([
      "Validating worktree identity",
      "Stopping tracked Clankers",
      "Deleting worktree",
      "Deleting session",
      "Refreshing Clankerhouse",
    ])
  })
})

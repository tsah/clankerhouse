import { describe, expect, test } from "bun:test"
import { mutationProgressSteps, parseArgs } from "./cli"

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

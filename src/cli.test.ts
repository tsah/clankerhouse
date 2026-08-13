import { describe, expect, test } from "bun:test"
import { parseArgs } from "./cli"

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
})

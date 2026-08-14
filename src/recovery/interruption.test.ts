import { describe, expect, test } from "bun:test"
import { classifyInterruptedWork } from "./interruption"

describe("interrupted tool recovery", () => {
  test("never treats expensive, external, or unknown work as replayable", () => {
    expect(classifyInterruptedWork({ tool: "bash", command: "./task/test/integration && ./task/lint" })).toBe("interrupted_expensive")
    expect(classifyInterruptedWork({ tool: "bash", command: "git push origin main" })).toBe("interrupted_external")
    expect(classifyInterruptedWork({})).toBe("unknown")
  })

  test("recognizes a settled generation without an in-flight tool", () => {
    expect(classifyInterruptedWork({ lastSettledGeneration: 4, currentGeneration: 4 })).toBe("settled")
  })
})

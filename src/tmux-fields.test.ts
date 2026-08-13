import { describe, expect, test } from "bun:test"
import { parseTmuxFields, parseTmuxRows, tmuxFields } from "./tmux-fields"

describe("tmux printable field transport", () => {
  test("does not pass literal control characters in tmux format arguments", () => {
    expect(tmuxFields("#{session_id}", "#{session_name}")).toBe("#{session_id}\\t#{session_name}")
  })

  test("parses tmux 3.6 printable separators and tab-based fixtures", () => {
    expect(parseTmuxFields("$1\\tworkshop")).toEqual(["$1", "workshop"])
    expect(parseTmuxFields("$1\tworkshop")).toEqual(["$1", "workshop"])
    expect(parseTmuxRows("$1\\tone\n$2\\ttwo\n")).toEqual([["$1", "one"], ["$2", "two"]])
  })
})

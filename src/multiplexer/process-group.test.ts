import { describe, expect, test } from "bun:test"
import { foregroundGroup } from "./process-group"

describe("foreground process group", () => {
  // The lifecycle wrapper (pid 100) leads the group; claude (101) is its child, and 102 is a background job in its own group.
  const proc: Record<string, string> = {
    "/proc/100/task/100/children": "101 102 ",
    "/proc/101/stat": "101 (claude) S 100 100 100 34816 100 0",
    "/proc/101/comm": "claude\n",
    "/proc/101/cmdline": "claude\0--resume\0s1\0",
    "/proc/101/cwd": "/repo",
    "/proc/101/task/101/children": "103",
    "/proc/102/stat": "102 (bun test) S 100 102 100 34816 100 0",
    "/proc/102/comm": "bun\n",
    "/proc/103/stat": "103 (node) S 101 100 100 34816 100 0",
    "/proc/103/comm": "node\n",
    "/proc/103/cmdline": "node\0mcp\0",
  }
  const wrapper = { pid: 100, name: "clankerhouse-ha", argv: ["/bin/bash", "/x/clankerhouse-harness-lifecycle", "--", "claude"], cwd: "/repo" }

  test("adds the leader's descendants in its group, which is where the harness runs", () => {
    expect(foregroundGroup(wrapper, (path) => proc[path]).map((member) => [member.pid, member.name])).toEqual([[100, "clankerhouse-ha"], [101, "claude"], [103, "node"]])
    expect(foregroundGroup(wrapper, () => undefined)).toEqual([wrapper])
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyResourceIncidents, readResourceIncidents, resolveRecoveredClankerIncidents, type ResourceIncident } from "./incidents"
import type { SessionRow } from "./model"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const incident = (overrides: Partial<ResourceIncident> = {}): ResourceIncident => ({
  version: 1,
  id: "pressure-test",
  kind: "resource_pressure_termination",
  occurredAt: 2_000,
  status: "open",
  clanker: { clankerId: "clanker-test", harness: "pi", sessionName: "repo@work", worktreePath: "/tmp/work" },
  evidence: { reason: "sustained_memory_pressure" },
  ...overrides,
})

const session = (): SessionRow => ({
  name: "repo@work",
  path: "/tmp/work",
  branch: "work",
  flags: "clean",
  markers: ["pi"],
  age: "1m",
  recency: 1,
  target: { type: "tmux_session", session: "repo@work" },
  details: [],
  searchText: "repo work",
})

describe("resource incidents", () => {
  test("reads valid open incidents and ignores malformed records", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-incidents-"))
    roots.push(root)
    writeFileSync(join(root, "valid.json"), JSON.stringify(incident()))
    writeFileSync(join(root, "closed.json"), JSON.stringify({ ...incident(), id: "closed", status: "closed" }))
    writeFileSync(join(root, "broken.json"), "{")

    expect(readResourceIncidents(root).map((record) => record.id)).toEqual(["pressure-test"])
  })

  test("resolves only reboot-loss incidents for an attested recovered clanker", () => {
    const root = mkdtempSync(join(tmpdir(), "clankerhouse-incidents-"))
    roots.push(root)
    const rebootPath = join(root, "reboot.json")
    writeFileSync(rebootPath, JSON.stringify(incident({ id: "reboot-test", kind: "unclean_boot_clanker_loss" })))
    writeFileSync(join(root, "pressure.json"), JSON.stringify(incident()))

    expect(resolveRecoveredClankerIncidents("clanker-test", root, 3_000)).toEqual(["reboot-test"])
    expect(readResourceIncidents(root).map((record) => record.id)).toEqual(["pressure-test"])
    expect(JSON.parse(readFileSync(rebootPath, "utf8"))).toMatchObject({ status: "resolved", resolvedAt: 3_000 })
  })

  test("attaches a red-x detail to the original session at the prepared observation time", () => {
    const [row] = applyResourceIncidents([session()], [incident()], 62_000)
    expect(row?.details[0]).toMatchObject({ kind: "incident", status: "terminated", age: "1m", state: "failed", target: { type: "tmux_session", session: "repo@work" } })
    expect(row?.searchText).toContain("sustained_memory_pressure")
  })

  test("creates a directory-backed row for a session lost on reboot", () => {
    const reboot = incident({ id: "reboot-test", kind: "unclean_boot_clanker_loss", clanker: { clankerId: "clanker-lost", harness: "claude", sessionName: "repo@lost", worktreePath: "/tmp/lost" } })
    const [row] = applyResourceIncidents([], [reboot])
    expect(row).toMatchObject({ name: "repo@lost", target: { type: "directory", path: "/tmp/lost" } })
    expect(row?.details[0]).toMatchObject({ status: "lost on reboot", state: "failed" })
  })
})

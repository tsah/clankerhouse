import { describe, expect, test } from "bun:test"
import { applyLabelChange, branchFromTitle, doneHookHandled, doneTtlMs, hookEnvironment, isDone, labelTags, parseLabelAssignment, reapDecision, validLabelKey, validLabelValue, type ReapCandidate } from "./labels"

describe("workshop labels", () => {
  test("parses KEY=VALUE and rejects keys or values that cannot be a tag or an environment name", () => {
    expect(parseLabelAssignment("stage=retro")).toEqual({ key: "stage", value: "retro" })
    expect(parseLabelAssignment("pr=acme/repo:42")).toEqual({ key: "pr", value: "acme/repo:42" })
    for (const invalid of ["stage", "=retro", "stage=", "Stage=retro", "stage=two words", "1st=x", `stage=${"x".repeat(65)}`]) {
      expect(() => parseLabelAssignment(invalid)).toThrow("Invalid label")
    }
    expect(validLabelKey("retro-stage_2")).toBe(true)
    expect(validLabelValue("line\nbreak")).toBe(false)
  })

  test("one key holds one value, and only a real difference counts as a change", () => {
    const set = applyLabelChange({}, "stage", "implementing")
    expect(set).toEqual({ previous: {}, labels: { stage: "implementing" }, changed: true })
    const replaced = applyLabelChange(set.labels, "stage", "merged")
    expect(replaced).toEqual({ previous: { stage: "implementing" }, labels: { stage: "merged" }, changed: true })
    expect(applyLabelChange(replaced.labels, "stage", "merged").changed).toBe(false)
    expect(applyLabelChange(replaced.labels, "stage", null)).toEqual({ previous: { stage: "merged" }, labels: {}, changed: true })
    expect(applyLabelChange({}, "stage", null).changed).toBe(false)
    expect(() => applyLabelChange({}, "Bad Key", "x")).toThrow("Invalid label key")
  })

  test("a title is free text, replaces the row name, and is never a tag", () => {
    expect(parseLabelAssignment("title=Migrate OpenCode adapter to v2")).toEqual({ key: "title", value: "Migrate OpenCode adapter to v2" })
    expect(validLabelValue("two words", "title")).toBe(true)
    expect(validLabelValue("two words", "stage")).toBe(false)
    for (const invalid of ["", " leading", "trailing ", "tab\tinside", "x".repeat(81)]) expect(validLabelValue(invalid, "title")).toBe(false)
    expect(applyLabelChange({}, "title", "A new title").labels).toEqual({ title: "A new title" })
    expect(labelTags({ title: "A new title", status: "done" })).toEqual(["done"])
  })

  test("a branch is derived from a title, and branch-shaped input is kept verbatim", () => {
    // The native client implements the same rule; these cases are asserted there too.
    expect(branchFromTitle("Migrate OpenCode adapter to v2")).toBe("migrate-opencode-adapter-to-v2")
    expect(branchFromTitle("fix/TWE-12_thing.v2")).toBe("fix/TWE-12_thing.v2")
    expect(branchFromTitle("Rework the extraction pipeline so that retirement is durable across restarts")).toBe("rework-the-extraction-pipeline-so-that-retirement")
    expect(() => branchFromTitle("  ¡¿  ")).toThrow("Cannot derive a branch name")
  })

  test("tags are the values ordered by key", () => {
    expect(labelTags({ stage: "retro", owner: "tsah" })).toEqual(["tsah", "retro"])
    expect(labelTags(undefined)).toEqual([])
  })

  test("hooks receive every label as JSON and as a plain variable", () => {
    expect(hookEnvironment({ event: "labels-changed", workshopId: "w1", path: "/repo/feature", branch: "feature", labels: { stage: "retro", "review-state": "open" }, previousLabels: { stage: "merged" } })).toEqual({
      CLANKERHOUSE_HOOK_EVENT: "labels-changed",
      CLANKERHOUSE_WORKSHOP_ID: "w1",
      CLANKERHOUSE_WORKSHOP_PATH: "/repo/feature",
      CLANKERHOUSE_WORKSHOP_BRANCH: "feature",
      CLANKERHOUSE_LABELS: '{"review-state":"open","stage":"retro"}',
      CLANKERHOUSE_LABEL_STAGE: "retro",
      CLANKERHOUSE_LABEL_REVIEW_STATE: "open",
      CLANKERHOUSE_PREVIOUS_LABELS: '{"stage":"merged"}',
      CLANKERHOUSE_PREVIOUS_LABEL_STAGE: "merged",
    })
    expect(hookEnvironment({ event: "done", workshopId: "w1", path: "/p", branch: "b", labels: {} })).not.toHaveProperty("CLANKERHOUSE_PREVIOUS_LABELS")
  })

  test("only a zero exit means the repository handled the done key", () => {
    expect(doneHookHandled(0)).toBe(true)
    expect(doneHookHandled(1)).toBe(false)
    expect(doneHookHandled(null)).toBe(false)
  })
})

describe("done workshop reaping", () => {
  const day = 86_400_000
  const now = 100 * day
  const idle: ReapCandidate = { markedAt: now - 8 * day, lastActivityAt: now - 9 * day, linkedWorktree: true, dirty: false, busyClanker: false }

  test("only status=done is the built-in done label", () => {
    expect(isDone({ status: "done" })).toBe(true)
    expect(isDone({ stage: "done" })).toBe(false)
    expect(isDone(undefined)).toBe(false)
  })

  test("retention defaults to a week, is configurable, and zero disables it", () => {
    expect(doneTtlMs({})).toBe(7 * day)
    expect(doneTtlMs({ CLANKERHOUSE_DONE_TTL_DAYS: "14" })).toBe(14 * day)
    expect(doneTtlMs({ CLANKERHOUSE_DONE_TTL_DAYS: "0" })).toBeUndefined()
    expect(doneTtlMs({ CLANKERHOUSE_DONE_TTL_DAYS: "nonsense" })).toBe(7 * day)
    expect(doneTtlMs({ CLANKERHOUSE_DONE_TTL_DAYS: "-1" })).toBe(7 * day)
  })

  test("an idle, clean, linked worktree is reaped once the retention has passed", () => {
    expect(reapDecision(idle, now, 7 * day)).toEqual({ reap: true })
    expect(reapDecision({ ...idle, markedAt: now - 6 * day }, now, 7 * day)).toEqual({ reap: false, reason: "not-expired" })
    expect(reapDecision(idle, now, undefined)).toEqual({ reap: false, reason: "disabled" })
  })

  test("coming back to a done workshop restarts the clock", () => {
    expect(reapDecision({ ...idle, lastActivityAt: now - day }, now, 7 * day)).toEqual({ reap: false, reason: "not-expired" })
  })

  test("uncommitted work, a busy clanker, and a primary checkout are never reaped", () => {
    expect(reapDecision({ ...idle, dirty: true }, now, 7 * day)).toEqual({ reap: false, reason: "uncommitted-changes" })
    expect(reapDecision({ ...idle, busyClanker: true }, now, 7 * day)).toEqual({ reap: false, reason: "busy-clanker" })
    expect(reapDecision({ ...idle, linkedWorktree: false, dirty: true }, now, 7 * day)).toEqual({ reap: false, reason: "not-a-linked-worktree" })
  })
})

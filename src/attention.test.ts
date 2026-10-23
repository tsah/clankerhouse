import { describe, expect, test } from "bun:test"
import { notifyReport, reportNotice, reportNotifyStates } from "./attention"

const report = (state: "question" | "blocked" | "done" | "failed" | "working", message: string | null = "Which retention?") => ({ state, message, clankerId: "clanker-1" })

describe("report attention", () => {
  test("notifies for question, blocked, and failed by default, and lets the operator choose or turn it off", () => {
    expect([...reportNotifyStates({})].toSorted()).toEqual(["blocked", "failed", "question"])
    expect([...reportNotifyStates({ CLANKERHOUSE_REPORT_NOTIFY: "" })].toSorted()).toEqual(["blocked", "failed", "question"])
    expect([...reportNotifyStates({ CLANKERHOUSE_REPORT_NOTIFY: "done, question,bogus" })].toSorted()).toEqual(["done", "question"])
    for (const off of ["none", "off", "0"]) expect(reportNotifyStates({ CLANKERHOUSE_REPORT_NOTIFY: off }).size).toBe(0)
  })

  test("titles the notice with the state and Workshop and keeps text plain and bounded", () => {
    expect(reportNotice(report("question"), "Rework the parser")).toEqual({ title: "question · Rework the parser", body: "Which retention?" })
    expect(reportNotice(report("blocked", null), undefined)).toEqual({ title: "blocked · clanker-1" })
    const notice = reportNotice(report("failed", `line one\n\tline\u0007 two ${"x".repeat(300)}`), "w".repeat(100))
    expect(notice.title.length).toBeLessThanOrEqual(80)
    expect(notice.body!.startsWith("line one line two ")).toBe(true)
    expect(notice.body!.length).toBeLessThanOrEqual(240)
  })

  test("never fails or waits long, and skips states the operator did not ask for", async () => {
    const shown: unknown[] = []
    expect(await notifyReport(report("question"), "w", async (notice) => { shown.push(notice); return true }, {})).toBe(true)
    expect(await notifyReport(report("working"), "w", async (notice) => { shown.push(notice); return true }, {})).toBe(false)
    expect(shown).toHaveLength(1)
    expect(await notifyReport(report("blocked"), "w", async () => { throw new Error("no server") }, {})).toBe(false)
    expect(await notifyReport(report("blocked"), "w", () => { throw new Error("sync") }, {})).toBe(false)
    const started = Date.now()
    expect(await notifyReport(report("blocked"), "w", () => new Promise(() => {}), {})).toBe(false)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

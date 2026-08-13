import { describe, expect, test } from "bun:test"
import { resolveWorkshopParent } from "./workflow"

describe("workshop parent resolution", () => {
  const missingParentId = "00000000-0000-4000-8000-000000000001"

  test("rejects explicit parents when lineage is off", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "off")).rejects.toThrow(/does not support --parent/)
  })

  test("rejects unknown explicit parents in enabled modes", async () => {
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "best-effort")).rejects.toThrow(/Unknown workshop parent id/)
    await expect(resolveWorkshopParent({ parentWorkshopId: missingParentId }, "strict")).rejects.toThrow(/Unknown workshop parent id/)
  })
})

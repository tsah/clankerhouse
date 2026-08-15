import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireProducerLease, replaceProducerLeaseRecord } from "./producer-lease"

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "clankerhouse-producer-"))
  roots.push(root)
  return { root, path: join(root, "producer.lease") }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("authoritative producer lease", () => {
  test("allows one live process identity and rejects a replaced epoch", async () => {
    const { path } = fixture()
    const lease = await acquireProducerLease(path, "tmux-instance")
    await expect(acquireProducerLease(path, "tmux-instance")).rejects.toThrow(/already owns/)
    await replaceProducerLeaseRecord(path, "tmux-instance", "replacement")
    expect(() => lease.assertCurrentSync()).toThrow(/stale producer/)
    await lease.release()
  })

  test("refuses a symlink lease path instead of following it", async () => {
    const { root, path } = fixture()
    const target = join(root, "target")
    writeFileSync(target, "{}")
    symlinkSync(target, path)
    await expect(acquireProducerLease(path, "tmux-instance")).rejects.toThrow(/unsafe producer lease path/)
  })
})

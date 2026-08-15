import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

interface LeaseRecord { version: 1; epoch: string; owner: string; pid: number; acquiredAt: number }
export interface ProducerLease {
  readonly epoch: string
  readonly owner: string
  assertCurrent(): Promise<void>
  assertCurrentSync(): void
  release(): Promise<void>
}

const processAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

const readLease = async (path: string): Promise<LeaseRecord | undefined> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseRecord>
    return value.version === 1 && typeof value.epoch === "string" && typeof value.owner === "string" && Number.isSafeInteger(value.pid)
      ? value as LeaseRecord
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export const acquireProducerLease = async (path: string, owner: string): Promise<ProducerLease> => {
  if (!owner) throw new Error("Producer owner identity is required")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const epoch = randomUUID()
  const record: LeaseRecord = { version: 1, epoch, owner, pid: process.pid, acquiredAt: Date.now() }
  const claim = async () => {
    const handle = await open(path, "wx", 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() }
    finally { await handle.close() }
  }
  try {
    await claim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readLease(path)
    if (existing && processAlive(existing.pid)) throw new Error(`Authoritative producer already owns ${owner} (pid ${existing.pid}, epoch ${existing.epoch})`)
    const before = await stat(path).catch(() => undefined)
    if (before) {
      const stale = `${path}.stale.${process.pid}.${epoch}`
      await rename(path, stale).catch((renameError) => {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError
      })
      await rm(stale, { force: true })
    }
    await claim()
  }
  let released = false
  return {
    epoch,
    owner,
    async assertCurrent() {
      if (released) throw new Error("stale producer lease: released")
      const current = await readLease(path)
      if (!current || current.epoch !== epoch || current.owner !== owner || current.pid !== process.pid) throw new Error("stale producer lease: authority changed")
    },
    assertCurrentSync() {
      if (released) throw new Error("stale producer lease: released")
      let current: LeaseRecord | undefined
      try { current = JSON.parse(readFileSync(path, "utf8")) as LeaseRecord } catch {}
      if (!current || current.epoch !== epoch || current.owner !== owner || current.pid !== process.pid) throw new Error("stale producer lease: authority changed")
    },
    async release() {
      if (released) return
      released = true
      const current = await readLease(path)
      if (current?.epoch === epoch && current.pid === process.pid) await rm(path, { force: true })
    },
  }
}

/** Test helper and explicit handoff primitive. A producer detects replacement before publishing. */
export const replaceProducerLeaseRecord = async (path: string, owner: string, epoch: string, pid = process.pid) => {
  const temporary = `${path}.${process.pid}.replacement`
  await writeFile(temporary, JSON.stringify({ version: 1, epoch, owner, pid, acquiredAt: Date.now() } satisfies LeaseRecord), { mode: 0o600 })
  await rename(temporary, path)
}

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

interface LeaseRecord {
  version: 1
  epoch: string
  owner: string
  pid: number
  processStartTicks?: number
  bootId?: string
  acquiredAt: number
}
export interface ProducerLease {
  readonly epoch: string
  readonly owner: string
  assertCurrent(): Promise<void>
  assertCurrentSync(): void
  release(): Promise<void>
}

const processStartTicks = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const closing = stat.lastIndexOf(")")
    const ticks = Number(stat.slice(closing + 2).trim().split(/\s+/)[19])
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : undefined
  } catch { return undefined }
}
const currentBootId = () => {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }
  catch { return "unknown-boot" }
}
const processOwnsLease = (record: LeaseRecord) => {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return false
  try { process.kill(record.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  // A live legacy producer without reuse-resistant fields is conservatively
  // authoritative until explicit handoff; never steal merely on resemblance.
  if (record.processStartTicks === undefined || record.bootId === undefined) return true
  return record.bootId === currentBootId() && processStartTicks(record.pid) === record.processStartTicks
}

const readLease = async (path: string): Promise<LeaseRecord | undefined> => {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Refusing unsafe producer lease path: ${path}`)
    const uid = process.getuid?.()
    if (uid !== undefined && metadata.uid !== uid) throw new Error(`Producer lease is not owned by the current user: ${path}`)
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
  const record: LeaseRecord = {
    version: 1,
    epoch,
    owner,
    pid: process.pid,
    processStartTicks: processStartTicks(process.pid),
    bootId: currentBootId(),
    acquiredAt: Date.now(),
  }
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
    if (existing && processOwnsLease(existing)) throw new Error(`Authoritative producer already owns ${owner} (pid ${existing.pid}, epoch ${existing.epoch})`)
    const before = await lstat(path).catch(() => undefined)
    if (before) {
      const stale = `${path}.stale.${process.pid}.${epoch}`
      await rename(path, stale).catch((renameError) => {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError
      })
      await rm(stale, { force: true })
    }
    await claim()
  }
  await chmod(path, 0o600)
  let released = false
  const authoritative = (current: LeaseRecord | undefined) => Boolean(
    current
    && current.epoch === epoch
    && current.owner === owner
    && current.pid === process.pid
    && current.processStartTicks === record.processStartTicks
    && current.bootId === record.bootId,
  )
  return {
    epoch,
    owner,
    async assertCurrent() {
      if (released) throw new Error("stale producer lease: released")
      if (!authoritative(await readLease(path))) throw new Error("stale producer lease: authority changed")
    },
    assertCurrentSync() {
      if (released) throw new Error("stale producer lease: released")
      let current: LeaseRecord | undefined
      try { current = JSON.parse(readFileSync(path, "utf8")) as LeaseRecord } catch {}
      if (!authoritative(current)) throw new Error("stale producer lease: authority changed")
    },
    async release() {
      if (released) return
      released = true
      const current = await readLease(path)
      if (authoritative(current)) await rm(path, { force: true })
    },
  }
}

/** Test helper and explicit handoff primitive. A producer detects replacement before publishing. */
export const replaceProducerLeaseRecord = async (path: string, owner: string, epoch: string, pid = process.pid) => {
  const temporary = `${path}.${process.pid}.replacement`
  await writeFile(temporary, JSON.stringify({
    version: 1,
    epoch,
    owner,
    pid,
    processStartTicks: processStartTicks(pid),
    bootId: currentBootId(),
    acquiredAt: Date.now(),
  } satisfies LeaseRecord), { mode: 0o600 })
  await rename(temporary, path)
}

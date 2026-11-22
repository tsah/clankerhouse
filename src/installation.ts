import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))

export const applicationRoot = resolve(Bun.env.CLANKERHOUSE_HOME || sourceRoot)
export const binPath = (name: string) => resolve(Bun.env.CLANKERHOUSE_BIN_DIR || resolve(applicationRoot, "bin"), name)
export const libexecPath = (name: string) => resolve(Bun.env.CLANKERHOUSE_LIBEXEC || resolve(applicationRoot, "libexec"), name)
export const integrationPath = (...parts: string[]) => resolve(applicationRoot, "integrations", ...parts)

const activeTarget = (root: string) => {
  try {
    const own = realpathSync(root)
    const versions = dirname(own)
    if (basename(versions) !== "clankerhouse-versions") return undefined
    return { own, active: realpathSync(join(dirname(versions), "clankerhouse")) }
  } catch { return undefined }
}

/** Whether this process's version was the active one when it started (a staged version under test is not). */
const startedActive = (() => { const target = activeTarget(sourceRoot); return !!target && target.own === target.active })()

/**
 * Whether this process started on the active installed version and an upgrade has since replaced it: a long-lived
 * `clankers watch` or `snapshot --watch`. Such a process must not deliver messages, since it would apply the delivery
 * rules of the version it started with (on 2026-11-22 a watch from before the StopFailure fix typed a message into a
 * clanker that was out of usage). A staged version under test, or a checkout, is never superseded.
 */
export const supersededInstall = (root = sourceRoot, wasActive = startedActive) => {
  if (!wasActive) return false
  const target = activeTarget(root)
  return !!target && target.own !== target.active
}

/**
 * Instance-scoped runtime and state locations.
 *
 * Instances never share a daemon socket, cache, registry, or recovery store. The
 * instance slug comes from CLANKERHOUSE_INSTANCE when set ("default" means no
 * suffix); otherwise it is `-herdr`, the Herdr instance's established paths.
 */

const uid = () => process.getuid?.() ?? Bun.env.USER ?? "user"

export const instanceSlug = (env: Record<string, string | undefined> = Bun.env) => {
  const explicit = env.CLANKERHOUSE_INSTANCE?.trim()
  if (explicit) {
    if (explicit === "." || explicit === ".." || !/^[A-Za-z0-9._-]+$/.test(explicit)) throw new Error(`Invalid CLANKERHOUSE_INSTANCE: ${explicit}`)
    return explicit === "default" ? "" : `-${explicit}`
  }
  return "-herdr"
}

export const runtimeDirFor = (env: Record<string, string | undefined> = Bun.env) =>
  `${env.XDG_RUNTIME_DIR ?? "/tmp"}/clankerhouse-${uid()}${instanceSlug(env)}`

export const stateHomeDefault = (env: Record<string, string | undefined> = Bun.env) =>
  env.XDG_STATE_HOME || `${env.HOME || ""}/.local/state`

export const stateDirFor = (stateHome = stateHomeDefault(), env: Record<string, string | undefined> = Bun.env) =>
  `${stateHome}/clankerhouse${instanceSlug(env)}`

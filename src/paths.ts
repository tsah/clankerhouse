/**
 * Instance-scoped runtime and state locations.
 *
 * Clankerhouse can run more than one instance at once — one per Multiplexer runtime —
 * so a herdr instance and the legacy tmux instance coexist without sharing a daemon
 * socket, cache, registry, or recovery store. The instance slug is derived from
 * CLANKERHOUSE_INSTANCE when set, else from the resolved Multiplexer. Explicit
 * selection wins; paired managed-Herdr pane markers infer `-herdr`; every other
 * unset environment keeps the unsuffixed legacy tmux paths.
 */
import { resolvedMultiplexerKind } from "./multiplexer/environment"

const uid = () => process.getuid?.() ?? Bun.env.USER ?? "user"

export const instanceSlug = (env: Record<string, string | undefined> = Bun.env) => {
  const explicit = env.CLANKERHOUSE_INSTANCE?.trim()
  if (explicit) {
    if (explicit === "." || explicit === ".." || !/^[A-Za-z0-9._-]+$/.test(explicit)) throw new Error(`Invalid CLANKERHOUSE_INSTANCE: ${explicit}`)
    return explicit === "default" || explicit === "tmux" ? "" : `-${explicit}`
  }
  const mux = resolvedMultiplexerKind(env)
  return mux === "tmux" ? "" : `-${mux}`
}

export const runtimeDirFor = (env: Record<string, string | undefined> = Bun.env) =>
  `${env.XDG_RUNTIME_DIR ?? "/tmp"}/clankerhouse-${uid()}${instanceSlug(env)}`

export const stateHomeDefault = (env: Record<string, string | undefined> = Bun.env) =>
  env.XDG_STATE_HOME || `${env.HOME || ""}/.local/state`

export const stateDirFor = (stateHome = stateHomeDefault(), env: Record<string, string | undefined> = Bun.env) =>
  `${stateHome}/clankerhouse${instanceSlug(env)}`

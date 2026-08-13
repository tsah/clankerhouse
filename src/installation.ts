import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))

export const applicationRoot = resolve(Bun.env.CLANKERHOUSE_HOME || sourceRoot)
export const binPath = (name: string) => resolve(Bun.env.CLANKERHOUSE_BIN_DIR || resolve(applicationRoot, "bin"), name)
export const libexecPath = (name: string) => resolve(Bun.env.CLANKERHOUSE_LIBEXEC || resolve(applicationRoot, "libexec"), name)
export const integrationPath = (...parts: string[]) => resolve(applicationRoot, "integrations", ...parts)

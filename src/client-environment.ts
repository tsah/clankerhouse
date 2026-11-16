/**
 * Variables that mark a process as the daemon's own child: its `clankers` mutations run in place instead of reaching
 * the daemon, and report progress on stderr. They belong to that one short-lived command, never to anything
 * long-lived it starts, such as a hook, a terminal or a harness, whose `clankers` calls must reach the daemon.
 */
export const DAEMON_INTERNAL_ENV_KEYS = ["CLANKERHOUSE_DAEMON_INTERNAL", "CLANKERHOUSE_PROGRESS", "CLANKERHOUSE_LEGACY_MUTATIONS"] as const

/** A copy of `env` without the daemon-internal markers. */
export const clientEnvironment = <T extends string | undefined>(env: Record<string, T>): Record<string, T> => {
  const copy = { ...env }
  for (const key of DAEMON_INTERNAL_ENV_KEYS) delete copy[key]
  return copy
}

/** `env -u` arguments that drop the daemon-internal markers from a command's inherited environment. */
export const unsetDaemonInternalArgs = () => DAEMON_INTERNAL_ENV_KEYS.flatMap((key) => ["-u", key])

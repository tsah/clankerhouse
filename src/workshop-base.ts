/**
 * The base a new Workshop branch starts from. An explicit base keeps its meaning. Without
 * one, the repository's local default branch is not trusted: nothing keeps it current, so
 * the remote's default branch is fetched and the Workshop starts from `origin/<default>`.
 * A failed fetch fails the create rather than falling back to the local ref.
 */

const remote = "origin"

export interface GitResult { exitCode: number; stdout: string; stderr: string }
export type GitRunner = (args: string[]) => GitResult

const runGit = (repository: string): GitRunner => (args) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } })
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() }
}

const failure = (result: GitResult, fallback: string) => result.stderr || result.stdout || fallback

const remoteDefaultBranch = (git: GitRunner) => {
  const head = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`])
  const prefix = `refs/remotes/${remote}/`
  if (head.exitCode === 0 && head.stdout.startsWith(prefix)) return head.stdout.slice(prefix.length)
  // refs/remotes/origin/HEAD is only written by clone or `git remote set-head`; ask the remote.
  const listed = git(["ls-remote", "--symref", remote, "HEAD"])
  if (listed.exitCode !== 0) throw new Error(`Unable to resolve ${remote}'s default branch: ${failure(listed, `git ls-remote exited ${listed.exitCode}`)}`)
  const branch = listed.stdout.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1]
  if (!branch) throw new Error(`Unable to resolve ${remote}'s default branch: the remote did not report a symbolic HEAD`)
  return branch
}

/**
 * Fetches the remote default branch and returns `origin/<default>`. Returns undefined only
 * when the repository has no `origin` remote, leaving the local default as the only truth.
 */
export const freshDefaultBase = (repository: string, git: GitRunner = runGit(repository)): string | undefined => {
  if (git(["remote", "get-url", remote]).exitCode !== 0) return undefined
  const branch = remoteDefaultBranch(git)
  const fetched = git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
  if (fetched.exitCode !== 0) throw new Error(`Unable to fetch ${remote}/${branch} for the new Workshop's base: ${failure(fetched, `git fetch exited ${fetched.exitCode}`)}`)
  return `${remote}/${branch}`
}

export const workshopBase = (repository: string, base?: string, git?: GitRunner) => base || freshDefaultBase(repository, git)

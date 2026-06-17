import { execFileSync } from 'node:child_process'

export interface GitState {
  available: boolean
  branch: string | null
  head_sha: string | null
  is_clean: boolean | null
}

/**
 * Read minimal git state for the project root. Returns `available: false`
 * if git is not installed or the directory is not a git repo. Never
 * throws — MCP tools must degrade gracefully outside git contexts.
 */
export function readGitState(projectRoot: string): GitState {
  if (!isGitRepo(projectRoot)) {
    return { available: false, branch: null, head_sha: null, is_clean: null }
  }

  const branch = safeGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head_sha = safeGit(projectRoot, ['rev-parse', '--short', 'HEAD'])
  const status = safeGit(projectRoot, ['status', '--porcelain'])

  return {
    available: true,
    branch,
    head_sha,
    is_clean: status !== null ? status.length === 0 : null,
  }
}

/**
 * Return the staged diff (`git diff --cached`) as a unified-diff string.
 * Returns `null` when not in a git repo or when git fails. Returns the
 * empty string when there are no staged changes.
 *
 * Uses `--no-color` and `-U0` so consumers parse a stable, minimal diff
 * shape (no context lines around hunks).
 */
export function getStagedDiff(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null
  return safeGitRaw(projectRoot, ['diff', '--cached', '--no-color', '-U0'])
}

/**
 * Return the unstaged diff (`git diff`) as a unified-diff string.
 * Same semantics as {@link getStagedDiff}.
 */
export function getUnstagedDiff(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null
  return safeGitRaw(projectRoot, ['diff', '--no-color', '-U0'])
}

function isGitRepo(projectRoot: string): boolean {
  const out = safeGit(projectRoot, ['rev-parse', '--is-inside-work-tree'])
  return out === 'true'
}

function safeGit(cwd: string, args: string[]): string | null {
  const raw = safeGitRaw(cwd, args)
  return raw !== null ? raw.trim() : null
}

function safeGitRaw(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/**
 * Result envelope for the injectable git executor used by mutating ops.
 * Distinct from `safeGit` / `safeGitRaw` (string|null) because mutating
 * helpers (gitCommit, gitPush, gitMerge in F2.5.5b/c) need exit code,
 * stderr, and the ability to swap implementations in tests.
 */
export interface GitExecResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

export type GitExecutor = (projectRoot: string, args: string[]) => GitExecResult

export const defaultGitExecutor: GitExecutor = (cwd, args) => {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    return normalizeGitExecError(err)
  }
}

function normalizeGitExecError(err: unknown): GitExecResult {
  if (err && typeof err === 'object') {
    const e = err as {
      status?: number | null
      stderr?: string | Buffer
      stdout?: string | Buffer
      message?: string
      code?: string
    }
    const result: GitExecResult = {
      ok: false,
      stdout: bufferOrStringToString(e.stdout),
      stderr: bufferOrStringToString(e.stderr),
      exitCode: typeof e.status === 'number' ? e.status : -1,
    }
    const message = e.message ?? (e.code ? `git exec failed: ${e.code}` : undefined)
    if (message) result.error = message
    return result
  }
  return { ok: false, stdout: '', stderr: '', exitCode: -1, error: String(err) }
}

function bufferOrStringToString(v: string | Buffer | undefined): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  return v.toString('utf8')
}

/**
 * Read the current HEAD short SHA via the injectable executor.
 * Returns `null` outside a git repo or on any git error.
 */
export function getHeadSha(
  projectRoot: string,
  executor: GitExecutor = defaultGitExecutor,
): string | null {
  const r = executor(projectRoot, ['rev-parse', '--short', 'HEAD'])
  if (!r.ok) return null
  return r.stdout.trim() || null
}

export interface GitCommitResult {
  ok: boolean
  sha_before: string | null
  sha_after: string | null
  error?: string
  stderr?: string
}

/**
 * Run `git commit -m <message>` via the injectable executor and capture
 * HEAD before/after for the audit log. Never throws — failures (nothing
 * staged, pre-commit hook block, signing prompt timeout) surface via
 * `ok: false` so the caller can append the audit entry without aborting.
 */
export function gitCommit(
  projectRoot: string,
  message: string,
  executor: GitExecutor = defaultGitExecutor,
): GitCommitResult {
  const sha_before = getHeadSha(projectRoot, executor)
  const exec = executor(projectRoot, ['commit', '-m', message])
  if (!exec.ok) {
    const result: GitCommitResult = { ok: false, sha_before, sha_after: null }
    if (exec.stderr) result.stderr = exec.stderr.trim()
    if (exec.error) result.error = exec.error
    return result
  }
  const sha_after = getHeadSha(projectRoot, executor)
  return { ok: true, sha_before, sha_after }
}

export interface GitPushResult {
  ok: boolean
  error?: string
  stderr?: string
  stdout?: string
}

/**
 * Run `git push <remote> <branch>` via the injectable executor. Never
 * throws — remote rejection, missing remote, or network failure surface
 * via `ok: false` so the caller can audit the failure without aborting.
 */
export function gitPush(
  projectRoot: string,
  remote: string,
  branch: string,
  executor: GitExecutor = defaultGitExecutor,
): GitPushResult {
  const exec = executor(projectRoot, ['push', remote, branch])
  if (!exec.ok) {
    const result: GitPushResult = { ok: false }
    if (exec.stderr) result.stderr = exec.stderr.trim()
    if (exec.error) result.error = exec.error
    if (exec.stdout) result.stdout = exec.stdout.trim()
    return result
  }
  return { ok: true, stdout: exec.stdout.trim() }
}

export interface GitMergeOptions {
  no_ff: boolean
  allow_unrelated_histories: boolean
}

export interface GitMergeResult {
  ok: boolean
  sha_before: string | null
  sha_after: string | null
  error?: string
  stderr?: string
  stdout?: string
}

/**
 * Run `git merge <sourceBranch> [--no-ff] [--allow-unrelated-histories]`
 * via the injectable executor. Always merges INTO the current HEAD —
 * the caller is responsible for `git checkout`ing the target first.
 *
 * `--no-commit` is NOT used: merge auto-commits unless there is a
 * conflict (in which case stderr will say so and ok=false).
 *
 * Never throws — conflicts, unrelated histories, missing source branch
 * all surface via `ok: false`.
 */
export function gitMerge(
  projectRoot: string,
  sourceBranch: string,
  options: GitMergeOptions,
  executor: GitExecutor = defaultGitExecutor,
): GitMergeResult {
  const args = ['merge']
  if (options.no_ff) args.push('--no-ff')
  if (options.allow_unrelated_histories) args.push('--allow-unrelated-histories')
  args.push(sourceBranch)

  const sha_before = getHeadSha(projectRoot, executor)
  const exec = executor(projectRoot, args)
  if (!exec.ok) {
    const result: GitMergeResult = { ok: false, sha_before, sha_after: null }
    if (exec.stderr) result.stderr = exec.stderr.trim()
    if (exec.stdout) result.stdout = exec.stdout.trim()
    if (exec.error) result.error = exec.error
    return result
  }
  const sha_after = getHeadSha(projectRoot, executor)
  return { ok: true, sha_before, sha_after, stdout: exec.stdout.trim() }
}

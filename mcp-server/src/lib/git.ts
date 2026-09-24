import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export interface GitState {
  available: boolean
  branch: string | null
  head_sha: string | null
  is_clean: boolean | null
}

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

export function getStagedDiff(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null
  return safeGitRaw(projectRoot, ['diff', '--cached', '--no-color', '-U0'])
}

export function getStagedPaths(projectRoot: string): string[] | null {
  if (!isGitRepo(projectRoot)) return null
  const raw = safeGitRaw(projectRoot, ['diff', '--cached', '--name-only', '-z'])
  if (raw === null) return null
  return splitNulPaths(raw)
}

function splitNulPaths(raw: string): string[] {
  return raw
    .split('\0')
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.length > 0)
}

export function isSafeRevisionToken(rev: string): boolean {
  if (typeof rev !== 'string' || rev.length === 0) return false
  if (rev.startsWith('-')) return false
  if (/[\u0000-\u001f\u007f]/.test(rev)) return false
  return true
}

export type RangePathsResult =
  | { status: 'ok'; paths: string[] }
  | { status: 'unsafe_revision'; revision: string }
  | { status: 'unavailable' }

export function getRangePaths(
  projectRoot: string,
  base: string,
  head: string,
): RangePathsResult {
  for (const rev of [base, head]) {
    if (!isSafeRevisionToken(rev)) return { status: 'unsafe_revision', revision: rev }
  }
  if (!isGitRepo(projectRoot)) return { status: 'unavailable' }
  const raw = safeGitRaw(projectRoot, [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=d',
    `${base}...${head}`,
  ])
  if (raw === null) return { status: 'unavailable' }
  return { status: 'ok', paths: splitNulPaths(raw) }
}

export interface StagedStats {
  files: number
  insertions: number
  deletions: number
  paths: string[]
}

export function getStagedStats(projectRoot: string): StagedStats | null {
  if (!isGitRepo(projectRoot)) return null
  const raw = safeGitRaw(projectRoot, ['diff', '--cached', '--numstat', '-z'])
  if (raw === null) return null
  return parseNumstatZ(raw)
}

export function parseNumstatZ(raw: string): StagedStats {
  const tokens = raw.split('\0')
  const paths: string[] = []
  let insertions = 0
  let deletions = 0
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok === '') {
      i += 1
      continue
    }
    const firstTab = tok.indexOf('\t')
    const secondTab = firstTab >= 0 ? tok.indexOf('\t', firstTab + 1) : -1
    if (firstTab < 0 || secondTab < 0) {
      i += 1
      continue
    }
    const addedRaw = tok.slice(0, firstTab)
    const deletedRaw = tok.slice(firstTab + 1, secondTab)
    const rest = tok.slice(secondTab + 1)
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10)
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw, 10)
    insertions += Number.isFinite(added) ? added : 0
    deletions += Number.isFinite(deleted) ? deleted : 0
    if (rest !== '') {
      paths.push(rest.replace(/\\/g, '/'))
      i += 1
    } else {
      const newPath = tokens[i + 2]
      if (newPath !== undefined && newPath !== '') {
        paths.push(newPath.replace(/\\/g, '/'))
      }
      i += 3
    }
  }
  return { files: paths.length, insertions, deletions, paths }
}

export function getFileAtHead(projectRoot: string, relPath: string): string | null {
  if (!isGitRepo(projectRoot)) return null
  return safeGitRaw(projectRoot, ['show', `HEAD:${relPath}`])
}

export function getUnstagedDiff(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null
  return safeGitRaw(projectRoot, ['diff', '--no-color', '-U0'])
}

function isGitRepo(projectRoot: string): boolean {
  const out = safeGit(projectRoot, ['rev-parse', '--is-inside-work-tree'])
  return out === 'true'
}

export function gitIsTracked(
  projectRoot: string,
  relPath: string,
  executor: GitExecutor = defaultGitExecutor,
): boolean {
  const r = executor(projectRoot, ['ls-files', '--error-unmatch', '--', relPath])
  if (r.ok) return true
  if (r.exitCode === 1) return false
  return true
}

export function gitBranchMerged(
  projectRoot: string,
  branch: string,
  target: string,
  executor: GitExecutor = defaultGitExecutor,
): boolean {
  const r = executor(projectRoot, ['branch', '--merged', target])
  if (!r.ok) return false
  return r.stdout
    .split('\n')
    .map((l) => l.replace(/^[*+]?\s*/, '').trim())
    .includes(branch)
}

export interface WorktreeInfo {
  in_git_repo: boolean
  is_worktree: boolean
  toplevel: string | null
  name: string | null
}

export function readWorktreeInfo(projectRoot: string): WorktreeInfo {
  if (safeGit(projectRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { in_git_repo: false, is_worktree: false, toplevel: null, name: null }
  }
  const norm = (s: string | null): string | null =>
    s === null ? null : s.replace(/\\/g, '/')
  const gitDirRaw = safeGit(projectRoot, ['rev-parse', '--git-dir'])
  const toplevel = norm(safeGit(projectRoot, ['rev-parse', '--show-toplevel']))

  let isWorktree = false
  let name: string | null = null
  if (gitDirRaw !== null) {
    const gitDirNorm = resolve(projectRoot, gitDirRaw).replace(/\\/g, '/')
    const m = gitDirNorm.match(/\/worktrees\/([^/]+)\/?$/)
    if (m) {
      isWorktree = true
      name = m[1] ?? null
    }
  }
  return { in_git_repo: true, is_worktree: isWorktree, toplevel, name }
}

function safeGit(cwd: string, args: string[]): string | null {
  const raw = safeGitRaw(cwd, args)
  return raw !== null ? raw.trim() : null
}

export const safeGitRead = safeGit

const GIT_READ_TIMEOUT_MS = 30_000
const CAPTURED_FAILURES_MAX = 5
const CAPTURED_MESSAGE_MAX = 200
const CAPTURED_ARGS_SHOWN = 4

export interface GitReadFailure {
  args: string[]
  cwd: string
  said: string
}

const failuresOfThisCall = new AsyncLocalStorage<GitReadFailure[]>()

export function withGitFailures<T>(run: () => T): T {
  return failuresOfThisCall.run([], run)
}

export function capturedGitFailures(): GitReadFailure[] {
  return [...(failuresOfThisCall.getStore() ?? [])]
}

export function gitFailureDetail(base: string): string {
  const said = capturedGitFailures()
    .map((failure) => {
      const command = failure.args.length > CAPTURED_ARGS_SHOWN ? `${failure.args.slice(0, CAPTURED_ARGS_SHOWN).join(' ')} …` : failure.args.join(' ')
      return `git ${command} (in ${failure.cwd}) said: "${failure.said}"`
    })
    .join('; ')
  return said.length > 0 ? `${base}: ${said}` : base
}

function firstLine(text: string): string {
  const line = (text.split('\n').find((part) => part.trim().length > 0)?.trim() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/"/g, "'")
  return line.length > CAPTURED_MESSAGE_MAX ? `${line.slice(0, CAPTURED_MESSAGE_MAX)}…` : line
}

function recordGitFailure(cwd: string, args: readonly string[], error: unknown): void {
  const failures = failuresOfThisCall.getStore()
  if (!failures) return
  const thrown = error as { status?: number | null; code?: string; signal?: string; stderr?: Buffer | string; message?: string }
  const said = firstLine(String(thrown.stderr ?? '')) || (thrown.code ? `git was stopped (${thrown.code})` : '')
  if (said.length === 0) return
  failures.push({ args: [...args], cwd, said })
  if (failures.length > CAPTURED_FAILURES_MAX) failures.shift()
}

function safeGitRaw(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_READ_TIMEOUT_MS,
    })
  } catch {
    return null
  }
}

export function safeGitBuffer(
  cwd: string,
  args: string[],
  input?: string,
  env?: Record<string, string>,
  maxBuffer: number = 64 * 1024 * 1024,
): Buffer | null {
  try {
    return execFileSync('git', args, {
      cwd,
      input: input ?? '',
      ...(env !== undefined && { env: { ...process.env, ...env } }),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer,
      timeout: GIT_READ_TIMEOUT_MS,
    })
  } catch (error) {
    recordGitFailure(cwd, args, error)
    return null
  }
}

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

export function getHeadSha(
  projectRoot: string,
  executor: GitExecutor = defaultGitExecutor,
): string | null {
  const r = executor(projectRoot, ['rev-parse', '--short', 'HEAD'])
  if (!r.ok) return null
  return r.stdout.trim() || null
}

export function getHeadShaFull(
  projectRoot: string,
  executor: GitExecutor = defaultGitExecutor,
): string | null {
  const r = executor(projectRoot, ['rev-parse', 'HEAD'])
  if (!r.ok) return null
  return r.stdout.trim() || null
}

function unsafeOperand(operands: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(operands)) {
    if (!isSafeRevisionToken(value)) {
      return `refusing to run git: ${name} is not a safe operand (${JSON.stringify(value)}) — a value starting with '-' is read by git as an OPTION, not a name`
    }
  }
  return null
}

export interface GitCommitResult {
  ok: boolean
  sha_before: string | null
  sha_after: string | null
  error?: string
  stderr?: string
}

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

export function gitPush(
  projectRoot: string,
  remote: string,
  branch: string,
  executor: GitExecutor = defaultGitExecutor,
): GitPushResult {
  const bad = unsafeOperand({ remote, branch })
  if (bad) return { ok: false, error: bad }
  const exec = executor(projectRoot, ['push', '--', remote, branch])
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

export function gitMerge(
  projectRoot: string,
  sourceBranch: string,
  options: GitMergeOptions,
  executor: GitExecutor = defaultGitExecutor,
): GitMergeResult {
  const bad = unsafeOperand({ sourceBranch })
  if (bad) return { ok: false, sha_before: null, sha_after: null, error: bad }
  const args = ['merge']
  if (options.no_ff) args.push('--no-ff')
  if (options.allow_unrelated_histories) args.push('--allow-unrelated-histories')
  args.push('--', sourceBranch)

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

export function gitRebase(
  projectRoot: string,
  upstream: string,
  executor: GitExecutor = defaultGitExecutor,
): GitMergeResult {
  const bad = unsafeOperand({ upstream })
  if (bad) return { ok: false, sha_before: null, sha_after: null, error: bad }
  const sha_before = getHeadSha(projectRoot, executor)
  const exec = executor(projectRoot, ['rebase', '--', upstream])
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

export function gitSquash(
  projectRoot: string,
  sourceBranch: string,
  executor: GitExecutor = defaultGitExecutor,
): GitMergeResult {
  const bad = unsafeOperand({ sourceBranch })
  if (bad) return { ok: false, sha_before: null, sha_after: null, error: bad }
  const sha_before = getHeadSha(projectRoot, executor)
  const exec = executor(projectRoot, ['merge', '--squash', '--', sourceBranch])
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

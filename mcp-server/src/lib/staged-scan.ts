import {
  COMMIT_PATCH_ARGS,
  STAGED_DIFF_ARGS,
  UNSTAGED_DIFF_ARGS,
  gitRepoStatus,
  listCommits,
  streamGitLines,
  treeDiffArgs,
  type CommitRange,
} from './git.js'
import { createDiffScanner, type ExtraPattern, type SecretFinding } from './secrets.js'

export type DiffScanResult = { ok: true; findings: SecretFinding[] } | { ok: false; reason: string }

export type CommitScanResult = { ok: true; findings: SecretFinding[]; commits: number } | { ok: false; reason: string }

export async function scanCommits(
  projectRoot: string,
  range: CommitRange,
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
  timeoutMs?: number,
): Promise<CommitScanResult> {
  const listed = listCommits(projectRoot, range)
  if (!listed.ok) return listed
  if (listed.commits.length === 0) return { ok: true, findings: [], commits: 0 }
  const scanner = createDiffScanner(extraPatterns)
  const read = await streamGitLines(projectRoot, COMMIT_PATCH_ARGS, scanner.line, timeoutMs, `${listed.commits.join('\n')}\n`)
  return read.ok ? { ok: true, findings: scanner.findings, commits: listed.commits.length } : { ok: false, reason: read.reason }
}

export async function scanGitDiff(
  projectRoot: string,
  which: 'staged' | 'unstaged',
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
): Promise<DiffScanResult> {
  const status = gitRepoStatus(projectRoot)
  if (status === 'not_a_repo') return { ok: true, findings: [] }
  if (status === 'unknown') return { ok: false, reason: 'git could not tell whether this folder is a repository' }
  return scanArgs(projectRoot, which === 'staged' ? STAGED_DIFF_ARGS : UNSTAGED_DIFF_ARGS, extraPatterns)
}

export async function scanTreeDiff(
  projectRoot: string,
  fromTree: string,
  toTree: string,
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
  timeoutMs?: number,
): Promise<DiffScanResult> {
  const args = treeDiffArgs(fromTree, toTree)
  if (args === null) return { ok: false, reason: 'not a pair of tree ids' }
  return scanArgs(projectRoot, args, extraPatterns, timeoutMs)
}

async function scanArgs(
  projectRoot: string,
  args: readonly string[],
  extraPatterns: ReadonlyArray<ExtraPattern>,
  timeoutMs?: number,
): Promise<DiffScanResult> {
  const scanner = createDiffScanner(extraPatterns)
  const read = await streamGitLines(projectRoot, args, scanner.line, timeoutMs)
  return read.ok ? { ok: true, findings: scanner.findings } : { ok: false, reason: read.reason }
}

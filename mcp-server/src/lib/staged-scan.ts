import { STAGED_DIFF_ARGS, UNSTAGED_DIFF_ARGS, gitRepoStatus, streamGitLines, treeDiffArgs } from './git.js'
import { createDiffScanner, type ExtraPattern, type SecretFinding } from './secrets.js'

export type DiffScanResult = { ok: true; findings: SecretFinding[] } | { ok: false; reason: string }

export async function scanGitDiff(
  projectRoot: string,
  which: 'staged' | 'unstaged',
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
  timeoutMs?: number,
): Promise<DiffScanResult> {
  const status = gitRepoStatus(projectRoot)
  if (status === 'not_a_repo') return { ok: true, findings: [] }
  if (status === 'unknown') return { ok: false, reason: 'git could not tell whether this folder is a repository' }
  return scanArgs(projectRoot, which === 'staged' ? STAGED_DIFF_ARGS : UNSTAGED_DIFF_ARGS, extraPatterns, timeoutMs)
}

export async function scanTreeDiff(
  projectRoot: string,
  fromTree: string,
  toTree: string,
  extraPatterns: ReadonlyArray<ExtraPattern> = [],
): Promise<DiffScanResult> {
  const args = treeDiffArgs(fromTree, toTree)
  if (args === null) return { ok: false, reason: 'not a pair of tree ids' }
  return scanArgs(projectRoot, args, extraPatterns)
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

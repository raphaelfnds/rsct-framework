import type { GitExecResult, GitExecutor } from '../../src/lib/git.js'

export const PROGRAMS_REV_PARSE = 'rev-parse --git-dir --git-path hooks'
export const PROGRAMS_CONFIG_LIST = 'config --show-origin -z --list'

export function emptyProgramsRead(args: readonly string[]): GitExecResult | null {
  const key = args.join(' ')
  if (key === PROGRAMS_REV_PARSE) return { ok: true, stdout: '.git\n.git/hooks\n', stderr: '', exitCode: 0 }
  if (key === PROGRAMS_CONFIG_LIST) return { ok: true, stdout: '', stderr: '', exitCode: 0 }
  return null
}

export function withEmptyPrograms(exec: GitExecutor): GitExecutor {
  return (root, args) => emptyProgramsRead(args) ?? exec(root, args)
}

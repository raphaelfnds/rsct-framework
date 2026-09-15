import { safeGitBuffer } from '../git.js'

export interface SweepRepo {
  toplevel: string
  prefix: string
  headCommit: string | null
}

export type TouchedStatus = 'added' | 'modified' | 'deleted'

export interface TouchedPath {
  path: string
  status: TouchedStatus
}

function text(buf: Buffer | null): string | null {
  return buf === null ? null : buf.toString('utf8')
}

function line(buf: Buffer | null): string | null {
  const out = text(buf)
  return out === null ? null : out.trim()
}

function nulList(buf: Buffer | null): string[] | null {
  const out = text(buf)
  return out === null ? null : out.split('\0').filter((p) => p.length > 0)
}

function scopeArgs(repo: SweepRepo): string[] {
  return repo.prefix.length > 0 ? ['--', `:(top,literal)${repo.prefix}`] : []
}

export function openSweepRepo(projectRoot: string): SweepRepo | null {
  const toplevel = line(safeGitBuffer(projectRoot, ['rev-parse', '--show-toplevel']))
  if (!toplevel) return null
  const prefix = line(safeGitBuffer(projectRoot, ['rev-parse', '--show-prefix'])) ?? ''
  const headCommit = line(safeGitBuffer(toplevel, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']))
  return { toplevel, prefix, headCommit: headCommit && headCommit.length > 0 ? headCommit : null }
}

function baseTree(repo: SweepRepo): string | null {
  if (repo.headCommit) return repo.headCommit
  return line(safeGitBuffer(repo.toplevel, ['hash-object', '-t', 'tree', '--stdin'], ''))
}

export function readTouchedPaths(repo: SweepRepo): TouchedPath[] | null {
  const base = baseTree(repo)
  if (!base) return null
  const diff = nulList(
    safeGitBuffer(repo.toplevel, ['diff', '--name-status', '-z', '--no-renames', base, ...scopeArgs(repo)]),
  )
  const others = nulList(
    safeGitBuffer(repo.toplevel, ['ls-files', '--others', '--exclude-standard', '-z', ...scopeArgs(repo)]),
  )
  if (diff === null || others === null) return null
  const byPath = new Map<string, TouchedStatus>()
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const code = diff[i]!
    const path = diff[i + 1]!
    byPath.set(path, code === 'D' ? 'deleted' : code === 'A' ? 'added' : 'modified')
  }
  for (const path of others) byPath.set(path, 'added')
  return [...byPath.entries()]
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function readStagedPaths(repo: SweepRepo): string[] | null {
  return nulList(
    safeGitBuffer(repo.toplevel, ['diff', '--cached', '--name-only', '-z', '--diff-filter=d', ...scopeArgs(repo)]),
  )
}

export function readWorkingBlobId(repo: SweepRepo, path: string): string | null {
  return line(safeGitBuffer(repo.toplevel, ['hash-object', `--path=${path}`, '--', path]))
}

function verifyObject(repo: SweepRepo, spec: string): string | null {
  const id = line(safeGitBuffer(repo.toplevel, ['rev-parse', '-q', '--verify', spec]))
  return id && id.length > 0 ? id : null
}

export function readStagedBlobId(repo: SweepRepo, path: string): string | null {
  return verifyObject(repo, `:0:${path}`)
}

export function readCommitBlobId(repo: SweepRepo, commit: string, path: string): string | null {
  return verifyObject(repo, `${commit}:${path}`)
}

export function readBlob(repo: SweepRepo, blobId: string): Buffer | null {
  return safeGitBuffer(repo.toplevel, ['cat-file', 'blob', blobId])
}

export function readHeadContent(repo: SweepRepo, path: string): Buffer | null {
  if (!repo.headCommit) return null
  const id = readCommitBlobId(repo, repo.headCommit, path)
  return id ? readBlob(repo, id) : null
}

export function readKnownPaths(repo: SweepRepo): Set<string> | null {
  const index = nulList(safeGitBuffer(repo.toplevel, ['ls-files', '-z', '--full-name']))
  if (index === null) return null
  const known = new Set(index)
  if (repo.headCommit) {
    const tree = nulList(safeGitBuffer(repo.toplevel, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', repo.headCommit]))
    if (tree === null) return null
    for (const p of tree) known.add(p)
  }
  return known
}

export function readCommitPaths(repo: SweepRepo, commit: string): string[] | null {
  return nulList(
    safeGitBuffer(repo.toplevel, [
      'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', '--diff-filter=d', commit, ...scopeArgs(repo),
    ]),
  )
}

export function hasGitFilter(repo: SweepRepo, path: string): boolean | null {
  const out = nulList(safeGitBuffer(repo.toplevel, ['check-attr', '-z', 'filter', '--', path]))
  if (out === null) return null
  const value = out[2]
  return value !== undefined && value !== 'unspecified' && value !== 'unset'
}

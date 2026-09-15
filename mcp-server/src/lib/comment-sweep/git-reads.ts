import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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

export interface StagedEntry {
  path: string
  status: TouchedStatus
  headBlob: string | null
}

const NON_CONTENT_MODES = new Set(['160000', '120000'])
const ADD_BATCH = 50

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

export function openSweepRepo(projectRoot: string): SweepRepo | null {
  const toplevel = line(safeGitBuffer(projectRoot, ['rev-parse', '--show-toplevel']))
  if (!toplevel) return null
  const prefix = line(safeGitBuffer(projectRoot, ['rev-parse', '--show-prefix'])) ?? ''
  const headCommit = line(safeGitBuffer(toplevel, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']))
  return { toplevel, prefix, headCommit: headCommit && headCommit.length > 0 ? headCommit : null }
}

function emptyTree(repo: SweepRepo): string | null {
  return line(safeGitBuffer(repo.toplevel, ['hash-object', '-t', 'tree', '--stdin'], ''))
}

interface RawEntry {
  path: string
  status: TouchedStatus
  oldMode: string
  newMode: string
  oldBlob: string
}

function readRaw(repo: SweepRepo, args: string[]): RawEntry[] | null {
  const tokens = nulList(safeGitBuffer(repo.toplevel, ['diff', '--raw', '--no-abbrev', '-z', '--no-renames', ...args]))
  if (tokens === null) return null
  const out: RawEntry[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const header = tokens[i]!.replace(/^:/, '').split(' ')
    const code = header[4] ?? ''
    out.push({
      path: tokens[i + 1]!,
      status: code === 'D' ? 'deleted' : code === 'A' ? 'added' : 'modified',
      oldMode: header[0] ?? '',
      newMode: header[1] ?? '',
      oldBlob: header[2] ?? '',
    })
  }
  return out
}

function hasContent(entry: RawEntry): boolean {
  const mode = entry.status === 'deleted' ? entry.oldMode : entry.newMode
  return !NON_CONTENT_MODES.has(mode)
}

export function readTouchedPaths(repo: SweepRepo): TouchedPath[] | null {
  const base = repo.headCommit ?? emptyTree(repo)
  if (!base) return null
  const diff = readRaw(repo, [base])
  const others = nulList(safeGitBuffer(repo.toplevel, ['ls-files', '--others', '--exclude-standard', '-z']))
  if (diff === null || others === null) return null
  const byPath = new Map<string, TouchedStatus>()
  for (const entry of diff) if (hasContent(entry)) byPath.set(entry.path, entry.status)
  for (const path of others) byPath.set(path, 'added')
  return [...byPath.entries()]
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function readStagedEntries(repo: SweepRepo): StagedEntry[] | null {
  const entries = readRaw(repo, ['--cached', ...(repo.headCommit ? [] : [emptyTree(repo) ?? ''])])
  if (entries === null) return null
  return entries
    .filter(hasContent)
    .map((e) => ({ path: e.path, status: e.status, headBlob: /^0+$/.test(e.oldBlob) ? null : e.oldBlob }))
}

export function readWorkingBlobIds(repo: SweepRepo, paths: readonly string[]): Map<string, string> | null {
  const ids = new Map<string, string>()
  if (paths.length === 0) return ids
  const indexOut = line(safeGitBuffer(repo.toplevel, ['rev-parse', '--git-path', 'index']))
  if (!indexOut) return null
  const realIndex = isAbsolute(indexOut) ? indexOut : join(repo.toplevel, indexOut)
  const dir = mkdtempSync(join(tmpdir(), 'rsct-sweep-index-'))
  const tempIndex = join(dir, 'index')
  try {
    if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex)
    const env = { GIT_INDEX_FILE: tempIndex }
    for (let i = 0; i < paths.length; i += ADD_BATCH) {
      const batch = paths.slice(i, i + ADD_BATCH)
      const added = safeGitBuffer(repo.toplevel, ['--literal-pathspecs', 'add', '-f', '--', ...batch], '', env)
      if (added === null) return null
    }
    const listing = nulList(safeGitBuffer(repo.toplevel, ['ls-files', '-s', '-z'], '', env))
    if (listing === null) return null
    const wanted = new Set(paths)
    for (const record of listing) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, blob, stage] = record.slice(0, tab).split(' ')
      const path = record.slice(tab + 1)
      if (stage === '0' && blob && mode && !NON_CONTENT_MODES.has(mode) && wanted.has(path)) ids.set(path, blob)
    }
    return ids
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

export function readCommitPaths(repo: SweepRepo, before: string | null, after: string): string[] | null {
  const base = before ?? emptyTree(repo)
  if (!base) return null
  const entries = readRaw(repo, [base, after])
  if (entries === null) return null
  return entries.filter((e) => e.status !== 'deleted' && hasContent(e)).map((e) => e.path)
}

export function readFullSha(repo: SweepRepo, rev: string): string | null {
  return verifyObject(repo, `${rev}^{commit}`)
}

export function hasGitFilter(repo: SweepRepo, path: string): boolean | null {
  const out = nulList(safeGitBuffer(repo.toplevel, ['check-attr', '-z', 'filter', '--', path]))
  if (out === null) return null
  const value = out[2]
  return value !== undefined && value !== 'unspecified' && value !== 'unset'
}

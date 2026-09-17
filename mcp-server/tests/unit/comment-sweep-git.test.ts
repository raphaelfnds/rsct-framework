import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasGitFilter,
  openSweepRepo,
  readCommitPaths,
  readHeadContent,
  readStagedBlobId,
  readStagedEntries,
  readTouchedPaths,
  readWorkingBlobIds,
} from '../../src/lib/comment-sweep/git-reads.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

const dirs: string[] = []

function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'rsct-symlink-probe-'))
  try {
    writeFileSync(join(probe, 'target'), 'x')
    symlinkSync('target', join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-sweep-git-'))
  dirs.push(dir)
  initSweepRepo(dir)
  return dir
}

function write(root: string, rel: string, content: string | Buffer): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('comment-sweep git reads', () => {
  it('works on an unborn HEAD', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    const r = openSweepRepo(root)!
    expect(r.headCommit).toBeNull()
    expect(readTouchedPaths(r)).toEqual([
      { path: '.gitignore', status: 'added', symlink: false },
      { path: 'a.ts', status: 'added', symlink: false },
    ])
    expect(readHeadContent(r, 'a.ts')).toBeNull()
    git(root, 'add', 'a.ts')
    expect(readStagedEntries(r)).toEqual([{ path: 'a.ts', status: 'added', headBlob: null, symlink: false }])
  })

  it('returns null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-sweep-nogit-'))
    dirs.push(dir)
    expect(openSweepRepo(dir)).toBeNull()
  })

  it('reads the whole repository even from a project subdirectory', () => {
    const root = repo()
    write(root, 'svc/a.ts', '// c\nexport const a = 1\n')
    write(root, 'other/o.ts', 'x\n')
    commitAll(root, 'i')
    git(root, 'mv', 'svc/a.ts', 'svc/b.ts')
    write(root, 'svc/b.ts', 'export const a = 1\n')
    write(root, 'other/o.ts', 'y\n')
    git(root, 'add', 'other/o.ts')
    const r = openSweepRepo(join(root, 'svc'))!
    expect(r.prefix).toBe('svc/')
    expect(readTouchedPaths(r)).toEqual([
      { path: 'other/o.ts', status: 'modified', symlink: false },
      { path: 'svc/a.ts', status: 'deleted', symlink: false },
      { path: 'svc/b.ts', status: 'added', symlink: false },
    ])
    expect(readStagedEntries(r)!.map((e) => [e.path, e.status])).toEqual([
      ['other/o.ts', 'modified'],
      ['svc/a.ts', 'deleted'],
      ['svc/b.ts', 'added'],
    ])
    expect(readHeadContent(r, 'svc/a.ts')!.toString('utf8')).toBe('// c\nexport const a = 1\n')
  })

  it('treats bracketed paths literally and hashes files the way git add stores them', () => {
    const root = repo()
    write(root, 'app/[id]/page.tsx', 'a\n')
    write(root, 'app/d/page.tsx', 'b\n')
    write(root, 'app/i/page.tsx', 'c\n')
    const r = openSweepRepo(root)!
    const ids = readWorkingBlobIds(r, ['app/[id]/page.tsx'])!
    expect([...ids.keys()]).toEqual(['app/[id]/page.tsx'])
    git(root, 'add', '-A')
    expect(readStagedBlobId(r, 'app/[id]/page.tsx')).toBe(ids.get('app/[id]/page.tsx'))
  })

  it('hashes the working bytes when the file is stat-identical to its index entry', () => {
    const root = repo()
    git(root, 'config', 'core.trustctime', 'false')
    const file = join(root, 'a.ts')
    const old = new Date(Date.now() - 10_000)
    write(root, 'a.ts', 'export const a = 1\n')
    utimesSync(file, old, old)
    git(root, 'add', 'a.ts')
    const r = openSweepRepo(root)!
    const staged = readStagedBlobId(r, 'a.ts')
    write(root, 'a.ts', 'export const a = 2\n')
    utimesSync(file, old, old)
    utimesSync(join(root, '.git', 'index'), old, old)
    const id = readWorkingBlobIds(r, ['a.ts'])!.get('a.ts')
    expect(id).toBe(git(root, 'hash-object', '--', 'a.ts').trim())
    expect(id).not.toBe(staged)
  })

  it('matches git add for a file whose committed blob keeps CRLF under text=auto', () => {
    const root = repo()
    git(root, 'config', 'core.autocrlf', 'false')
    write(root, 'a.ts', 'export const a = 1\r\n')
    commitAll(root, 'crlf blob')
    write(root, '.gitattributes', '* text=auto\n')
    write(root, 'a.ts', 'export const a = 2\r\n')
    const r = openSweepRepo(root)!
    const predicted = readWorkingBlobIds(r, ['a.ts'])!.get('a.ts')
    git(root, 'add', 'a.ts')
    expect(predicted).toBe(readStagedBlobId(r, 'a.ts'))
  })

  it('skips submodule gitlinks in staged and committed paths', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    commitAll(root, 'i')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${head},libs/lib`)
    const r = openSweepRepo(root)!
    expect(readStagedEntries(r)).toEqual([])
    git(root, 'commit', '-qm', 'gitlink')
    expect(readCommitPaths(r, head, 'HEAD')).toEqual([])
    const blob = git(root, 'hash-object', '-w', '--', 'a.ts').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},link.ts`)
    git(root, 'commit', '-qm', 'symlink')
    expect(readCommitPaths(r, head, 'HEAD')).toEqual([{ path: 'link.ts', symlink: true }])
  })

  it.skipIf(!canSymlink())('marks a staged symlink so the sweep can tell it from content', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    commitAll(root, 'i')
    symlinkSync('a.ts', join(root, 'link.ts'))
    git(root, 'add', 'link.ts')
    const r = openSweepRepo(root)!
    expect(readStagedEntries(r)).toEqual([{ path: 'link.ts', status: 'added', headBlob: null, symlink: true }])
  })

  it('detects a filter attribute and a staged deletion', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    write(root, '.gitattributes', '*.bin filter=lfs\n')
    commitAll(root, 'i')
    git(root, 'rm', '-q', 'a.ts')
    const r = openSweepRepo(root)!
    const entries = readStagedEntries(r)!
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: 'a.ts', status: 'deleted' })
    expect(entries[0]!.headBlob).toMatch(/^[0-9a-f]{40,64}$/)
    expect(hasGitFilter(r, 'x.bin')).toBe(true)
    expect(hasGitFilter(r, 'a.ts')).toBe(false)
  })
})

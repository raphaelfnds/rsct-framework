import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      { path: '.gitignore', status: 'added' },
      { path: 'a.ts', status: 'added' },
    ])
    expect(readHeadContent(r, 'a.ts')).toBeNull()
    git(root, 'add', 'a.ts')
    expect(readStagedEntries(r)).toEqual([{ path: 'a.ts', status: 'added', headBlob: null }])
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
      { path: 'other/o.ts', status: 'modified' },
      { path: 'svc/a.ts', status: 'deleted' },
      { path: 'svc/b.ts', status: 'added' },
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

  it('skips submodule gitlinks and symlinks in staged and committed paths', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    commitAll(root, 'i')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${head},libs/lib`)
    try {
      symlinkSync('a.ts', join(root, 'link.ts'))
      git(root, 'add', 'link.ts')
    } catch {
      rmSync(join(root, 'link.ts'), { force: true })
    }
    const r = openSweepRepo(root)!
    expect(readStagedEntries(r)).toEqual([])
    git(root, 'commit', '-qm', 'gitlink')
    expect(readCommitPaths(r, head, 'HEAD')).toEqual([])
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

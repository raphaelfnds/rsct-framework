import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasGitFilter,
  openSweepRepo,
  readHeadContent,
  readStagedBlobId,
  readStagedPaths,
  readTouchedPaths,
  readWorkingBlobId,
} from '../../src/lib/comment-sweep/git-reads.js'

const dirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-sweep-git-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'a@b.c')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function write(root: string, rel: string, content: string): void {
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
    expect(readTouchedPaths(r)).toEqual([{ path: 'a.ts', status: 'added' }])
    expect(readHeadContent(r, 'a.ts')).toBeNull()
  })

  it('returns null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-sweep-nogit-'))
    dirs.push(dir)
    expect(openSweepRepo(dir)).toBeNull()
  })

  it('reports a rename as delete plus add and scopes to the project subdirectory', () => {
    const root = repo()
    write(root, 'svc/a.ts', '// c\nexport const a = 1\n')
    write(root, 'other/o.ts', 'x\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'i')
    git(root, 'mv', 'svc/a.ts', 'svc/b.ts')
    write(root, 'svc/b.ts', 'export const a = 1\n')
    write(root, 'other/o.ts', 'y\n')
    const r = openSweepRepo(join(root, 'svc'))!
    expect(r.prefix).toBe('svc/')
    expect(readTouchedPaths(r)).toEqual([
      { path: 'svc/a.ts', status: 'deleted' },
      { path: 'svc/b.ts', status: 'added' },
    ])
    expect(readStagedPaths(r)).toEqual(['svc/b.ts'])
    expect(readHeadContent(r, 'svc/a.ts')!.toString('utf8')).toBe('// c\nexport const a = 1\n')
  })

  it('treats bracketed paths literally and binds working and staged blob ids', () => {
    const root = repo()
    write(root, 'app/[id]/page.tsx', 'a\n')
    write(root, 'app/d/page.tsx', 'b\n')
    write(root, 'app/i/page.tsx', 'c\n')
    git(root, 'add', '-A')
    const r = openSweepRepo(root)!
    const working = readWorkingBlobId(r, 'app/[id]/page.tsx')
    expect(working).toMatch(/^[0-9a-f]{40,64}$/)
    expect(readStagedBlobId(r, 'app/[id]/page.tsx')).toBe(working)
    write(root, 'app/[id]/page.tsx', 'changed\n')
    expect(readWorkingBlobId(r, 'app/[id]/page.tsx')).not.toBe(working)
  })

  it('excludes deletions from the staged set and detects a filter attribute', () => {
    const root = repo()
    write(root, 'a.ts', 'x\n')
    write(root, '.gitattributes', '*.bin filter=lfs\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'i')
    git(root, 'rm', '-q', 'a.ts')
    const r = openSweepRepo(root)!
    expect(readStagedPaths(r)).toEqual([])
    expect(hasGitFilter(r, 'x.bin')).toBe(true)
    expect(hasGitFilter(r, 'a.ts')).toBe(false)
    unlinkSync(join(root, '.gitattributes'))
  })
})

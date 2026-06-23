import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorktreeInfo } from '../../src/lib/git.js'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const GIT = hasGit()

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

let parent: string
let main: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'rsct-wt-'))
  main = join(parent, 'main')
  mkdirSync(main, { recursive: true })
  if (GIT) {
    git(main, ['init', '-q'])
    git(main, ['config', 'user.email', 't@t.t'])
    git(main, ['config', 'user.name', 't'])
    writeFileSync(join(main, 'README.md'), '# app\n')
    git(main, ['add', 'README.md'])
    git(main, ['commit', '-qm', 'init'])
  }
})

afterEach(() => {
  if (existsSync(parent)) rmSync(parent, { recursive: true, force: true })
})

describe('lib/git — readWorktreeInfo', () => {
  it('reports a non-git directory as not-in-repo, never throws', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'rsct-nogit-'))
    try {
      const r = readWorktreeInfo(nonGit)
      expect(r.in_git_repo).toBe(false)
      expect(r.is_worktree).toBe(false)
      expect(r.name).toBeNull()
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it.skipIf(!GIT)('main worktree → is_worktree=false', () => {
    const r = readWorktreeInfo(main)
    expect(r.in_git_repo).toBe(true)
    expect(r.is_worktree).toBe(false)
    expect(r.name).toBeNull()
    expect(r.toplevel).not.toBeNull()
  })

  it.skipIf(!GIT)('RV1 regression: a SUBDIR of the main worktree is NOT a linked worktree', () => {
    const sub = join(main, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    // From a subdir git returns --git-dir absolute but --git-common-dir relative;
    // a raw string compare would false-positive. The path.resolve fix keeps it false.
    const r = readWorktreeInfo(sub)
    expect(r.in_git_repo).toBe(true)
    expect(r.is_worktree).toBe(false)
    expect(r.name).toBeNull()
  })

  it.skipIf(!GIT)('linked worktree → is_worktree=true with the worktree name', () => {
    const wt = join(parent, 'wt2')
    git(main, ['worktree', 'add', '-q', wt, '-b', 'feat/other'])
    const r = readWorktreeInfo(wt)
    expect(r.in_git_repo).toBe(true)
    expect(r.is_worktree).toBe(true)
    expect(r.name).toBe('wt2')
  })
})

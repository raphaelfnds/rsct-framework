import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readWorktreeInfo,
  getRangePaths,
  isSafeRevisionToken,
  gitPush,
  gitMerge,
  gitRebase,
  gitSquash,
  type GitExecutor,
} from '../../src/lib/git.js'

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

describe('lib/git — isSafeRevisionToken (injection guard)', () => {
  it('rejects a revision that git would read as an OPTION', () => {
    for (const bad of ['--output=X', '-M', '--ext-diff', '--textconv', '--stat', '-']) {
      expect(isSafeRevisionToken(bad), bad).toBe(false)
    }
  })

  it('accepts the revision EXPRESSIONS a real rebase target uses', () => {
    for (const ok of ['HEAD~3', 'HEAD^', 'HEAD^1', 'HEAD@{0}', '@']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  it('leaves non-resolving shapes to git instead of posing as a refspec guard', () => {
    for (const ok of ['feat:main', 'main..feat', '+feat', 'feat.lock', 'feat/']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  it('accepts the revision shapes real branches actually use', () => {
    for (const ok of ['HEAD', 'main', 'origin/main', 'refs/heads/main', 'feat/62-hygiene-ack', 'release/2.8.0', 'a1b2c3d', 'v1.0.0', 'feat/café']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  it('rejects control characters and the empty string', () => {
    expect(isSafeRevisionToken('')).toBe(false)
    expect(isSafeRevisionToken(`feat${String.fromCharCode(10)}main`)).toBe(false)
    expect(isSafeRevisionToken(`feat${String.fromCharCode(0)}main`)).toBe(false)
    expect(isSafeRevisionToken('feat main')).toBe(true)
  })
})

const GIT_TEST_TIMEOUT = 30_000

describe.skipIf(!GIT)('lib/git — getRangePaths', () => {
  function seedRange(): void {
    writeFileSync(join(main, 'renamed-me.txt'), 'content line for rename detection\n')
    writeFileSync(join(main, 'deleted-me.txt'), 'gone\n')
    git(main, ['add', '-A'])
    git(main, ['commit', '-qm', 'base'])
    git(main, ['checkout', '-qb', 'feat'])
    git(main, ['mv', 'renamed-me.txt', 'now-named.txt'])
    git(main, ['rm', '-q', 'deleted-me.txt'])
    writeFileSync(join(main, 'added.txt'), 'new\n')
    git(main, ['add', '-A'])
    git(main, ['commit', '-qm', 'work'])
    git(main, ['checkout', '-q', '-'])
  }

  function paths(r: ReturnType<typeof getRangePaths>): string[] {
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
    return r.paths
  }

  it('omits deleted paths — there is nothing left to sweep', () => {
    seedRange()
    const p = paths(getRangePaths(main, 'HEAD', 'feat'))
    expect(p).not.toContain('deleted-me.txt')
    expect(p).toContain('added.txt')
  }, GIT_TEST_TIMEOUT)

  it('reports only the NEW side of a rename, even under diff.renames=false', () => {
    seedRange()
    git(main, ['config', 'diff.renames', 'false'])
    const p = paths(getRangePaths(main, 'HEAD', 'feat'))
    expect(p).toContain('now-named.txt')
    expect(p).not.toContain('renamed-me.txt')
  }, GIT_TEST_TIMEOUT)

  it('never invokes git with an option-shaped revision', () => {
    seedRange()
    const r = getRangePaths(main, `--output=${join(main, 'PWNED')}`, 'feat')
    expect(r.status).toBe('unsafe_revision')
    expect(existsSync(join(main, 'PWNED...feat'))).toBe(false)
  }, GIT_TEST_TIMEOUT)

  it('distinguishes a REJECTED revision from an UNREADABLE range', () => {
    seedRange()
    const rejected = getRangePaths(main, 'HEAD', '--output=X')
    const unreadable = getRangePaths(main, 'HEAD', 'no-such-branch')
    expect(rejected.status).toBe('unsafe_revision')
    expect(unreadable.status).toBe('unavailable')
  }, GIT_TEST_TIMEOUT)

  it('an empty range is ok+[], never conflated with an unreadable one', () => {
    seedRange()
    expect(getRangePaths(main, 'HEAD', 'HEAD')).toEqual({ status: 'ok', paths: [] })
    expect(getRangePaths(main, 'HEAD', 'no-such-branch')).toEqual({ status: 'unavailable' })
    expect(getRangePaths(mkdtempSync(join(tmpdir(), 'rsct-nogit-')), 'HEAD', 'feat').status).toBe(
      'unavailable',
    )
  }, GIT_TEST_TIMEOUT)
})

describe('lib/git — mutating helpers guard their operands', () => {
  const PUSH_DEFAULTS = { submodules: 'no' as const, pushOptions: [] }
  const seen: string[][] = []
  const spy: GitExecutor = (_root, args) => {
    seen.push(args)
    return { ok: true, stdout: 'aaaa111', stderr: '', exitCode: 0 }
  }
  beforeEach(() => { seen.length = 0 })
  const lastOf = (verb: string): string[] | undefined =>
    [...seen].reverse().find((a) => a[0] === verb)

  it('gitPush puts -- BEFORE the remote', () => {
    gitPush('/tmp/x', 'origin', 'main', spy, PUSH_DEFAULTS)
    expect(seen.at(-1)).toEqual(['-c', 'push.pushOption=', 'push', '--no-follow-tags', '--recurse-submodules=no', '--', 'origin', 'main'])
  })

  it('gitPush sends the submodule mode and exactly the push options it is given, all before --', () => {
    gitPush('/tmp/x', 'origin', 'main', spy, { submodules: 'check', pushOptions: ['ci.skip', '-x'] })
    expect(seen.at(-1)).toEqual([
      '-c', 'push.pushOption=', 'push', '--no-follow-tags', '--recurse-submodules=check',
      '--push-option=ci.skip', '--push-option=-x', '--', 'origin', 'main',
    ])
  })

  it('gitMerge puts -- after its flags and before the branch', () => {
    gitMerge('/tmp/x', 'feat/x', { no_ff: true, allow_unrelated_histories: false }, spy)
    expect(lastOf('merge')).toEqual(['merge', '--no-ff', '--', 'feat/x'])
  })

  it('gitRebase puts -- before the upstream', () => {
    gitRebase('/tmp/x', 'main', spy)
    expect(lastOf('rebase')).toEqual(['rebase', '--', 'main'])
  })

  it('gitSquash puts -- before the source branch', () => {
    gitSquash('/tmp/x', 'feat/x', spy)
    expect(lastOf('merge')).toEqual(['merge', '--squash', '--', 'feat/x'])
  })

  it.each([
    ['gitPush/remote', () => gitPush('/tmp/x', '--exec=/tmp/pwn.sh', 'main', spy, PUSH_DEFAULTS)],
    ['gitPush/branch', () => gitPush('/tmp/x', 'origin', '--exec=/tmp/pwn.sh', spy, PUSH_DEFAULTS)],
    ['gitRebase', () => gitRebase('/tmp/x', '--exec=/tmp/pwn.sh', spy)],
    ['gitMerge', () => gitMerge('/tmp/x', '--exec=/tmp/pwn.sh', { no_ff: true, allow_unrelated_histories: false }, spy)],
    ['gitSquash', () => gitSquash('/tmp/x', '--exec=/tmp/pwn.sh', spy)],
  ])('%s refuses an option-shaped operand WITHOUT invoking git', (_label, call) => {
    const r = call()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not a safe operand')
    expect(seen).toEqual([])
  })

  it('VACUITY: ordinary operands still reach git', () => {
    expect(gitPush('/tmp/x', 'origin', 'release/2.0', spy, PUSH_DEFAULTS).ok).toBe(true)
    expect(gitRebase('/tmp/x', 'origin/main', spy).ok).toBe(true)
    expect(gitMerge('/tmp/x', 'feat/café', { no_ff: false, allow_unrelated_histories: false }, spy).ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
  })
})

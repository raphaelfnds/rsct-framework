import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorktreeInfo, getRangePaths, isSafeRevisionToken } from '../../src/lib/git.js'

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

// #62 — the paths an integration CARRIES, for the pre_merge_ack cross-check.
describe('lib/git — isSafeRevisionToken (injection guard)', () => {
  // Breaks on: deleting the `rev.startsWith('-')` clause in isSafeRevisionToken.
  // That clause is the whole security guard. Measured on git 2.45.1, real argv:
  // `git diff --name-only -z --diff-filter=d "--output=SIDEEFFECT...HEAD"` exits
  // 0 and CREATES the file. Because the ack runs BEFORE gateRequest, that write
  // happens with no OS dialog shown and no dev_approval validated.
  it('rejects a revision that git would read as an OPTION', () => {
    for (const bad of ['--output=X', '-M', '--ext-diff', '--textconv', '--stat', '-']) {
      expect(isSafeRevisionToken(bad), bad).toBe(false)
    }
  })

  // Breaks on: RE-ADDING a `~` / `^` / `@{` rejection. An earlier draft of this
  // predicate had exactly that, and a 30-token battery against real git refuted
  // it: all of these RESOLVE, and `git rebase HEAD~3` is a canonical call. Since
  // merge and rebase fail CLOSED on an unreadable range, a false reject here is a
  // hard stop on a legitimate integration — raised before any dialog, with no
  // override path. Over-restriction is the expensive error, not the safe one.
  it('accepts the revision EXPRESSIONS a real rebase target uses', () => {
    for (const ok of ['HEAD~3', 'HEAD^', 'HEAD^1', 'HEAD@{0}', '@']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  // Breaks on: RE-ADDING a ':' or '..' rejection. Measured: `feat:main`,
  // `main..feat`, `+feat`, `feat.lock` and `feat/` all exit 128 with no side
  // effect, so the `unavailable` path already handles them. Rejecting them here
  // buys nothing and would pretend this is a refspec guard — a different control,
  // at a different layer, tracked in its own issue.
  it('leaves non-resolving shapes to git instead of posing as a refspec guard', () => {
    for (const ok of ['feat:main', 'main..feat', '+feat', 'feat.lock', 'feat/']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  // Breaks on: replacing the deny-list with an /^[A-Za-z0-9._/-]+$/ allow-list.
  // A false reject here is not cosmetic — under the fail-closed posture it
  // BLOCKS a legitimate merge of a branch whose name is not ASCII.
  it('accepts the revision shapes real branches actually use', () => {
    for (const ok of ['HEAD', 'main', 'origin/main', 'refs/heads/main', 'feat/62-hygiene-ack', 'release/2.8.0', 'a1b2c3d', 'v1.0.0', 'feat/café']) {
      expect(isSafeRevisionToken(ok), ok).toBe(true)
    }
  })

  // Breaks on: dropping the control-character clause. A NUL makes Node's
  // execFileSync throw rather than return; a newline would split the JSONL audit
  // record that echoes the rejected revision back.
  it('rejects control characters and the empty string', () => {
    expect(isSafeRevisionToken('')).toBe(false)
    expect(isSafeRevisionToken(`feat${String.fromCharCode(10)}main`)).toBe(false)
    expect(isSafeRevisionToken(`feat${String.fromCharCode(0)}main`)).toBe(false)
    // A space is NOT a control character and is deliberately accepted here —
    // measured, `a b` exits 128 with no side effect, so git rejects it for us.
    expect(isSafeRevisionToken('feat main')).toBe(true)
  })
})

describe.skipIf(!GIT)('lib/git — getRangePaths', () => {
  /** Build `base` -> `head` with one rename, one deletion and one addition. */
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

  /** Narrow to the ok-branch, failing loudly instead of silently skipping. */
  function paths(r: ReturnType<typeof getRangePaths>): string[] {
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
    return r.paths
  }

  // Breaks on: dropping `--diff-filter=d` from the argv in getRangePaths.
  // `--name-only` lists deletions by default, and asking the agent to sweep a
  // file the integration REMOVES is an unsatisfiable demand.
  it('omits deleted paths — there is nothing left to sweep', () => {
    seedRange()
    const p = paths(getRangePaths(main, 'HEAD', 'feat'))
    expect(p).not.toContain('deleted-me.txt')
    expect(p).toContain('added.txt')
  })

  // Breaks on: dropping `--diff-filter=d` (the SAME flag, a second reason it is
  // load-bearing). Measured: under diff.renames=false git reports the old side
  // of a rename as a DELETION, so without the filter the range carries
  // `renamed-me.txt`, which does not exist at head. An explicit `-M` was tried
  // and removed — it produced byte-identical output, so it proved nothing.
  it('reports only the NEW side of a rename, even under diff.renames=false', () => {
    seedRange()
    git(main, ['config', 'diff.renames', 'false'])
    const p = paths(getRangePaths(main, 'HEAD', 'feat'))
    expect(p).toContain('now-named.txt')
    expect(p).not.toContain('renamed-me.txt')
  })

  // Breaks on: removing the isSafeRevisionToken loop from getRangePaths.
  // Without it this exact call writes a file into the repo (measured, git 2.45.1).
  it('never invokes git with an option-shaped revision', () => {
    seedRange()
    const r = getRangePaths(main, `--output=${join(main, 'PWNED')}`, 'feat')
    expect(r.status).toBe('unsafe_revision')
    expect(existsSync(join(main, 'PWNED...feat'))).toBe(false)
  })

  // Breaks on: collapsing 'unsafe_revision' and 'unavailable' into one status
  // (e.g. returning { status: 'unavailable' } from the guard). Merge and rebase
  // fail CLOSED on an unreadable range, so without this distinction a crafted
  // ref and an unfetched remote branch produce the same audit record.
  it('distinguishes a REJECTED revision from an UNREADABLE range', () => {
    seedRange()
    const rejected = getRangePaths(main, 'HEAD', '--output=X')
    const unreadable = getRangePaths(main, 'HEAD', 'no-such-branch')
    expect(rejected.status).toBe('unsafe_revision')
    expect(unreadable.status).toBe('unavailable')
  })

  // Breaks on: returning { status: 'ok', paths: [] } from the `raw === null`
  // branch of getRangePaths. The three tools branch on the status to pick their
  // degraded/fail-closed posture; an ok-with-nothing would be indistinguishable
  // from "this range carries nothing" and would silently disable the
  // cross-check. `no-such-branch` is the case that reaches that branch — a
  // non-git directory returns earlier, at the isGitRepo guard, so asserting only
  // that one would leave `raw === null` untested (the first draft of this test
  // did exactly that, and the mutation harness caught it).
  it('an empty range is ok+[], never conflated with an unreadable one', () => {
    seedRange()
    expect(getRangePaths(main, 'HEAD', 'HEAD')).toEqual({ status: 'ok', paths: [] })
    expect(getRangePaths(main, 'HEAD', 'no-such-branch')).toEqual({ status: 'unavailable' })
    expect(getRangePaths(mkdtempSync(join(tmpdir(), 'rsct-nogit-')), 'HEAD', 'feat').status).toBe(
      'unavailable',
    )
  })
})


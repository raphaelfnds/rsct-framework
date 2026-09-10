import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveRepositoryAnchor, sameDirectory, LOCAL_ANCHORS, canonicalPath } from '../../src/lib/repo-anchor.js'
import { phaseStatePath } from '../../src/lib/phase-scope.js'

/**
 * #92 — the shared anchors must resolve at the repository the mutation lands
 * in, not at the string the caller supplied.
 *
 * Every case below was MEASURED against real git before the module existed, and
 * two of them are the reason the derivation is conditional rather than a
 * one-liner: a linked worktree and a submodule disagree about which single git
 * command gives the right answer.
 */

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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t.t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# app\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'init'])
}

let box: string

beforeEach(() => {
  box = canonicalPath(mkdtempSync(join(tmpdir(), 'rsct-anchor-')))
})
afterEach(() => {
  if (existsSync(box)) rmSync(box, { recursive: true, force: true })
})

describe.runIf(GIT)('resolveRepositoryAnchor — the four derivation cases', () => {
  it('plain repo: the declared root IS the anchor root', () => {
    // Mutation that reddens: make the derivation always return `relocated`.
    const repo = join(box, 'repo')
    initRepo(repo)
    const a = resolveRepositoryAnchor(repo)
    expect(a.status).toBe('same')
    expect(sameDirectory(a.root, repo)).toBe(true)
    expect(a.detail).toBeNull()
  })

  it('crafted subdirectory: resolves BACK to the repository, which is the defect', () => {
    // Mutation that reddens: return the declared root instead of the toplevel.
    const repo = join(box, 'repo')
    initRepo(repo)
    const crafted = join(repo, 'docs', 'scratch')
    mkdirSync(crafted, { recursive: true })

    const a = resolveRepositoryAnchor(crafted)
    expect(a.status).toBe('relocated')
    expect(sameDirectory(a.root, repo)).toBe(true)
    // The relocation must be SAYABLE — a silent move is the surprise D1 forbids.
    expect(a.detail).toContain('repository this action lands in')
  })

  it('linked worktree: resolves to the MAIN worktree, so the ceiling survives `git worktree add`', () => {
    // Mutation that reddens: use `--show-toplevel` for the worktree branch too.
    const main = join(box, 'main')
    initRepo(main)
    const wt = join(box, 'wt')
    git(main, ['worktree', 'add', '-q', '-b', 'feat/x', wt])

    const a = resolveRepositoryAnchor(wt)
    expect(a.status).toBe('relocated')
    expect(sameDirectory(a.root, main)).toBe(true)
  })

  it('submodule: resolves to its own working root, NEVER under .git/modules', () => {
    // Mutation that reddens: use `dirname(--git-common-dir)`, which lands
    // inside `.git/modules/<path>` — measured, and invisible to the developer.
    const child = join(box, 'child')
    initRepo(child)
    const parent = join(box, 'parent')
    initRepo(parent)
    try {
      git(parent, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        child.replace(/\\/g, '/'),
        'vendor/child',
      ])
    } catch {
      return // environment forbids file-protocol submodules; nothing to assert
    }
    const sub = join(parent, 'vendor', 'child')
    if (!existsSync(sub)) return

    const a = resolveRepositoryAnchor(sub)
    expect(a.root.replace(/\\/g, '/')).not.toContain('/.git/')
    expect(sameDirectory(a.root, sub)).toBe(true)
    expect(a.status).toBe('same')
  })

  it('monorepo package: relocates to the repository root and says so', () => {
    // Mutation that reddens: drop the relocation detail from the result.
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(pkg, { recursive: true })

    const a = resolveRepositoryAnchor(pkg)
    expect(a.status).toBe('relocated')
    expect(sameDirectory(a.root, repo)).toBe(true)
    expect(a.detail).not.toBeNull()
  })

  it('five legitimate spellings of one root all compare equal', () => {
    // Mutation that reddens: drop `resolve`, or drop the trailing-separator
    // strip. MEASURED baseline: a naive `===` passes only 2 of these 5, so a
    // test that passed before the fix would be vacuous.
    const repo = join(box, 'repo')
    initRepo(repo)
    const abs = resolve(repo)
    const forms = [
      abs,
      abs + sep,
      abs.replace(/\\/g, '/'),
      abs.charAt(0).toLowerCase() + abs.slice(1),
      join(abs, '.', '.'),
    ]
    for (const form of forms) {
      expect(resolveRepositoryAnchor(form).status, `spelling: ${form}`).toBe('same')
    }
  })
})

describe('resolveRepositoryAnchor — degraded paths never brick', () => {
  it('a directory that is not a git repository is not-applicable, never a failure', () => {
    // Mutation that reddens: treat a missing identity as `unavailable` and let
    // a caller fail closed on it.
    const plain = join(box, 'plain')
    mkdirSync(plain, { recursive: true })

    const a = resolveRepositoryAnchor(plain, {
      worktreeInfo: () => ({ in_git_repo: false, is_worktree: false, toplevel: null, name: null }),
    })
    expect(a.status).toBe('not-applicable')
    expect(sameDirectory(a.root, plain)).toBe(true)
    expect(a.detail).toContain('not a git repository')
  })

  it('git present but unable to answer is UNAVAILABLE — a capability failure, not tampering', () => {
    // Mutation that reddens: return `relocated` (or throw) when the identity
    // read fails. That is the shape that would brick every commit on a git too
    // old for the command, which is why capability and tampering are separated.
    const repo = join(box, 'repo')
    mkdirSync(repo, { recursive: true })

    const a = resolveRepositoryAnchor(repo, {
      gitRead: () => null,
      worktreeInfo: () => ({ in_git_repo: true, is_worktree: false, toplevel: repo, name: null }),
    })
    expect(a.status).toBe('unavailable')
    expect(sameDirectory(a.root, repo)).toBe(true)
    expect(a.detail).toContain('not enforced')
  })

  it('a repository with no usable working root degrades instead of throwing', () => {
    // Mutation that reddens: return `resolve(null)` and let it throw.
    const repo = join(box, 'repo')
    mkdirSync(repo, { recursive: true })

    const a = resolveRepositoryAnchor(repo, {
      gitRead: (_cwd, args) => (args[1] === '--git-common-dir' ? '.git' : null),
      worktreeInfo: () => ({ in_git_repo: true, is_worktree: false, toplevel: null, name: null }),
    })
    expect(a.status).toBe('unavailable')
    expect(a.identity).not.toBeNull()
  })
})

describe.runIf(GIT)('D2 is pinned — the per-checkout anchors must NOT follow the repository', () => {
  it('phase-state stays at the DECLARED root even when the log relocates', () => {
    // Mutation that reddens: make `phaseStatePath` use `anchorFor(root).root`.
    //
    // This test exists because the Rv sweep found `LOCAL_ANCHORS` was dead — an
    // exported list that READ as authoritative and that nothing consulted — and
    // that the decision it described was pinned by nothing at all. Relocating
    // phase-state would put two parallel worktrees on one advisory lock, and
    // MEASURED, that lock does not wait or retry: the second writer is refused
    // outright. D2 kept it local precisely to avoid that, on the very flow the
    // framework recommends for complex work.
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(pkg, { recursive: true })

    // Precondition: this IS a relocating shape, or the assertion is vacuous.
    expect(resolveRepositoryAnchor(pkg).status).toBe('relocated')

    expect(LOCAL_ANCHORS).toContain('phase-state.json')
    expect(sameDirectory(dirname(phaseStatePath(pkg)), join(pkg, '.rsct'))).toBe(true)
    expect(sameDirectory(dirname(phaseStatePath(pkg)), join(repo, '.rsct'))).toBe(false)
  })

  it('every name in LOCAL_ANCHORS is one the code actually keeps local', () => {
    // Mutation that reddens: add 'audit.log' to LOCAL_ANCHORS. The list must
    // describe the code, not aspire to it — a constant that drifts from what it
    // documents is worse than no constant, because it reads as enforcement.
    expect([...LOCAL_ANCHORS].sort()).toEqual(
      ['phase-state.json', 'phase-state.lock', 'scripts'].sort(),
    )
  })
})

describe('canonicalPath — the class that broke 4 of 6 CI cells', () => {
  it('resolves a path whose TAIL does not exist yet', () => {
    // Mutation that reddens: call realpathSync on the full path and return the
    // input when it throws. A containment candidate (an `audit.path` target)
    // usually does not exist yet, and without the ancestor walk it would keep
    // the caller's spelling while the base kept the canonical one — the two
    // sides of one comparison canonicalized differently.
    const target = join(box, 'does-not-exist', 'a.log')
    expect(canonicalPath(target)).toBe(join(canonicalPath(box), 'does-not-exist', 'a.log'))
  })

  it('two spellings of one non-existent path compare equal', () => {
    // Mutation that reddens: drop canonicalPath from `comparable`.
    expect(sameDirectory(join(box, 'x', 'y'), join(box, '.', 'x', 'y'))).toBe(true)
  })

  it('a SYMLINKED directory compares equal to its target', () => {
    // This is the macOS CI failure in portable form: `/var` is a symlink to
    // `/private/var`, so `tmpdir()` and git disagreed about the same directory
    // and every anchor test read `relocated`. Windows needs privileges for
    // directory symlinks, so a refusal here is skipped rather than failed.
    const target = join(box, 'real')
    const link = join(box, 'link')
    mkdirSync(target, { recursive: true })
    try {
      symlinkSync(target, link, 'junction')
    } catch {
      return
    }
    expect(sameDirectory(link, target)).toBe(true)
  })
})

describe('sameDirectory', () => {
  it('distinguishes genuinely different directories', () => {
    // Mutation that reddens: compare only the basename.
    expect(sameDirectory(join(box, 'a'), join(box, 'b'))).toBe(false)
  })

  it('treats a trailing separator and a mixed separator as the same path', () => {
    // Mutation that reddens: drop the trailing-separator strip.
    const p = join(box, 'a', 'b')
    expect(sameDirectory(p, p + sep)).toBe(true)
    expect(sameDirectory(p, p.replace(/\\/g, '/'))).toBe(true)
  })
})

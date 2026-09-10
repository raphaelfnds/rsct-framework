import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decideAuditPath,
  resolveAuditPath,
  clearAuditMigrationMemo,
} from '../../src/lib/audit-log.js'
import { clearAnchorCache, sameDirectory, canonicalPath } from '../../src/lib/repo-anchor.js'
import { sanitize } from '../../src/scripts/sanitize-permissions.js'

/**
 * #92 — the audit log is the anti-rollback anchor, so where it resolves decides
 * whether a crafted `project_root` can present a blank history for commits that
 * land in the real repository.
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

const LOCKED = JSON.stringify({
  ts: '2026-01-01T00:00:00.000Z',
  event: 'free_commit.locked',
  plan_slug: 'alpha',
  reason: 'commit_cap',
})

let box: string

beforeEach(() => {
  box = canonicalPath(mkdtempSync(join(tmpdir(), 'rsct-auditanchor-')))
  clearAnchorCache()
  clearAuditMigrationMemo()
})
afterEach(() => {
  clearAnchorCache()
  clearAuditMigrationMemo()
  if (existsSync(box)) rmSync(box, { recursive: true, force: true })
})

describe.runIf(GIT)('the log resolves at the repository, not at the declared root', () => {
  it('a crafted subdirectory resolves to the PARENT repository', () => {
    // Mutation that reddens: base the default path on `projectRoot` again.
    const repo = join(box, 'repo')
    initRepo(repo)
    const crafted = join(repo, 'docs', 'scratch')
    mkdirSync(crafted, { recursive: true })

    const d = decideAuditPath(crafted)
    expect(sameDirectory(d.base, repo)).toBe(true)
    expect(d.path).toBe(join(repo, '.rsct', 'audit.log'))
    expect(d.anchor).toBe('relocated')
  })

  it('a plain repo is unchanged — the common case must not move', () => {
    // Mutation that reddens: always relocate to the parent directory.
    const repo = join(box, 'repo')
    initRepo(repo)
    expect(resolveAuditPath(repo)).toBe(join(repo, '.rsct', 'audit.log'))
    expect(decideAuditPath(repo).anchor).toBe('same')
  })

  it('a directory with no git keeps the log where it is', () => {
    // Mutation that reddens: treat a missing identity as a relocation.
    const plain = join(box, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(resolveAuditPath(plain)).toBe(join(plain, '.rsct', 'audit.log'))
    expect(decideAuditPath(plain).anchor).toBe('not-applicable')
  })
})

describe.runIf(GIT)('audit.path containment', () => {
  it('an absolute path OUTSIDE the base is refused and falls back', () => {
    // Mutation that reddens: honour the configured path unconditionally. This
    // is the escape that survives the root binding untouched — MEASURED, it
    // relocates both free-lane anchors from the CORRECT root.
    const repo = join(box, 'repo')
    initRepo(repo)
    const outside = join(box, 'elsewhere', 'audit.log')

    const d = decideAuditPath(repo, { path: outside })
    expect(d.escaped).not.toBeNull()
    expect(d.path).toBe(join(repo, '.rsct', 'audit.log'))
  })

  it('a path INSIDE the base is honoured', () => {
    // Mutation that reddens: refuse every configured path.
    const repo = join(box, 'repo')
    initRepo(repo)
    const d = decideAuditPath(repo, { path: 'logs/rsct.log' })
    expect(d.escaped).toBeNull()
    expect(d.path).toBe(join(repo, 'logs', 'rsct.log'))
  })

  it('containment uses the anchor normalization, not a raw prefix', () => {
    // Mutation that reddens: replace `isInside` with `candidate.startsWith(base)`.
    // A sibling whose name merely EXTENDS the base would then read as inside.
    const repo = join(box, 'repo')
    initRepo(repo)
    const sibling = repo + '-evil'
    mkdirSync(sibling, { recursive: true })

    const d = decideAuditPath(repo, { path: join(sibling, 'audit.log') })
    expect(d.escaped).not.toBeNull()
  })
})

describe.runIf(GIT)('AUDIT-1 — the SessionStart hook and the reader agree on the log', () => {
  it("the sanitizer's settings.baseline lands where request-commit reads it, in a RELOCATED project", () => {
    // Mutation that reddens: give `resolveAuditLogPath` its own copy of the path
    // logic again (it had one, justified by "audit-log reaches zod" — measured
    // false today: the whole runtime chain is node builtins, and the bundle has
    // zero `zod` occurrences). Two copies would be a second way for this hook
    // and the reader to disagree about WHERE the log is, and the old docstring
    // named the consequence: "the drift report is silently dead".
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.claude'), { recursive: true })
    writeFileSync(
      join(pkg, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git commit:*)'] } }, null, 2),
    )

    sanitize(pkg, { now: new Date('2026-09-10T12:00:00.000Z') })

    // The reader resolves the log at the repository; the hook must have written
    // its baseline into that same file, not into the package directory.
    const readerPath = decideAuditPath(pkg).path
    expect(readerPath).toBe(join(repo, '.rsct', 'audit.log'))
    expect(readFileSync(readerPath, 'utf8')).toContain('settings.baseline')
    expect(existsSync(join(pkg, '.rsct', 'audit.log'))).toBe(false)
  })
})

describe.runIf(GIT)('AUDIT-2 — an existing install keeps its history across the upgrade', () => {
  it('a legacy log at the old location is migrated, and the migration is audited', () => {
    // Mutation that reddens: skip the migration. The ceiling would reset to 0
    // and a locked budget would silently unlock on the first run after upgrade.
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    writeFileSync(join(pkg, '.rsct', 'audit.log'), LOCKED + '\n')

    const target = decideAuditPath(pkg).path
    expect(target).toBe(join(repo, '.rsct', 'audit.log'))

    const carried = readFileSync(target, 'utf8')
    expect(carried).toContain('free_commit.locked')
    expect(carried).toContain('audit_log.migrated')
  })

  it('the legacy file is COPIED, never moved — a half-done migration cannot destroy the only copy', () => {
    // Mutation that reddens: use renameSync instead of copyFileSync.
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    const legacy = join(pkg, '.rsct', 'audit.log')
    writeFileSync(legacy, LOCKED + '\n')

    decideAuditPath(pkg)
    expect(existsSync(legacy)).toBe(true)
  })

  it('when BOTH logs exist the migration is skipped — merging would double-count the ceiling', () => {
    // Mutation that reddens: append the legacy file to the existing target.
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    mkdirSync(join(repo, '.rsct'), { recursive: true })
    writeFileSync(join(pkg, '.rsct', 'audit.log'), LOCKED + '\n')
    writeFileSync(join(repo, '.rsct', 'audit.log'), '{"event":"already.here"}\n')

    const target = decideAuditPath(pkg).path
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('already.here')
    expect(content).not.toContain('free_commit.locked')
    expect(content).not.toContain('audit_log.migrated')
  })

  it('nothing is migrated when the root and the repository already agree', () => {
    // Mutation that reddens: drop the `sameDirectory` guard, so a plain repo
    // would rewrite its own log through the migration path on every process.
    const repo = join(box, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, '.rsct'), { recursive: true })
    writeFileSync(join(repo, '.rsct', 'audit.log'), LOCKED + '\n')

    decideAuditPath(repo)
    expect(readFileSync(join(repo, '.rsct', 'audit.log'), 'utf8')).not.toContain(
      'audit_log.migrated',
    )
  })
})

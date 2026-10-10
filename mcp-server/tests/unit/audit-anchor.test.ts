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
import { resolveProjectRoot } from '../../src/lib/project-root.js'
import { sanitize } from '../../src/lib/sanitize-permissions.js'

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

const LEGACY_LINE = JSON.stringify({
  ts: '2026-01-01T00:00:00.000Z',
  event: 'classify.verdict',
  tier: 'small',
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
    const repo = join(box, 'repo')
    initRepo(repo)
    expect(resolveAuditPath(repo)).toBe(join(repo, '.rsct', 'audit.log'))
    expect(decideAuditPath(repo).anchor).toBe('same')
  })

  it('a directory with no git keeps the log where it is', () => {
    const plain = join(box, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(resolveAuditPath(plain)).toBe(join(plain, '.rsct', 'audit.log'))
    expect(decideAuditPath(plain).anchor).toBe('not-applicable')
  })
})

describe.runIf(GIT)('audit.path containment', () => {
  it('an absolute path OUTSIDE the base is refused and falls back', () => {
    const repo = join(box, 'repo')
    initRepo(repo)
    const outside = join(box, 'elsewhere', 'audit.log')

    const d = decideAuditPath(repo, { path: outside })
    expect(d.escaped).not.toBeNull()
    expect(d.path).toBe(join(repo, '.rsct', 'audit.log'))
  })

  it('a path INSIDE the base is honoured', () => {
    const repo = join(box, 'repo')
    initRepo(repo)
    const d = decideAuditPath(repo, { path: 'logs/rsct.log' })
    expect(d.escaped).toBeNull()
    expect(d.path).toBe(join(repo, 'logs', 'rsct.log'))
  })

  it('containment uses the anchor normalization, not a raw prefix', () => {
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
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.claude'), { recursive: true })
    writeFileSync(
      join(pkg, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git commit:*)'] } }, null, 2),
    )

    sanitize(pkg, { now: new Date('2026-09-10T12:00:00.000Z') })

    const readerPath = decideAuditPath(pkg).path
    expect(readerPath).toBe(join(repo, '.rsct', 'audit.log'))
    expect(readFileSync(readerPath, 'utf8')).toContain('settings.baseline')
    expect(existsSync(join(pkg, '.rsct', 'audit.log'))).toBe(false)
  })
})

describe.runIf(GIT)('AUDIT-2 — an existing install keeps its history across the upgrade', () => {
  it('a legacy log at the old location is migrated, and the migration is audited', () => {
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    writeFileSync(join(pkg, '.rsct', 'audit.log'), LEGACY_LINE + '\n')

    const target = decideAuditPath(pkg).path
    expect(target).toBe(join(repo, '.rsct', 'audit.log'))

    const carried = readFileSync(target, 'utf8')
    expect(carried).toContain('classify.verdict')
    expect(carried).toContain('audit_log.migrated')
  })

  it('the legacy file is COPIED, never moved — a half-done migration cannot destroy the only copy', () => {
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    const legacy = join(pkg, '.rsct', 'audit.log')
    writeFileSync(legacy, LEGACY_LINE + '\n')

    decideAuditPath(pkg)
    expect(existsSync(legacy)).toBe(true)
  })

  it('when BOTH logs exist the migration is skipped — merging would double-count the ceiling', () => {
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    mkdirSync(join(repo, '.rsct'), { recursive: true })
    writeFileSync(join(pkg, '.rsct', 'audit.log'), LEGACY_LINE + '\n')
    writeFileSync(join(repo, '.rsct', 'audit.log'), '{"event":"already.here"}\n')

    const target = decideAuditPath(pkg).path
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('already.here')
    expect(content).not.toContain('classify.verdict')
    expect(content).not.toContain('audit_log.migrated')
  })

  it('nothing is migrated when the root and the repository already agree', () => {
    const repo = join(box, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, '.rsct'), { recursive: true })
    writeFileSync(join(repo, '.rsct', 'audit.log'), LEGACY_LINE + '\n')

    decideAuditPath(repo)
    expect(readFileSync(join(repo, '.rsct', 'audit.log'), 'utf8')).not.toContain(
      'audit_log.migrated',
    )
  })
})

describe.runIf(GIT)('a rejected config in a relocating package is recorded once per hour (#93)', () => {
  it('dedups against the repository log it writes to, not the package folder', () => {
    const repo = join(box, 'mono')
    initRepo(repo)
    const pkg = join(repo, 'packages', 'app')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, '.rsct.json'), '{ not valid json')

    expect(resolveProjectRoot(pkg).rsct_installed).toBe(false)
    expect(resolveProjectRoot(pkg).rsct_installed).toBe(false)

    const recorded = readFileSync(join(repo, '.rsct', 'audit.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"rsct_json.malformed"'))
    expect(recorded).toHaveLength(1)
    expect(existsSync(join(pkg, '.rsct', 'audit.log'))).toBe(false)
  })
})

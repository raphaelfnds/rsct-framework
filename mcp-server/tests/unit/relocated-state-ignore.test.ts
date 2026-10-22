import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SHARED_ANCHORS,
  SHARED_STATE_IGNORE,
  LOCAL_ANCHORS,
  canonicalPath,
  clearAnchorCache,
  protectRelocatedState,
  anchorFor,
} from '../../src/lib/repo-anchor.js'
import { appendAuditEntry, clearAuditMigrationMemo, decideAuditPath, resolveAuditPath } from '../../src/lib/audit-log.js'
import { recordConsumedApproval } from '../../src/lib/dev-approval.js'
import { sanitize } from '../../src/lib/sanitize-permissions.js'
import { pruneAuditLog } from '../../src/lib/audit-retention.js'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const GIT = hasGit()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t.t'])
  git(dir, ['config', 'user.name', 't'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.hooksPath', '.no-hooks'])
  writeFileSync(join(dir, 'README.md'), '# app\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'init'])
}

let box: string
let root: string
let pkg: string

beforeEach(() => {
  box = canonicalPath(mkdtempSync(join(tmpdir(), 'rsct-shared-ignore-')))
  root = join(box, 'mono')
  pkg = join(root, 'packages', 'api')
  clearAnchorCache()
  clearAuditMigrationMemo()
})
afterEach(() => {
  clearAnchorCache()
  clearAuditMigrationMemo()
  if (existsSync(box)) rmSync(box, { recursive: true, force: true })
})

const ignoreAt = (dir: string) => join(dir, '.rsct', '.gitignore')
const porcelain = (dir: string) => git(dir, ['status', '--porcelain', '--untracked-files=all'])

function monorepo(): void {
  initRepo(root)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, '.rsct.json'), '{}\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'pkg'])
}

describe.skipIf(!GIT)('the ignore file at a relocated anchor (#82, #92)', () => {
  it('lists every shared file and itself, never a wildcard', () => {
    expect(SHARED_STATE_IGNORE).toBe(`${[...SHARED_ANCHORS, '.gitignore'].join('\n')}\n`)
    expect(SHARED_STATE_IGNORE.split('\n')).not.toContain('*')
    for (const local of LOCAL_ANCHORS) expect(SHARED_STATE_IGNORE.split('\n')).not.toContain(local)
  })

  it('an audit append in a monorepo package writes it at the repository root, and git status stays clean', () => {
    monorepo()
    expect(anchorFor(pkg).status).toBe('relocated')
    const result = appendAuditEntry(pkg, { event: 'test.entry' })
    expect(result.ok).toBe(true)
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
    expect(existsSync(join(root, '.rsct', 'audit.log'))).toBe(true)
    expect(porcelain(root), porcelain(root)).toBe('')
  })

  it('a consumed approval writes it too, and the store and the log stay out of git', () => {
    monorepo()
    const record = recordConsumedApproval(
      { action_scope: 'commit', timestamp: new Date().toISOString(), dev_confirmation: 'ok', channel: 'trust' } as never,
      { projectRoot: pkg },
    )
    expect(record.ok, JSON.stringify(record)).toBe(true)
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
    expect(existsSync(join(root, '.rsct', 'approvals-seen.json'))).toBe(true)
    expect(porcelain(root), porcelain(root)).toBe('')
  })

  it('the first read that copies an old project log forward writes it with the copy', () => {
    monorepo()
    mkdirSync(join(pkg, '.rsct'), { recursive: true })
    writeFileSync(join(pkg, '.rsct', 'audit.log'), '{"event":"old"}\n')
    decideAuditPath(pkg)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain('"old"')
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
    expect(git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.rsct'])).toBe('')
  })

  it('a read with nothing to copy creates no folder and no file', () => {
    monorepo()
    resolveAuditPath(pkg)
    decideAuditPath(pkg)
    anchorFor(pkg)
    expect(existsSync(join(root, '.rsct'))).toBe(false)
  })

  it('writes nothing when the anchor is the project itself', () => {
    initRepo(root)
    expect(anchorFor(root).status).toBe('same')
    expect(appendAuditEntry(root, { event: 'test.entry' }).ok).toBe(true)
    expect(existsSync(ignoreAt(root))).toBe(false)
  })

  it('never replaces an ignore file that is already there', () => {
    monorepo()
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(ignoreAt(root), 'mine\n')
    expect(appendAuditEntry(pkg, { event: 'test.entry' }).ok).toBe(true)
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe('mine\n')
  })

  it('a failure to write it never changes the result of the write it follows', () => {
    monorepo()
    mkdirSync(ignoreAt(root), { recursive: true })
    const result = appendAuditEntry(pkg, { event: 'test.entry' })
    expect(result.ok).toBe(true)
    expect(() => protectRelocatedState(pkg)).not.toThrow()
  })

  it('the approval store write protects it even when the audit line before it failed', () => {
    monorepo()
    mkdirSync(join(root, '.rsct', 'audit.log'), { recursive: true })
    const record = recordConsumedApproval(
      { action_scope: 'commit', timestamp: new Date().toISOString(), dev_confirmation: 'ok', channel: 'trust' } as never,
      { projectRoot: pkg },
    )
    expect(record.ok, JSON.stringify(record)).toBe(true)
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
  })

  it('the audit line of a consumed approval protects it even when the store write fails', () => {
    monorepo()
    mkdirSync(join(root, '.rsct', 'approvals-seen.json'), { recursive: true })
    const record = recordConsumedApproval(
      { action_scope: 'commit', timestamp: new Date().toISOString(), dev_confirmation: 'ok', channel: 'trust' } as never,
      { projectRoot: pkg },
    )
    expect(record.ok).toBe(false)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain('"action_scope":"commit"')
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
  })

  it('a SessionStart sanitizer run writes it with its audit line', () => {
    monorepo()
    mkdirSync(join(pkg, '.claude'), { recursive: true })
    writeFileSync(join(pkg, '.claude', 'settings.json'), '{ "permissions": { "allow": ["Bash(git commit*)"] } }\n')
    const result = sanitize(pkg)
    expect(result.files.some((f) => f.status === 'sanitized')).toBe(true)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain('git commit')
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
  })

  it('a retention pass with no log writes nothing', () => {
    monorepo()
    pruneAuditLog(pkg, undefined, new Date())
    expect(existsSync(join(root, '.rsct'))).toBe(false)
  })

  it('a retention pass over a log an older version left writes it', () => {
    monorepo()
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'audit.log'), '{"ts":"2026-01-01T00:00:00.000Z","event":"old"}\n')
    pruneAuditLog(pkg, undefined, new Date())
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
  })

  it('a linked worktree writes it in the main worktree', () => {
    initRepo(root)
    const linked = join(box, 'linked')
    git(root, ['worktree', 'add', '-q', '-b', 'side', linked])
    clearAnchorCache()
    expect(anchorFor(linked).status).toBe('relocated')
    expect(appendAuditEntry(linked, { event: 'test.entry' }).ok).toBe(true)
    expect(readFileSync(ignoreAt(root), 'utf8')).toBe(SHARED_STATE_IGNORE)
    expect(porcelain(root), porcelain(root)).toBe('')
  })
})

describe('the session-start sanitizer bundle stays free of zod', () => {
  it('dist/scripts/sanitize-permissions.js has no zod and carries the ignore content', () => {
    const bundle = readFileSync(resolve(__dirname, '..', '..', 'dist', 'scripts', 'sanitize-permissions.js'), 'utf8')
    expect(bundle).not.toMatch(/zod|ZodError/)
    expect(bundle).toContain('approvals-seen.json.tmp')
  })
})

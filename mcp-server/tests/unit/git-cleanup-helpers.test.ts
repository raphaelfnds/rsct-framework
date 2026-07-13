import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  gitIsTracked,
  gitBranchMerged,
  gitRebase,
  gitSquash,
  type GitExecutor,
  type GitExecResult,
} from '../../src/lib/git.js'
import { planCleanupReport } from '../../src/lib/plan-cleanup.js'
import type { RsctConfig } from '../../src/lib/project-root.js'

function exec(map: Record<string, GitExecResult>, fallback?: GitExecResult): GitExecutor {
  return (_root, args) => {
    const key = args.join(' ')
    if (key in map) return map[key]!
    return fallback ?? { ok: true, stdout: '', stderr: '', exitCode: 0 }
  }
}
const OK = (stdout = ''): GitExecResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const FAIL = (exitCode: number, stderr = ''): GitExecResult => ({ ok: false, stdout: '', stderr, exitCode })

describe('lib/git — gitIsTracked (fail-safe)', () => {
  it('tracked on clean exit 0', () => {
    expect(gitIsTracked('/r', 'a.md', exec({ 'ls-files --error-unmatch -- a.md': OK('a.md') }))).toBe(true)
  })
  it('not tracked on clean exit 1', () => {
    expect(gitIsTracked('/r', 'a.md', exec({ 'ls-files --error-unmatch -- a.md': FAIL(1) }))).toBe(false)
  })
  it('FAIL-SAFE: unknown error (exit 128) ⇒ treated as tracked', () => {
    expect(gitIsTracked('/r', 'a.md', exec({ 'ls-files --error-unmatch -- a.md': FAIL(128, 'not a git repo') }))).toBe(true)
  })
})

describe('lib/git — gitBranchMerged', () => {
  it('true when the branch appears in --merged output', () => {
    const e = exec({ 'branch --merged main': OK('  feat/x\n* main\n  feat/y\n') })
    expect(gitBranchMerged('/r', 'feat/x', 'main', e)).toBe(true)
  })
  it('false when absent', () => {
    const e = exec({ 'branch --merged main': OK('* main\n') })
    expect(gitBranchMerged('/r', 'feat/x', 'main', e)).toBe(false)
  })
  it('false on git failure (never falsely claims merged)', () => {
    const e = exec({ 'branch --merged main': FAIL(1) })
    expect(gitBranchMerged('/r', 'feat/x', 'main', e)).toBe(false)
  })
})

describe('lib/git — gitRebase / gitSquash envelopes', () => {
  it('gitRebase captures sha before/after on success', () => {
    const e = exec({ 'rev-parse --short HEAD': OK('aaa'), 'rebase main': OK('rebased') }, OK('aaa'))
    const r = gitRebase('/r', 'main', e)
    expect(r.ok).toBe(true)
  })
  it('gitRebase surfaces failure without throwing', () => {
    const e = exec({ 'rev-parse --short HEAD': OK('aaa'), 'rebase main': FAIL(1, 'CONFLICT') })
    const r = gitRebase('/r', 'main', e)
    expect(r.ok).toBe(false)
    expect(r.stderr).toMatch(/CONFLICT/)
  })
  it('gitSquash runs merge --squash', () => {
    let called = ''
    const e: GitExecutor = (_root, args) => {
      if (args[0] === 'merge') called = args.join(' ')
      return OK('aaa')
    }
    const r = gitSquash('/r', 'feat/x', e)
    expect(r.ok).toBe(true)
    expect(called).toBe('merge --squash feat/x')
  })
})

describe('lib/plan-cleanup — planCleanupReport (advisory-only)', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-clean-'))
  })
  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
  })
  const allLoose = exec({}, FAIL(1)) // ls-files exit 1 ⇒ nothing tracked

  it('lists artifacts and suggests delete only when progress is all_closed', () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [x] done\n')
    const r = planCleanupReport(tmpRoot, 'p', null, allLoose)
    expect(r.artifacts.map((a) => a.name).sort()).toEqual(['plan_p.md', 'progress_p.md'])
    expect(r.completion).toBe('all_closed')
    expect(r.can_suggest_delete).toBe(true)
  })

  it('does NOT suggest delete when progress has open items', () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [ ] todo\n')
    const r = planCleanupReport(tmpRoot, 'p', null, allLoose)
    expect(r.can_suggest_delete).toBe(false)
    expect(r.hint).toMatch(/NOT confirmed complete/)
  })

  it('documented mode excludes the spec_ file from cleanup', () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'spec_p.md'), '# spec')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [x] done\n')
    const cfg = { plan_file_retention: 'documented' } as unknown as RsctConfig
    const r = planCleanupReport(tmpRoot, 'p', cfg, allLoose)
    expect(r.artifacts.map((a) => a.name)).not.toContain('spec_p.md')
  })

  it('labels a tracked artifact as deferred (never a loose-delete suggestion)', () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [x] done\n')
    const trackedPlan = exec({ 'ls-files --error-unmatch -- plan_p.md': OK('plan_p.md') }, FAIL(1))
    const r = planCleanupReport(tmpRoot, 'p', null, trackedPlan)
    expect(r.artifacts.find((a) => a.name === 'plan_p.md')?.tracked).toBe(true)
    expect(r.hint).toMatch(/TRACKED/)
  })
})

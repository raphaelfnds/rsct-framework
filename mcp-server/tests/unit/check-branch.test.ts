import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  checkBranchHandler,
  type CheckBranchOutput,
} from '../../src/tools/check-branch.js'
import {
  DEFAULT_PROTECTED_BRANCHES,
  effectiveProtectedList,
  isProtectedBranch,
} from '../../src/lib/branch-protection.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('lib/branch-protection — effectiveProtectedList', () => {
  it('returns the default list with source=default when no config', () => {
    const { list, source } = effectiveProtectedList()
    expect(list).toEqual([...DEFAULT_PROTECTED_BRANCHES])
    expect(source).toBe('default')
  })

  it('replaces the default when protected_branches is set in config', () => {
    const { list, source } = effectiveProtectedList({
      protected_branches: ['release', 'main'],
    })
    expect(list).toEqual(['release', 'main'])
    expect(source).toBe('config')
  })

  it('appends protected_patterns_extra (deduped, order preserved)', () => {
    const { list, source } = effectiveProtectedList({
      protected_branches: ['main'],
      protected_patterns_extra: ['hotfix', 'main', 'release'],
    })
    expect(list).toEqual(['main', 'hotfix', 'release'])
    expect(source).toBe('config+extras')
  })

  it('treats extras-only (no protected_branches) as defaults + extras', () => {
    const { list, source } = effectiveProtectedList({
      protected_patterns_extra: ['release'],
    })
    expect(list).toEqual([...DEFAULT_PROTECTED_BRANCHES, 'release'])
    expect(source).toBe('config+extras')
  })
})

describe('lib/branch-protection — isProtectedBranch', () => {
  it('returns false for null branch (e.g. outside git)', () => {
    expect(isProtectedBranch(null, ['main'])).toBe(false)
  })

  it('matches exact branch name', () => {
    expect(isProtectedBranch('main', ['main', 'test'])).toBe(true)
    expect(isProtectedBranch('feat/foo', ['main', 'test'])).toBe(false)
  })
})

describe('rsct_check_branch — protected detection', () => {
  it('marks an explicit protected branch (main) as protected with sample fixture', async () => {
    const out = (await checkBranchHandler({
      project_root: SAMPLE_RSCT,
      branch: 'main',
    })) as CheckBranchOutput
    expect(out.rsct_installed).toBe(true)
    expect(out.branch).toBe('main')
    expect(out.is_protected).toBe(true)
    expect(out.protected_list).toEqual(['main', 'test'])
    expect(out.source).toBe('config')
    expect(out.hints.some((h) => h.includes("'main' is protected"))).toBe(true)
  })

  it('config replaces default — master is NOT protected in sample fixture', async () => {
    const out = (await checkBranchHandler({
      project_root: SAMPLE_RSCT,
      branch: 'master',
    })) as CheckBranchOutput
    expect(out.is_protected).toBe(false)
    expect(out.protected_list).not.toContain('master')
  })

  it('derived branch is_protected=false', async () => {
    const out = (await checkBranchHandler({
      project_root: SAMPLE_RSCT,
      branch: 'feat/some-work',
    })) as CheckBranchOutput
    expect(out.is_protected).toBe(false)
    expect(out.hints.some((h) => h.includes('not in the protected list'))).toBe(true)
  })

  it('falls back to default list when no .rsct.json', async () => {
    const out = (await checkBranchHandler({
      project_root: NO_RSCT,
      branch: 'main',
    })) as CheckBranchOutput
    expect(out.rsct_installed).toBe(false)
    expect(out.is_protected).toBe(true)
    expect(out.protected_list).toEqual([...DEFAULT_PROTECTED_BRANCHES])
    expect(out.source).toBe('default')
    expect(out.hints.some((h) => h.includes('No .rsct.json'))).toBe(true)
  })

  it('uses live git HEAD when branch input not provided', async () => {
    // Project root is the rsct-framework repo itself (has .git); we cannot
    // assume which branch the test runner is on, so just assert shape +
    // consistency with isProtectedBranch.
    const out = (await checkBranchHandler({})) as CheckBranchOutput
    expect(typeof out.in_git_repo).toBe('boolean')
    if (out.in_git_repo) {
      expect(typeof out.branch === 'string' || out.branch === null).toBe(true)
      const expected = out.branch !== null && out.protected_list.includes(out.branch)
      expect(out.is_protected).toBe(expected)
    }
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      checkBranchHandler({ project_root: SAMPLE_RSCT, unknown_key: 'x' }),
    ).rejects.toThrow()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deriveAuditCeiling,
  reserveFreeBudget,
  evaluateFreeEligibility,
  higherTier,
  isFreeTier,
} from '../../src/lib/free-commit.js'
import type { PhaseState, FreeCommitBudget } from '../../src/lib/phase-scope.js'
import type { StagedStats } from '../../src/lib/git.js'

const NOW = new Date('2026-07-11T12:00:00.000Z')
let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-free-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

/** Write a project that passes the health check, with the given audit lines. */
function makeProject(root: string, auditLines: Array<Record<string, unknown>>) {
  writeFileSync(
    join(root, '.rsct.json'),
    JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
    'utf8',
  )
  mkdirSync(join(root, '.rsct'), { recursive: true })
  const body = auditLines.map((l) => JSON.stringify({ ...l, ts: NOW.toISOString() })).join('\n') + '\n'
  writeFileSync(join(root, '.rsct', 'audit.log'), body, 'utf8')
}

function stats(over: Partial<StagedStats> = {}): StagedStats {
  return { files: 1, insertions: 2, deletions: 1, paths: ['a.ts'], ...over }
}

describe('lib/free-commit — helpers', () => {
  it('isFreeTier is explicit membership (not a rank comparison)', () => {
    expect(isFreeTier('trivial')).toBe(true)
    expect(isFreeTier('small')).toBe(true)
    expect(isFreeTier('standard')).toBe(false)
    expect(isFreeTier('complex')).toBe(false)
    expect(isFreeTier(undefined)).toBe(false)
  })
  it('higherTier returns the higher-ranked tier', () => {
    expect(higherTier('trivial', 'complex')).toBe('complex')
    expect(higherTier('small', undefined)).toBe('small')
    expect(higherTier(undefined, undefined)).toBeUndefined()
  })
})

describe('lib/free-commit — deriveAuditCeiling', () => {
  it('counts free_commit.committed cumulatively for the slug across the whole log', () => {
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'other' }, // different plan — not counted
    ])
    const c = deriveAuditCeiling(tmpRoot, null, 'p')
    expect(c.readable).toBe(true)
    expect(c.classifyEvidencePresent).toBe(true)
    expect(c.auditTierMax).toBe('small')
    expect(c.freeCommitsUsed).toBe(2)
  })

  it('reconstructs the tier ratchet as the MAX over classify.verdict tiers', () => {
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'classify.verdict', tier: 'complex' },
      { event: 'classify.verdict', tier: 'trivial' }, // a later weaker classify must NOT lower it
    ])
    expect(deriveAuditCeiling(tmpRoot, null, 'p').auditTierMax).toBe('complex')
  })

  it('is CRLF-tolerant', () => {
    writeFileSync(
      join(tmpRoot, '.rsct.json'),
      JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
      'utf8',
    )
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'audit.log'),
      `${JSON.stringify({ event: 'classify.verdict', tier: 'small' })}\r\n${JSON.stringify({ event: 'free_commit.committed', plan_slug: 'p' })}\r\n`,
      'utf8',
    )
    const c = deriveAuditCeiling(tmpRoot, null, 'p')
    expect(c.classifyEvidencePresent).toBe(true)
    expect(c.freeCommitsUsed).toBe(1)
  })

  it('detects a free_commit.locked event for the slug', () => {
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'free_commit.locked', plan_slug: 'p', reason: 'commit_cap' },
    ])
    expect(deriveAuditCeiling(tmpRoot, null, 'p').auditLocked).toBe(true)
  })

  it('fails closed (readable:false) when the log is absent', () => {
    const c = deriveAuditCeiling(tmpRoot, null, 'p')
    expect(c.readable).toBe(false)
  })
})

describe('lib/free-commit — reserveFreeBudget (debit-first, lock-on-cap)', () => {
  const limits = { maxCommits: 5, maxFiles: 20, maxLines: 600 }

  it('starts a fresh budget on the first commit', () => {
    const r = reserveFreeBudget({ planSlug: 'p', prev: undefined, stats: stats(), limits })
    expect(r.nextBudget.commits_used).toBe(1)
    expect(r.nextBudget.lines_changed).toBe(3)
    expect(r.nextBudget.files_touched_paths).toEqual(['a.ts'])
    expect(r.nextBudget.locked).toBe(false)
    expect(r.newlyLocked).toBe(false)
  })

  it('accumulates cumulatively and dedupes the path union', () => {
    const prev: FreeCommitBudget = {
      plan_slug: 'p', files_touched_paths: ['a.ts'], commits_used: 1, lines_changed: 3, locked: false,
    }
    const r = reserveFreeBudget({
      planSlug: 'p', prev, stats: stats({ paths: ['a.ts', 'b.ts'], insertions: 4, deletions: 0 }), limits,
    })
    expect(r.nextBudget.commits_used).toBe(2)
    expect(r.nextBudget.lines_changed).toBe(7)
    expect(r.nextBudget.files_touched_paths.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('emits tier_volume_divergence + locks when THIS commit blows the caps', () => {
    const r = reserveFreeBudget({
      planSlug: 'p', prev: undefined, stats: stats({ files: 99, insertions: 5000, deletions: 0, paths: ['big.ts'] }), limits,
    })
    expect(r.signals).toContain('tier_volume_divergence')
    expect(r.nextBudget.locked).toBe(true)
    expect(r.nextBudget.locked_reason).toBe('tier_divergence')
    expect(r.newlyLocked).toBe(true)
  })

  it('locks with commit_cap on the Nth commit (still lands — caller does not reject)', () => {
    const prev: FreeCommitBudget = {
      plan_slug: 'p', files_touched_paths: ['a.ts'], commits_used: 4, lines_changed: 10, locked: false,
    }
    const r = reserveFreeBudget({ planSlug: 'p', prev, stats: stats(), limits })
    expect(r.nextBudget.commits_used).toBe(5)
    expect(r.nextBudget.locked).toBe(true)
    expect(r.nextBudget.locked_reason).toBe('commit_cap')
  })

  it('ignores a prev budget belonging to a different plan (carry-guard)', () => {
    const prev: FreeCommitBudget = {
      plan_slug: 'OTHER', files_touched_paths: ['x.ts'], commits_used: 4, lines_changed: 999, locked: true,
    }
    const r = reserveFreeBudget({ planSlug: 'p', prev, stats: stats(), limits })
    expect(r.nextBudget.commits_used).toBe(1) // fresh, not 5
    expect(r.nextBudget.locked).toBe(false)
  })
})

describe('lib/free-commit — evaluateFreeEligibility (anti-rollback)', () => {
  function eligState(over: Partial<PhaseState> = {}): PhaseState {
    return { last_classify: { tier: 'small', tier_max: 'small', classified_at: NOW.toISOString() }, ...over }
  }

  it('is eligible: healthy + free tier + active plan + classify evidence + not locked', () => {
    makeProject(tmpRoot, [{ event: 'classify.verdict', tier: 'small' }])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(true)
    expect(e.tierMax).toBe('small')
  })

  it('is INELIGIBLE when there is no active plan', () => {
    makeProject(tmpRoot, [{ event: 'classify.verdict', tier: 'small' }])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: null,
    })
    expect(e.eligible).toBe(false)
  })

  it('is INELIGIBLE when the MCP is unhealthy (no audit history)', () => {
    // No project files at all → health fails.
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.reason).toMatch(/unhealthy/)
  })

  it('ANTI-ROLLBACK: state is wiped (null) but the audit history still bars a complex plan', () => {
    makeProject(tmpRoot, [{ event: 'classify.verdict', tier: 'complex' }])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: null, activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.tierMax).toBe('complex') // derived from audit, not the (wiped) state
  })

  it('ANTI-ROLLBACK: a wiped state cannot lower an audit-recorded complex tier', () => {
    // Audit says complex; a forged/wiped state claims trivial → effective = complex.
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'complex' },
      { event: 'classify.verdict', tier: 'trivial' },
    ])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW,
      state: { last_classify: { tier: 'trivial', tier_max: 'trivial', classified_at: NOW.toISOString() } },
      activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.tierMax).toBe('complex')
  })

  it('ANTI-ROLLBACK: a wiped state budget cannot reset the audit-recorded free-commit count', () => {
    // Audit shows 5 free commits already used (>= default max) for slug p.
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
    ])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.lockedHint).toBe(true)
  })

  it('SIGN-FLIP: no classify evidence in the audit history ⇒ ineligible (absence is not permissive)', () => {
    makeProject(tmpRoot, [{ event: 'install' }]) // non-empty log (health ok) but no classify.verdict
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.reason).toMatch(/no classify evidence/)
  })

  it('is INELIGIBLE (lockedHint) when the audit log shows the budget locked', () => {
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'free_commit.locked', plan_slug: 'p', reason: 'commit_cap' },
    ])
    const e = evaluateFreeEligibility({
      projectRoot: tmpRoot, config: null, now: NOW, state: eligState(), activePlanSlug: 'p',
    })
    expect(e.eligible).toBe(false)
    expect(e.lockedHint).toBe(true)
  })
})

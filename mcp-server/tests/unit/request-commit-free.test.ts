import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestCommitHandler,
  type RequestCommitOutput,
  type RequestCommitInternal,
} from '../../src/tools/request-commit.js'
import type { GitExecutor, GitState, StagedStats } from '../../src/lib/git.js'
import type { PhaseState } from '../../src/lib/phase-scope.js'

let tmpRoot: string
const FIXED_NOW = new Date('2026-07-11T12:00:00.000Z')

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rcf-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
    'utf8',
  )
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function gitState(branch: string | null): GitState {
  return { available: branch !== null, branch, head_sha: branch ? 'aaaa111' : null, is_clean: false }
}

/** A git executor where commit + rev-parse succeed. */
const okExec: GitExecutor = (_root, args) => {
  const key = args.join(' ')
  const stdout = key.startsWith('rev-parse') ? 'bbbb222' : ''
  return { ok: true, stdout, stderr: '', exitCode: 0 }
}

function writePlan(slug = 'p', status = 'in progress'): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Status | ${status} |\n`)
}

function writeAudit(lines: Array<Record<string, unknown>>): void {
  const body = lines.map((l) => JSON.stringify({ ...l, ts: FIXED_NOW.toISOString() })).join('\n') + '\n'
  writeFileSync(join(tmpRoot, '.rsct', 'audit.log'), body, 'utf8')
}

function writeState(state: PhaseState): void {
  writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), JSON.stringify(state, null, 2), 'utf8')
}

function readAudit(): string {
  return readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
}

function internal(stats: StagedStats, over: Partial<RequestCommitInternal> = {}): RequestCommitInternal {
  return {
    gitStateOverride: gitState('feat/x'),
    gitExecutor: okExec,
    stagedDiffOverride: '', // no secrets
    stagedStatsOverride: stats,
    now: FIXED_NOW,
    ...over,
  }
}

const smallStats: StagedStats = { files: 1, insertions: 2, deletions: 1, paths: ['a.ts'] }

/** A project set up so the free lane is eligible: small tier + active plan + classify history. */
function eligibleProject(): void {
  writePlan('p')
  writeAudit([{ event: 'classify.verdict', tier: 'small' }])
  writeState({ last_classify: { tier: 'small', tier_max: 'small', classified_at: FIXED_NOW.toISOString() } })
}

describe('rsct_request_commit — free-commit lane (Bloco 1)', () => {
  it('lands a dialog-free commit via the free_commit channel', async () => {
    eligibleProject()
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'free checkpoint' },
      internal(smallStats),
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.channel).toBe('free_commit')
    expect(out.authorized_via).toBe('free_commit')
    expect(out.free_commit?.commits_used).toBe(1)
    expect(out.free_commit?.locked).toBe(false)
    // durable ledger event emitted for the anti-rollback anchor
    expect(readAudit()).toMatch(/"event":"free_commit\.committed"/)
  })

  it('a cap-blowing commit still LANDS but locks the budget + flags divergence', async () => {
    eligibleProject()
    const huge: StagedStats = { files: 99, insertions: 9000, deletions: 0, paths: ['big.ts'] }
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'huge free commit' },
      internal(huge),
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.free_commit?.locked).toBe(true)
    expect(out.free_commit?.locked_reason).toBe('tier_divergence')
    expect(out.fabrication_signals).toContain('tier_volume_divergence')
    expect(readAudit()).toMatch(/"event":"free_commit\.locked"/)
  })

  it('ANTI-ROLLBACK: audit history of exhausted commits refuses free even with NO state budget', async () => {
    writePlan('p')
    writeAudit([
      { event: 'classify.verdict', tier: 'small' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
      { event: 'free_commit.committed', plan_slug: 'p' },
    ])
    // state deliberately has NO free_commit_budget (as if wiped)
    writeState({ last_classify: { tier: 'small', tier_max: 'small', classified_at: FIXED_NOW.toISOString() } })

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'sixth free commit' },
      internal(smallStats),
    )) as RequestCommitOutput

    // Not eligible → falls through to the token path → no token → rejected.
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.reason).toMatch(/locked/i)
  })

  it('falls through to the strict path when the audit tier is complex (not free)', async () => {
    writePlan('p')
    writeAudit([{ event: 'classify.verdict', tier: 'complex' }])
    writeState({ last_classify: { tier: 'complex', tier_max: 'complex', classified_at: FIXED_NOW.toISOString() } })

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'not eligible' },
      internal(smallStats),
    )) as RequestCommitOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid') // fell to token, none present
    expect(out.channel).not.toBe('free_commit')
  })

  it('fails CLOSED when the staged diff cannot be measured (no override, non-git root)', async () => {
    eligibleProject()
    // Omit stagedStatsOverride → getStagedStats reads the (non-git) tmpRoot →
    // null → the free lane must refuse rather than proceed with zero stats.
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'unmeasurable free commit' },
      {
        gitStateOverride: gitState('feat/x'),
        gitExecutor: okExec,
        stagedDiffOverride: '',
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('free_budget_reserve_failed')
    expect(out.reason).toMatch(/could not measure/i)
  })

  it('still blocks a protected branch on the free lane (INV-5, no override)', async () => {
    eligibleProject()
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'free on main' },
      internal(smallStats, { gitStateOverride: gitState('main') }),
    )) as RequestCommitOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(out.authorized_via).toBe('free_commit') // free auth resolved, then INV-5 blocked
  })
})

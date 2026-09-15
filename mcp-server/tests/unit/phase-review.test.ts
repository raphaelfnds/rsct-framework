import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { phaseSpecCompleteHandler } from '../../src/tools/phase-spec-complete.js'
import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { phaseAbandonHandler } from '../../src/tools/phase-abandon.js'
import { stampReviewCompleted, readPhaseState } from '../../src/lib/phase-scope.js'
import type { CompletePhaseResult } from '../../src/lib/phase-machine.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-review-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test-app', org: 'test-org' },
    }),
    'utf8',
  )
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify(state),
    'utf8',
  )
}

function readState(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
  ) as Record<string, unknown>
}

describe('stampReviewCompleted', () => {
  it('writes spec_ref and completed_at, replacing any legacy decision fields', () => {
    writeState({ review: { spec_ref: 'old', decision: 'no', decided_at: VALID_TS } })
    const w = stampReviewCompleted(tmpRoot, { spec_ref: 'feat-x', completed_at: FIXED_NOW.toISOString() })
    expect(w.ok).toBe(true)
    expect(readPhaseState(tmpRoot).state?.review).toEqual({
      spec_ref: 'feat-x',
      completed_at: FIXED_NOW.toISOString(),
    })
  })

  it('preserves other phase-state sub-blocks', () => {
    writeState({ last_classify: { tier: 'small', tier_max: 'small', classified_at: VALID_TS } })
    stampReviewCompleted(tmpRoot, { spec_ref: 'feat-x', completed_at: FIXED_NOW.toISOString() })
    expect(readState().last_classify).toBeDefined()
  })
})

describe('phase_spec_complete rejects the removed include_review', () => {
  for (const value of [true, false]) {
    it(`include_review=${value} returns review_option_removed and writes nothing`, async () => {
      writeState({ phase: 'spec', spec_slug: 'feat-x' })
      let prompts = 0
      const r = await phaseSpecCompleteHandler(
        {
          project_root: tmpRoot,
          spec_ref: 'feat-x',
          include_review: value,
          dev_approval: {
            timestamp: VALID_TS,
            action_scope: 'spec_complete:spec_ref=feat-x',
            reason: 'spec approved by the dev; closing S',
          },
        },
        {
          now: FIXED_NOW,
          promptFn: async () => {
            prompts++
            return { response: 'yes', channel: 'windows' }
          },
        },
      )
      expect(r.status).toBe('rejected')
      if (!('removed_options' in r)) throw new Error('expected the removed-option envelope')
      expect(r.reject_kind).toBe('review_option_removed')
      expect(r.removed_options).toEqual(['include_review'])
      expect(prompts).toBe(0)
      expect(readState().phase).toBe('spec')
      expect(readState().review).toBeUndefined()
    })
  }

  it('without include_review the spec phase completes', async () => {
    writeState({ phase: 'spec', spec_slug: 'feat-x' })
    const r = (await phaseSpecCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'spec_complete:spec_ref=feat-x',
          reason: 'spec approved by the dev; closing S',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(readState().review).toBeUndefined()
  })
})

describe('phase_review start + complete', () => {
  it('review_start writes phase=review', async () => {
    const r = await phaseReviewStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
    })
    expect(r.phase).toBe('review')
    expect(r.status).toBe('started')
    expect(readState().phase).toBe('review')
  })

  it('review_complete stamps completed_at, clears the phase and ends the cycle', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x' })
    const r = (await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'review_complete:spec_ref=feat-x',
          reason: 'review of code and tests done; closing the cycle',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBeNull()
    const s = readState()
    expect(s.phase).toBeUndefined()
    expect(s.review).toEqual({ spec_ref: 'feat-x', completed_at: FIXED_NOW.toISOString() })
    expect(s.context_stale).toBeDefined()
  })

  it('flags scope_mismatch when the action_scope prefix is wrong (INV-2.2 registered)', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x' })
    const r = (await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'code_complete:spec_ref=feat-x',
          reason: 'mismatched scope — should raise scope_mismatch',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.fabrication_signals).toContain('scope_mismatch')
  })
})

describe('phase_status review summary', () => {
  it('returns the completion state, with no decision fields', async () => {
    writeState({
      review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS, completed_at: FIXED_NOW.toISOString() },
    })
    const r = await phaseStatusHandler({ project_root: tmpRoot })
    expect(r.review).toEqual({
      spec_ref: 'feat-x',
      completed: true,
      completed_at: FIXED_NOW.toISOString(),
      open_findings: [],
      evidence_mix: {
        measurable: false,
        measured: 0,
        reported: 0,
        hypothesis: 0,
        unrecorded: 0,
        total: 0,
      },
      findings_run_id: null,
    })
    expect(r.rsct_phase_order).toContain('review')
  })

  it('review is null when no review was recorded', async () => {
    writeState({ phase: 'code', spec_slug: 'feat-x' })
    const r = await phaseStatusHandler({ project_root: tmpRoot })
    expect(r.review).toBeNull()
  })
})

describe('phase_abandon and the review blocks', () => {
  it('wipes the review block but keeps the byte-bound sweep ledger', async () => {
    const ledger = {
      'src/a.ts': [
        { blob: 'abc', verdict: 'clean', migrations: [], channel: 'dialog', spec_ref: 'feat-x', at: VALID_TS },
      ],
    }
    writeState({
      phase: 'review',
      spec_slug: 'feat-x',
      review: { spec_ref: 'feat-x', completed_at: VALID_TS },
      review_sweep: ledger,
    })
    await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'pivot — abandoning the active phase and its review',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'phase_abandon:feat-x',
          reason: 'pivot — abandoning the active phase and its review',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )
    expect(readState().review).toBeUndefined()
    expect(readState().review_sweep).toEqual(ledger)
  })
})

describe('phase-review-complete — findings_actions (#19)', () => {
  const APPROVAL = {
    timestamp: VALID_TS,
    action_scope: 'review_complete:spec_ref=feat-x',
    reason: 'code review of the diff done; ready for tests',
  }

  function activeReview(): void {
    writeState({
      phase: 'review',
      spec_slug: 'feat-x',
    })
  }

  function auditEvents(): Record<string, unknown>[] {
    const p = join(tmpRoot, '.rsct', 'audit.log')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('records one audit entry per finding and summarises the actions', async () => {
    activeReview()
    const r = await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: APPROVAL,
        findings_actions: [
          { finding_id: 'r-dead-code-1', action: 'address-now', note: 'orphaned import' },
          { finding_id: 'r-stale-comment-2', action: 'accept' },
          { finding_id: 'r-leftover-3', action: 'capture-as-issue' },
        ],
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )

    expect(r.status).toBe('completed')
    expect(r.actions_summary['address-now']).toBe(1)
    expect(r.actions_summary.accept).toBe(1)
    expect(r.actions_summary['capture-as-issue']).toBe(1)
    expect(r.actions_summary.block).toBe(0)

    const actions = auditEvents().filter((e) => e.event === 'review.action')
    expect(actions).toHaveLength(3)
    expect(actions[0]?.finding_id).toBe('r-dead-code-1')
    expect(actions[0]?.note).toBe('orphaned import')
  })

  it('a blocking finding aborts BEFORE the dialog, and the phase stays open', async () => {
    activeReview()
    let dialogShown = false
    const r = await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: APPROVAL,
        findings_actions: [
          { finding_id: 'r-dead-code-1', action: 'block', note: 'unreachable branch shipped' },
          { finding_id: 'r-stale-comment-2', action: 'accept' },
        ],
      },
      {
        now: FIXED_NOW,
        promptFn: async () => {
          dialogShown = true
          return { response: 'yes', channel: 'windows' }
        },
      },
    )

    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('block_actions_present')
    expect(dialogShown).toBe(false)
    const s = readState()
    expect(s.phase).toBe('review')
    expect(s.review).toBeUndefined()
    expect(auditEvents().some((e) => e.event === 'review.action')).toBe(false)
    expect(auditEvents().some((e) => e.event === 'review.complete.rejected')).toBe(true)
  })

  it('stays backward compatible — omitting findings_actions still completes', async () => {
    activeReview()
    const r = await phaseReviewCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: APPROVAL },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )
    expect(r.status).toBe('completed')
    expect(r.actions_summary.block).toBe(0)
    expect(auditEvents().some((e) => e.event === 'review.action')).toBe(false)
  })

  it('logs no action when the gate itself rejects — the log records approved decisions only', async () => {
    activeReview()
    const r = await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: { ...APPROVAL, action_scope: 'wrong_scope' },
        findings_actions: [{ finding_id: 'r-dead-code-1', action: 'accept' }],
      },
      { now: FIXED_NOW, promptFn: async () => ({ response: 'no', channel: 'windows' }) },
    )
    expect(r.status).toBe('rejected')
    expect(auditEvents().some((e) => e.event === 'review.action')).toBe(false)
  })
})

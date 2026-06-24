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

import {
  evaluateReviewGate,
  phaseTestStartHandler,
  type PhaseTestStartGateRejectedOutput,
} from '../../src/tools/phase-test-start.js'
import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { phaseSpecCompleteHandler } from '../../src/tools/phase-spec-complete.js'
import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { phaseAbandonHandler } from '../../src/tools/phase-abandon.js'
import {
  stampReviewDecision,
  readPhaseState,
  type PhaseReviewBlock,
} from '../../src/lib/phase-scope.js'
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

function reviewBlock(over: Partial<PhaseReviewBlock> = {}): PhaseReviewBlock {
  return { spec_ref: 'feat-x', decision: 'yes', ...over }
}

// ── evaluateReviewGate (pure) — all states + the stale-poison guard ──────────
describe('evaluateReviewGate — tier bypass', () => {
  it('bypassed_tier for trivial + small', () => {
    for (const tier of ['trivial', 'small'] as const) {
      const g = evaluateReviewGate({
        projectRoot: tmpRoot,
        specRef: 'feat-x',
        specTier: tier,
        overrideReviewSkip: false,
      })
      expect(g.status).toBe('bypassed_tier')
    }
  })
})

describe('evaluateReviewGate — standard/complex decision states', () => {
  it('rejected_undecided when no review block exists', () => {
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'standard',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('rejected_undecided')
    expect(g.review_block_found).toBe(false)
  })

  it('bypassed_declined when decision=no for the matching spec_ref', () => {
    writeState({ review: reviewBlock({ decision: 'no' }) })
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'complex',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('bypassed_declined')
    expect(g.review_decision).toBe('no')
  })

  it('passed when decision=yes AND completed_at set for the matching spec_ref', () => {
    writeState({
      review: reviewBlock({ decision: 'yes', completed_at: VALID_TS }),
    })
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'standard',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('passed')
    expect(g.review_completed_at).toBe(VALID_TS)
  })

  it('rejected_incomplete when decision=yes but not completed', () => {
    writeState({ review: reviewBlock({ decision: 'yes' }) })
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'standard',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('rejected_incomplete')
  })

  it('overridden bypasses BOTH undecided and incomplete', () => {
    // undecided → overridden
    const g1 = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'standard',
      overrideReviewSkip: true,
    })
    expect(g1.status).toBe('overridden')
    // incomplete → overridden
    writeState({ review: reviewBlock({ decision: 'yes' }) })
    const g2 = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-x',
      specTier: 'standard',
      overrideReviewSkip: true,
    })
    expect(g2.status).toBe('overridden')
  })
})

describe('evaluateReviewGate — stale-poison guard (re-plan / different spec_ref)', () => {
  it('a completed decision for X does NOT satisfy the gate for Y → rejected_undecided', () => {
    writeState({
      review: reviewBlock({ spec_ref: 'feat-X', decision: 'yes', completed_at: VALID_TS }),
    })
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-Y',
      specTier: 'standard',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('rejected_undecided')
  })

  it('a declined decision for X does NOT bypass the gate for Y → rejected_undecided', () => {
    writeState({ review: reviewBlock({ spec_ref: 'feat-X', decision: 'no' }) })
    const g = evaluateReviewGate({
      projectRoot: tmpRoot,
      specRef: 'feat-Y',
      specTier: 'standard',
      overrideReviewSkip: false,
    })
    expect(g.status).toBe('rejected_undecided')
  })
})

// ── stampReviewDecision — additive upsert + carry-guard ──────────────────────
describe('stampReviewDecision', () => {
  it('records the decision, then merges completed_at without clobbering it', () => {
    stampReviewDecision(tmpRoot, {
      spec_ref: 'feat-x',
      decision: 'yes',
      decided_at: VALID_TS,
    })
    let r = readPhaseState(tmpRoot).state?.review
    expect(r).toEqual({ spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS })

    stampReviewDecision(tmpRoot, { spec_ref: 'feat-x', completed_at: FIXED_NOW.toISOString() })
    r = readPhaseState(tmpRoot).state?.review
    expect(r?.decision).toBe('yes')
    expect(r?.decided_at).toBe(VALID_TS)
    expect(r?.completed_at).toBe(FIXED_NOW.toISOString())
  })

  it('starts a FRESH block on a spec_ref change (no stale inheritance)', () => {
    stampReviewDecision(tmpRoot, {
      spec_ref: 'feat-X',
      decision: 'yes',
      decided_at: VALID_TS,
      completed_at: FIXED_NOW.toISOString(),
    })
    // re-plan to Y, decline it
    stampReviewDecision(tmpRoot, { spec_ref: 'feat-Y', decision: 'no', decided_at: VALID_TS })
    const r = readPhaseState(tmpRoot).state?.review
    expect(r?.spec_ref).toBe('feat-Y')
    expect(r?.decision).toBe('no')
    expect(r?.completed_at).toBeUndefined() // X's completed_at did NOT carry over
  })

  it('preserves other phase-state sub-blocks (additive)', () => {
    writeState({ spec_slug: 'feat-x', last_classify: { tier: 'standard', tier_max: 'standard', classified_at: VALID_TS } })
    stampReviewDecision(tmpRoot, { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS })
    const s = readState()
    expect(s.spec_slug).toBe('feat-x')
    expect(s.last_classify).toBeDefined()
    expect((s.review as Record<string, unknown>).decision).toBe('yes')
  })
})

// ── spec_complete include_review → records the decision (on success only) ────
describe('phase_spec_complete include_review', () => {
  function specComplete(includeReview: boolean | undefined) {
    writeState({ phase: 'spec', spec_slug: 'feat-x' })
    return phaseSpecCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'spec_complete:spec_ref=feat-x',
          reason: 'spec approved; recording the review decision',
        },
        ...(includeReview !== undefined && { include_review: includeReview }),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    ) as Promise<CompletePhaseResult>
  }

  it('include_review=true → review block decision=yes', async () => {
    const r = await specComplete(true)
    expect(r.status).toBe('completed')
    const review = readState().review as Record<string, unknown>
    expect(review.decision).toBe('yes')
    expect(review.spec_ref).toBe('feat-x')
  })

  it('include_review=false → review block decision=no', async () => {
    const r = await specComplete(false)
    expect(r.status).toBe('completed')
    expect((readState().review as Record<string, unknown>).decision).toBe('no')
  })

  it('omitting include_review records NO review block', async () => {
    const r = await specComplete(undefined)
    expect(r.status).toBe('completed')
    expect(readState().review).toBeUndefined()
  })
})

// ── review_start / review_complete ───────────────────────────────────────────
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

  it('review_complete stamps completed_at + clears the phase + recommends test', async () => {
    writeState({
      phase: 'review',
      spec_slug: 'feat-x',
      review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS },
    })
    const r = (await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'review_complete:spec_ref=feat-x',
          reason: 'code review of the diff done; ready for tests',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBe('test')
    const s = readState()
    expect(s.phase).toBeUndefined() // active phase cleared
    const review = s.review as Record<string, unknown>
    expect(review.decision).toBe('yes') // preserved
    expect(review.completed_at).toBe(FIXED_NOW.toISOString()) // stamped
  })

  it('flags scope_mismatch when the action_scope prefix is wrong (INV-2.2 registered)', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x' })
    const r = (await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'code_complete:spec_ref=feat-x', // wrong prefix for review_complete
          reason: 'mismatched scope — should raise scope_mismatch',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.fabrication_signals).toContain('scope_mismatch')
  })
})

// ── test_start handler — gate enforcement end-to-end ─────────────────────────
describe('phase_test_start review gate', () => {
  it('rejects (review_gate_rejected) with no state write when undecided (standard)', async () => {
    const r = (await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
    })) as PhaseTestStartGateRejectedOutput
    expect(r.status).toBe('review_gate_rejected')
    expect(r.reject_kind).toBe('review_undecided')
    expect(r.phase_state_written).toBe(false)
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json'))).toBe(false)
  })

  it('rejects review_incomplete when decision=yes but not completed', async () => {
    writeState({ review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS } })
    const r = (await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
    })) as PhaseTestStartGateRejectedOutput
    expect(r.status).toBe('review_gate_rejected')
    expect(r.reject_kind).toBe('review_incomplete')
  })

  it('proceeds (phase=test) when the review was declined', async () => {
    writeState({ review: { spec_ref: 'feat-x', decision: 'no', decided_at: VALID_TS } })
    const r = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
    })
    if (r.status !== 'started') throw new Error(`expected started, got ${r.status}`)
    expect(r.phase).toBe('test')
    expect(r.review_gate.status).toBe('bypassed_declined')
  })

  it('proceeds when the review was completed (passed)', async () => {
    writeState({
      review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS, completed_at: VALID_TS },
    })
    const r = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
    })
    if (r.status !== 'started') throw new Error(`expected started, got ${r.status}`)
    expect(r.review_gate.status).toBe('passed')
  })

  it('proceeds with override_review_skip even when undecided (audit-logged)', async () => {
    const r = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-x',
      override_review_skip: true,
    })
    if (r.status !== 'started') throw new Error(`expected started, got ${r.status}`)
    expect(r.review_gate.status).toBe('overridden')
    const audit = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
    expect(audit).toContain('test.start.review_override')
  })
})

// ── phase_status surfaces the review summary ─────────────────────────────────
describe('phase_status review summary', () => {
  it('returns the review decision + completion state', async () => {
    writeState({
      review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS, completed_at: FIXED_NOW.toISOString() },
    })
    const r = await phaseStatusHandler({ project_root: tmpRoot })
    expect(r.review).toEqual({
      spec_ref: 'feat-x',
      decision: 'yes',
      completed: true,
      decided_at: VALID_TS,
      completed_at: FIXED_NOW.toISOString(),
    })
    expect(r.rsct_phase_order).toContain('review')
  })

  it('review is null when no decision recorded', async () => {
    writeState({ phase: 'code', spec_slug: 'feat-x' })
    const r = await phaseStatusHandler({ project_root: tmpRoot })
    expect(r.review).toBeNull()
  })
})

// ── phase_abandon wipes the review block ─────────────────────────────────────
describe('phase_abandon clears the review block', () => {
  it('wipes review along with the rest of phase-state', async () => {
    writeState({
      phase: 'review',
      spec_slug: 'feat-x',
      review: { spec_ref: 'feat-x', decision: 'yes', decided_at: VALID_TS },
    })
    await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'pivot — abandoning the active phase and its review decision',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'phase_abandon:feat-x',
          reason: 'pivot — abandoning the active phase and its review decision',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )
    expect(readState().review).toBeUndefined()
  })
})

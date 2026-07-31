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
  nextPhase,
  startPhaseGeneric,
  gatePhaseComplete,
  RSCT_PHASES,
  type StartPhaseResult,
  type CompletePhaseResult,
} from '../../src/lib/phase-machine.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pm-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test', org: 'test' },
    }),
    'utf8',
  )
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'research_complete:spec_ref=feat-foo',
    reason: 'research phase complete; ready to advance to spec',
    ...overrides,
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(r: DialogResult) {
  return async () => r
}

describe('phase-machine — RSCT_PHASES + nextPhase', () => {
  it('exposes the canonical phase tuple', () => {
    expect(RSCT_PHASES).toEqual([
      'research',
      'spec',
      'verification',
      'code',
      'review',
      'test',
    ])
  })

  it('nextPhase advances through the chain', () => {
    expect(nextPhase('research')).toBe('spec')
    expect(nextPhase('spec')).toBe('verification')
    expect(nextPhase('verification')).toBe('code')
    expect(nextPhase('code')).toBe('review')
    expect(nextPhase('review')).toBe('test')
  })

  it('nextPhase returns null for the terminal phase', () => {
    expect(nextPhase('test')).toBeNull()
  })
})

describe('phase-machine — startPhaseGeneric', () => {
  it('writes phase-state.json with phase + spec_slug + started_at', () => {
    const r = startPhaseGeneric(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
      },
      null,
      { now: FIXED_NOW },
    )
    expect(r.status).toBe('started')
    expect(r.phase_state_written).toBe(true)

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBe('research')
    expect(state.spec_slug).toBe('feat-foo')
    expect(state.started_at).toBe(FIXED_NOW.toISOString())
  })

  it('honors explicit spec_slug + scope_globs', () => {
    const r = startPhaseGeneric(
      {
        projectRoot: tmpRoot,
        phase: 'spec',
        specRef: 'feat-x',
        specSlug: 'feature-x-custom',
        scopeGlobs: ['src/lib/**/*.ts'],
      },
      null,
    )
    expect(r.status).toBe('started')
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.spec_slug).toBe('feature-x-custom')
    expect(state.scope_globs).toEqual(['src/lib/**/*.ts'])
  })

  it('refuses with phase_already_active when a different phase is open', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({ phase: 'code', spec_slug: 'other' }),
      'utf8',
    )
    const r = startPhaseGeneric(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-new',
      },
      null,
    )
    expect(r.status).toBe('phase_already_active')
    expect(r.existing_phase).toBe('code')
    expect(r.phase_state_written).toBe(false)
  })

  it('allows re-starting the SAME phase (idempotent / sub-iteration friendly)', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({ phase: 'research', spec_slug: 'feat-foo' }),
      'utf8',
    )
    const r = startPhaseGeneric(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
      },
      null,
    )
    expect(r.status).toBe('started')
  })

  it('emits <phase>.start audit event', () => {
    startPhaseGeneric(
      { projectRoot: tmpRoot, phase: 'spec', specRef: 'feat-audit' },
      null,
    )
    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'spec.start')).toBe(true)
  })
})

describe('phase-machine — gatePhaseComplete', () => {
  function writeActivePhase(phase: string, specSlug: string): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({ phase, spec_slug: specSlug }),
      'utf8',
    )
  }

  it('returns no_active_phase when phase-state is absent', async () => {
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
        devApproval: approval(),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('no_active_phase')
  })

  it('rejects with phase_mismatch when active phase differs', async () => {
    writeActivePhase('spec', 'feat-foo')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
        devApproval: approval(),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('phase_mismatch')
  })

  it('rejects with spec_ref_mismatch when spec_slug differs', async () => {
    writeActivePhase('research', 'feat-A')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-B',
        devApproval: approval(),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('spec_ref_mismatch')
  })

  it('rejects via §C when dialog returns no', async () => {
    writeActivePhase('research', 'feat-foo')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
        devApproval: approval(),
      },
      null,
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'no', channel: 'windows' }),
      },
    )) as CompletePhaseResult
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('dialog_no')
  })

  it('completes, clears phase, advances next_recommended_phase', async () => {
    writeActivePhase('research', 'feat-foo')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'feat-foo',
        devApproval: approval(),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.cleared).toBe(true)
    expect(r.next_recommended_phase).toBe('spec')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined()
    expect(state.spec_slug).toBe('feat-foo')
  })

  it('terminal phase (test) returns null next_recommended_phase', async () => {
    writeActivePhase('test', 'feat-foo')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'test',
        specRef: 'feat-foo',
        devApproval: approval({
          action_scope: 'test_complete:spec_ref=feat-foo',
        }),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBeNull()
  })
})

/**
 * Issue #15 — the stale-label exception. The positive case is one line; the
 * value of this block is the NEGATIVES. A looser reading of "stale" would turn
 * the repair into a general escape hatch from `phase_already_active`, which is
 * the behavior the mechanical layer exists to block. Each rejected widening
 * named in the issue gets its own test.
 */
describe('startPhaseGeneric — stale verification label (#15)', () => {
  function writeState(state: Record<string, unknown>): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), JSON.stringify(state))
  }

  const start = (phase: 'code' | 'research' | 'test'): StartPhaseResult =>
    startPhaseGeneric({ projectRoot: tmpRoot, phase, specRef: 'feat-foo' }, null)

  function auditEvents(): string[] {
    const p = join(tmpRoot, '.rsct', 'audit.log')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { event: string }).event)
  }

  it('lets Code start over a completed verification label, and audits it', () => {
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: { spec_ref: 'feat-foo', completed_at: '2026-07-31T12:00:00.000Z' },
    })
    const out = start('code')
    expect(out.status).toBe('started')
    expect(auditEvents()).toContain('phase.stale_label_cleared')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBe('code')
    // The V record survives — it is what the code_start gate reads.
    expect(state.verification).toBeDefined()
  })

  it('NEGATIVE — a verification block without completed_at still rejects', () => {
    // `verification != null` alone must never satisfy the exception: this is the
    // in-flight V that `rejected_incomplete` exists to catch.
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: { spec_ref: 'feat-foo', started_at: '2026-07-31T11:00:00.000Z' },
    })
    const out = start('code')
    expect(out.status).toBe('phase_already_active')
    expect(out.existing_phase).toBe('verification')
    expect(auditEvents()).not.toContain('phase.stale_label_cleared')
  })

  it('NEGATIVE — a verification label with NO verification block rejects', () => {
    writeState({ phase: 'verification', spec_slug: 'feat-foo' })
    expect(start('code').status).toBe('phase_already_active')
  })

  it('NEGATIVE — completed_at explicitly null rejects', () => {
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: { spec_ref: 'feat-foo', completed_at: null },
    })
    expect(start('code').status).toBe('phase_already_active')
  })

  it('NEGATIVE — the exception does not extend to other phase labels', () => {
    // A stale `code` label carries no completion evidence, so it is a different
    // situation with no claim on this exception — even with a completed V block.
    writeState({
      phase: 'code',
      spec_slug: 'feat-foo',
      verification: { spec_ref: 'feat-foo', completed_at: '2026-07-31T12:00:00.000Z' },
    })
    expect(start('research').status).toBe('phase_already_active')
  })

  it('NEGATIVE — an old started_at does not make a label stale (no clock heuristic)', () => {
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      started_at: '2020-01-01T00:00:00.000Z',
      verification: { spec_ref: 'feat-foo', started_at: '2020-01-01T00:00:00.000Z' },
    })
    expect(start('code').status).toBe('phase_already_active')
  })

  it('restarting the SAME phase is unchanged — no stale-label event', () => {
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: { spec_ref: 'feat-foo', completed_at: '2026-07-31T12:00:00.000Z' },
    })
    const out = startPhaseGeneric(
      { projectRoot: tmpRoot, phase: 'verification', specRef: 'feat-foo' },
      null,
    )
    expect(out.status).toBe('started')
    expect(auditEvents()).not.toContain('phase.stale_label_cleared')
  })
})

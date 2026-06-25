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

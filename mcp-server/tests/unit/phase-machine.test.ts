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
      'test',
      'review',
    ])
  })

  it('nextPhase advances through the chain', () => {
    expect(nextPhase('research')).toBe('spec')
    expect(nextPhase('spec')).toBe('verification')
    expect(nextPhase('verification')).toBe('code')
    expect(nextPhase('code')).toBe('test')
    expect(nextPhase('test')).toBe('review')
  })

  it('nextPhase returns null for the terminal phase', () => {
    expect(nextPhase('review')).toBeNull()
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

  it('terminal phase (review) returns null next_recommended_phase', async () => {
    writeActivePhase('review', 'feat-foo')
    const r = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'review',
        specRef: 'feat-foo',
        devApproval: approval({
          action_scope: 'review_complete:spec_ref=feat-foo',
        }),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBeNull()
  })
})

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
    expect(state.verification).toBeDefined()
  })

  it('NEGATIVE — a verification block without completed_at still rejects', () => {
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

describe('phase-machine — a leftover task name is not silently inherited', () => {
  function writeState(state: Record<string, unknown>): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
  }
  const rawState = (): string => readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8')

  it('stops, leaves the state untouched and names both choices', () => {
    writeState({ spec_slug: 'old-task', started_at: '2026-09-07T10:00:00.000Z' })
    const before = rawState()
    const r = startPhaseGeneric({ projectRoot: tmpRoot, phase: 'review', specRef: 'new-task' }, null)
    expect(r.status).toBe('previous_task_pending')
    expect(r.phase_state_written).toBe(false)
    expect(rawState()).toBe(before)
    const hint = r.hints.join(' ')
    expect(hint).toContain("spec_slug='old-task'")
    expect(hint).toContain("spec_slug='new-task'")
    expect(hint).toContain('2026-09-07T10:00:00.000Z')
    const audit = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(audit.some((l) => l.reject_kind === 'previous_task_pending' && l.existing_spec_slug === 'old-task')).toBe(true)
  })

  it('a new task named by the developer starts and then completes under its own name', async () => {
    writeState({ spec_slug: 'old-task' })
    const r = startPhaseGeneric(
      { projectRoot: tmpRoot, phase: 'research', specRef: 'new-task', specSlug: 'new-task' },
      null,
    )
    expect(r.status).toBe('started')
    const c = (await gatePhaseComplete(
      {
        projectRoot: tmpRoot,
        phase: 'research',
        specRef: 'new-task',
        devApproval: approval({ action_scope: 'research_complete:spec_ref=new-task' }),
      },
      null,
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(c.status).toBe('completed')
  })

  it('continuing the recorded task keeps its name', () => {
    writeState({ spec_slug: 'old-task' })
    const r = startPhaseGeneric(
      { projectRoot: tmpRoot, phase: 'test', specRef: 'new-task', specSlug: 'old-task' },
      null,
    )
    expect(r.status).toBe('started')
    expect(JSON.parse(rawState()).spec_slug).toBe('old-task')
  })

  it('restarting the SAME active phase keeps inheriting, as before', () => {
    writeState({ phase: 'code', spec_slug: 'old-task' })
    const r = startPhaseGeneric({ projectRoot: tmpRoot, phase: 'code', specRef: 'other' }, null)
    expect(r.status).toBe('started')
    expect(JSON.parse(rawState()).spec_slug).toBe('old-task')
  })

  it('the same name, or no recorded name, starts as before', () => {
    writeState({ spec_slug: 'same' })
    expect(startPhaseGeneric({ projectRoot: tmpRoot, phase: 'spec', specRef: 'same' }, null).status).toBe('started')
    rmSync(join(tmpRoot, '.rsct'), { recursive: true, force: true })
    expect(startPhaseGeneric({ projectRoot: tmpRoot, phase: 'spec', specRef: 'fresh' }, null).status).toBe('started')
  })

  it('a stale V label of another task asks instead of inheriting', () => {
    writeState({
      phase: 'verification',
      spec_slug: 'old-task',
      verification: { spec_ref: 'old-task', completed_at: '2026-09-07T11:00:00.000Z' },
    })
    const r = startPhaseGeneric({ projectRoot: tmpRoot, phase: 'code', specRef: 'new-task' }, null)
    expect(r.status).toBe('previous_task_pending')
  })
})

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
  phaseAbandonHandler,
  type PhaseAbandonOutput,
} from '../../src/tools/phase-abandon.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pa-'))
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
    action_scope: 'phase_abandon:spec_ref=feat-foo',
    reason: 'pivoting away from this approach after research',
    ...overrides,
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(r: DialogResult) {
  return async () => r
}

function writePhaseState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify(state),
    'utf8',
  )
}

describe('rsct_phase_abandon — no active phase', () => {
  it('returns no_active_phase when phase-state.json absent', async () => {
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'task was cancelled by stakeholder',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('no_active_phase')
    expect(r.abandoned_phase).toBeNull()
  })

  it('returns no_active_phase when phase-state present but no phase field', async () => {
    writePhaseState({ spec_slug: 'something' })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'task was cancelled by stakeholder',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('no_active_phase')
  })
})

describe('rsct_phase_abandon — §C-gated path', () => {
  it('rejects with dialog_no when dev declines', async () => {
    writePhaseState({ phase: 'research', spec_slug: 'feat-foo' })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'changed approach to a refactor instead',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'no', channel: 'windows' }),
      },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('dialog_no')
    // Phase still present
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBe('research')
  })

  it('clears the active phase + spec_slug on approved abandon', async () => {
    writePhaseState({
      phase: 'spec',
      spec_slug: 'feat-aborted',
      started_at: '2026-06-07T15:00:00.000Z',
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'requirements changed before code phase started',
        dev_approval: approval({
          action_scope: 'phase_abandon:spec_ref=feat-aborted',
        }),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')
    expect(r.abandoned_phase).toBe('spec')
    expect(r.abandoned_spec_slug).toBe('feat-aborted')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined()
    expect(state.spec_slug).toBeUndefined()
    expect(state.started_at).toBeUndefined()
  })

  it('clears the verification block when abandoning verification phase', async () => {
    writePhaseState({
      phase: 'verification',
      spec_slug: 'feat-v',
      verification: {
        spec_ref: 'feat-v',
        spec_tier: 'standard',
        findings: [{ id: 'v-1' }],
        started_at: '2026-06-07T16:00:00.000Z',
      },
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'verification revealed blocker, restarting spec',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')
    expect(r.abandoned_verification_block_present).toBe(true)
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.verification).toBeUndefined()
  })

  it('emits phase_abandon.complete audit with the reason', async () => {
    writePhaseState({ phase: 'code', spec_slug: 'feat-x' })
    await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'spec was wrong, restarting from research',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )
    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const completed = lines.find((l) => l.event === 'phase_abandon.complete')
    expect(completed).toBeDefined()
    expect(completed.abandoned_phase).toBe('code')
    expect(completed.reason).toBe('spec was wrong, restarting from research')
  })
})

describe('rsct_phase_abandon — input validation', () => {
  it('rejects reason < 10 chars', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        reason: 'short',
        dev_approval: approval(),
      }),
    ).rejects.toThrow()
  })

  it('rejects missing reason', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        reason: 'a long enough reason here',
        dev_approval: approval(),
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  phaseStatusHandler,
  type PhaseStatusOutput,
} from '../../src/tools/phase-status.js'
import { RSCT_PHASES } from '../../src/lib/phase-machine.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-ps-'))
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

function writePhaseState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify(state),
    'utf8',
  )
}

describe('rsct_phase_status', () => {
  it('returns phase_state_exists=false + null active_phase when file absent', async () => {
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(r.phase_state_exists).toBe(false)
    expect(r.active_phase).toBeNull()
    expect(r.next_recommended_phase).toBeNull()
    expect(r.rsct_phase_order).toEqual(RSCT_PHASES)
  })

  it('returns active_phase + next_recommended_phase for a known phase', async () => {
    writePhaseState({ phase: 'research', spec_slug: 'feat-foo' })
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(r.active_phase).toBe('research')
    expect(r.spec_slug).toBe('feat-foo')
    expect(r.next_recommended_phase).toBe('spec')
  })

  it('returns null next_recommended_phase when phase=test (terminal)', async () => {
    writePhaseState({ phase: 'test', spec_slug: 'feat-foo' })
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(r.active_phase).toBe('test')
    expect(r.next_recommended_phase).toBeNull()
  })

  it('surfaces verification summary when phase=verification', async () => {
    writePhaseState({
      phase: 'verification',
      spec_slug: 'feat-bar',
      verification: {
        spec_ref: 'feat-bar',
        spec_tier: 'standard',
        findings: [{ id: 'v-1' }, { id: 'v-2' }],
        started_at: '2026-06-07T10:00:00.000Z',
      },
    })
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(r.active_phase).toBe('verification')
    expect(r.verification?.findings_count).toBe(2)
    expect(r.verification?.spec_tier).toBe('standard')
  })

  it('emits a hint naming next recommended phase', async () => {
    writePhaseState({ phase: 'spec', spec_slug: 'feat-X' })
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(
      r.hints.some(
        (h) => h.includes('Active phase: spec') && h.includes('verification'),
      ),
    ).toBe(true)
  })

  it('hints when phase value is not a known RSCT phase', async () => {
    writePhaseState({ phase: 'planning', spec_slug: 'feat-X' })
    const r = (await phaseStatusHandler({
      project_root: tmpRoot,
    })) as PhaseStatusOutput
    expect(r.active_phase).toBeNull()
    expect(r.hints.some((h) => h.includes("unrecognized phase"))).toBe(true)
  })
})

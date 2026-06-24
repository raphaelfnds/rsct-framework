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

import { phaseSpecStartHandler } from '../../src/tools/phase-spec-start.js'
import { phaseSpecCompleteHandler } from '../../src/tools/phase-spec-complete.js'
import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'
import { phaseCodeCompleteHandler } from '../../src/tools/phase-code-complete.js'
import { phaseTestStartHandler } from '../../src/tools/phase-test-start.js'
import { phaseTestCompleteHandler } from '../../src/tools/phase-test-complete.js'
import type { CompletePhaseResult } from '../../src/lib/phase-machine.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-phs-'))
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

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function setActivePhase(phase: string, specSlug: string): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify({ phase, spec_slug: specSlug }),
    'utf8',
  )
}

describe('phase-spec start + complete', () => {
  it('start writes phase=spec', async () => {
    const r = await phaseSpecStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-spec-smoke',
    })
    expect(r.phase).toBe('spec')
    expect(r.status).toBe('started')
  })

  it('complete advances to verification (next phase per RSCT)', async () => {
    setActivePhase('spec', 'feat-spec-smoke')
    const r = (await phaseSpecCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-spec-smoke',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'spec_complete:spec_ref=feat-spec-smoke',
          reason: 'spec phase complete; ready to verify or code',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBe('verification')
  })
})

describe('phase-code start + complete', () => {
  it('start writes phase=code with scope_globs (tier=trivial bypasses V gate)', async () => {
    // CAP-28: default tier=standard requires V completion; this smoke
    // uses tier=trivial to bypass the gate since the focus is the
    // phase-state write + scope_globs handling, not V gate semantics
    // (V gate has dedicated coverage in phase-code-start.test.ts).
    const r = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-code-smoke',
      scope_globs: ['src/lib/**/*.ts'],
      spec_tier: 'trivial',
    })
    if (r.status !== 'started') {
      throw new Error(
        `expected status=started, got ${r.status} (${JSON.stringify(r)})`,
      )
    }
    expect(r.phase).toBe('code')
    expect(r.scope_globs).toEqual(['src/lib/**/*.ts'])
    expect(r.verification_gate.status).toBe('bypassed_tier')
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.scope_globs).toEqual(['src/lib/**/*.ts'])
  })

  it('complete advances to review (next phase per RSCT)', async () => {
    setActivePhase('code', 'feat-code-smoke')
    const r = (await phaseCodeCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-code-smoke',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'code_complete:spec_ref=feat-code-smoke',
          reason: 'code phase complete; ready for review then tests',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBe('review')
  })
})

describe('phase-test start + complete (terminal)', () => {
  it('start writes phase=test (tier=trivial bypasses review gate)', async () => {
    // DX-4: default tier=standard requires an honored review decision;
    // this smoke uses tier=trivial to bypass the gate since the focus is
    // the phase-state write, not review-gate semantics (the gate has
    // dedicated coverage in phase-review.test.ts).
    const r = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-test-smoke',
      spec_tier: 'trivial',
    })
    if (r.status !== 'started') {
      throw new Error(
        `expected status=started, got ${r.status} (${JSON.stringify(r)})`,
      )
    }
    expect(r.phase).toBe('test')
    expect(r.review_gate.status).toBe('bypassed_tier')
  })

  it('complete returns null next_recommended_phase (cycle done)', async () => {
    setActivePhase('test', 'feat-test-smoke')
    const r = (await phaseTestCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-test-smoke',
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'test_complete:spec_ref=feat-test-smoke',
          reason: 'test phase complete; sign-off the RSCT cycle for this spec',
        },
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as CompletePhaseResult
    expect(r.status).toBe('completed')
    expect(r.next_recommended_phase).toBeNull()
  })
})

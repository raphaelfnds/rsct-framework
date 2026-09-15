import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'
import { phaseTestStartHandler } from '../../src/tools/phase-test-start.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-ceremony-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test-app', org: 'test-org' },
      ...extra,
    }),
    'utf8',
  )
}

function writeClassifyVerdict(tier: string): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  const line = JSON.stringify({
    ts: '2026-06-07T17:00:00.000Z',
    event: 'classify.verdict',
    tool: 'rsct_classify_task',
    tier,
  })
  writeFileSync(join(tmpRoot, '.rsct/audit.log'), `${line}\n`, 'utf8')
}

function writePlanTracking(slug: string): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), '| Status | in-progress |\n', 'utf8')
  writeFileSync(join(tmpRoot, `progress_${slug}.md`), '# progress\n', 'utf8')
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'code_start:bypass',
    reason: 'dev chose to bypass the phase for this task',
    ...overrides,
  }
}

const yes = (): ((o: DialogOptions) => Promise<DialogResult>) => async () => ({
  response: 'yes',
  channel: 'windows',
})
const no = (): ((o: DialogOptions) => Promise<DialogResult>) => async () => ({
  response: 'no',
  channel: 'windows',
})
const noChannel = (): ((o: DialogOptions) => Promise<DialogResult>) => async () => ({
  response: 'unavailable',
  channel: null,
  error: 'no dialog channel',
})

describe('ceremony bypass gate — the override booleans need a per-call decision', () => {
  it('rejects override_verification_skip with no dev_approval', async () => {
    writeConfig()
    writePlanTracking('feat-a')
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-a',
        spec_tier: 'standard',
        plan_slug: 'feat-a',
        override_verification_skip: true,
      },
      { now: FIXED_NOW, promptFn: yes() },
    )
    expect(out.status).toBe('bypass_gate_rejected')
    if (out.status !== 'bypass_gate_rejected') return
    expect(out.reject_kind).toBe('schema')
  })

  it('rejects override_classify_downgrade with no dev_approval', async () => {
    writeConfig()
    writeClassifyVerdict('complex')
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-b',
        spec_tier: 'small',
        override_classify_downgrade: true,
      },
      { now: FIXED_NOW, promptFn: yes() },
    )
    expect(out.status).toBe('bypass_gate_rejected')
  })

  it('rejects override_plan_tracking with no dev_approval', async () => {
    writeConfig()
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-c',
        spec_tier: 'standard',
        plan_slug: 'gone',
        override_plan_tracking: true,
      },
      { now: FIXED_NOW, promptFn: yes() },
    )
    expect(out.status).toBe('bypass_gate_rejected')
  })

  it('rejects override_review_skip as a removed option', async () => {
    writeConfig()
    const out = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-d',
      override_review_skip: true,
    })
    expect(out.status).toBe('rejected')
    if (out.status !== 'rejected') return
    expect(out.reject_kind).toBe('review_option_removed')
    expect(out.removed_options).toEqual(['override_review_skip'])
  })

  it('rejects when the dev declines the dialog', async () => {
    writeConfig()
    writePlanTracking('feat-e')
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-e',
        spec_tier: 'standard',
        plan_slug: 'feat-e',
        override_verification_skip: true,
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: no() },
    )
    expect(out.status).toBe('bypass_gate_rejected')
    if (out.status !== 'bypass_gate_rejected') return
    expect(out.reject_kind).toBe('dialog_no')
  })

  it('ignores trust_allowed_for when no dialog channel exists', async () => {
    writeConfig({
      approval_modes: { trust_allowed_for: ['rsct_phase_code_complete'] },
    })
    writePlanTracking('feat-f')
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-f',
        spec_tier: 'standard',
        plan_slug: 'feat-f',
        override_verification_skip: true,
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: noChannel() },
    )
    expect(out.status).toBe('bypass_gate_rejected')
    if (out.status !== 'bypass_gate_rejected') return
    expect(out.reject_kind).toBe('force_dialog_no_channel')
  })

  it('asks once for several bypasses in the same call', async () => {
    writeConfig()
    writeClassifyVerdict('complex')
    let prompts = 0
    const counting =
      (): ((o: DialogOptions) => Promise<DialogResult>) => async () => {
        prompts += 1
        return { response: 'yes', channel: 'windows' }
      }
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-g',
        spec_tier: 'standard',
        plan_slug: 'gone',
        override_verification_skip: true,
        override_classify_downgrade: true,
        override_plan_tracking: true,
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: counting() },
    )
    expect(out.status).toBe('started')
    expect(prompts).toBe(1)
  })

  it('does not gate a call that requests no bypass', async () => {
    writeConfig()
    writePlanTracking('feat-h')
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({
        spec_slug: 'feat-h',
        verification: {
          spec_ref: 'feat-h',
          spec_tier: 'standard',
          started_at: '2026-06-07T17:30:00.000Z',
          completed_at: '2026-06-07T17:45:00.000Z',
        },
      }),
      'utf8',
    )
    let prompts = 0
    const counting =
      (): ((o: DialogOptions) => Promise<DialogResult>) => async () => {
        prompts += 1
        return { response: 'yes', channel: 'windows' }
      }
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-h',
        spec_tier: 'standard',
        plan_slug: 'feat-h',
      },
      { now: FIXED_NOW, promptFn: counting() },
    )
    expect(out.status).toBe('started')
    expect(prompts).toBe(0)
  })
})

describe('ceremony bypass gate — a tier that skips phases needs evidence', () => {
  it('rejects spec_tier=trivial at code_start with no classify verdict', async () => {
    writeConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-i',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('classify_gate_rejected')
    if (out.status !== 'classify_gate_rejected') return
    expect(out.reject_kind).toBe('classify_evidence_absent')
  })

  it('rejects spec_tier at test_start as a removed option', async () => {
    writeConfig()
    const out = await phaseTestStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-j',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('rejected')
    if (out.status !== 'rejected') return
    expect(out.reject_kind).toBe('review_option_removed')
    expect(out.removed_options).toEqual(['spec_tier'])
  })

  it('accepts spec_tier=trivial once a verdict is on record', async () => {
    writeConfig()
    writeClassifyVerdict('trivial')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-k',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
  })

  it('accepts a verdict recorded only in phase-state, not the audit log', async () => {
    writeConfig()
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({
        last_classify: {
          tier: 'trivial',
          tier_max: 'trivial',
          classified_at: '2026-06-07T17:00:00.000Z',
        },
      }),
      'utf8',
    )
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-l',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
  })

  it('leaves a non-bypassing tier alone when no verdict exists', async () => {
    writeConfig()
    writePlanTracking('feat-m')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-m',
      spec_tier: 'standard',
      plan_slug: 'feat-m',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
  })
})

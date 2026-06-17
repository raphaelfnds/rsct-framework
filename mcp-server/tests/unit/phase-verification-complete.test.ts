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
  phaseVerificationCompleteHandler,
  type PhaseVerificationCompleteOutput,
} from '../../src/tools/phase-verification-complete.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-vcomplete-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function writeRsctConfig(overrides: Record<string, unknown> = {}): void {
  writeFile(
    '.rsct.json',
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test-app', org: 'test-org' },
      ...overrides,
    }),
  )
}

function writeActiveVerification(specRef: string): void {
  writeFile(
    '.rsct/phase-state.json',
    JSON.stringify({
      phase: 'verification',
      spec_slug: specRef,
      verification: {
        spec_ref: specRef,
        spec_tier: 'standard',
        declared_paths: ['src/foo.ts'],
        discovered_importers: [],
        findings: [],
        started_at: '2026-06-07T17:30:00.000Z',
      },
    }),
  )
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'verification_complete:spec_ref=feat-foo',
    reason: 'V phase findings reviewed; ready to enter code phase',
    ...overrides,
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(
  r: DialogResult,
): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => r
}

describe('phase-verification-complete — no active verification', () => {
  it('returns no_active_verification when phase-state.json absent', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('no_active_verification')
    expect(out.cleared_verification).toBe(false)
  })

  it('returns no_active_verification when phase-state.json has no verification block', async () => {
    writeRsctConfig()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({ phase: 'spec', spec_slug: 'feat-foo' }),
    )
    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('no_active_verification')
  })
})

describe('phase-verification-complete — spec_ref mismatch', () => {
  it('rejects with spec_ref_mismatch when input ref does not match phase-state', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-A')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-B',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('spec_ref_mismatch')
    expect(out.cleared_verification).toBe(false)
  })
})

describe('phase-verification-complete — block_actions_present', () => {
  it('rejects before §C when any finding action=block', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings_actions: [
          { finding_id: 'v-gap-1', action: 'block' },
          { finding_id: 'v-gap-2', action: 'defer' },
        ],
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('block_actions_present')
    expect(out.actions_summary.block).toBe(1)
    expect(out.cleared_verification).toBe(false)
    // phase-state must remain intact
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json'))).toBe(true)
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.verification).toBeDefined()
  })
})

describe('phase-verification-complete — §C gate rejection paths', () => {
  it('rejects with dialog_no when dev says no', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'no', channel: 'windows' }),
      },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dialog_no')
    expect(out.cleared_verification).toBe(false)
  })

  it('rejects with no_channel when dialog unavailable and not in trust_allowed_for', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'unavailable', channel: 'none' }),
      },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('no_channel')
  })
})

describe('phase-verification-complete — happy path', () => {
  it('completes, clears verification + phase, writes audit', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings_actions: [
          { finding_id: 'v-gap-1', action: 'address-now' },
          { finding_id: 'v-forgotten-1', action: 'accept' },
        ],
        dev_approval: approval(),
        clear_phase: true,
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('completed')
    expect(out.channel).toBe('windows')
    expect(out.cleared_verification).toBe(true)
    expect(out.cleared_phase).toBe(true)
    expect(out.actions_summary['address-now']).toBe(1)
    expect(out.actions_summary.accept).toBe(1)
    expect(out.anti_replay_persisted).toBe(true)

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    // CAP-28: verification block preserved as audit trail (large arrays
    // pruned, but metadata + completed_at retained for downstream gate).
    const stateV = state.verification as
      | { spec_ref?: string; spec_tier?: string; completed_at?: string }
      | undefined
    expect(stateV).toBeDefined()
    expect(stateV?.spec_ref).toBe('feat-foo')
    expect(stateV?.completed_at).toBeDefined()
    expect(state.phase).toBeUndefined()

    const auditLines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(auditLines.some((l) => l.event === 'verification.complete')).toBe(
      true,
    )
    expect(
      auditLines.filter((l) => l.event === 'verification.action').length,
    ).toBe(2)
  })

  it('clear_phase=false keeps phase and other top-level fields intact', async () => {
    writeRsctConfig()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        phase: 'verification',
        spec_slug: 'feat-foo',
        scope_globs: ['src/**/*.ts'],
        started_at: '2026-06-07T16:00:00.000Z',
        verification: {
          spec_ref: 'feat-foo',
          spec_tier: 'standard',
          declared_paths: [],
          findings: [],
          started_at: '2026-06-07T17:30:00.000Z',
        },
      }),
    )

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
        clear_phase: false,
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('completed')
    expect(out.cleared_phase).toBe(false)

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    // CAP-28: verification block kept as audit trail (with completed_at);
    // arrays pruned but metadata + clear_phase=false preserves rest.
    const stateV = state.verification as
      | { spec_ref?: string; completed_at?: string }
      | undefined
    expect(stateV).toBeDefined()
    expect(stateV?.spec_ref).toBe('feat-foo')
    expect(stateV?.completed_at).toBeDefined()
    expect(state.phase).toBe('verification')
    expect(state.scope_globs).toEqual(['src/**/*.ts'])
  })
})

describe('phase-verification-complete — input validation', () => {
  it('rejects when dev_approval missing required fields', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: { timestamp: VALID_TS }, // missing action_scope + reason
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('schema')
  })

  it('default findings_actions to empty array', async () => {
    writeRsctConfig()
    writeActiveVerification('feat-foo')

    const out = (await phaseVerificationCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseVerificationCompleteOutput

    expect(out.status).toBe('completed')
    expect(out.actions_summary).toEqual({
      accept: 0,
      'address-now': 0,
      'capture-as-issue': 0,
      defer: 0,
      block: 0,
    })
  })
})

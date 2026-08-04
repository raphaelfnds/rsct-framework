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
  phaseVerificationStartHandler,
  type PhaseVerificationStartOutput,
} from '../../src/tools/phase-verification-start.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-vstart-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

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

describe('phase-verification-start — tier skip', () => {
  it('skips when spec_tier=trivial — no phase-state written', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'trivial-task',
      spec_tier: 'trivial',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
    expect(out.phase_state_written).toBe(false)
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json'))).toBe(false)
    expect(out.findings).toEqual([])
    expect(out.hints.some((h) => h.includes('skipped per tier table'))).toBe(
      true,
    )
  })

  it('skips when spec_tier=small', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'small-task',
      spec_tier: 'small',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
  })
})

describe('phase-verification-start — verified happy path', () => {
  it('writes verification block to phase-state.json on standard tier', async () => {
    writeRsctConfig()
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      declared_paths: ['src/seed.ts'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('verified')
    expect(out.phase_state_written).toBe(true)
    expect(out.discovered_importers).toHaveLength(1)
    expect(out.discovered_importers[0]?.file).toBe('src/importer.ts')

    const stateRaw = readFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      'utf8',
    )
    const state = JSON.parse(stateRaw) as Record<string, unknown>
    expect(state.phase).toBe('verification')
    expect(state.spec_slug).toBe('feat-foo')
    expect(state.verification).toBeDefined()
    const v = state.verification as Record<string, unknown>
    expect(v.spec_ref).toBe('feat-foo')
    expect(v.spec_tier).toBe('standard')
    expect(v.declared_paths).toEqual(['src/seed.ts'])
    expect(v.started_at).toBeDefined()
  })

  it('passes requested_persona through to audit log and state', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      declared_paths: [],
      spec_tier: 'complex',
      persona: 'security',
    })) as PhaseVerificationStartOutput

    expect(out.requested_persona).toBe('security')
    const stateRaw = readFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      'utf8',
    )
    const v = (JSON.parse(stateRaw) as { verification: Record<string, unknown> })
      .verification
    expect(v.persona).toBe('security')
  })

  it('appends verification.start + verification.finding entries to audit log', async () => {
    writeRsctConfig()
    // Sample-rsct fixture not needed — we set up corpus-less project; finding count = 0
    writeFile('src/seed.ts', 'export const x = 1\n')

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-audit',
      declared_paths: ['src/seed.ts'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.audit_path).toBeTruthy()
    expect(out.audit_error).toBeNull()
    const auditRaw = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
    const lines = auditRaw.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'verification.start')).toBe(true)
  })

})

describe('phase-verification-start — input validation', () => {
  it('rejects empty spec_ref', async () => {
    writeRsctConfig()
    await expect(
      phaseVerificationStartHandler({
        project_root: tmpRoot,
        spec_ref: '',
      }),
    ).rejects.toThrow()
  })

  it('defaults declared_paths to empty array', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'no-paths',
    })) as PhaseVerificationStartOutput

    expect(out.declared_paths).toEqual([])
    expect(out.discovered_importers).toEqual([])
  })

  it('defaults spec_tier to standard', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'default-tier',
    })) as PhaseVerificationStartOutput

    expect(out.spec_tier).toBe('standard')
  })
})

/**
 * Load-bearing invariant for issue #15's stale-label exception.
 *
 * `startPhaseGeneric` lets a phase start over a `verification` label whose block
 * carries `completed_at`. That is safe ONLY because a fresh V-start rebuilds the
 * verification block from scratch, so `completed_at` can never survive into a
 * newly opened V. If a future refactor "preserved previous metadata" by
 * spreading the old block, an agent could arm the exception at will and defeat
 * `phase_already_active` from any phase, at no cost.
 *
 * Nothing else pins this. That is what this test is for.
 */
describe('phase-verification-start — a new V never inherits completed_at (#15)', () => {
  it('drops a stale completed_at when re-opening V over a completed block', async () => {
    writeRsctConfig()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        spec_slug: 'feat-foo',
        verification: {
          spec_ref: 'feat-foo',
          spec_tier: 'standard',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T01:00:00.000Z',
        },
      }),
    )

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput
    expect(out.status).toBe('verified')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as { phase?: string; verification?: { completed_at?: string } }
    expect(state.phase).toBe('verification')
    expect(state.verification?.completed_at).toBeUndefined()
  })
})

describe('phase-verification-start — respects the active phase (#27)', () => {
  /** Every audit event of a given name, in order. */
  function auditEvents(): Record<string, unknown>[] {
    const p = join(tmpRoot, '.rsct/audit.log')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  const readState = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8')) as Record<
      string,
      unknown
    >

  function writeState(state: Record<string, unknown>): void {
    writeFile('.rsct/phase-state.json', JSON.stringify(state))
  }

  it('refuses to overwrite a DIFFERENT active phase, and audits the refusal', async () => {
    // The hole #27 closes: this used to write `phase: 'verification'` over an
    // active `code` label with no gate and no audit, letting an agent reach Test
    // without ever calling code_complete.
    writeRsctConfig()
    writeState({ phase: 'code', spec_slug: 'feat-foo', started_at: '2026-01-01T00:00:00.000Z' })

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('phase_already_active')
    expect(out.existing_phase).toBe('code')
    expect(out.phase_state_written).toBe(false)
    expect(out.hints.join(' ')).toContain('rsct_phase_code_complete')

    // The label survives untouched — that is the whole point.
    expect(readState().phase).toBe('code')

    const rejected = auditEvents().find((e) => e.event === 'verification.start.rejected')
    expect(rejected).toBeDefined()
    expect(rejected?.reject_kind).toBe('phase_already_active')
    expect(rejected?.existing_phase).toBe('code')
    // Nothing may claim the phase started.
    expect(auditEvents().some((e) => e.event === 'verification.start')).toBe(false)
  })

  it('allows reopening a COMPLETED verification, and records the discarded record', async () => {
    // Same-label restart over a block carrying completed_at: a finished V record
    // is being discarded, which is the transition #15's gate exception rests on.
    writeRsctConfig()
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: {
        spec_ref: 'feat-foo',
        spec_tier: 'standard',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T01:00:00.000Z',
      },
    })

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput
    expect(out.status).toBe('verified')

    const cleared = auditEvents().find((e) => e.event === 'phase.stale_label_cleared')
    expect(cleared).toBeDefined()
    expect(cleared?.tool).toBe('rsct_phase_verification_start')
    expect(cleared?.previous_spec_slug).toBe('feat-foo')
    expect(cleared?.verification_completed_at).toBe('2026-01-01T01:00:00.000Z')
    expect(cleared?.phase_state_written).toBe(true)
  })

  it('restarting an IN-FLIGHT verification is routine — no stale-label event', async () => {
    // No completed_at, so nothing finished is being discarded. Emitting here
    // would make the event meaningless by firing on every ordinary re-run.
    writeRsctConfig()
    writeState({
      phase: 'verification',
      spec_slug: 'feat-foo',
      verification: {
        spec_ref: 'feat-foo',
        spec_tier: 'standard',
        started_at: '2026-01-01T00:00:00.000Z',
      },
    })

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput
    expect(out.status).toBe('verified')
    expect(auditEvents().some((e) => e.event === 'phase.stale_label_cleared')).toBe(false)
  })

  it('is unchanged when no phase is active', async () => {
    writeRsctConfig()
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput
    expect(out.status).toBe('verified')
    expect(out.existing_phase).toBeNull()
    expect(readState().phase).toBe('verification')
    expect(auditEvents().some((e) => e.event === 'phase.stale_label_cleared')).toBe(false)
  })

  it('the trivial-tier skip still writes NO state, even with another phase active', async () => {
    // The gate sits after the skip return on purpose: the skip path's
    // "audit-only, no state write" claim has to stay literally true.
    writeRsctConfig()
    writeState({ phase: 'code', spec_slug: 'feat-foo' })

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'trivial',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
    expect(out.phase_state_written).toBe(false)
    expect(readState().phase).toBe('code')
    expect(auditEvents().some((e) => e.event === 'verification.start.rejected')).toBe(false)
  })
})

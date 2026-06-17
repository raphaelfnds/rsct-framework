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

import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-codestart-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function writeRsctConfig(): void {
  writeFile(
    '.rsct.json',
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test-app', org: 'test-org' },
    }),
  )
}

function writeCompletedVerification(specRef: string): void {
  writeFile(
    '.rsct/phase-state.json',
    JSON.stringify({
      spec_slug: specRef,
      verification: {
        spec_ref: specRef,
        spec_tier: 'standard',
        started_at: '2026-06-07T17:30:00.000Z',
        completed_at: '2026-06-07T17:55:00.000Z',
      },
    }),
  )
}

function writeStartedVerification(specRef: string): void {
  writeFile(
    '.rsct/phase-state.json',
    JSON.stringify({
      phase: 'verification',
      spec_slug: specRef,
      verification: {
        spec_ref: specRef,
        spec_tier: 'standard',
        started_at: '2026-06-07T17:30:00.000Z',
      },
    }),
  )
}

function readAuditLines(): Array<Record<string, unknown>> {
  const path = join(tmpRoot, '.rsct/audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('phase-code-start — CAP-28 verification gate', () => {
  it('bypasses gate for spec_tier=trivial (no V record required)', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'fix-typo',
      spec_tier: 'trivial',
      scope_globs: ['docs/**/*.md'],
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.verification_gate.status).toBe('bypassed_tier')
    expect(out.verification_gate.spec_tier).toBe('trivial')
  })

  it('bypasses gate for spec_tier=small (no V record required)', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'small-fix',
      spec_tier: 'small',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.verification_gate.status).toBe('bypassed_tier')
  })

  it('proceeds when spec_tier=standard and V was completed for same spec_ref', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-foo')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
      scope_globs: ['src/**/*.ts'],
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.verification_gate.status).toBe('satisfied')
    expect(out.verification_gate.v_completed_at).toBe(
      '2026-06-07T17:55:00.000Z',
    )
  })

  it('rejects (verification_incomplete) when V was started but not completed', async () => {
    writeRsctConfig()
    writeStartedVerification('feat-foo')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_incomplete')
    expect(out.verification_gate.status).toBe('rejected_incomplete')

    const audit = readAuditLines()
    expect(
      audit.some(
        (l) =>
          l.event === 'code.start.rejected' &&
          l.reject_kind === 'verification_incomplete',
      ),
    ).toBe(true)
  })

  it('rejects (verification_required) when tier=standard and no V record + no override', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
    expect(out.verification_gate.v_block_found).toBe(false)

    const audit = readAuditLines()
    expect(
      audit.some(
        (l) =>
          l.event === 'code.start.rejected' &&
          l.reject_kind === 'verification_required',
      ),
    ).toBe(true)
  })

  it('proceeds with audit when override_verification_skip=true', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
      override_verification_skip: true,
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.verification_gate.status).toBe('overridden')

    const audit = readAuditLines()
    expect(
      audit.some((l) => l.event === 'code.start.verification_override'),
    ).toBe(true)
  })

  it('rejects when spec_tier=complex and no V record + no override', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-complex',
      spec_tier: 'complex',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
    expect(out.verification_gate.spec_tier).toBe('complex')
  })

  it('rejects when V was completed for a DIFFERENT spec_ref', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-other')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-mine',
      spec_tier: 'standard',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
    expect(out.verification_gate.v_spec_ref).toBe('feat-other')
  })

  it('defaults spec_tier to standard when omitted (gate active by default)', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-default',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.verification_gate.spec_tier).toBe('standard')
  })
})

describe('phase-code-start — CAP-30 classify-downgrade gate', () => {
  function writeClassifyVerdict(
    tier: string,
    tier_max: string,
    classified_at = '2026-06-09T17:00:00.000Z',
  ): void {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        last_classify: { tier, tier_max, classified_at },
      }),
    )
  }

  it('rejects when spec_tier < recorded tier_max (downgrade attempt)', async () => {
    writeRsctConfig()
    writeClassifyVerdict('complex', 'complex')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-downgrade',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('classify_gate_rejected')
    if (out.status !== 'classify_gate_rejected') return
    expect(out.reject_kind).toBe('classify_downgrade')
    expect(out.classify_gate.status).toBe('rejected_downgrade')
    expect(out.classify_gate.tier_max_recorded).toBe('complex')

    const audit = readAuditLines()
    expect(
      audit.some(
        (l) =>
          l.event === 'code.start.rejected' &&
          l.reject_kind === 'classify_downgrade',
      ),
    ).toBe(true)
  })

  it('proceeds when spec_tier >= recorded tier_max', async () => {
    writeRsctConfig()
    writeClassifyVerdict('standard', 'standard')
    // V completed for this spec, so V gate also passes; classify_gate satisfied
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        last_classify: {
          tier: 'standard',
          tier_max: 'standard',
          classified_at: '2026-06-09T17:00:00.000Z',
        },
        verification: {
          spec_ref: 'feat-match',
          spec_tier: 'standard',
          started_at: '2026-06-09T17:10:00.000Z',
          completed_at: '2026-06-09T17:30:00.000Z',
        },
        bootstrap_at: new Date().toISOString(),
      }),
    )
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-match',
      spec_tier: 'standard',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.classify_gate.status).toBe('satisfied')
  })

  it('overrides downgrade with override_classify_downgrade=true (audit-logged)', async () => {
    writeRsctConfig()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        last_classify: {
          tier: 'complex',
          tier_max: 'complex',
          classified_at: '2026-06-09T17:00:00.000Z',
        },
        bootstrap_at: new Date().toISOString(),
      }),
    )
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-override',
      spec_tier: 'small',
      override_classify_downgrade: true,
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.classify_gate.status).toBe('overridden')

    const audit = readAuditLines()
    expect(
      audit.some((l) => l.event === 'code.start.classify_downgrade_override'),
    ).toBe(true)
  })

  it('falls through to no_record (gate inactive) when no classify verdict on file', async () => {
    writeRsctConfig()
    // No last_classify in phase-state — gate inactive, falls through to V
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-noclassify',
      spec_tier: 'trivial', // would bypass V gate too
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.classify_gate.status).toBe('no_record')
  })
})

describe('phase-code-start — CAP-31 bootstrap marker', () => {
  it('surfaces missing bootstrap warning + audit when bootstrap_at absent', async () => {
    writeRsctConfig()
    // tier=trivial bypasses V gate; no classify record; no bootstrap stamp
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-no-bootstrap',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.bootstrap_marker.status).toBe('missing')
    expect(out.hints.some((h) => h.includes('bootstrap not detected'))).toBe(
      true,
    )

    const audit = readAuditLines()
    expect(
      audit.some(
        (l) =>
          l.event === 'code.start.bootstrap_warning' &&
          l.bootstrap_status === 'missing',
      ),
    ).toBe(true)
  })

  it('surfaces stale warning when bootstrap_at older than 4h', async () => {
    writeRsctConfig()
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({ bootstrap_at: fiveHoursAgo }),
    )
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-stale-boot',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.bootstrap_marker.status).toBe('stale')
    expect(out.hints.some((h) => h.includes('stale window'))).toBe(true)
  })

  it('no warning when bootstrap_at is fresh (<4h)', async () => {
    writeRsctConfig()
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString()
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({ bootstrap_at: oneMinuteAgo }),
    )
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-fresh-boot',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.bootstrap_marker.status).toBe('fresh')
    expect(out.hints.some((h) => h.includes('bootstrap'))).toBe(false)
  })
})

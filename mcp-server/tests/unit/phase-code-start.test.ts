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
  phaseCodeStartHandler,
  phaseCodeStartInputSchema,
  phaseCodeStartTool,
} from '../../src/tools/phase-code-start.js'

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

// PH-1: standard/complex tasks now require plan_<slug>.md + progress_<slug>.md
// to exist (the plan-tracking gate). Helper writes both for a single-phase plan.
function writePlanTracking(slug: string): void {
  writeFile(`plan_${slug}.md`, `| Status | in-progress |\n`)
  writeFile(`progress_${slug}.md`, `# progress\n`)
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
    writePlanTracking('feat-foo')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
      plan_slug: 'feat-foo',
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
    writePlanTracking('feat-foo')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
      plan_slug: 'feat-foo',
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
    writePlanTracking('feat-bar')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
      plan_slug: 'feat-bar',
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
    writePlanTracking('feat-bar')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-bar',
      spec_tier: 'standard',
      plan_slug: 'feat-bar',
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
    writePlanTracking('feat-complex')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-complex',
      spec_tier: 'complex',
      plan_slug: 'feat-complex',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
    expect(out.verification_gate.spec_tier).toBe('complex')
  })

  it('rejects when V was completed for a DIFFERENT spec_ref', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-other')
    writePlanTracking('feat-mine')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-mine',
      spec_tier: 'standard',
      plan_slug: 'feat-mine',
    })
    expect(out.status).toBe('verification_gate_rejected')
    if (out.status !== 'verification_gate_rejected') return
    expect(out.reject_kind).toBe('verification_required')
    expect(out.verification_gate.v_spec_ref).toBe('feat-other')
  })

  it('defaults spec_tier to standard when omitted (gate active by default)', async () => {
    writeRsctConfig()
    writePlanTracking('feat-default')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-default',
      plan_slug: 'feat-default',
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
    writePlanTracking('feat-match')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-match',
      spec_tier: 'standard',
      plan_slug: 'feat-match',
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

describe('phase-code-start — PH-1 plan-tracking gate', () => {
  it('bypasses the gate for spec_tier=trivial (no plan files required)', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'tiny',
      spec_tier: 'trivial',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.plan_tracking_gate.status).toBe('bypassed_tier')
  })

  it('rejects (slug_indeterminate) when standard and no plan_slug', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-noslug',
      spec_tier: 'standard',
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.reject_kind).toBe('plan_tracking')
    expect(out.plan_tracking_gate.status).toBe('rejected_slug_indeterminate')
    // plan-tracking runs BEFORE V: a missing-plan rejection surfaces even
    // though V is also unsatisfied here.
    const audit = readAuditLines()
    expect(
      audit.some(
        (l) =>
          l.event === 'code.start.rejected' && l.reject_kind === 'plan_tracking',
      ),
    ).toBe(true)
  })

  it('rejects (invalid_slug) on a path-traversal slug — before any fs read', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-evil',
      spec_tier: 'standard',
      plan_slug: '../../etc/passwd',
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.plan_tracking_gate.status).toBe('rejected_invalid_slug')
  })

  it('rejects (plan_missing) when plan_<slug>.md is absent', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-noplan',
      spec_tier: 'standard',
      plan_slug: 'noplan',
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.plan_tracking_gate.status).toBe('rejected_plan_missing')
  })

  it('rejects (progress_missing) when plan_ exists but progress_ is absent', async () => {
    writeRsctConfig()
    writeFile('plan_halfdone.md', '| Status | in-progress |\n')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-halfdone',
      spec_tier: 'standard',
      plan_slug: 'halfdone',
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.plan_tracking_gate.status).toBe('rejected_progress_missing')
  })

  it('rejects (phase_spec_missing) for a multi-phase plan without the phase spec', async () => {
    writeRsctConfig()
    writePlanTracking('planx')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-mp',
      spec_tier: 'standard',
      plan_slug: 'planx',
      spec_slug: 'ph-1', // ≠ plan_slug → multi-phase
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.plan_tracking_gate.status).toBe('rejected_phase_spec_missing')
    expect(out.plan_tracking_gate.is_multi_phase).toBe(true)
  })

  it('multi-phase satisfied when plan+progress+phase-spec all present', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-mp2') // V passes for this spec_ref
    writePlanTracking('planx')
    writeFile('spec_ph-2.md', '# phase spec\n')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-mp2',
      spec_tier: 'standard',
      plan_slug: 'planx',
      spec_slug: 'ph-2',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.plan_tracking_gate.status).toBe('satisfied')
    expect(out.plan_tracking_gate.is_multi_phase).toBe(true)
    expect(out.plan_tracking_gate.phase_spec_present).toBe(true)
  })

  it('single-phase satisfied with no spec file (spec_slug omitted)', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-sp')
    writePlanTracking('feat-sp')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-sp',
      spec_tier: 'standard',
      plan_slug: 'feat-sp',
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.plan_tracking_gate.status).toBe('satisfied')
    expect(out.plan_tracking_gate.is_multi_phase).toBe(false)
    expect(out.plan_tracking_gate.phase_spec_present).toBe(null)
  })

  it('override_plan_tracking=true proceeds + audits (no plan files)', async () => {
    writeRsctConfig()
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-ovr',
      spec_tier: 'standard',
      plan_slug: 'gone',
      override_plan_tracking: true,
      override_verification_skip: true, // let V pass too so we reach 'started'
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.plan_tracking_gate.status).toBe('overridden')
    const audit = readAuditLines()
    expect(
      audit.some((l) => l.event === 'code.start.plan_tracking_override'),
    ).toBe(true)
  })

  it('single-phase satisfied when spec_slug === plan_slug (no spec file)', async () => {
    writeRsctConfig()
    writeCompletedVerification('feat-eq')
    writePlanTracking('feat-eq')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-eq',
      spec_tier: 'standard',
      plan_slug: 'feat-eq',
      spec_slug: 'feat-eq', // === plan_slug → single-phase, no spec file required
    })
    expect(out.status).toBe('started')
    if (out.status !== 'started') return
    expect(out.plan_tracking_gate.status).toBe('satisfied')
    expect(out.plan_tracking_gate.is_multi_phase).toBe(false)
    expect(out.plan_tracking_gate.phase_spec_present).toBe(null)
  })

  it('rejects (invalid_slug) on a traversal spec_slug even with a valid plan_slug', async () => {
    writeRsctConfig()
    writePlanTracking('okplan')
    const out = await phaseCodeStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-badspec',
      spec_tier: 'standard',
      plan_slug: 'okplan',
      spec_slug: '../evil',
    })
    expect(out.status).toBe('plan_tracking_gate_rejected')
    if (out.status !== 'plan_tracking_gate_rejected') return
    expect(out.plan_tracking_gate.status).toBe('rejected_invalid_slug')
  })

  it('Zod schema and advertised inputSchema expose the same keys (parity)', () => {
    const zodKeys = Object.keys(phaseCodeStartInputSchema.shape).sort()
    const props = (
      phaseCodeStartTool.inputSchema as { properties: Record<string, unknown> }
    ).properties
    const toolKeys = Object.keys(props).sort()
    expect(toolKeys).toEqual(zodKeys)
  })
})

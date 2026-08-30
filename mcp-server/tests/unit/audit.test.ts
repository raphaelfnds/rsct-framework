import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { auditHandler, type AuditOutput } from '../../src/tools/audit.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-audit-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const install = (): void =>
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }),
    'utf8',
  )

function writePhaseState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify(state),
    'utf8',
  )
}

const run = (now?: Date): Promise<AuditOutput> =>
  auditHandler({ project_root: tmpRoot }, now ? { now } : {})

describe('rsct_audit (#55)', () => {
  it('degrades gracefully on an unmanaged project, still listing plans', async () => {
    writeFileSync(join(tmpRoot, 'plan_x.md'), '# Plan\n')
    const r = await run()
    expect(r.rsct_installed).toBe(false)
    expect(r.install_drift).toBeNull()
    expect(r.free_commit_eligibility).toBeNull()
    expect(r.plans.map((p) => p.slug)).toEqual(['x'])
  })

  it('ships a non-empty coverage boundary naming the settings-drift omission', async () => {
    install()
    const r = await run()
    expect(r.coverage_boundary.length).toBeGreaterThan(0)
    expect(r.coverage_boundary.join(' ')).toMatch(/settings\.json/i)
  })

  it('reports install drift in the structured field and NEVER as a hint', async () => {
    install()
    const r = await run()
    // The fixture has no .rsct/scripts/, so every enforcement script reads as
    // absent and the notice is a non-null `security` one. That is PINNED here,
    // not assumed: an earlier version guarded the real assertion behind
    // `if (message)`, which would have evaporated silently the day the fixture
    // changed — the same `if (found) compare` shape this suite rejects elsewhere.
    expect(r.install_drift?.severity).toBe('security')
    expect(r.install_drift?.affected_components.length).toBeGreaterThan(0)
    const message = r.install_drift?.message
    expect(typeof message).toBe('string')
    // rsct_status owns the install-drift HINT (one advisory surface, one dedup
    // rule per pair). Mutation that reddens this: hints.push(drift.hint).
    expect(r.hints).not.toContain(message)
    expect(r.hints.join(' ')).not.toMatch(/enforcement is not running/i)
  })

  it('names free-commit eligibility for what it is, not "unhealthy"', async () => {
    install()
    const r = await run()
    // A fresh install has no audit history, so the fail-closed guard says false.
    // Mutation that reddens this: surface health.reasons raw with no translation.
    expect(r.free_commit_eligibility?.eligible).toBe(false)
    expect(r.free_commit_eligibility?.reasons).toContain('audit_history_absent')
    expect(r.free_commit_eligibility?.explanation).toMatch(/not a fault|NOT a fault/i)
  })

  it('reports open-phase age from the VERIFICATION block when V is the open phase', async () => {
    install()
    // phase-verification-start writes started_at into the verification block and
    // NOT onto PhaseState — reproduced here exactly. Mutation that reddens this:
    // read state.started_at instead.
    writePhaseState({
      phase: 'verification',
      verification: { spec_ref: 's', started_at: '2026-08-20T00:00:00Z' },
    })
    const r = await run(new Date('2026-08-30T00:00:00Z'))
    expect(r.open_phase?.phase).toBe('verification')
    expect(r.open_phase?.started_at).toBe('2026-08-20T00:00:00Z')
    expect(r.open_phase?.age_days).toBe(10)
  })

  it('reports age from PhaseState for every non-V phase', async () => {
    install()
    writePhaseState({ phase: 'code', started_at: '2026-08-28T00:00:00Z' })
    const r = await run(new Date('2026-08-30T00:00:00Z'))
    expect(r.open_phase?.phase).toBe('code')
    expect(r.open_phase?.age_days).toBe(2)
  })

  it('reports a null age rather than fabricating one when no timestamp exists', async () => {
    install()
    // Reachable via a stranded `verification` label from a downgraded binary.
    // Mutation that reddens this: default the missing timestamp to now.
    writePhaseState({ phase: 'verification', verification: { spec_ref: 's' } })
    const r = await run(new Date('2026-08-30T00:00:00Z'))
    expect(r.open_phase?.phase).toBe('verification')
    expect(r.open_phase?.started_at).toBeNull()
    expect(r.open_phase?.age_days).toBeNull()
  })

  it('returns no open_phase when no phase is active', async () => {
    install()
    writePhaseState({ spec_slug: 'x' })
    expect((await run()).open_phase).toBeNull()
  })

  it('never recommends a state-mutating remedy', async () => {
    install()
    writePhaseState({ phase: 'code', started_at: '2026-01-01T00:00:00Z' })
    const r = await run(new Date('2026-08-30T00:00:00Z'))
    // The long-open phase IS reported...
    expect(r.hints.join(' ')).toMatch(/has been open/i)
    // ...but never by pointing at a tool that wipes state. rsct_phase_abandon
    // replaces the whole state object with {}. Mutation that reddens this: add
    // "run rsct_phase_abandon" to the hint.
    expect(r.hints.join(' ')).not.toMatch(/rsct_phase_abandon|rsct_plan_dispose/)
  })

  it('does NOT claim "no .rsct.json" when the config is present but rejected', async () => {
    // rsct_installed:false collapses absent / unreadable / rejected. Reporting a
    // tampered or corrupt config as "not rsct-managed" fabricates a cause, and
    // the bounds check exists precisely to catch a config edited to disable
    // enforcement. Mutation that reddens this: go back to the single hint.
    writeFileSync(join(tmpRoot, '.rsct.json'), '{ not json', 'utf8')
    const r = await run()
    expect(r.rsct_installed).toBe(false)
    expect(r.hints.join(' ')).toMatch(/PRESENT here but was rejected/)
    expect(r.hints.join(' ')).not.toMatch(/no \.rsct\.json/)
  })

  it('discloses the one write it can cause, instead of claiming "no writes"', async () => {
    // Measured: a present-but-rejected .rsct.json makes the SHARED config loader
    // create/append .rsct/audit.log — identically for rsct_status and
    // rsct_load_context. Claiming "read-only, no writes ever" was false.
    // Mutation that reddens this: drop the exception from COVERAGE_BOUNDARY.
    writeFileSync(join(tmpRoot, '.rsct.json'), '{ not json', 'utf8')
    const r = await run()
    expect(r.coverage_boundary.join(' ')).toMatch(/rsct_json\.\* entry in \.rsct\/audit\.log/)
    // ...and the write really does happen, so the disclosure is not theatre.
    expect(existsSync(join(tmpRoot, '.rsct/audit.log'))).toBe(true)
  })

  it('names a genuine fault as a fault, not as a withheld convenience', async () => {
    install()
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/audit.log'), 'x\n', 'utf8')
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), '{ torn', 'utf8')
    const r = await run()
    // Mutation that reddens this: drop the `faults` branch from
    // explainEligibility, lumping a torn phase-state in with a fresh install.
    expect(r.free_commit_eligibility?.eligible).toBe(false)
    expect(r.free_commit_eligibility?.explanation).toMatch(/genuine fault/)
    expect(r.free_commit_eligibility?.explanation).not.toMatch(/NOT a fault/)
  })

  it('actually orders plans by file mtime, not just claims to', async () => {
    install()
    writeFileSync(join(tmpRoot, 'plan_older.md'), '# Plan\n', 'utf8')
    writeFileSync(join(tmpRoot, 'spec_newer.md'), '# Plan\n', 'utf8')
    utimesSync(join(tmpRoot, 'plan_older.md'), 1_000_000, 1_000_000)
    utimesSync(join(tmpRoot, 'spec_newer.md'), 3_000_000, 3_000_000)

    const r = await run()
    // `plans_ordered_by` is a single-member union literal, so changing it is a
    // tsc error rather than a test failure — asserting it alone tested the
    // spelling of a promise, not the promise. This asserts the ORDER, which is
    // what the label claims. Mutation that reddens it: flip the comparator in
    // enumeratePlanFiles.
    expect(r.plans.map((p) => p.slug)).toEqual(['newer', 'older'])
    expect(r.plans_ordered_by).toBe('plan_file_mtime')
  })

  it('emits no long-open hint for a recently started phase', async () => {
    install()
    writePhaseState({ phase: 'code', started_at: '2026-08-28T00:00:00Z' })
    const r = await run(new Date('2026-08-30T00:00:00Z'))
    // Pins the threshold from BELOW. The long-open case alone only caught a
    // RAISED threshold; loosening `>= 7` to `>= 0` went unnoticed.
    expect(r.open_phase?.age_days).toBe(2)
    expect(r.hints.join(' ')).not.toMatch(/has been open/i)
  })

  it('says the project is unmanaged when there really is no .rsct.json', async () => {
    // Mutation that reddens this: delete the hints.push for the absent branch.
    const r = await run()
    expect(r.hints.join(' ')).toMatch(/not rsct-managed \(no \.rsct\.json\)/)
  })

  it('rejects unknown input keys', async () => {
    install()
    await expect(auditHandler({ nope: 1 })).rejects.toThrow()
  })
})

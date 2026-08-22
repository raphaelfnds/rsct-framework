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
import {
  COVERAGE_HINT_PREFIX,
  ZERO_IMPORTER_HINT_PREFIX,
} from '../../src/lib/reverse-dep-walk.js'

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

/**
 * #54 — the honest-coverage report, and the leak it must not become.
 *
 * The reverse-dep walk runs BEFORE the tier branch, and `walk.hints` is spread
 * into the `skipped_tier` return. So a coverage advisory pushed into the walk's
 * own hints would fire from a V phase that verified nothing. The wording lives
 * in the lib; only this tool decides where it is heard.
 */
describe('phase-verification-start — coverage advisory (#54)', () => {
  /** A project the v1 walk cannot analyse, with a corpus-less root. */
  function writeJavaProject(): void {
    writeFile('src/Main.java', 'class Main {}\n')
    writeFile('pom.xml', '<project/>\n')
  }

  const coverageLines = (out: PhaseVerificationStartOutput): string[] =>
    out.hints.filter((h) => h.startsWith(COVERAGE_HINT_PREFIX))

  it('says so on a standard tier — as a HINT, leaving findings empty', async () => {
    // The non-negotiable constraint. Since #40 a declared finding must be
    // answered or `_complete` rejects, so shipping this as a finding would
    // charge every Java / Python / Go project a mandatory action at every V
    // phase, forever.
    //
    // Mutation: emit the advisory as a VerificationFinding instead of a hint.
    writeRsctConfig()
    writeJavaProject()

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-java',
      declared_paths: ['src/Main.java'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('verified')
    expect(out.walk_coverage).toBe('uncovered')
    expect(coverageLines(out)).toHaveLength(2)
    expect(coverageLines(out).join(' ')).toContain('UNAVAILABLE, not empty')
    expect(out.findings).toEqual([])
  })

  it('stays SILENT on a tier-skipped V, which verified nothing', async () => {
    // The live leak: the walk runs at the top of the handler, before the tier
    // branch, and the skip return spreads `walk.hints`. An advisory placed
    // there would announce what a phase that never ran could not analyse.
    //
    // Mutation: push the coverage lines into `walk.hints`, or move the
    // `coverageHints` call above the `skipped_tier` return.
    writeRsctConfig()
    writeJavaProject()

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'trivial-java',
      declared_paths: ['src/Main.java'],
      spec_tier: 'trivial',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
    expect(coverageLines(out)).toEqual([])
    // The FACT still travels — it is the only artifact this run leaves.
    expect(out.walk_coverage).toBe('uncovered')
  })

  it('still EXPLAINS itself on a tier-skipped V — gating the advisory must not create silence', async () => {
    // The regression an earlier revision of this change introduced, caught in
    // review. Suppressing the walk's own zero-importer hint in the two states
    // where it misdiagnoses, while emitting the replacement only from the
    // non-skipped path, left a trivial/small V phase saying NOTHING about a
    // walk that had found nothing — strictly worse than the wrong hint it
    // replaced, and the exact "silence reads as clean" failure this issue
    // exists to remove.
    //
    // Mutation: suppress the zero-importer hint on `coverage === 'uncovered'`
    // without giving it a replacement in `hints`.
    writeRsctConfig()
    writeFile('app.py', 'import os\n')
    writeFile('tailwind.config.js', 'module.exports = {}\n')

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'small-polyglot',
      declared_paths: ['app.py'],
      spec_tier: 'small',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('skipped_tier')
    expect(coverageLines(out)).toEqual([])
    const explanation = out.hints.filter((h) =>
      h.startsWith(ZERO_IMPORTER_HINT_PREFIX),
    )
    expect(explanation).toHaveLength(1)
    expect(explanation[0]).toContain('UNAVAILABLE, not empty')
    // ...and it does not prescribe the action that is wrong here.
    expect(out.hints.some((h) => h.includes('check that seed paths'))).toBe(
      false,
    )
  })

  it('stays silent when another phase blocked the start', async () => {
    // Nothing was verified here either; this return carries its own rejection
    // hint and nothing else.
    //
    // Mutation: push the coverage lines into that return's hint array.
    writeRsctConfig()
    writeJavaProject()
    writeFile('.rsct/phase-state.json', JSON.stringify({ phase: 'code' }))

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'blocked-java',
      declared_paths: ['src/Main.java'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.status).toBe('phase_already_active')
    expect(coverageLines(out)).toEqual([])
  })

  it('says nothing about coverage when no declared paths were given', async () => {
    // `declared_paths` defaults to [], which returns before the scan. A verdict
    // recomputed inside the tool from `walk_stats.files_scanned === 0` would
    // tell this healthy TypeScript project its language is unsupported.
    //
    // Mutation: derive the verdict from `walk.stats.files_scanned` in the tool.
    writeRsctConfig()
    writeFile('src/seed.ts', 'export const x = 1\n')

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'no-paths',
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.walk_coverage).toBe('not-run')
    expect(coverageLines(out)).toEqual([])
  })

  it('says nothing when the walk really did cover the declared paths', async () => {
    // Mutation: make `coverageHints` return a line when coverage is
    // 'analyzed' (emitting it unconditionally from the tool does NOT break
    // this test — for this fixture the function returns [] either way).
    writeRsctConfig()
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-ts',
      declared_paths: ['src/seed.ts'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    expect(out.walk_coverage).toBe('analyzed')
    expect(coverageLines(out)).toEqual([])
  })

  it('is read BEFORE the checklist reassures that nothing was found', async () => {
    // With a corpus that parses but raises nothing, the checklist emits "found
    // no findings to surface against the available corpus". Appended after it,
    // the correction would be read after the sentence it exists to qualify.
    //
    // Mutation: push the coverage lines after `checklist.hints`.
    writeRsctConfig()
    writeJavaProject()
    writeFile(
      'documentation/decisions.md',
      '# Decisions\n\nPlain prose, no decision ids.\n',
    )

    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-order',
      declared_paths: ['src/Main.java'],
      spec_tier: 'standard',
    })) as PhaseVerificationStartOutput

    const reassurance = out.hints.findIndex((h) =>
      h.includes('no findings to surface'),
    )
    const correction = out.hints.findIndex((h) =>
      h.startsWith(COVERAGE_HINT_PREFIX),
    )
    expect(reassurance).toBeGreaterThan(-1)
    expect(correction).toBeGreaterThan(-1)
    expect(correction).toBeLessThan(reassurance)
  })

  it('records the verdict in the audit log on both the start and the skip event', async () => {
    // Hints are not audited, so `discovered_count: 0` used to read identically
    // whether the graph was empty or unavailable.
    //
    // Mutation: drop `walk_coverage` or `uncovered_seed_count` from either event.
    writeRsctConfig()
    writeJavaProject()

    await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-audit-cov',
      declared_paths: ['src/Main.java'],
      spec_tier: 'standard',
    })
    await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-audit-skip',
      declared_paths: ['src/Main.java'],
      spec_tier: 'small',
    })

    const events = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const start = events.find((e) => e.event === 'verification.start')
    expect(start?.walk_coverage).toBe('uncovered')
    expect(start?.uncovered_seed_count).toBe(1)
    // The seed counts alone cannot describe a resolver that dropped every edge
    // while every seed was analyzable, so the third field is not optional.
    expect(start?.unresolved_js_specifiers).toBe(0)

    const skip = events.find((e) => e.event === 'verification.skip')
    expect(skip?.walk_coverage).toBe('uncovered')
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

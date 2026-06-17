import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadContextHandler,
  type LoadContextOutput,
} from '../../src/tools/load-context.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('rsct_load_context', () => {
  it('returns a structured snapshot for an rsct project', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.app_name).toBe('sample-app')
    expect(out.decisions.file_exists).toBe(true)
    expect(out.decisions.premises_count).toBeGreaterThanOrEqual(3)
    expect(out.decisions.adrs_count).toBeGreaterThanOrEqual(5)
    expect(out.decisions.recent_premises[0]?.id).toBe('#3')
    expect(out.decisions.recent_adrs[0]?.id).toBe('ADR-007')
  })

  it('detects active plan and parses metadata', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.active_plan).not.toBeNull()
    expect(out.active_plan?.slug).toBe('sample-task')
    expect(out.active_plan?.status).toBe('approved')
    expect(out.active_plan?.branch).toBe('feat/sample-task')
  })

  it('reports knowledge category coverage', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.knowledge.directory_exists).toBe(true)
    expect(out.knowledge.categories_present).toContain('business-rules')
    expect(out.knowledge.categories_missing.length).toBeGreaterThan(0)
  })

  it('produces a setup hint when no rsct', async () => {
    const out = (await loadContextHandler({ project_root: NO_RSCT })) as LoadContextOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.active_plan).toBeNull()
    expect(out.decisions.file_exists).toBe(false)
    expect(out.next_action_hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('honors decisions_excerpt_count', async () => {
    const out = (await loadContextHandler({
      project_root: SAMPLE_RSCT,
      decisions_excerpt_count: 1,
    })) as LoadContextOutput

    expect(out.decisions.recent_premises.length).toBe(1)
    expect(out.decisions.recent_adrs.length).toBe(1)
  })

  it('rejects out-of-range decisions_excerpt_count', async () => {
    await expect(
      loadContextHandler({ project_root: SAMPLE_RSCT, decisions_excerpt_count: 999 }),
    ).rejects.toThrow()
  })

  it('active_phase is null for the sample fixture (no phase-state.json)', async () => {
    const out = (await loadContextHandler({
      project_root: SAMPLE_RSCT,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })
})

describe('rsct_load_context — active_phase block (CAP-2)', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-lc-phase-'))
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
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  function writePhaseStateFile(state: Record<string, unknown>): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify(state),
      'utf8',
    )
  }

  it('returns null when phase-state.json is absent', async () => {
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })

  it('returns null when phase-state.json has no phase field', async () => {
    writePhaseStateFile({ spec_slug: 'foo' })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })

  it('populates active_phase when phase-state has a phase (no verification)', async () => {
    writePhaseStateFile({
      phase: 'spec',
      spec_slug: 'feat-foo',
      started_at: '2026-06-07T10:00:00.000Z',
      scope_globs: ['src/**/*.ts'],
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).not.toBeNull()
    expect(out.active_phase?.phase).toBe('spec')
    expect(out.active_phase?.spec_slug).toBe('feat-foo')
    expect(out.active_phase?.scope_globs).toEqual(['src/**/*.ts'])
    expect(out.active_phase?.verification).toBeNull()
  })

  it('populates active_phase.verification when phase=verification', async () => {
    writePhaseStateFile({
      phase: 'verification',
      spec_slug: 'feat-bar',
      verification: {
        spec_ref: 'feat-bar',
        spec_tier: 'standard',
        declared_paths: ['src/a.ts'],
        findings: [
          { id: 'v-gap-1', severity: 'address-now' },
          { id: 'v-forgotten-1', severity: 'defer' },
        ],
        started_at: '2026-06-07T11:00:00.000Z',
      },
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase?.verification).not.toBeNull()
    expect(out.active_phase?.verification?.spec_ref).toBe('feat-bar')
    expect(out.active_phase?.verification?.spec_tier).toBe('standard')
    expect(out.active_phase?.verification?.findings_count).toBe(2)
    expect(out.active_phase?.verification?.started_at).toBe(
      '2026-06-07T11:00:00.000Z',
    )
  })

  it('emits a hint when the verification phase is active', async () => {
    writePhaseStateFile({
      phase: 'verification',
      spec_slug: 'feat-baz',
      verification: {
        spec_ref: 'feat-baz',
        spec_tier: 'complex',
        findings: [{ id: 'v-1' }],
      },
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(
      out.next_action_hints.some(
        (h) =>
          h.includes('Active phase: verification') &&
          h.includes('feat-baz'),
      ),
    ).toBe(true)
  })
})

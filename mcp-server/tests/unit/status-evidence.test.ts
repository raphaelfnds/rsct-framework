import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { loadContextHandler } from '../../src/tools/load-context.js'

/**
 * #75, step 4. The two READ surfaces: `rsct_phase_status` (both blocks) and
 * `rsct_load_context`, which is the §0 bootstrap read — the first thing a resumed
 * session sees, and therefore where a missing mix costs the most.
 */

let tmpRoot: string

const MEASURED = {
  kind: 'measured',
  command: 'npx vitest run findings',
  output_excerpt: '163 passed',
  also_explained_by: 'a cached run prints the same totals without executing',
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-stev-'))
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ version: '1' }), 'utf8')
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeState(state: unknown): void {
  writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
}

const V_BLOCK = (findings: unknown[]) => ({
  phase: 'verification',
  spec_slug: 'feat-foo',
  verification: {
    spec_ref: 'feat-foo',
    spec_tier: 'standard',
    findings,
    findings_run_id: 'abc123',
    started_at: '2026-06-07T17:30:00.000Z',
  },
})

describe('rsct_phase_status — the mix on both blocks', () => {
  // MUTATION: return a hard-coded empty mix on the verification block.
  it('T13 — the V block reports the mix, and a legacy finding reads as unrecorded', async () => {
    writeState(
      V_BLOCK([
        { id: 'v-gap-1', category: 'gap', title: 'legacy' },
        { id: 'v-brk-2', category: 'breakage', title: 'measured', evidence: MEASURED },
      ]),
    )
    const out = await phaseStatusHandler({ project_root: tmpRoot })
    expect(out.verification?.evidence_mix).toMatchObject({
      measurable: true,
      total: 2,
      measured: 1,
      hypothesis: 1,
      unrecorded: 1,
    })
  })

  // MUTATION: return a hard-coded empty mix on the review block.
  it('T13b — the REVIEW block reports the mix from the declared set', async () => {
    writeState({
      phase: 'review',
      spec_slug: 'feat-foo',
      review_findings: {
        spec_ref: 'feat-foo',
        run_id: 'r1',
        declared_at: '2026-06-07T17:30:00.000Z',
        findings: [{ id: 'r-1', category: 'bug', title: 'x', evidence: MEASURED }],
      },
    })
    const out = await phaseStatusHandler({ project_root: tmpRoot })
    expect(out.review?.evidence_mix).toMatchObject({ measurable: true, measured: 1, total: 1 })
  })

  // MUTATION: feed `readFindingsBaseline(findings) ?? []` to summarizeEvidence
  // instead of the raw baseline.
  //
  // The guard that keeps "unreadable" distinct from "found nothing". Collapsing
  // null to [] here would report a hand-edited or foreign block as a clean one —
  // a state read as if it were an observation, which is the mechanism this whole
  // issue was opened over.
  it('T19-status — an UNREADABLE baseline is measurable:false, not a clean zero', async () => {
    writeState(V_BLOCK([{ noId: true }, 7]))
    const out = await phaseStatusHandler({ project_root: tmpRoot })
    expect(out.verification?.open_findings).toEqual([])
    expect(out.verification?.evidence_mix.measurable).toBe(false)
  })

  it('T19-status-b — a phase that genuinely raised nothing is measurable:false too, but empty', async () => {
    // readFindingsBaseline returns null for [] as well, by its pre-existing
    // contract. Pinned so a future change to that contract is a visible decision
    // rather than a silent shift in what the dev is shown.
    writeState(V_BLOCK([]))
    const out = await phaseStatusHandler({ project_root: tmpRoot })
    expect(out.verification?.findings_count).toBe(0)
    expect(out.verification?.evidence_mix).toMatchObject({ measurable: false, total: 0 })
  })
})

describe('rsct_load_context — the mix on the §0 bootstrap read (V-7)', () => {
  // MUTATION: drop `evidence_mix` from buildActivePhase's verification summary.
  it('T13c — a resumed session sees the mix, not only a count', async () => {
    writeState(
      V_BLOCK([
        { id: 'v-gap-1', category: 'gap', title: 'legacy' },
        { id: 'v-gap-2', category: 'gap', title: 'legacy2' },
        { id: 'v-brk-3', category: 'breakage', title: 'real', evidence: MEASURED },
      ]),
    )
    const out = await loadContextHandler({ project_root: tmpRoot })
    expect(out.active_phase?.verification?.findings_count).toBe(3)
    expect(out.active_phase?.verification?.evidence_mix).toMatchObject({
      measurable: true,
      total: 3,
      measured: 1,
      hypothesis: 2,
      unrecorded: 2,
    })
  })

  // MUTATION: default the missing baseline to `[]` here as well.
  it('T13d — bootstrap reports an unreadable baseline as unmeasurable', async () => {
    writeState(V_BLOCK([{ noId: true }]))
    const out = await loadContextHandler({ project_root: tmpRoot })
    expect(out.active_phase?.verification?.evidence_mix.measurable).toBe(false)
  })
})

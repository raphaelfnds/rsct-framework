import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { initSweepRepo } from '../sweep-repo.js'

let tmpRoot: string
const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rev-'))
  initSweepRepo(tmpRoot)
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ version: '1' }), 'utf8')
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const MEASURED = {
  kind: 'measured' as const,
  command: 'npx vitest run findings',
  output_excerpt: '163 passed',
  also_explained_by: 'a cached run would print the same totals without executing',
}

function start(findings: unknown[]) {
  return phaseReviewStartHandler(
    { project_root: tmpRoot, spec_ref: 'feat-foo', findings },
    { now: FIXED_NOW },
  )
}

describe('rsct_phase_review_start — the declaration door', () => {
  it('T9 — a finding with NO evidence is accepted, and counts as unrecorded', async () => {
    const out = await start([{ id: 'r-1', category: 'bug', title: 'x' }])
    expect(out.status).toBe('started')
    expect(out.evidence_mix).toMatchObject({
      measurable: true,
      total: 1,
      measured: 0,
      hypothesis: 1,
      unrecorded: 1,
    })
  })

  it('T8 — claiming `measured` without a command is REJECTED at the door', async () => {
    await expect(
      start([
        {
          id: 'r-1',
          category: 'bug',
          title: 'x',
          evidence: { kind: 'measured', output_excerpt: 'o', also_explained_by: 'a' },
        },
      ]),
    ).rejects.toThrow()
  })

  it('T8b — an unrecognised kind is rejected at the door, not silently stored', async () => {
    await expect(
      start([{ id: 'r-1', category: 'bug', title: 'x', evidence: { kind: 'guess' } }]),
    ).rejects.toThrow()
  })

  it('T-mix — a well-formed measured declaration is counted and echoed back', async () => {
    const out = await start([
      { id: 'r-1', category: 'bug', title: 'real', evidence: MEASURED },
      { id: 'r-2', category: 'bug', title: 'guess' },
    ])
    expect(out.evidence_mix).toMatchObject({ measured: 1, hypothesis: 1, unrecorded: 1, total: 2 })
    expect(out.findings[0]?.evidence).toEqual(MEASURED)
    expect(out.hints.some((h) => h.includes('1 measured'))).toBe(true)
  })
})

describe('rsct_phase_review_complete — the mix reaches the dev', () => {
  async function complete(
    promptFn: (o: DialogOptions) => Promise<DialogResult>,
    internalExtra: Record<string, unknown> = {},
  ) {
    return phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings_actions: [{ finding_id: 'r-1', action: 'accept' }],
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'review_complete:spec_ref=feat-foo',
          reason: 'ok',
        },
      },
      { now: FIXED_NOW, promptFn, ...internalExtra },
    )
  }

  it('T22a — the dialog carries the mix, appended to the generic line, not replacing it', async () => {
    await start([{ id: 'r-1', category: 'bug', title: 'x' }])
    const seen: DialogOptions[] = []
    await complete(async (o) => {
      seen.push(o)
      return { response: 'yes', channel: 'env-override' }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.message).toContain('Evidence:')
    expect(seen[0]!.message).toContain('1 unrecorded')
    expect(seen[0]!.message).toContain('Complete the review phase')
  })

  it('T22 — production’s mix wins over a dialogDetail supplied by the caller', async () => {
    await start([{ id: 'r-1', category: 'bug', title: 'x' }])
    const seen: DialogOptions[] = []
    await complete(
      async (o) => {
        seen.push(o)
        return { response: 'yes', channel: 'env-override' }
      },
      { dialogDetail: 'INJECTED-SHOULD-NOT-WIN' },
    )
    expect(seen[0]!.message).not.toContain('INJECTED-SHOULD-NOT-WIN')
    expect(seen[0]!.message).toContain('Evidence:')
  })

  it('T6-headless — the mix is in hints too, not only in the dialog', async () => {
    await start([{ id: 'r-1', category: 'bug', title: 'x', evidence: MEASURED }])
    const out = await complete(async () => ({ response: 'yes', channel: 'env-override' }))
    expect(out.hints.some((h) => h.includes('Evidence:') && h.includes('1 measured'))).toBe(true)
    expect(out.evidence_mix).toMatchObject({ measured: 1, total: 1 })
  })

  it('T-baseline — the mix comes from the stored baseline, not from the actions', async () => {
    await start([{ id: 'r-1', category: 'bug', title: 'x', evidence: MEASURED }])
    const out = await complete(async () => ({ response: 'yes', channel: 'env-override' }))
    expect(out.evidence_mix.measured).toBe(1)
    expect(out.evidence_mix.unrecorded).toBe(0)
  })

  it('T19-review — no declared findings reads as UNMEASURABLE, not as a clean zero', async () => {
    await start([])
    const out = await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings_actions: [],
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'review_complete:spec_ref=feat-foo',
          reason: 'ok',
        },
      },
      { now: FIXED_NOW, promptFn: async () => ({ response: 'yes', channel: 'env-override' }) },
    )
    expect(out.evidence_mix.measurable).toBe(false)
    expect(out.hints.some((h) => h.includes('unavailable'))).toBe(true)
  })
})

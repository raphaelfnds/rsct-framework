import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  checkFindingsGate,
  computeRunId,
  readFindingsBaseline,
} from '../../src/lib/findings.js'
import {
  phaseVerificationCompleteHandler,
  type PhaseVerificationCompleteOutput,
} from '../../src/tools/phase-verification-complete.js'
import {
  phaseReviewStartHandler,
  type PhaseReviewStartOutput,
} from '../../src/tools/phase-review-start.js'
import {
  phaseReviewCompleteHandler,
  type PhaseReviewCompleteOutput,
} from '../../src/tools/phase-review-complete.js'
import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { phaseVerificationStartHandler } from '../../src/tools/phase-verification-start.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { initSweepRepo } from '../sweep-repo.js'

let tmpRoot: string
const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}
function readState(): Record<string, any> {
  return JSON.parse(readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'))
}
function auditEntries(): Record<string, any>[] {
  const p = join(tmpRoot, '.rsct/audit.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
}
function auditEvents(): string[] {
  return auditEntries().map((e) => e.event as string)
}
function writeRsctConfig(): void {
  writeFile(
    '.rsct.json',
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }),
  )
}
const F1 = { id: 'v-gap-1', category: 'gap', title: 'Claim conflicts with AD-2' }
const F2 = { id: 'v-breakage-2', category: 'breakage', title: 'Edits affect 3 importers' }

const DEGRADED = {
  kind: 'hypothesis',
  how_to_falsify: expect.stringContaining('no evidence class was supplied'),
  degraded: true,
  degraded_from: 'absent',
}
function withEvidence<T extends object>(f: T): T & { evidence: typeof DEGRADED } {
  return { ...f, evidence: DEGRADED }
}

function seedVerification(findings: unknown[], runId?: string): void {
  const block: Record<string, unknown> = {
    spec_ref: 'feat-foo',
    spec_tier: 'standard',
    declared_paths: ['src/foo.ts'],
    discovered_importers: [],
    findings,
    started_at: '2026-06-07T17:30:00.000Z',
  }
  if (runId !== undefined) block.findings_run_id = runId
  writeFile(
    '.rsct/phase-state.json',
    JSON.stringify({ phase: 'verification', spec_slug: 'feat-foo', verification: block }),
  )
}
function approval(scope = 'verification_complete:spec_ref=feat-foo') {
  return { timestamp: VALID_TS, action_scope: scope, reason: 'reviewed the findings' }
}
let dialogShown = false
const alwaysYes = async (_o: DialogOptions): Promise<DialogResult> => {
  dialogShown = true
  return { response: 'yes', channel: 'windows' }
}
async function completeV(
  actions: { finding_id: string; action: string }[],
  runId?: string,
): Promise<PhaseVerificationCompleteOutput> {
  return (await phaseVerificationCompleteHandler(
    {
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      dev_approval: approval(),
      findings_actions: actions,
      ...(runId !== undefined ? { findings_run_id: runId } : {}),
    },
    { now: FIXED_NOW, promptFn: alwaysYes },
  )) as PhaseVerificationCompleteOutput
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-fgate-'))
  initSweepRepo(tmpRoot)
  dialogShown = false
  writeRsctConfig()
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('lib/findings — readFindingsBaseline', () => {
  it('returns null for every shape that is not a usable baseline', () => {
    for (const raw of [undefined, null, [], 'nope', 42, {}, [null], [{ noId: 1 }], [{ id: '' }]]) {
      expect(readFindingsBaseline(raw)).toBeNull()
    }
  })
  it('keeps only entries with a usable id, carrying category/title when present', () => {
    expect(readFindingsBaseline([F1, { id: 'x' }, { noId: true }, 7])).toEqual([
      withEvidence(F1),
      withEvidence({ id: 'x' }),
    ])
  })
})

describe('lib/findings — computeRunId', () => {
  it('is order-independent and changes with the set', () => {
    expect(computeRunId([F1, F2])).toBe(computeRunId([F2, F1]))
    expect(computeRunId([F1])).not.toBe(computeRunId([F1, F2]))
  })
})

describe('lib/findings — checkFindingsGate', () => {
  const base = { storedRunId: null, suppliedRunId: null }
  it('fails OPEN with no baseline — any actions pass', () => {
    expect(checkFindingsGate({ ...base, baseline: null, actions: [{ finding_id: 'made-up' }] }).ok).toBe(true)
  })
  it('rejects an unknown id and lists the valid set', () => {
    const r = checkFindingsGate({ ...base, baseline: [F1], actions: [{ finding_id: 'nope' }] })
    expect(r.reject_kind).toBe('unknown_finding_ids')
    expect(r.reason).toContain('v-gap-1')
  })
  it('rejects an unanswered finding, naming it with its title', () => {
    const r = checkFindingsGate({ ...base, baseline: [F1, F2], actions: [{ finding_id: 'v-gap-1' }] })
    expect(r.reject_kind).toBe('unanswered_findings')
    expect(r.reason).toContain('Edits affect 3 importers')
    expect(r.open_findings).toEqual([F2])
  })
  it('rejects a duplicate id', () => {
    const r = checkFindingsGate({
      ...base,
      baseline: [F1],
      actions: [{ finding_id: 'v-gap-1' }, { finding_id: 'v-gap-1' }],
    })
    expect(r.reject_kind).toBe('duplicate_finding_ids')
  })
  it('rejects a supplied-but-stale run id, and accepts the current one', () => {
    const stored = computeRunId([F1])
    const args = { baseline: [F1], storedRunId: stored, actions: [{ finding_id: 'v-gap-1' }] }
    expect(checkFindingsGate({ ...args, suppliedRunId: 'older' }).reject_kind).toBe('stale_finding_run')
    expect(checkFindingsGate({ ...args, suppliedRunId: stored }).ok).toBe(true)
  })

  it('an absent run id falls through to the id checks', () => {
    const args = { baseline: [F1, F2], storedRunId: computeRunId([F1, F2]), suppliedRunId: null }
    expect(checkFindingsGate({ ...args, actions: [{ finding_id: 'v-gap-1' }] }).reject_kind).toBe(
      'unanswered_findings',
    )
    expect(checkFindingsGate({ ...args, actions: [{ finding_id: 'ghost' }] }).reject_kind).toBe(
      'unknown_finding_ids',
    )
    expect(
      checkFindingsGate({
        ...args,
        actions: [{ finding_id: 'v-gap-1' }, { finding_id: 'v-breakage-2' }],
      }).ok,
    ).toBe(true)
  })
  it('run identity outranks id errors — a moved set is not a per-id problem', () => {
    const base = { baseline: [F1], storedRunId: 'current', suppliedRunId: 'stale' }
    expect(checkFindingsGate({ ...base, actions: [{ finding_id: 'ghost' }] }).reject_kind).toBe(
      'stale_finding_run',
    )
    expect(
      checkFindingsGate({
        ...base,
        actions: [{ finding_id: 'v-gap-1' }, { finding_id: 'v-gap-1' }],
      }).reject_kind,
    ).toBe('stale_finding_run')
    expect(checkFindingsGate({ ...base, actions: [] }).reject_kind).toBe('stale_finding_run')
  })

  it('refuses a baseline belonging to a different spec_ref', () => {
    const r = checkFindingsGate({
      ...base,
      baseline: [F1],
      storedSpecRef: 'spec-a',
      specRef: 'spec-b',
      actions: [{ finding_id: 'v-gap-1' }],
    })
    expect(r.reject_kind).toBe('findings_spec_mismatch')
    expect(r.reason).toContain('spec-a')
    expect(
      checkFindingsGate({
        ...base,
        baseline: [F1],
        storedSpecRef: 'spec-a',
        specRef: 'spec-a',
        actions: [{ finding_id: 'v-gap-1' }],
      }).ok,
    ).toBe(true)
  })

  it('refuses a baseline that reuses an id', () => {
    const r = checkFindingsGate({
      ...base,
      baseline: [F1, { id: 'v-gap-1', category: 'gap', title: 'a different problem' }],
      actions: [{ finding_id: 'v-gap-1' }],
    })
    expect(r.reject_kind).toBe('ambiguous_baseline')
  })
})

describe('rsct_phase_verification_complete — the gate binds (#40)', () => {
  it('an unknown id rejects before the dialog, logs the rejection, does not complete', async () => {
    seedVerification([F1], computeRunId([F1]))
    const out = await completeV([{ finding_id: 'v-ghost-9', action: 'accept' }], computeRunId([F1]))
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('unknown_finding_ids')
    expect(dialogShown).toBe(false)
    expect(auditEvents()).toContain('verification.complete.rejected')
    expect(auditEvents()).not.toContain('verification.action')
    expect(readState().verification.completed_at).toBeUndefined()
    const ok = await completeV([{ finding_id: 'v-gap-1', action: 'accept' }], computeRunId([F1]))
    expect(ok.status).toBe('completed')
  })

  it('an unanswered finding rejects and the payload carries it back', async () => {
    seedVerification([F1, F2], computeRunId([F1, F2]))
    const out = await completeV([{ finding_id: 'v-gap-1', action: 'accept' }], computeRunId([F1, F2]))
    expect(out.reject_kind).toBe('unanswered_findings')
    expect(out.open_findings).toEqual([withEvidence(F2)])
    expect(out.reason).toContain('v-breakage-2')
  })

  it('answering every finding completes and logs one action each', async () => {
    seedVerification([F1, F2], computeRunId([F1, F2]))
    const out = await completeV(
      [
        { finding_id: 'v-gap-1', action: 'accept' },
        { finding_id: 'v-breakage-2', action: 'defer' },
      ],
      computeRunId([F1, F2]),
    )
    expect(out.status).toBe('completed')
    expect(auditEvents().filter((e) => e === 'verification.action')).toHaveLength(2)
  })

  it('a duplicated id rejects even when every finding is covered', async () => {
    seedVerification([F1], computeRunId([F1]))
    const out = await completeV(
      [
        { finding_id: 'v-gap-1', action: 'accept' },
        { finding_id: 'v-gap-1', action: 'defer' },
      ],
      computeRunId([F1]),
    )
    expect(out.reject_kind).toBe('duplicate_finding_ids')
  })

  it('an unknown id outranks a block action — report the ghost, not the action', async () => {
    seedVerification([F1], computeRunId([F1]))
    const out = await completeV([{ finding_id: 'v-ghost-9', action: 'block' }], computeRunId([F1]))
    expect(out.reject_kind).toBe('unknown_finding_ids')
  })

  it('a stale run id rejects with the open set', async () => {
    seedVerification([F1, F2], computeRunId([F1, F2]))
    const out = await completeV(
      [
        { finding_id: 'v-gap-1', action: 'accept' },
        { finding_id: 'v-breakage-2', action: 'defer' },
      ],
      'from-an-earlier-run',
    )
    expect(out.reject_kind).toBe('stale_finding_run')
    expect(out.open_findings).toHaveLength(2)
  })

  it.each([
    ['key absent', undefined],
    ['empty array', []],
    ['null', null],
    ['ids missing', [{ category: 'gap', title: 'no id here' }]],
    ['not an array', 'corrupted'],
  ])('fails OPEN when the baseline is unusable: %s', async (_label, findings) => {
    seedVerification(findings as unknown[])
    const out = await completeV([{ finding_id: 'anything', action: 'accept' }])
    expect(out.status).toBe('completed')
  })

  it('_start actually produces the run id it tells the agent to echo', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    const started = await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'feat-foo',
      spec_tier: 'standard',
      declared_paths: ['src/foo.ts'],
    })
    expect(started.findings_run_id).toBe(computeRunId(started.findings))
    expect(readState().verification.findings_run_id).toBe(started.findings_run_id)
    expect(started.hints.join(' ')).toContain(started.findings_run_id!)
  })

  it('phase_status lists the open findings so a resumed session can answer them', async () => {
    seedVerification([F1, F2], computeRunId([F1, F2]))
    const st = await phaseStatusHandler({ project_root: tmpRoot })
    expect(st.verification?.open_findings).toEqual([withEvidence(F1), withEvidence(F2)])
    expect(st.verification?.findings_run_id).toBe(computeRunId([F1, F2]))
  })
})

describe('rsct_phase_review_start — declared baseline (#40)', () => {
  const R1 = { id: 'r-bug-1', category: 'correctness', title: 'Off-by-one in the retry loop' }
  const R2 = { id: 'r-sec-2', category: 'security', title: 'Token logged at debug level' }

  async function startReview(findings?: unknown[]): Promise<PhaseReviewStartOutput> {
    return (await phaseReviewStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        ...(findings !== undefined ? { findings } : {}),
      },
      { now: FIXED_NOW },
    )) as PhaseReviewStartOutput
  }

  it('stores the findings and echoes them with a run id', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    const out = await startReview([R1, R2])
    expect(out.findings_run_id).toBe(computeRunId([R1, R2]))
    expect(out.findings).toEqual([R1, R2])
    const s = readState()
    expect(s.review_findings.findings).toEqual([R1, R2])
    expect(s.phase).toBe('review')
  })

  it('starting a review never stamps a review block or a sweep ledger', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    await startReview([R1])
    expect(readState().review).toBeUndefined()
    expect(readState().review_sweep).toBeUndefined()
  })

  it('re-running replaces the set, clears completed_at, and warns that answers are stale', async () => {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        spec_slug: 'feat-foo',
        review: { spec_ref: 'feat-foo', decision: 'yes', completed_at: FIXED_NOW.toISOString() },
      }),
    )
    await startReview([R1, R2])
    const second = await startReview([R1])
    expect(readState().review_findings.findings).toEqual([R1])
    expect(readState().review.completed_at).toBeUndefined()
    expect(readState().review.decision).toBe('yes')
    expect(second.hints.some((h) => /stale/.test(h))).toBe(true)
  })

  it('the first start warns about nothing', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    const out = await startReview([R1])
    expect(out.hints.some((h) => /stale/.test(h))).toBe(false)
  })

  it('restarting with no findings clears a stale set, and logs what it discarded', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    await startReview([R1, R2])
    await startReview()
    expect(readState().review_findings).toBeUndefined()
    const replaced = auditEntries().find((e) => e.event === 'review.findings_replaced')
    expect(replaced).toBeDefined()
    expect(replaced!.discarded_ids).toEqual(['r-bug-1', 'r-sec-2'])
    expect(replaced!.declared_count).toBe(0)
  })

  it('reopens a completed review even when the restart declares nothing', async () => {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        spec_slug: 'feat-foo',
        review: { spec_ref: 'feat-foo', decision: 'yes', completed_at: FIXED_NOW.toISOString() },
      }),
    )
    await startReview()
    expect(readState().review.completed_at).toBeUndefined()
  })

  it('refuses a declared set that reuses an id', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ spec_slug: 'feat-foo' }))
    await expect(startReview([R1, { ...R2, id: R1.id }])).rejects.toThrow(/distinct id/)
    expect(readState().review_findings).toBeUndefined()
  })

  it('does not advertise findings when the write did not happen', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ phase: 'code', spec_slug: 'feat-foo' }))
    const out = await startReview([R1])
    expect(out.status).toBe('phase_already_active')
    expect(out.findings).toEqual([])
    expect(out.findings_run_id).toBeNull()
  })

  it('still refuses when a DIFFERENT phase is active (the generic guard is intact)', async () => {
    writeFile('.rsct/phase-state.json', JSON.stringify({ phase: 'code', spec_slug: 'feat-foo' }))
    const out = await startReview([R1])
    expect(out.status).toBe('phase_already_active')
    expect(readState().phase).toBe('code')
    expect(readState().review_findings).toBeUndefined()
  })

  it('still clears a stale completed-V label (#15 intact)', async () => {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        phase: 'verification',
        spec_slug: 'feat-foo',
        verification: { spec_ref: 'feat-foo', completed_at: FIXED_NOW.toISOString() },
      }),
    )
    const out = await startReview([R1])
    expect(out.status).toBe('started')
    expect(readState().phase).toBe('review')
  })
})

describe('rsct_phase_review_complete — coverage and prune (#40)', () => {
  const R1 = { id: 'r-bug-1', category: 'correctness', title: 'Off-by-one in the retry loop' }
  const R2 = { id: 'r-sec-2', category: 'security', title: 'Token logged at debug level' }

  function seedDeclaredReview(findings: unknown[]): void {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        phase: 'review',
        spec_slug: 'feat-foo',
        started_at: '2026-06-07T17:30:00.000Z',
        review: { spec_ref: 'feat-foo', decision: 'yes', decided_at: VALID_TS },
        review_findings: {
          spec_ref: 'feat-foo',
          run_id: computeRunId(findings as { id: string }[]),
          findings,
          declared_at: '2026-06-07T17:31:00.000Z',
        },
      }),
    )
  }
  async function completeReview(
    actions: { finding_id: string; action: string }[],
    runId?: string,
  ): Promise<PhaseReviewCompleteOutput> {
    return (await phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        dev_approval: { timestamp: VALID_TS, action_scope: 'review_complete:spec_ref=feat-foo', reason: 'reviewed' },
        findings_actions: actions,
        ...(runId !== undefined ? { findings_run_id: runId } : {}),
      },
      { now: FIXED_NOW, promptFn: alwaysYes },
    )) as PhaseReviewCompleteOutput
  }

  it('answering nothing no longer closes the phase', async () => {
    seedDeclaredReview([R1, R2])
    const out = await completeReview([])
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('unanswered_findings')
    expect(out.open_findings).toHaveLength(2)
    expect(dialogShown).toBe(false)
    expect(readState().review.completed_at).toBeUndefined()
  })

  it('answering everything completes and prunes the findings', async () => {
    seedDeclaredReview([R1, R2])
    const out = await completeReview(
      [
        { finding_id: 'r-bug-1', action: 'address-now' },
        { finding_id: 'r-sec-2', action: 'capture-as-issue' },
      ],
      computeRunId([R1, R2]),
    )
    expect(out.status).toBe('completed')
    const s = readState()
    expect(s.review_findings).toBeUndefined()
    expect(s.review.completed_at).toBe(FIXED_NOW.toISOString())
    expect(auditEvents().filter((e) => e === 'review.action')).toHaveLength(2)
  })

  it('a REJECTED complete does not prune', async () => {
    seedDeclaredReview([R1, R2])
    await completeReview([{ finding_id: 'r-bug-1', action: 'accept' }])
    expect(readState().review_findings.findings).toHaveLength(2)
  })

  it('with no declared baseline it still completes (legacy reviews keep working)', async () => {
    writeFile(
      '.rsct/phase-state.json',
      JSON.stringify({
        phase: 'review',
        spec_slug: 'feat-foo',
        started_at: '2026-06-07T17:30:00.000Z',
        review: { spec_ref: 'feat-foo', decision: 'yes', decided_at: VALID_TS },
      }),
    )
    const out = await completeReview([])
    expect(out.status).toBe('completed')
  })
})

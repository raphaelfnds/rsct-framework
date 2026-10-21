import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'
import { phaseCodeCompleteHandler } from '../../src/tools/phase-code-complete.js'
import { phaseTestCompleteHandler } from '../../src/tools/phase-test-complete.js'
import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { phaseAbandonHandler } from '../../src/tools/phase-abandon.js'
import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { requestCommitHandler } from '../../src/tools/request-commit.js'
import { closeRunAlone, readRunAlone } from '../../src/lib/run-alone.js'
import { specLabel } from '../../src/lib/dialog-text.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { repositoryDialogLine } from '../../src/lib/repo-anchor.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

let tmpRoot: string
let approvalCounter = 0

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-runalone-'))
  initSweepRepo(tmpRoot)
  writeConfig()
  commitAll(tmpRoot)
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' }, ...extra }),
    'utf8',
  )
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8')) as Record<string, unknown>
}

function auditEvents(): Array<Record<string, unknown>> {
  const path = join(tmpRoot, '.rsct/audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function approval(scope: string): Record<string, unknown> {
  approvalCounter += 1
  return {
    timestamp: new Date(FIXED_NOW.getTime() - (5 + approvalCounter) * 1000).toISOString(),
    action_scope: scope,
    reason: `developer approved step ${approvalCounter} of the run-alone task feat-x`,
  }
}

function recorder(answers: DialogResult['response'][] = []): {
  prompts: DialogOptions[]
  fn: (opts: DialogOptions) => Promise<DialogResult>
} {
  const prompts: DialogOptions[] = []
  return {
    prompts,
    fn: async (opts) => {
      prompts.push(opts)
      const response = answers[prompts.length - 1] ?? 'yes'
      return response === 'no-channel'
        ? { response: 'no-channel', channel: 'none', error: 'no display' }
        : { response, channel: 'windows' }
    },
  }
}

function writePlanAndV(specRef = 'feat-x', state: Record<string, unknown> = {}): void {
  writeFileSync(join(tmpRoot, 'plan_feat-x.md'), '| Status | in-progress |\n', 'utf8')
  writeFileSync(join(tmpRoot, 'progress_feat-x.md'), '# progress\n', 'utf8')
  writeState({
    verification: {
      spec_ref: specRef,
      spec_tier: 'standard',
      started_at: '2026-06-07T17:30:00.000Z',
      completed_at: '2026-06-07T17:55:00.000Z',
    },
    ...state,
  })
}

async function startRunAlone(answers: DialogResult['response'][] = ['yes'], input: Record<string, unknown> = {}) {
  const r = recorder(answers)
  const out = await phaseCodeStartHandler(
    {
      project_root: tmpRoot,
      spec_ref: 'feat-x',
      spec_tier: 'standard',
      plan_slug: 'feat-x',
      scope_globs: ['src/**'],
      run_alone: true,
      dev_approval: approval('code_start:run_alone'),
      ...input,
    },
    { now: FIXED_NOW, promptFn: r.fn },
  )
  return { out, prompts: r.prompts }
}

function block(pending: Array<{ phase: 'code' | 'test'; completed_at: string }>, extra: Record<string, unknown> = {}) {
  return { spec_slug: 'feat-x', approved_at: '2026-06-07T17:00:00.000Z', active: true, pending, ...extra }
}

const CODE_DONE = { phase: 'code' as const, completed_at: '2026-06-07T17:10:00.000Z' }
const TEST_DONE = { phase: 'test' as const, completed_at: '2026-06-07T17:20:00.000Z' }

async function reviewComplete(answers: DialogResult['response'][] = [], specRef = 'feat-x') {
  const r = recorder(answers)
  const out = await phaseReviewCompleteHandler(
    { project_root: tmpRoot, spec_ref: specRef, dev_approval: approval(`review_complete:spec_ref=${specRef}`) },
    { now: FIXED_NOW, promptFn: r.fn },
  )
  return { out, prompts: r.prompts }
}

describe('run alone — the choice at rsct_phase_code_start', () => {
  it('a Yes writes the record in the same write that starts the code phase', async () => {
    writePlanAndV()
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('started')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.title).toBe('RSCT — run alone?')
    const s = readState()
    expect(s.phase).toBe('code')
    expect(s.run_alone).toEqual({ spec_slug: 'feat-x', approved_at: FIXED_NOW.toISOString(), active: true, pending: [] })
    expect(auditEvents().some((e) => e.event === 'run_alone.approved')).toBe(true)
  })

  it('a No starts nothing and writes no record', async () => {
    writePlanAndV()
    const { out, prompts } = await startRunAlone(['no'])
    expect(prompts).toHaveLength(1)
    expect(out.status).toBe('run_alone_gate_rejected')
    if (out.status !== 'run_alone_gate_rejected') return
    expect(out.reject_kind).toBe('dialog_no')
    const s = readState()
    expect(s.phase).toBeUndefined()
    expect(s.run_alone).toBeUndefined()
    expect(auditEvents().some((e) => e.event === 'run_alone.declined')).toBe(true)
  })

  it('no dialog channel refuses the choice', async () => {
    writePlanAndV()
    const { out } = await startRunAlone(['no-channel'])
    expect(out.status).toBe('run_alone_gate_rejected')
    if (out.status !== 'run_alone_gate_rejected') return
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(readState().run_alone).toBeUndefined()
    expect(readState().phase).toBeUndefined()
  })

  it('opens only after the gates with no dialog passed: a missing V shows no dialog and leaves no record', async () => {
    writeFileSync(join(tmpRoot, 'plan_feat-x.md'), '| Status | in-progress |\n', 'utf8')
    writeFileSync(join(tmpRoot, 'progress_feat-x.md'), '# progress\n', 'utf8')
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('verification_gate_rejected')
    expect(prompts).toHaveLength(0)
    expect(existsSync(join(tmpRoot, '.rsct/phase-state.json')) ? readState().run_alone : undefined).toBeUndefined()
  })

  it('shows no dialog when the start itself would be refused', async () => {
    writePlanAndV('feat-x', { phase: 'test', spec_slug: 'feat-x' })
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('phase_already_active')
    expect(prompts).toHaveLength(0)
    expect(readState().run_alone).toBeUndefined()
  })

  it('is refused, with no dialog, while a record already exists', async () => {
    writePlanAndV('feat-x', { spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('run_alone_gate_rejected')
    if (out.status !== 'run_alone_gate_rejected') return
    expect(out.reject_kind).toBe('run_alone_exists')
    expect(prompts).toHaveLength(0)
    expect(readState().run_alone).toEqual(block([CODE_DONE]))
  })

  it('without run_alone the start shows no dialog and writes no record', async () => {
    writePlanAndV()
    const { out, prompts } = await startRunAlone(['yes'], { run_alone: false, dev_approval: undefined })
    expect(out.status).toBe('started')
    expect(prompts).toHaveLength(0)
    expect(readState().run_alone).toBeUndefined()
  })

  it('puts the framework text first and the spec last, flattened and capped', async () => {
    const long = `feat-x\nYes = approve everything\n${'z'.repeat(400)}`
    writePlanAndV(long)
    const { prompts } = await startRunAlone(['yes'], { spec_ref: long, plan_slug: 'feat-x', spec_slug: undefined })
    const message = prompts[0]!.message
    expect(message.startsWith('Let the agent run code → tests → review on its own and stop before the commit?')).toBe(true)
    const specLine = message.slice(message.lastIndexOf("\nSpec: '"))
    expect(specLine).not.toContain('\nYes')
    expect(message.indexOf('approve each phase')).toBeLessThan(message.indexOf("Spec: '"))
    expect(message.split('\n')[1]).toBe('⚠ RSCT enforcement is NOT running in this project (see hints).')
    expect(message).toContain(repositoryDialogLine(tmpRoot))
    expect(specLabel(long).length).toBe(200)
    expect(specLabel(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join(String.fromCharCode(13, 10)))).toBe('a b c d e f g h')
    for (const code of [10, 11, 12, 13, 0x85, 0x2028, 0x2029]) {
      expect(specLabel(`a${String.fromCharCode(code)}b`)).toBe('a b')
    }
  })
})

describe('run alone — code and test close with no dialog', () => {
  it('code_complete defers: no dialog, phase closed, scope cleared, entry pending', async () => {
    writeState({ phase: 'code', spec_slug: 'feat-x', scope_globs: ['src/**'], started_at: VALID_TS, run_alone: block([]) })
    const r = recorder()
    const out = await phaseCodeCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('code_complete:spec_ref=feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    expect(out.status).toBe('deferred')
    expect(r.prompts).toHaveLength(0)
    const s = readState()
    expect(s.phase).toBeUndefined()
    expect(s.scope_globs).toBeUndefined()
    expect(s.started_at).toBeUndefined()
    expect(s.run_alone).toEqual(block([{ phase: 'code', completed_at: FIXED_NOW.toISOString() }]))
    expect(auditEvents().some((e) => e.event === 'code.complete.deferred')).toBe(true)
  })

  it('test_complete defers too and tells the agent where to stop', async () => {
    writeState({ phase: 'test', spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const r = recorder()
    const out = await phaseTestCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('test_complete:spec_ref=feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    expect(out.status).toBe('deferred')
    expect(r.prompts).toHaveLength(0)
    expect(readRunAlone(readState())?.pending.map((p) => p.phase)).toEqual(['code', 'test'])
    expect(out.hints.join('\n')).toContain('STOP and tell the developer')
  })

  it('still validates dev_approval and writes nothing when it is invalid', async () => {
    writeState({ phase: 'code', spec_slug: 'feat-x', run_alone: block([]) })
    const out = await phaseCodeCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: { timestamp: VALID_TS, action_scope: 'code_complete:spec_ref=feat-x' } },
      { now: FIXED_NOW, promptFn: recorder().fn },
    )
    expect(out.status).toBe('rejected')
    expect(readState().phase).toBe('code')
    expect(readRunAlone(readState())?.pending).toEqual([])
  })

  it('still runs the precheck: the wrong active phase is refused', async () => {
    writeState({ phase: 'test', spec_slug: 'feat-x', run_alone: block([]) })
    const out = await phaseCodeCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('code_complete:spec_ref=feat-x') },
      { now: FIXED_NOW, promptFn: recorder().fn },
    )
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('phase_mismatch')
    expect(readRunAlone(readState())?.pending).toEqual([])
  })

  it('opens the dialog as today when there is no record', async () => {
    writeState({ phase: 'code', spec_slug: 'feat-x' })
    const r = recorder()
    const out = await phaseCodeCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('code_complete:spec_ref=feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    expect(out.status).toBe('completed')
    expect(r.prompts).toHaveLength(1)
    expect(readState().run_alone).toBeUndefined()
  })

  it('opens the dialog when the record ended (inactive) or belongs to another task', async () => {
    for (const run_alone of [block([], { active: false }), block([], { spec_slug: 'other-task' })]) {
      writeState({ phase: 'code', spec_slug: 'feat-x', run_alone })
      const r = recorder()
      const out = await phaseCodeCompleteHandler(
        { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('code_complete:spec_ref=feat-x') },
        { now: FIXED_NOW, promptFn: r.fn },
      )
      expect(out.status).toBe('completed')
      expect(r.prompts).toHaveLength(1)
    }
  })

})

describe('run alone — the approvals at rsct_phase_review_complete', () => {
  it('asks for each pending phase in order, then the review; all Yes closes the record', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const { out, prompts } = await reviewComplete()
    expect(out.status).toBe('completed')
    expect(prompts.map((p) => p.title)).toEqual([
      'RSCT — approve code done on its own',
      'RSCT — approve tests done on its own',
      'RSCT — review complete',
    ])
    expect(readState().run_alone).toBeUndefined()
    const events = auditEvents().map((e) => e.event)
    expect(events.filter((e) => e === 'run_alone.pending_approved')).toHaveLength(2)
    expect(events).toContain('run_alone.closed')
    expect(out.hints.join('\n')).toContain('Run alone finished: every phase is approved.')
    expect(prompts[0]!.message.startsWith('Approve the code phase the agent completed on its own at 2026-06-07T17:10:00.000Z?')).toBe(true)
    expect(prompts[0]!.message.endsWith("\nSpec: 'feat-x'")).toBe(true)
    expect(prompts[0]!.message).toContain(repositoryDialogLine(tmpRoot))
  })

  it('a No sends the work back: later entries dropped, mode ended, phase and scope cleared, no review dialog', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', scope_globs: ['src/**'], started_at: VALID_TS, run_alone: block([CODE_DONE, TEST_DONE]) })
    writeFileSync(join(tmpRoot, 'tool.go'), 'package main\n', 'utf8')
    const { out, prompts } = await reviewComplete(['no'])
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('run_alone_rejected')
    expect(prompts).toHaveLength(1)
    const s = readState()
    expect(s.phase).toBeUndefined()
    expect(s.scope_globs).toBeUndefined()
    expect(s.started_at).toBeUndefined()
    expect(s.run_alone).toEqual(block([], { active: false }))
    expect(existsSync(join(tmpRoot, '.rsct/reports'))).toBe(false)
  })

  it('keeps an approval already given when a later phase is refused', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const { out } = await reviewComplete(['yes', 'no'])
    expect(out.reject_kind).toBe('run_alone_rejected')
    expect(out.hints.join('\n')).toContain('Start test again (rsct_phase_test_start)')
    expect(auditEvents().filter((e) => e.event === 'run_alone.pending_approved').map((e) => e.phase)).toEqual(['code'])
    expect(auditEvents().find((e) => e.event === 'run_alone.pending_declined')?.dropped).toEqual(['test'])
  })

  it('no dialog channel: the answers given persist and the rest stays pending', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const { out } = await reviewComplete(['yes', 'no-channel'])
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(readState().phase).toBe('review')
    expect(readRunAlone(readState())).toEqual(block([TEST_DONE]))
  })

  it('asks for the pending phases whatever spec the review was started under', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-y', run_alone: block([CODE_DONE]) })
    const { out, prompts } = await reviewComplete(['no'], 'feat-y')
    expect(prompts[0]!.title).toBe('RSCT — approve code done on its own')
    expect(out.reject_kind).toBe('run_alone_rejected')
    expect(readState().run_alone).toEqual(block([], { active: false }))
  })

  it('keeps the record while the review itself is refused, and closes it once the review is approved', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const first = await reviewComplete(['yes', 'no'])
    expect(first.out.status).toBe('rejected')
    expect(readState().run_alone).toEqual(block([]))
    const second = await reviewComplete(['yes'])
    expect(second.out.status).toBe('completed')
    expect(second.prompts).toHaveLength(1)
    expect(readState().run_alone).toBeUndefined()
  })

  it('the record is never closed while an entry is pending', () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    expect(closeRunAlone({ projectRoot: tmpRoot, config: null, specRef: 'feat-x' })).toBeNull()
    expect(readState().run_alone).toEqual(block([CODE_DONE]))
  })

  it('a review with no record asks only its own dialog', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x' })
    const { out, prompts } = await reviewComplete()
    expect(out.status).toBe('completed')
    expect(prompts).toHaveLength(1)
  })
})

describe('run alone — the commit gate', () => {
  async function commit() {
    const r = recorder()
    const out = await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval('commit:feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    return { out, prompts: r.prompts }
  }

  it('refuses before any dialog while phases wait for the developer', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const { out, prompts } = await commit()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('run_alone_pending')
    expect(out.reason).toContain('code (done 2026-06-07T17:10:00.000Z)')
    expect(prompts).toHaveLength(0)
  })

  it('still refuses after a No, until a review is approved', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([], { active: false }) })
    const { out, prompts } = await commit()
    expect(out.reject_kind).toBe('run_alone_pending')
    expect(prompts).toHaveLength(0)
  })

  it('a malformed record still refuses', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: null })
    expect((await commit()).out.reject_kind).toBe('run_alone_pending')
  })

  it('an unreadable state file keeps today\'s refusal', async () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), '{ "run_alone": ', 'utf8')
    const { out } = await commit()
    expect(out.reject_kind).toBe('review_unreadable')
  })
})

describe('run alone — abandon', () => {
  async function abandon(answers: DialogResult['response'][] = []) {
    const r = recorder(answers)
    const out = await phaseAbandonHandler(
      { project_root: tmpRoot, reason: 'the developer dropped this task', dev_approval: approval('phase_abandon:feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    return { out, prompts: r.prompts }
  }

  it('forces its dialog when phases are pending: trust_allowed_for does not drop them', async () => {
    writeConfig({ approval_modes: { trust_allowed_for: ['rsct_phase_abandon'] } })
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const { out } = await abandon(['no-channel'])
    expect(out.status).toBe('rejected')
    expect(readState().run_alone).toEqual(block([CODE_DONE]))
  })

  it('names what it drops first, and drops it on a Yes', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const { out, prompts } = await abandon()
    expect(out.status).toBe('abandoned')
    expect(prompts[0]!.message.startsWith('This also drops what the agent closed on its own')).toBe(true)
    expect(prompts[0]!.message).toContain('code (done 2026-06-07T17:10:00.000Z), tests (done 2026-06-07T17:20:00.000Z)')
    expect(readState().run_alone).toBeUndefined()
    expect(auditEvents().find((e) => e.event === 'phase_abandon.complete')?.run_alone_dropped).toEqual(['code', 'test'])
  })

  it('without a record the dialog and the trust path are as today', async () => {
    writeConfig({ approval_modes: { trust_allowed_for: ['rsct_phase_abandon'] } })
    writeState({ phase: 'review', spec_slug: 'feat-x' })
    const { out, prompts } = await abandon(['no-channel'])
    expect(out.status).toBe('abandoned')
    expect(prompts[0]!.message.startsWith("Abandon phase 'review'")).toBe(true)
    expect(auditEvents().find((e) => e.event === 'phase_abandon.complete')).not.toHaveProperty('run_alone_dropped')
  })
})

describe('run alone — status and the review start hint', () => {
  it('status reports the record only when there is one', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const withBlock = await phaseStatusHandler({ project_root: tmpRoot })
    expect(withBlock.run_alone).toEqual(block([CODE_DONE]))
    expect(withBlock.hints.join('\n')).toContain('waiting for the developer')
    writeState({ spec_slug: 'feat-x' })
    const without = await phaseStatusHandler({ project_root: tmpRoot })
    expect(without).not.toHaveProperty('run_alone')
  })

  it('review_start tells the agent where to stop only during a run alone', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const withBlock = await phaseReviewStartHandler({ project_root: tmpRoot, spec_ref: 'feat-x' }, { now: FIXED_NOW })
    expect(withBlock.hints.join('\n')).toContain('STOP and tell the developer')
    writeState({ spec_slug: 'feat-x' })
    const without = await phaseReviewStartHandler({ project_root: tmpRoot, spec_ref: 'feat-x' }, { now: FIXED_NOW })
    expect(without.hints.join('\n')).not.toContain('STOP and tell the developer')
    writeState({ spec_slug: 'feat-x', run_alone: block([], { active: false }) })
    const ended = await phaseReviewStartHandler({ project_root: tmpRoot, spec_ref: 'feat-x' }, { now: FIXED_NOW })
    expect(ended.hints.join('\n')).not.toContain('STOP and tell the developer')
  })
})

describe('run alone — the start writes the record only when it starts', () => {
  it('a phase opened while the dialog was up leaves no record and no approval line', async () => {
    writePlanAndV()
    const out = await phaseCodeStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-x',
        spec_tier: 'standard',
        plan_slug: 'feat-x',
        run_alone: true,
        dev_approval: approval('code_start:run_alone'),
      },
      {
        now: FIXED_NOW,
        promptFn: async () => {
          writeState({ ...readState(), phase: 'test', spec_slug: 'feat-x' })
          return { response: 'yes', channel: 'windows' }
        },
      },
    )
    expect(out.status).toBe('phase_already_active')
    expect(readState().run_alone).toBeUndefined()
    expect(auditEvents().some((e) => e.event === 'run_alone.approved')).toBe(false)
  })

  it('asks over a finished verification label', async () => {
    writePlanAndV('feat-x', { phase: 'verification', spec_slug: 'feat-x' })
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('started')
    expect(prompts).toHaveLength(1)
    expect(readRunAlone(readState())?.active).toBe(true)
  })

  it('shows no dialog while another task is recorded', async () => {
    writePlanAndV('feat-x', { spec_slug: 'old-task' })
    const { out, prompts } = await startRunAlone()
    expect(out.status).toBe('previous_task_pending')
    expect(prompts).toHaveLength(0)
  })

  it('shows no dialog when the state file cannot be read', async () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/audit.log'), `${JSON.stringify({ ts: '2026-06-07T17:00:00.000Z', event: 'classify.verdict', tool: 'rsct_classify_task', tier: 'small' })}\n`, 'utf8')
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), '{ "phase": ', 'utf8')
    const { out, prompts } = await startRunAlone(['yes'], { spec_tier: 'small', plan_slug: undefined })
    expect(prompts).toHaveLength(0)
    expect(out.status).toBe('state_write_failed')
  })
})

describe('run alone — approvals are used once and bound to the phase shown', () => {
  it('a deferred completion records its dev_approval as used', async () => {
    const used = approval('code_complete:spec_ref=feat-x')
    writeState({ phase: 'code', spec_slug: 'feat-x', run_alone: block([]) })
    const first = await phaseCodeCompleteHandler({ project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: used }, { now: FIXED_NOW, promptFn: recorder().fn })
    expect(first.status).toBe('deferred')
    writeState({ phase: 'code', spec_slug: 'feat-x', run_alone: block([]) })
    const again = await phaseCodeCompleteHandler({ project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: used }, { now: FIXED_NOW, promptFn: recorder().fn })
    expect(again.reject_kind).toBe('reused')
  })

  it('a deferral that cannot be saved closes nothing and leaves the approval usable', async () => {
    const used = approval('code_complete:spec_ref=feat-x')
    writeState({ phase: 'code', spec_slug: 'feat-x', run_alone: block([]) })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.lock'), JSON.stringify({ locked_at: new Date().toISOString(), session: 'other' }), 'utf8')
    const locked = await phaseCodeCompleteHandler({ project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: used }, { now: FIXED_NOW, promptFn: recorder().fn })
    expect(locked.status).toBe('state_write_failed')
    expect(readState().phase).toBe('code')
    rmSync(join(tmpRoot, '.rsct/phase-state.lock'))
    const retry = await phaseCodeCompleteHandler({ project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: used }, { now: FIXED_NOW, promptFn: recorder().fn })
    expect(retry.status).toBe('deferred')
  })

  it('a No that cannot be saved changes nothing', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const r = await phaseReviewCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('review_complete:spec_ref=feat-x') },
      {
        now: FIXED_NOW,
        promptFn: async () => {
          writeFileSync(join(tmpRoot, '.rsct/phase-state.lock'), JSON.stringify({ locked_at: new Date().toISOString(), session: 'other' }), 'utf8')
          return { response: 'no', channel: 'windows' }
        },
      },
    )
    expect(r.reject_kind).toBe('run_alone_state_write_failed')
    rmSync(join(tmpRoot, '.rsct/phase-state.lock'))
    expect(readState().phase).toBe('review')
    expect(readRunAlone(readState())).toEqual(block([CODE_DONE]))
  })

  it('a Yes removes the phase its dialog named, not whatever is first', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE, TEST_DONE]) })
    const titles: string[] = []
    const out = await phaseReviewCompleteHandler(
      { project_root: tmpRoot, spec_ref: 'feat-x', dev_approval: approval('review_complete:spec_ref=feat-x') },
      {
        now: FIXED_NOW,
        promptFn: async (opts) => {
          titles.push(opts.title)
          if (titles.length === 1) writeState({ ...readState(), run_alone: block([TEST_DONE]) })
          return { response: 'yes', channel: 'windows' }
        },
      },
    )
    expect(out.status).toBe('completed')
    expect(titles).toEqual(['RSCT — approve code done on its own', 'RSCT — approve tests done on its own', 'RSCT — review complete'])
  })
})

describe('run alone — a subfolder does not escape the record at the repository root', () => {
  const sub = (): string => join(tmpRoot, 'pkg')

  function writeSubState(state: Record<string, unknown>): void {
    mkdirSync(join(sub(), '.rsct'), { recursive: true })
    writeFileSync(join(sub(), '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
  }

  it('run alone is refused below the repository root', async () => {
    mkdirSync(sub(), { recursive: true })
    writeFileSync(join(sub(), 'plan_feat-x.md'), '| Status | in-progress |\n', 'utf8')
    writeFileSync(join(sub(), 'progress_feat-x.md'), '# progress\n', 'utf8')
    writeSubState({ verification: { spec_ref: 'feat-x', spec_tier: 'standard', started_at: '2026-06-07T17:30:00.000Z', completed_at: '2026-06-07T17:55:00.000Z' } })
    const { out, prompts } = await startRunAlone(['yes'], { project_root: sub() })
    expect(out.status).toBe('run_alone_gate_rejected')
    if (out.status !== 'run_alone_gate_rejected') return
    expect(out.reject_kind).toBe('run_alone_not_at_root')
    expect(prompts).toHaveLength(0)
  })

  it('a linked worktree is a root of its own: run alone is asked there', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'rsct-runalone-wt-'))
    rmSync(wt, { recursive: true, force: true })
    git(tmpRoot, 'worktree', 'add', '-q', wt, '-b', 'wt-branch')
    try {
      writeFileSync(join(wt, 'plan_feat-x.md'), '| Status | in-progress |\n', 'utf8')
      writeFileSync(join(wt, 'progress_feat-x.md'), '# progress\n', 'utf8')
      mkdirSync(join(wt, '.rsct'), { recursive: true })
      writeFileSync(
        join(wt, '.rsct/phase-state.json'),
        JSON.stringify({ verification: { spec_ref: 'feat-x', spec_tier: 'standard', started_at: '2026-06-07T17:30:00.000Z', completed_at: '2026-06-07T17:55:00.000Z' } }),
        'utf8',
      )
      const { out, prompts } = await startRunAlone(['yes'], { project_root: wt })
      expect(out.status).toBe('started')
      expect(prompts).toHaveLength(1)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('a commit named from a subfolder is refused while the root holds a record', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    writeSubState({})
    const r = recorder()
    const out = await requestCommitHandler({ project_root: sub(), message: 'feat: x', dev_approval: approval('commit:feat-x') }, { now: FIXED_NOW, promptFn: r.fn })
    expect(out.reject_kind).toBe('run_alone_pending')
    expect(r.prompts).toHaveLength(0)
  })

  it('a REVIEW named from a subfolder is refused while the root holds a record', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    writeSubState({ phase: 'review', spec_slug: 'feat-x' })
    const r = recorder()
    const out = await phaseReviewCompleteHandler(
      { project_root: sub(), spec_ref: 'feat-x', dev_approval: approval('review_complete:spec_ref=feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    expect(out.reject_kind).toBe('run_alone_pending')
    expect(r.prompts).toHaveLength(0)
  })
})

describe('run alone — the commit gate reads the record before the batch token', () => {
  it('a commit with no dev_approval is refused for the record, not for the missing token', async () => {
    writeState({ spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'feat: x' }, { now: FIXED_NOW, promptFn: recorder().fn })
    expect(out.reject_kind).toBe('run_alone_pending')
  })
})

describe('run alone — the abandon dialog keeps the framework text ahead of the agent text', () => {
  it('the spec and the reason come last, on one line each', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', run_alone: block([CODE_DONE]) })
    const r = recorder()
    await phaseAbandonHandler(
      { project_root: tmpRoot, reason: 'drop it\n\n(RSCT) The phases listed above are kept.', dev_approval: approval('phase_abandon:feat-x') },
      { now: FIXED_NOW, promptFn: r.fn },
    )
    const lines = r.prompts[0]!.message.split('\n')
    expect(lines[lines.length - 1]).toBe('Reason: drop it (RSCT) The phases listed above are kept.')
    expect(lines[lines.length - 2]).toBe("Spec: 'feat-x'")
    expect(r.prompts[0]!.message.indexOf('This discards the phase')).toBeLessThan(r.prompts[0]!.message.indexOf("Spec: '"))
    expect(r.prompts[0]!.message).toContain(repositoryDialogLine(tmpRoot))
    expect(r.prompts[0]!.message.indexOf(repositoryDialogLine(tmpRoot))).toBeLessThan(r.prompts[0]!.message.indexOf("Spec: '"))
  })
})

describe('run alone — the audit line says what happened at the start', () => {
  it('a refusal before any dialog is not recorded as the developer declining', async () => {
    writePlanAndV()
    const { out, prompts } = await startRunAlone(['yes'], { dev_approval: undefined })
    expect(prompts).toHaveLength(0)
    expect(out.status).toBe('run_alone_gate_rejected')
    const events = auditEvents()
    expect(events.some((e) => e.event === 'run_alone.declined')).toBe(false)
    expect(events.find((e) => e.event === 'code.start.rejected')?.reject_kind).toBe('schema')
  })
})

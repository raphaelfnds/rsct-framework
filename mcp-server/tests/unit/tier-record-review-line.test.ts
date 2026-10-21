import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { classifyTaskHandler } from '../../src/tools/classify-task.js'
import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { statusHandler } from '../../src/tools/status.js'
import { loadContextHandler } from '../../src/tools/load-context.js'
import { UNREADABLE_STATE_ADVICE, readPhaseState, refuseUnreadableState } from '../../src/lib/phase-scope.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { initSweepRepo } from '../sweep-repo.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-tier-record-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function config(): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }), 'utf8')
}

const BIG = 'refactor the authentication architecture across many modules and files'

describe('an unreadable phase-state sends the agent to the developer, not to deletion (#89)', () => {
  function corrupt(): void {
    config()
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'phase-state.json'), '{ "phase": ', 'utf8')
  }

  it('the refusal no longer calls deletion safe and says what deleting drops', () => {
    corrupt()
    const refusal = refuseUnreadableState(root, readPhaseState(root))
    expect(refusal).not.toBeNull()
    const text = refusal!.error ?? ''
    expect(text).not.toContain('safe recovery')
    expect(text).toContain(UNREADABLE_STATE_ADVICE)
    for (const dropped of ['REVIEW ledger', 'review_drift lock', 'batch token', 'tier recorded by rsct_classify_task', 'run_alone record']) {
      expect(UNREADABLE_STATE_ADVICE).toContain(dropped)
    }
  })

  it('rsct_status and rsct_load_context give the same advice and no longer say to delete the file', async () => {
    corrupt()
    const status = (await statusHandler({ project_root: root })) as { hints: string[] }
    const context = (await loadContextHandler({ project_root: root })) as unknown as { next_action_hints: string[] }
    for (const lines of [status.hints, context.next_action_hints]) {
      const line = lines.find((hint) => hint.includes('could not be parsed'))
      expect(line).toBeDefined()
      expect(line).toContain(UNREADABLE_STATE_ADVICE)
      expect(line).not.toContain('start clean')
    }
  })
})

describe('the REVIEW dialog says what process the work went through (#89)', () => {
  function seen(): { fn: (o: DialogOptions) => Promise<DialogResult>; last: () => string } {
    const messages: string[] = []
    return {
      fn: async (o) => {
        messages.push(o.message)
        return { response: 'no', channel: 'windows' }
      },
      last: () => messages.at(-1) ?? '',
    }
  }

  async function reviewDialog(): Promise<string> {
    await phaseReviewStartHandler({ project_root: root, spec_ref: 'feat-r', findings: [] }, {})
    const prompt = seen()
    await phaseReviewCompleteHandler(
      {
        project_root: root,
        spec_ref: 'feat-r',
        findings_actions: [],
        dev_approval: { timestamp: new Date(Date.now() - 5000).toISOString(), action_scope: 'review_complete:feat-r', reason: 'check the process line (unit test)' },
      },
      { promptFn: prompt.fn },
    )
    return prompt.last()
  }

  beforeEach(() => {
    initSweepRepo(root)
    config()
  })

  it('names no classification and no V when none is recorded', async () => {
    expect(await reviewDialog()).toContain('Process: no classification on record; V phase for this spec: not run.')
  })

  it('names the latest and the highest classification, and that V did not run', async () => {
    await classifyTaskHandler({ project_root: root, task_description: BIG })
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo' })
    expect(await reviewDialog()).toContain(
      "Process: classified 'trivial' by rsct_classify_task (highest on record 'complex'); V phase for this spec: not run.",
    )
  })

  it('names the highest classification from the audit log when phase-state lost it', async () => {
    await classifyTaskHandler({ project_root: root, task_description: BIG })
    unlinkSync(join(root, '.rsct', 'phase-state.json'))
    expect(await reviewDialog()).toContain("Process: classified 'complex' by rsct_classify_task; V phase for this spec: not run.")
  })

  it('says V completed only for a completed V block of this spec', async () => {
    mkdirSync(join(root, '.rsct'), { recursive: true })
    const write = (spec: string, done: boolean): void =>
      writeFileSync(
        join(root, '.rsct', 'phase-state.json'),
        JSON.stringify({ verification: { spec_ref: spec, started_at: '2026-10-21T10:00:00.000Z', ...(done ? { completed_at: '2026-10-21T10:30:00.000Z' } : {}) } }),
        'utf8',
      )
    write('other-spec', true)
    expect(await reviewDialog()).toContain('V phase for this spec: not run.')
    rmSync(join(root, '.rsct', 'phase-state.json'))
    write('feat-r', false)
    expect(await reviewDialog()).toContain('V phase for this spec: not run.')
    rmSync(join(root, '.rsct', 'phase-state.json'))
    write('feat-r', true)
    const message = await reviewDialog()
    expect(message).toContain('V phase for this spec: completed.')
    expect(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')).toContain('"completed_at"')
  })
})

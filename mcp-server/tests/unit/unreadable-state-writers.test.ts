import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPhaseState,
  stampClassifyVerdict,
  stampContextStale,
  stampPlanDisposition,
  stampReviewCompleted,
  type WritePhaseStateResult,
} from '../../src/lib/phase-scope.js'
import type { GitExecResult, GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let root: string
const CORRUPT = '{ "spec_slug": "feat-foo", "review_sweep": {'
const DOCS_DIFF = 'diff --git a/NOTES.md b/NOTES.md\n--- a/NOTES.md\n+++ b/NOTES.md\n@@ -1 +1 @@\n+docs\n'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-unreadable-'))
  mkdirSync(join(root, '.rsct'), { recursive: true })
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

const statePath = (): string => join(root, '.rsct', 'phase-state.json')
const raw = (): string => readFileSync(statePath(), 'utf8')

function install(): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
}

function auditLines(): Array<Record<string, unknown>> {
  const path = join(root, '.rsct', 'audit.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function approval(scope: string): Record<string, string> {
  return {
    timestamp: new Date(Date.now() - 5_000).toISOString(),
    action_scope: scope,
    reason: `unreadable state test approval for ${scope}`,
  }
}

function branchState(branch: string): GitState {
  return { available: true, branch, head_sha: 'aaaa111', is_clean: false }
}

interface PromptSpy {
  fn: (options: DialogOptions) => Promise<DialogResult>
  calls: number
}

function promptSpy(): PromptSpy {
  const spy: PromptSpy = {
    calls: 0,
    fn: async () => {
      spy.calls++
      return { response: 'yes', channel: 'windows' }
    },
  }
  return spy
}

interface CommitRun {
  out: { status: string; reject_kind: string | null; reason: string | null }
  prompt: PromptSpy
  gitCalls: string[]
}

async function commitDocs(): Promise<CommitRun> {
  const { requestCommitHandler } = await import('../../src/tools/request-commit.js')
  const prompt = promptSpy()
  const gitCalls: string[] = []
  const answer: GitExecResult = { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }
  const out = await requestCommitHandler(
    { project_root: root, message: 'docs: notes', dev_approval: approval('commit:feat/foo:abc1234') },
    {
      gitStateOverride: branchState('feat/foo'),
      gitExecutor: (_cwd, args) => {
        gitCalls.push(args.join(' '))
        return answer
      },
      promptFn: prompt.fn,
      stagedDiffOverride: DOCS_DIFF,
      stagedPathsOverride: ['NOTES.md'],
    },
  )
  return { out, prompt, gitCalls }
}

const writers: Array<[string, () => WritePhaseStateResult]> = [
  ['stampContextStale', () => stampContextStale(root, 'plan_closed')],
  ['stampClassifyVerdict', () => stampClassifyVerdict(root, { tier: 'complex' })],
  ['stampReviewCompleted', () => stampReviewCompleted(root, { spec_ref: 'feat-foo', completed_at: 'now' })],
  [
    'stampPlanDisposition',
    () => stampPlanDisposition(root, { plan_slug: 'feat-foo', decision: 'keep', decided_at: 'now' }),
  ],
]

describe('phase-state writers refuse an unreadable file instead of overwriting it (#77)', () => {
  for (const [name, write] of writers) {
    it(`${name} leaves a corrupt phase-state.json byte-identical`, () => {
      writeFileSync(statePath(), CORRUPT, 'utf8')
      const before = raw()
      const result = write()
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe('unreadable_state')
      expect(raw()).toBe(before)
    })

    it(`${name} says the file could not be read and that nothing was overwritten`, () => {
      writeFileSync(statePath(), CORRUPT, 'utf8')
      const result = write()
      expect(result.ok === false && result.error).toContain('could not be read')
      expect(result.ok === false && result.error).toContain('nothing was overwritten')
    })

    it(`${name} still writes when the file is readable`, () => {
      writeFileSync(statePath(), JSON.stringify({ spec_slug: 'feat-foo', bootstrap_at: 'earlier' }), 'utf8')
      expect(write().ok).toBe(true)
      const state = readPhaseState(root).state
      expect(state?.spec_slug).toBe('feat-foo')
      expect(state?.bootstrap_at).toBe('earlier')
    })
  }

  it('a top-level value that is not an object is refused too', () => {
    writeFileSync(statePath(), '"just a string"', 'utf8')
    const result = stampClassifyVerdict(root, { tier: 'small' })
    expect(result.ok === false && result.reason).toBe('unreadable_state')
    expect(raw()).toBe('"just a string"')
  })

  it('an absent file is not an unreadable one: the writer creates it', () => {
    const result = stampClassifyVerdict(root, { tier: 'small' })
    expect(result.ok).toBe(true)
    expect(readPhaseState(root).state?.last_classify?.tier).toBe('small')
  })
})

describe('the tools say so when a corrupt phase-state stops them (#77)', () => {
  it('rsct_classify_task reports that the tier was not recorded', async () => {
    const { classifyTaskHandler } = await import('../../src/tools/classify-task.js')
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const out = (await classifyTaskHandler({
      project_root: root,
      task_description: 'rewrite the authentication layer across services and migrate the database',
    })) as { hints: string[] }
    expect(out.hints.join(' ')).toContain('NOT recorded')
    expect(raw()).toBe(CORRUPT)
  })

  it('a phase start refuses instead of replacing the corrupt file', async () => {
    const { startPhaseGeneric } = await import('../../src/lib/phase-machine.js')
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const r = startPhaseGeneric({ projectRoot: root, phase: 'research', specRef: 'feat-new' }, null)
    expect(r.status).toBe('state_write_failed')
    expect(r.phase_state_written).toBe(false)
    expect(r.hints.join(' ')).toContain('could not be read')
    expect(raw()).toBe(CORRUPT)
  })
})

describe('an unreadable phase-state is refused, an empty one is not (#77)', () => {
  it('rsct_phase_verification_start refuses instead of replacing the file', async () => {
    const { phaseVerificationStartHandler } = await import('../../src/tools/phase-verification-start.js')
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const out = (await phaseVerificationStartHandler({
      project_root: root,
      spec_ref: 'feat-new',
      spec_tier: 'complex',
    })) as { status: string; phase_state_written: boolean; hints: string[] }
    expect(out.status).toBe('state_write_failed')
    expect(out.phase_state_written).toBe(false)
    expect(raw()).toBe(CORRUPT)
  })

  for (const [label, content] of [
    ['empty', ''],
    ['whitespace only', '  \n'],
    ['a BOM before valid JSON', '﻿{"spec_slug":"feat-foo"}'],
  ] as const) {
    it(`treats ${label} as a file to write, not as corruption`, () => {
      writeFileSync(statePath(), content, 'utf8')
      expect(readPhaseState(root).parse_error).toBeUndefined()
      expect(stampClassifyVerdict(root, { tier: 'small' }).ok).toBe(true)
    })
  }

  it('an array at the top level is corruption, not state', () => {
    writeFileSync(statePath(), '["keep-me"]', 'utf8')
    expect(readPhaseState(root).parse_error).toBeDefined()
    expect(stampClassifyVerdict(root, { tier: 'small' }).ok).toBe(false)
    expect(raw()).toBe('["keep-me"]')
  })
})

describe('four tools refuse an unreadable phase-state and say so (#101)', () => {
  it('rsct_plan_authorize mints nothing and leaves the corrupt file byte-identical', async () => {
    const { planAuthorizeHandler } = await import('../../src/tools/plan-authorize.js')
    install()
    writeFileSync(join(root, 'plan_t3.md'), '# Plan\n\n| Status | in progress |\n')
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const input = { project_root: root, dev_approval: approval('plan_authorize:t3'), ttl_minutes: 120, max_actions: 5 }
    const internal = { gitStateOverride: branchState('feat/t3'), promptFn: promptSpy().fn }
    const out = (await planAuthorizeHandler(input, internal)) as { status: string; hints: string[] }
    expect(out.status).toBe('state_write_failed')
    expect(raw()).toBe(CORRUPT)
    const hints = out.hints.join(' ')
    expect(hints).toContain('token NOT minted')
    expect(hints).toContain('phase-state.json could not be read')
    expect(hints).toContain('dev_approval NOT consumed.')
    expect(hints).not.toContain('write failed')
    expect(hints).not.toContain('retry')
    const line = auditLines().find((entry) => entry.event === 'plan_authorize.state_write_failed')
    expect(line).toBeDefined()
    expect(String(line?.reason)).toContain('phase-state.json could not be read')
    expect(existsSync(join(root, '.rsct', 'approvals-seen.json'))).toBe(false)

    writeFileSync(statePath(), '{}', 'utf8')
    const retried = (await planAuthorizeHandler(input, internal)) as { status: string }
    expect(retried.status).toBe('authorized')
  })

  it('rsct_plan_authorize still mints over an empty phase-state, which is not corruption', async () => {
    const { planAuthorizeHandler } = await import('../../src/tools/plan-authorize.js')
    install()
    writeFileSync(join(root, 'plan_t3.md'), '# Plan\n\n| Status | in progress |\n')
    writeFileSync(statePath(), '', 'utf8')
    const out = (await planAuthorizeHandler(
      { project_root: root, dev_approval: approval('plan_authorize:t3'), ttl_minutes: 120, max_actions: 5 },
      { gitStateOverride: branchState('feat/t3'), promptFn: promptSpy().fn },
    )) as { status: string }
    expect(out.status).toBe('authorized')
  })

  it('rsct_plan_revoke says the file could not be read instead of answering no_token', async () => {
    const { planRevokeHandler } = await import('../../src/tools/plan-revoke.js')
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const out = (await planRevokeHandler({ project_root: root, reason: 'done early' })) as {
      status: string
      hints: string[]
    }
    expect(out.status).toBe('state_write_failed')
    expect(out.hints.join(' ')).toContain('phase-state.json could not be read')
    expect(out.hints.join(' ')).toContain('No token was revoked')
    expect(raw()).toBe(CORRUPT)
    const line = auditLines().find((entry) => entry.event === 'plan_revoke.state_write_failed')
    expect(line).toBeDefined()
    expect(String(line?.reason)).toContain('phase-state.json could not be read')
  })

  it('rsct_plan_revoke still answers no_token over an empty phase-state, which is not corruption', async () => {
    const { planRevokeHandler } = await import('../../src/tools/plan-revoke.js')
    install()
    writeFileSync(statePath(), '', 'utf8')
    const out = (await planRevokeHandler({ project_root: root })) as { status: string }
    expect(out.status).toBe('no_token')
  })

  it('rsct_phase_abandon refuses before any dialog instead of calling the state clean', async () => {
    const { phaseAbandonHandler } = await import('../../src/tools/phase-abandon.js')
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const prompt = promptSpy()
    const out = (await phaseAbandonHandler(
      {
        project_root: root,
        reason: 'pivoting away from this approach',
        dev_approval: approval('phase_abandon:spec_ref=feat-foo'),
      },
      { promptFn: prompt.fn },
    )) as { status: string; hints: string[] }
    expect(out.status).toBe('state_write_failed')
    expect(out.hints.join(' ')).toContain('phase-state.json could not be read')
    expect(out.hints.join(' ')).toContain('Nothing was abandoned')
    expect(prompt.calls).toBe(0)
    expect(raw()).toBe(CORRUPT)
    const line = auditLines().find((entry) => entry.event === 'phase_abandon.rejected')
    expect(line).toBeDefined()
    expect(line?.reject_kind).toBe('state_unreadable')
  })

  it('rsct_phase_abandon still answers no_active_phase over an empty phase-state, which is not corruption', async () => {
    const { phaseAbandonHandler } = await import('../../src/tools/phase-abandon.js')
    install()
    writeFileSync(statePath(), '', 'utf8')
    const out = (await phaseAbandonHandler(
      {
        project_root: root,
        reason: 'pivoting away from this approach',
        dev_approval: approval('phase_abandon:spec_ref=feat-foo'),
      },
      { promptFn: promptSpy().fn },
    )) as { status: string }
    expect(out.status).toBe('no_active_phase')
  })

  it('rsct_request_commit refuses before any approval dialog and never runs git commit', async () => {
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const { out, prompt, gitCalls } = await commitDocs()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('review_unreadable')
    expect(out.reason).toContain('phase-state.json could not be read')
    expect(out.reason).toContain('No commit was made')
    expect(prompt.calls).toBe(0)
    expect(gitCalls.filter((call) => call.startsWith('commit'))).toEqual([])
    expect(raw()).toBe(CORRUPT)
  })

  it('rsct_request_commit still commits over an empty phase-state, which is not corruption', async () => {
    install()
    writeFileSync(statePath(), '', 'utf8')
    const { out, gitCalls } = await commitDocs()
    expect(out.status).toBe('committed')
    expect(gitCalls.filter((call) => call.startsWith('commit'))).toHaveLength(1)
  })

  it('rsct_audit says commits are refused when the fault is a torn phase-state, and only then', async () => {
    const { auditHandler } = await import('../../src/tools/audit.js')
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    const torn = await auditHandler({ project_root: root })
    expect(torn.free_commit_eligibility?.explanation).toContain('phase_state_corrupt')
    expect(torn.free_commit_eligibility?.explanation).toContain('refuses every commit')
    expect(torn.free_commit_eligibility?.explanation).not.toContain('Commits still work')

    writeFileSync(statePath(), '{}', 'utf8')
    writeFileSync(join(root, '.rsct', 'phase-state.lock'), 'not a lock', 'utf8')
    const staleLock = await auditHandler({ project_root: root })
    expect(staleLock.free_commit_eligibility?.explanation).toContain('phase_state_lock_stale')
    expect(staleLock.free_commit_eligibility?.explanation).toContain('Commits still work')
    expect(staleLock.free_commit_eligibility?.explanation).not.toContain('refuses every commit')
  })
})

describe('the audit log says what a refusal on an unreadable phase-state was (#101)', () => {
  it('classify.verdict records false when the stamp was refused and true when it landed', async () => {
    const { classifyTaskHandler } = await import('../../src/tools/classify-task.js')
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo in the readme' })
    const refused = auditLines().filter((entry) => entry.event === 'classify.verdict')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.recorded).toBe(false)

    writeFileSync(statePath(), '{}', 'utf8')
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo in the readme' })
    const all = auditLines().filter((entry) => entry.event === 'classify.verdict')
    expect(all).toHaveLength(2)
    expect(all[1]?.recorded).toBe(true)
  })

  it('a refused phase start logs reject_kind state_unreadable', async () => {
    const { startPhaseGeneric } = await import('../../src/lib/phase-machine.js')
    writeFileSync(statePath(), CORRUPT, 'utf8')
    startPhaseGeneric({ projectRoot: root, phase: 'research', specRef: 'feat-new' }, null)
    const line = auditLines().find((entry) => entry.event === 'research.start.rejected')
    expect(line).toBeDefined()
    expect(line?.reject_kind).toBe('state_unreadable')
  })

  it('a refused rsct_phase_verification_start logs reject_kind state_unreadable', async () => {
    const { phaseVerificationStartHandler } = await import('../../src/tools/phase-verification-start.js')
    install()
    writeFileSync(statePath(), CORRUPT, 'utf8')
    await phaseVerificationStartHandler({ project_root: root, spec_ref: 'feat-new', spec_tier: 'complex' })
    const line = auditLines().find((entry) => entry.event === 'verification.start.rejected')
    expect(line).toBeDefined()
    expect(line?.reject_kind).toBe('state_unreadable')
  })
})

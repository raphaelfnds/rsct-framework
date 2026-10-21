import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DIALOG_UNCUT, commitMessageView, dialogList, specLabel } from '../../src/lib/dialog-text.js'
import { describePending } from '../../src/lib/run-alone.js'
import { repositoryDialogLine } from '../../src/lib/repo-anchor.js'
import { requestCommitHandler } from '../../src/tools/request-commit.js'
import { requestPushHandler } from '../../src/tools/request-push.js'
import { requestMergeHandler } from '../../src/tools/request-merge.js'
import { requestRebaseHandler } from '../../src/tools/request-rebase.js'
import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'
import { phaseCodeCompleteHandler } from '../../src/tools/phase-code-complete.js'
import { phaseVerificationCompleteHandler } from '../../src/tools/phase-verification-complete.js'
import { phaseAbandonHandler } from '../../src/tools/phase-abandon.js'
import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { captureIssueHandler } from '../../src/tools/capture-issue.js'
import { classifyTaskHandler } from '../../src/tools/classify-task.js'
import type { GitExecResult, GitExecutor, GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { git, initSweepRepo } from '../sweep-repo.js'

const c = (...codes: number[]): string => String.fromCharCode(...codes)
const LF = c(10)
const LS = c(0x2028)
const FAKE = 'Repository: C:/somewhere/else'
const PUSHED_DOWN = `${LF.repeat(200)}${FAKE}`
const FRAMEWORK_LINE = /^(?:Repository|Folder): /

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-dialog-order-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function config(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, ...extra }), 'utf8')
}

function recorder(response: DialogResult['response'] = 'no'): { fn: (o: DialogOptions) => Promise<DialogResult>; messages: string[] } {
  const messages: string[] = []
  return {
    fn: async (o) => {
      messages.push(o.message)
      return { response, channel: 'windows' }
    },
    messages,
  }
}

function approval(scope: string) {
  return { timestamp: new Date(Date.now() - 5000).toISOString(), action_scope: scope, reason: 'check the order of the dialog text (unit test)' }
}

function ack() {
  return { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'plan done, ADRs recorded, issues closed, files swept (unit test)' }
}

function expectFrameworkFirst(message: string): string[] {
  const lines = message.split('\n')
  const real = lines.findIndex((line) => FRAMEWORK_LINE.test(line) && !line.startsWith(FAKE))
  const fake = lines.findIndex((line) => line.includes(FAKE))
  expect(real).toBeGreaterThanOrEqual(0)
  expect(fake).toBeGreaterThan(real)
  expect(lines.length).toBeLessThan(30)
  return lines
}

function expectFlattenedLast(message: string): void {
  const lines = expectFrameworkFirst(message)
  expect(lines.some((line) => line.startsWith(FAKE))).toBe(false)
}

function expectQuestionKeepsIt(message: string): void {
  const lines = message.split('\n')
  expect(message.includes(LS)).toBe(false)
  expect(lines[0]).toContain(FAKE)
  expect(lines.some((line) => line.startsWith(FAKE))).toBe(false)
  expect(lines.findIndex((line) => FRAMEWORK_LINE.test(line))).toBeGreaterThan(0)
  expect(lines.length).toBeLessThan(15)
}

const OK: GitExecResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }
const exec: GitExecutor = (_root, args) => (args[0] === 'remote' ? { ok: true, stdout: 'origin\n', stderr: '', exitCode: 0 } : OK)
const state = (branch: string): GitState => ({ available: true, branch, head_sha: 'aaaa111', is_clean: true })

describe('dialog text helpers', () => {
  it('specLabel turns every line break and tab into a space and drops control and format characters', () => {
    expect(specLabel(`a${LS}${LS}b${c(9)}c${c(0x202e)}d${c(0xad)}e${c(0x85)}f${c(1)}g`)).toBe('a b cde fg')
    expect(specLabel(`t${String.fromCodePoint(0xe0049)}g`)).toBe('tg')
    expect(specLabel(`a${LF}${c(0x200b)}${LF}b`)).toBe('a b')
  })

  it('specLabel cuts by code point and never splits a character', () => {
    const smile = String.fromCodePoint(0x1f600)
    expect(specLabel(`ab${smile.repeat(3)}`, 3)).toBe('ab…')
    expect(specLabel(`ab${smile.repeat(3)}`, 4)).toBe(`ab${smile}…`)
    expect(specLabel('x'.repeat(300))).toHaveLength(200)
  })

  it('commitMessageView keeps lines, collapses blank runs and shows hidden characters', () => {
    const message = `subject${c(13, 10, 13, 10, 13, 10)}   ${LF}body${LS}second${c(0x202e)}${c(13)}third${c(9)}x${LF}${LF}${LF}`
    expect(commitMessageView(message)).toBe(`subject${LF}${LF}body${LF}second${c(0xfffd)}${LF}third x`)
    expect(commitMessageView(`${LF}${LF}a`)).toBe('a')
    expect(commitMessageView(`a${c(13, 10)}b`)).toBe(`a${LF}b`)
  })

  it('a pile of combining marks is cut to four, so it cannot draw over the lines above it', () => {
    const pile = `M${c(0x346).repeat(150)}`
    expect(specLabel(pile, DIALOG_UNCUT)).toBe(`M${c(0x346).repeat(4)}`)
    expect(commitMessageView(`fix: typo${LF}${LF}${pile}`)).toBe(`fix: typo${LF}${LF}M${c(0x346).repeat(4)}${c(0xfffd)}`)
    expect(specLabel(`a${c(0x301)}${c(0x323)}`)).toBe(`a${c(0x301)}${c(0x323)}`)
  })

  it('the pending phases of run alone show their time on one line', () => {
    expect(describePending([{ phase: 'code', completed_at: `2026-10-21${LF}${FAKE}` }])).toBe(`code (done 2026-10-21 ${FAKE})`)
  })

  it('dialogList puts each item on one line and counts the rest', () => {
    expect(dialogList([`a${LF}b`, 'c', 'd'], 2)).toBe(`• a b${LF}• c${LF}… and 1 more`)
  })

  it('the repository line keeps a folder name with line separators on one line', () => {
    const odd = join(root, `pkg${LS.repeat(40)}x`)
    mkdirSync(odd, { recursive: true })
    const line = repositoryDialogLine(odd)
    expect(line.includes(LS)).toBe(false)
    expect(line.split('\n')).toHaveLength(1)
    expect(line.startsWith('Folder: ')).toBe(true)
    expect(line).toContain(`pkg${' '}x`)
  })
})

describe('every approval dialog shows the framework lines before what the agent wrote', () => {
  it('commit: the message comes after the repository line, its blank lines collapsed', async () => {
    initSweepRepo(root)
    config()
    writeFileSync(join(root, 'README.md'), 'a\n', 'utf8')
    git(root, 'add', 'README.md')
    const seen = recorder()
    await requestCommitHandler(
      { project_root: root, message: `docs: tweak${PUSHED_DOWN}${c(13, 10)}tail${c(0x202e)}`, dev_approval: approval('commit:docs') },
      { promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    const lines = expectFrameworkFirst(seen.messages[0]!)
    expect(lines.indexOf('Commit message:')).toBeGreaterThan(lines.findIndex((line) => FRAMEWORK_LINE.test(line)))
    expect(lines.slice(-5)).toEqual(['Commit message:', 'docs: tweak', '', FAKE, `tail${c(0xfffd)}`])
  })

  it('ceremony bypass: the spec comes last, on one line', async () => {
    config()
    const seen = recorder()
    await phaseCodeStartHandler(
      { project_root: root, spec_ref: `feat-a${PUSHED_DOWN}`, spec_tier: 'standard', override_verification_skip: true, override_plan_tracking: true, dev_approval: approval('code_start:bypass') },
      { promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    expectFlattenedLast(seen.messages[0]!)
    expect(seen.messages[0]!.split('\n').at(-1)!.startsWith("Spec: 'feat-a ")).toBe(true)
  })

  it('code complete: the dialog gains the repository line and the spec comes last', async () => {
    config()
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo' })
    const spec = `feat-b${PUSHED_DOWN}`
    expect((await phaseCodeStartHandler({ project_root: root, spec_ref: spec, spec_tier: 'trivial' }, {})).status).toBe('started')
    const seen = recorder()
    await phaseCodeCompleteHandler({ project_root: root, spec_ref: spec, dev_approval: approval('code_complete') }, { promptFn: seen.fn })
    expect(seen.messages).toHaveLength(1)
    expectFlattenedLast(seen.messages[0]!)
    expect(seen.messages[0]!.startsWith('Complete the code phase?')).toBe(true)
  })

  it('verification complete: the dialog gains the repository line and the spec comes last', async () => {
    config()
    const spec = `feat-v${PUSHED_DOWN}`
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({ phase: 'verification', spec_slug: spec, verification: { spec_ref: spec, spec_tier: 'standard', declared_paths: [], discovered_importers: [], findings: [], started_at: '2026-10-21T10:00:00.000Z' } }),
      'utf8',
    )
    const seen = recorder()
    await phaseVerificationCompleteHandler({ project_root: root, spec_ref: spec, dev_approval: approval('verification_complete') }, { promptFn: seen.fn })
    expect(seen.messages).toHaveLength(1)
    expectFlattenedLast(seen.messages[0]!)
  })

  it('abandon: the reason comes last, on one line, after the repository line', async () => {
    config()
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo' })
    expect((await phaseCodeStartHandler({ project_root: root, spec_ref: 'feat-c', spec_tier: 'trivial' }, {})).status).toBe('started')
    const seen = recorder()
    await phaseAbandonHandler(
      { project_root: root, reason: `scope changed${PUSHED_DOWN}`, dev_approval: approval('phase_abandon:feat-c') },
      { promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    expectFlattenedLast(seen.messages[0]!)
    expect(seen.messages[0]!.split('\n').at(-1)!.startsWith('Reason: scope changed ')).toBe(true)
  })

  it('abandon: a long reason is shown whole, as it was before', async () => {
    config()
    await classifyTaskHandler({ project_root: root, task_description: 'fix typo' })
    expect((await phaseCodeStartHandler({ project_root: root, spec_ref: 'feat-d', spec_tier: 'trivial' }, {})).status).toBe('started')
    const seen = recorder()
    await phaseAbandonHandler(
      { project_root: root, reason: `${'the scope moved '.repeat(30)}FINAL-WORDS`, dev_approval: approval('phase_abandon:feat-d') },
      { promptFn: seen.fn },
    )
    expect(seen.messages[0]).toContain('FINAL-WORDS')
  })

  it('REVIEW complete: the spec comes last, after the repository line', async () => {
    initSweepRepo(root)
    config()
    const spec = `feat-r${PUSHED_DOWN}`
    await phaseReviewStartHandler({ project_root: root, spec_ref: spec, findings: [] }, {})
    const seen = recorder()
    await phaseReviewCompleteHandler(
      { project_root: root, spec_ref: spec, findings_actions: [], dev_approval: approval('review_complete') },
      { promptFn: seen.fn },
    )
    expect(seen.messages.length).toBeGreaterThanOrEqual(1)
    expectFlattenedLast(seen.messages.at(-1)!)
  })

  it('REVIEW complete: a removed comment that spans lines is listed on one line, below the repository line', async () => {
    initSweepRepo(root)
    config()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), `/* first line${LF}${FAKE}${LF}last line ${'x'.repeat(100)} */${LF}export const a = 1${LF}`, 'utf8')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'with comment')
    writeFileSync(join(root, 'src', 'a.ts'), `export const a = 1${LF}`, 'utf8')
    await phaseReviewStartHandler({ project_root: root, spec_ref: 'feat-list', findings: [] }, {})
    const call = (extra: Record<string, unknown>, fn?: (o: DialogOptions) => Promise<DialogResult>) =>
      phaseReviewCompleteHandler(
        { project_root: root, spec_ref: 'feat-list', findings_actions: [], dev_approval: approval('review_complete:feat-list'), ...extra },
        fn ? { promptFn: fn } : {},
      )
    const pending = await call({})
    const id = pending.pending_dispositions![0]!.comment_id
    const seen = recorder()
    await call({ comment_dispositions: [{ comment_id: id, action: 'discarded' }] }, seen.fn)
    expect(seen.messages).toHaveLength(1)
    const lines = expectFrameworkFirst(seen.messages[0]!)
    expect(lines.some((line) => line.startsWith(FAKE))).toBe(false)
    const header = lines.findIndex((line) => line.startsWith('Comments removed: 1'))
    expect(header).toBeGreaterThan(lines.findIndex((line) => FRAMEWORK_LINE.test(line)))
    expect(lines[header + 1]).toContain(`first line ${FAKE} last line`)
    expect(lines[header + 1]).toContain('…')
    expect(lines[header + 1]).not.toContain('x'.repeat(100))
  })

  it('REVIEW unverified files: the question and the repository line come first, the files and the spec after', async () => {
    initSweepRepo(root)
    config()
    writeFileSync(join(root, `to${LS.repeat(30)}ol.go`), `package main // go comment${LF}`, 'utf8')
    const spec = `feat-u${PUSHED_DOWN}`
    await phaseReviewStartHandler({ project_root: root, spec_ref: spec, findings: [] }, {})
    const seen = recorder()
    await phaseReviewCompleteHandler(
      { project_root: root, spec_ref: spec, findings_actions: [], dev_approval: approval('review_complete') },
      { promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    const message = seen.messages[0]!
    expectFlattenedLast(message)
    expect(message.startsWith('These exact file versions would become committable WITHOUT')).toBe(true)
    expect(message.includes(LS)).toBe(false)
    expect(message).toContain(`• to${' '}ol.go — unsupported_language`)
    expect(message.split('\n').at(-1)!.startsWith("Spec: 'feat-u ")).toBe(true)
  })

  it('capture issue: labels and title come last, on one line each', async () => {
    config()
    const seen = recorder()
    await captureIssueHandler(
      {
        project_root: root,
        mode: 'create',
        title: `A finding${LS.repeat(20)}${FAKE}`,
        body: 'A finding that does not block the current task but should be logged for later resolution here.',
        severity: 'low',
        labels: [`bug${LF.repeat(30)}${FAKE}`],
        dev_approval: approval('capture_issue:gh'),
      },
      { promptFn: seen.fn, ghAvailable: () => true, ghCreate: () => ({ ok: true, url: 'https://example.invalid/1', raw_stdout: '' }) },
    )
    expect(seen.messages).toHaveLength(1)
    const lines = seen.messages[0]!.split('\n')
    expect(lines.length).toBeLessThan(15)
    expect(lines.some((line) => line.startsWith(FAKE))).toBe(false)
    expect(lines.at(-1)!.startsWith("Title: 'A finding ")).toBe(true)
  })

  it('push: a branch name with line separators stays on the question line', async () => {
    config()
    const seen = recorder()
    await requestPushHandler(
      { project_root: root, branch: `feat/x${LS.repeat(60)}${FAKE}`, dev_approval: approval('push:feat/x') },
      { gitStateOverride: state('feat/x'), gitExecutor: exec, promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    expectQuestionKeepsIt(seen.messages[0]!)
  })

  it('push: the destination stays visible after a long source, and protected names from the config stay on one line', async () => {
    config({ protected_branches: [`re${LS.repeat(10)}lease`] })
    const seen = recorder()
    await requestPushHandler(
      { project_root: root, branch: `feature/${'x'.repeat(120)}:main`, dev_approval: approval('push:feature/x') },
      { gitStateOverride: state('feature/x'), gitExecutor: exec, promptFn: seen.fn },
    )
    expect(seen.messages).toHaveLength(1)
    const lines = seen.messages[0]!.split('\n')
    expect(lines[0]).toContain(`${'x'.repeat(120)}:main`)
    expect(lines[1]).toBe("Destination branch: 'main'")
    expect(seen.messages[0]!.includes(LS)).toBe(false)
    expect(seen.messages[0]).toContain('re lease')
  })

  it('merge and rebase: the agent-named ref stays on the question line', async () => {
    config()
    const odd = `feat/x${LS.repeat(60)}${FAKE}`
    const merge = recorder()
    await requestMergeHandler(
      { project_root: root, source_branch: odd, dev_approval: approval('merge:feat/x'), pre_merge_ack: ack() },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: state('integ'), gitExecutor: exec, promptFn: merge.fn },
    )
    const rebase = recorder()
    await requestRebaseHandler(
      { project_root: root, mode: 'rebase', ref: odd, dev_approval: approval('rebase:feat/x'), pre_merge_ack: ack() },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: state('integ'), gitExecutor: exec, promptFn: rebase.fn },
    )
    for (const seen of [merge, rebase]) {
      expect(seen.messages).toHaveLength(1)
      expectQuestionKeepsIt(seen.messages[0]!)
    }
  })
})

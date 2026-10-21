import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  branchKey,
  branchPlansHaveOpenItems,
  findActivePlan,
  findNewestPlanFile,
  findPlanByBranch,
  listPlans,
} from '../../src/lib/plan.js'
import { requestMergeHandler, type RequestMergeOutput } from '../../src/tools/request-merge.js'
import { requestPushHandler, type RequestPushOutput } from '../../src/tools/request-push.js'
import { requestRebaseHandler, type RequestRebaseOutput } from '../../src/tools/request-rebase.js'
import type { GitExecResult, GitExecutor, GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-plan-order-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-10-21T12:00:00.000Z')
const VALID_TS = '2026-10-21T11:59:45.000Z'
const TIE = new Date('2026-10-20T10:00:00.000Z')
const OK: GitExecResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }

function plan(name: string, branch: string, open: boolean | null = null): void {
  writeFileSync(join(root, name), `| Branch | ${branch} |\n| Status | in progress |\n`, 'utf8')
  utimesSync(join(root, name), TIE, TIE)
  if (open !== null) {
    const slug = name.replace(/^(?:plan|spec)_/, '').replace(/\.md$/, '')
    writeFileSync(join(root, `progress_${slug}.md`), open ? '- [x] a\n- [ ] b\n' : '- [x] a\n- [x] b\n', 'utf8')
  }
}

function config(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, ...extra }), 'utf8')
}

function ack() {
  return { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'plan done, ADRs recorded, issues closed, files swept (unit test)' }
}

function approval(over: Record<string, unknown> = {}) {
  return { timestamp: VALID_TS, action_scope: 'integrate:feat/big', reason: 'integrate the finished branch (unit test)', ...over }
}

function gitState(branch: string): GitState {
  return { available: true, branch, head_sha: 'aaaa111', is_clean: true }
}

const exec: GitExecutor = (_root, args) =>
  args[0] === 'remote' ? { ok: true, stdout: 'origin\n', stderr: '', exitCode: 0 } : OK

function counting(): { fn: (o: DialogOptions) => Promise<DialogResult>; calls: () => number } {
  let n = 0
  return { fn: async () => { n += 1; return { response: 'yes', channel: 'windows' } }, calls: () => n }
}

const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

describe('plan lists — one order on every system (#86)', () => {
  const NAMES = ['plan_Zeta.md', 'plan_alpha.md', 'plan_Beta.md', 'plan_a-b.md', 'plan_a_b.md', 'plan_ab.md', 'spec_Delta.md', 'spec_gamma.md', 'plan_B2.md', 'spec_eta.md']

  it('sorts files of the same mtime by name in code-unit order, not by what readdir returned', () => {
    for (const name of NAMES) plan(name, 'feat/x')
    const expected = [...NAMES].sort(codeUnit)
    expect(listPlans(root).map((p) => p.plan_path.slice(root.length + 1))).toEqual(expected)
    expect(findActivePlan(root)?.plan_path).toBe(join(root, expected[0]!))
    const expectedSlug = expected[0]!.replace(/^(?:plan|spec)_/, '').replace(/\.md$/, '')
    expect(findPlanByBranch(root, 'feat/x')?.slug).toBe(expectedSlug)
    const newestPlan = expected.find((n) => n.startsWith('plan_'))!
    expect(findNewestPlanFile(root)?.slug).toBe(newestPlan.slice('plan_'.length, -'.md'.length))
  })

  it('still puts the newer file first when the times differ', () => {
    plan('plan_aaa.md', 'feat/x')
    plan('plan_zzz.md', 'feat/x')
    const later = new Date(TIE.getTime() + 60_000)
    utimesSync(join(root, 'plan_zzz.md'), later, later)
    expect(findActivePlan(root)?.slug).toBe('zzz')
    expect(findPlanByBranch(root, 'feat/x')?.slug).toBe('zzz')
  })
})

describe('the integration lookup follows the spellings git accepts (#86)', () => {
  it('reduces refs/heads/, heads/ and letter case to one key', () => {
    expect(branchKey('refs/heads/Feat/Big')).toBe('feat/big')
    expect(branchKey('heads/feat/big')).toBe('feat/big')
    expect(branchKey(' FEAT/BIG ')).toBe('feat/big')
    expect(branchKey('feat/heads/x')).toBe('feat/heads/x')
  })

  it('finds the plan of a branch through every spelling', () => {
    plan('spec_big.md', 'feat/big', true)
    for (const spelling of ['feat/big', 'refs/heads/feat/big', 'heads/feat/big', 'Feat/Big', 'REFS/HEADS/FEAT/BIG']) {
      expect(findPlanByBranch(root, spelling)?.slug).toBe('big')
    }
    expect(findPlanByBranch(root, 'feat/bigger')).toBeNull()
  })

  it('answers undefined with no plan, and true when any named branch has open items', () => {
    plan('plan_done.md', 'feat/done', false)
    plan('plan_open.md', 'feat/open', true)
    expect(branchPlansHaveOpenItems(root, [null, ''])).toBeUndefined()
    expect(branchPlansHaveOpenItems(root, ['feat/none'])).toBeUndefined()
    expect(branchPlansHaveOpenItems(root, ['feat/done'])).toBe(false)
    expect(branchPlansHaveOpenItems(root, ['feat/done', 'feat/open'])).toBe(true)
  })

  it.each(['feat/big', 'refs/heads/feat/big', 'heads/feat/big', 'Feat/Big'])(
    'a merge of %s with open items is refused before any dialog',
    async (source) => {
      config()
      plan('spec_big.md', 'feat/big', true)
      const prompt = counting()
      const out = (await requestMergeHandler(
        { project_root: root, source_branch: source, dev_approval: approval(), pre_merge_ack: ack() },
        { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState('integ'), gitExecutor: exec, promptFn: prompt.fn, now: FIXED_NOW },
      )) as RequestMergeOutput
      expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
      expect(prompt.calls()).toBe(0)
    },
  )

  it('a squash reads the plan of the squashed ref as well as the current branch', async () => {
    config()
    plan('spec_big.md', 'feat/big', true)
    const prompt = counting()
    const out = (await requestRebaseHandler(
      { project_root: root, mode: 'squash', ref: 'feat/big', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState('integ'), gitExecutor: exec, promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestRebaseOutput
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(prompt.calls()).toBe(0)
  })

  it('a rebase still reads only the current branch, not the upstream it rebases onto', async () => {
    config()
    plan('spec_big.md', 'feat/big', true)
    const prompt = counting()
    const out = (await requestRebaseHandler(
      { project_root: root, mode: 'rebase', ref: 'feat/big', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState('integ'), gitExecutor: exec, promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestRebaseOutput
    expect(out.reject_kind).not.toBe('pre_merge_ack_incomplete')
  })

  it.each(['main', 'HEAD:main', 'feat/big:main', 'refs/heads/feat/big:main', '@:main'])(
    'a protected push of %s from feat/big with open items is refused before any dialog',
    async (refspec) => {
      config({ protected_branches: ['main'] })
      plan('spec_big.md', 'feat/big', true)
      plan('plan_main.md', 'main', true)
      const prompt = counting()
      const out = (await requestPushHandler(
        {
          project_root: root,
          branch: refspec,
          dev_approval: approval({ override_protected_branch: { reason: 'release push, unit test coverage' } }),
          pre_merge_ack: ack(),
        },
        { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState('feat/big'), gitExecutor: exec, promptFn: prompt.fn, now: FIXED_NOW },
      )) as RequestPushOutput
      expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
      expect(prompt.calls()).toBe(0)
    },
  )

  it('a plan whose Branch row is written exactly wins over one that matches only after folding', () => {
    plan('plan_upper.md', 'Feat/X', true)
    plan('plan_exact.md', 'feat/x', false)
    const later = new Date(TIE.getTime() + 60_000)
    utimesSync(join(root, 'plan_upper.md'), later, later)
    expect(findPlanByBranch(root, 'feat/x')?.slug).toBe('exact')
    expect(findPlanByBranch(root, 'FEAT/X')?.slug).toBe('upper')
  })

  async function push(refspec: string, current: string): Promise<RequestPushOutput> {
    return (await requestPushHandler(
      {
        project_root: root,
        branch: refspec,
        dev_approval: approval({ override_protected_branch: { reason: 'release push, unit test coverage' } }),
        pre_merge_ack: ack(),
      },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState(current), gitExecutor: exec, promptFn: counting().fn, now: FIXED_NOW },
    )) as RequestPushOutput
  }

  it('a push reads the plan of the pushed source, not of the current branch', async () => {
    config({ protected_branches: ['main'] })
    plan('spec_big.md', 'feat/big', true)
    plan('plan_done.md', 'done', false)
    expect((await push('feat/big:main', 'integ')).reject_kind).toBe('pre_merge_ack_incomplete')
    expect((await push('done:main', 'feat/big')).reject_kind).not.toBe('pre_merge_ack_incomplete')
  })

  it('a push that deletes the destination reads no plan', async () => {
    config({ protected_branches: ['main'] })
    plan('spec_big.md', 'feat/big', true)
    expect((await push(':main', 'feat/big')).reject_kind).not.toBe('pre_merge_ack_incomplete')
  })

  it('a protected push of a finished branch is not refused for a plan of another branch', async () => {
    config({ protected_branches: ['main'] })
    plan('spec_big.md', 'feat/big', false)
    plan('plan_other.md', 'feat/other', true)
    const out = (await requestPushHandler(
      {
        project_root: root,
        branch: 'HEAD:main',
        dev_approval: approval({ override_protected_branch: { reason: 'release push, unit test coverage' } }),
        pre_merge_ack: ack(),
      },
      { rangeReader: () => ({ status: 'ok', paths: [] }), gitStateOverride: gitState('feat/big'), gitExecutor: exec, promptFn: counting().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.reject_kind).not.toBe('pre_merge_ack_incomplete')
  })
})

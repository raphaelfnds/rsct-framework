import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestRebaseHandler,
  type RequestRebaseOutput,
  type RequestRebaseInternal,
} from '../../src/tools/request-rebase.js'
import type { GitExecutor, GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string
const FIXED_NOW = new Date('2026-07-11T12:00:00.000Z')
const VALID_TS = '2026-07-11T11:59:45.000Z'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-reb-'))
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function gitState(branch: string | null): GitState {
  return { available: branch !== null, branch, head_sha: branch ? 'aaaa111' : null, is_clean: false }
}
const okExec: GitExecutor = (_r, args) => ({
  ok: true,
  stdout: args[0] === 'rev-parse' ? 'bbbb222' : '',
  stderr: '',
  exitCode: 0,
})
function alwaysYes(): (o: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}
function approval(over: Record<string, unknown> = {}) {
  return { timestamp: VALID_TS, action_scope: 'rebase:feat/x', reason: 'rebase feat/x onto main for a clean history', ...over }
}
function ack(over: Record<string, unknown> = {}) {
  return { plan_complete: true, adr_confirmed: true, issues_resolved: true, note: 'ADR-1; issue #2 closed', ...over }
}
function internal(over: Partial<RequestRebaseInternal> = {}): RequestRebaseInternal {
  return { gitStateOverride: gitState('feat/x'), gitExecutor: okExec, promptFn: alwaysYes(), now: FIXED_NOW, ...over }
}

describe('rsct_request_rebase', () => {
  it('rejects (in chat) when the pre_merge_ack is missing', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
  })

  it('rebases onto the ref on the happy path', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rebased')
    expect(out.mode).toBe('rebase')
    expect(out.channel).not.toBeNull()
    expect(out.anti_replay_persisted).toBe(true)
  })

  it('squash-stages without committing (mode=squash)', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, mode: 'squash', ref: 'feat/src', dev_approval: approval(), pre_merge_ack: ack() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('squashed')
    expect(out.hints.some((h) => /NOT committed/.test(h))).toBe(true)
  })

  it('blocks rewriting a PROTECTED branch without override_protected_branch', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'feat/topic', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitStateOverride: gitState('main') }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
  })

  it('allows a protected-branch rewrite WITH the override', async () => {
    const out = (await requestRebaseHandler(
      {
        project_root: tmpRoot,
        ref: 'feat/topic',
        dev_approval: approval({ override_protected_branch: { reason: 'intentional main history cleanup' } }),
        pre_merge_ack: ack(),
      },
      internal({ gitStateOverride: gitState('main') }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rebased')
    expect(out.branch_check.override_used).toBe(true)
  })

  it('rejects a rebase against the same branch', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'feat/x', dev_approval: approval(), pre_merge_ack: ack() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('same_ref')
  })

  it('REJECTS when plan_complete is attested but the plan progress has open items', async () => {
    writeFileSync(join(tmpRoot, 'plan_x.md'), '# Plan\n\n| Branch | feat/x |\n')
    writeFileSync(join(tmpRoot, 'progress_x.md'), '- [ ] still open\n')
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
  })

  it('surfaces a mutation_failed on a rebase conflict', async () => {
    const conflictExec: GitExecutor = (_r, args) => {
      if (args[0] === 'rebase') return { ok: false, stdout: '', stderr: 'CONFLICT (content)', exitCode: 1 }
      return { ok: true, stdout: 'aaa', stderr: '', exitCode: 0 }
    }
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitExecutor: conflictExec }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('mutation_failed')
    expect(out.reason).toMatch(/CONFLICT/)
  })
})

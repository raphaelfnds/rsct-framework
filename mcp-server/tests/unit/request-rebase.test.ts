import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestRebaseHandler,
  requestRebaseTool,
  type RequestRebaseOutput,
  type RequestRebaseInternal,
} from '../../src/tools/request-rebase.js'
import { preMergeAckSchema } from '../../src/lib/pre-merge-ack.js'
import type { GitExecutor, GitState, RangePathsResult } from '../../src/lib/git.js'
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
  return { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'ADR-1; issue #2 closed; swept', ...over }
}
const emptyRange: RequestRebaseInternal['rangeReader'] = () => ({ status: 'ok', paths: [] })
function internal(over: Partial<RequestRebaseInternal> = {}): RequestRebaseInternal {
  return { gitStateOverride: gitState('feat/x'), gitExecutor: okExec, promptFn: alwaysYes(), now: FIXED_NOW, rangeReader: emptyRange, ...over }
}

describe('rsct_request_rebase', () => {
  it('exposes pre_merge_ack in inputSchema at parity with the Zod schema', () => {
    const schema = requestRebaseTool.inputSchema as {
      properties: Record<string, { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: unknown }>
      required?: string[]
    }
    const ackProp = schema.properties.pre_merge_ack
    expect(ackProp).toBeDefined()
    expect(ackProp.additionalProperties).toBe(false)
    const zodKeys = Object.keys(preMergeAckSchema.shape)
    expect(zodKeys.length).toBeGreaterThan(0)
    expect(Object.keys(ackProp.properties ?? {}).sort()).toEqual([...zodKeys].sort())
    expect(schema.required ?? []).not.toContain('pre_merge_ack')
    expect(ackProp.required).toBeUndefined()
  })

  it('rejects (in chat) when the pre_merge_ack is missing', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval() },
      internal(),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
  })

  it('needs the dialog: with no dialog channel nothing runs', async () => {
    const calls: string[] = []
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({
        promptFn: async () => ({ response: 'no-channel', channel: 'none', error: 'no display' }),
        gitExecutor: (root, args) => {
          if (args[0] === 'rebase' || args[0] === 'merge') calls.push(args.join(' '))
          return okExec(root, args)
        },
      }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(calls).toEqual([])
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

  it('rejects a branch that has no commit yet, as before its name could be read', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitStateOverride: { ...gitState('feat/new'), head_sha: null } }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('detached_head')
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

describe('rsct_request_rebase — #62 carried-path coverage cross-check', () => {
  function rangeSpy(result: RangePathsResult): {
    fn: NonNullable<RequestRebaseInternal['rangeReader']>
    seen: Array<[string, string]>
  } {
    const seen: Array<[string, string]> = []
    return { fn: (_r, base, head) => { seen.push([base, head]); return result }, seen }
  }

  it('reads <ref>...HEAD for mode=rebase', async () => {
    const spy = rangeSpy({ status: 'ok', paths: [] })
    await requestRebaseHandler(
      { project_root: tmpRoot, mode: 'rebase', ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: spy.fn }),
    )
    expect(spy.seen).toEqual([['main', 'HEAD']])
  })
  it('reads HEAD...<ref> for mode=squash — the OPPOSITE direction', async () => {
    const spy = rangeSpy({ status: 'ok', paths: [] })
    await requestRebaseHandler(
      { project_root: tmpRoot, mode: 'squash', ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: spy.fn }),
    )
    expect(spy.seen).toEqual([['HEAD', 'main']])
  })

  it('fails CLOSED when the range cannot be read', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: () => ({ status: 'unavailable' }) }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
  })

  it('rejects when a carried path was never attested', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack({ files_swept: [] }) },
      internal({ rangeReader: () => ({ status: 'ok', paths: ['src/z.ts'] }) }),
    )) as RequestRebaseOutput
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('src/z.ts')
  })

  it('refuses an option-shaped ref by NAME, not merely as an unreadable range', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: '--exec=touch PWNED', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitStateOverride: gitState('feat/x'), rangeReader: undefined }),
    )) as RequestRebaseOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).toContain('--exec=touch PWNED')
    expect(out.reason).toContain('OPTION')
  })

  it('reaches the same reject_kind for an ordinary ref, without naming it', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitStateOverride: gitState('feat/x'), rangeReader: undefined }),
    )) as RequestRebaseOutput

    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).not.toContain('main')
    expect(out.reason).toContain('CLOSED')
  })
})

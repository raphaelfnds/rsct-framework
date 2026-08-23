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
// #62: the tool now READS the paths the rebase/squash carries and fails CLOSED
// when that read is unavailable — which it always is here, because `tmpRoot` is a
// bare mkdtemp directory, not a git repo. These tests are not about coverage, so
// they inject an EMPTY but READABLE range: the cross-check is skipped and the
// audit records `empty_range`. The tests that DO exercise coverage pass their own
// reader, and the fail-closed path has its own test — this default must never be
// mistaken for one, which is why it returns `ok` rather than `unavailable`.
const emptyRange: RequestRebaseInternal['rangeReader'] = () => ({ status: 'ok', paths: [] })
function internal(over: Partial<RequestRebaseInternal> = {}): RequestRebaseInternal {
  return { gitStateOverride: gitState('feat/x'), gitExecutor: okExec, promptFn: alwaysYes(), now: FIXED_NOW, rangeReader: emptyRange, ...over }
}

describe('rsct_request_rebase', () => {
  // #62 — request-rebase had NO parity test at all, while merge and push each had
  // one that iterated a hardcoded key list. Derived from the Zod shape: a field
  // added to preMergeAckSchema and not mirrored into preMergeAckJsonSchema leaves
  // the exposed schema additionalProperties:false without it, so the agent can
  // never supply it, evaluatePreMergeAck pushes it into `failing` on every call,
  // and every rebase/squash is permanently blocked behind a green suite.
  // Breaks on: adding a field to preMergeAckSchema without mirroring it.
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

describe('rsct_request_rebase — #62 carried-path coverage cross-check', () => {
  function rangeSpy(result: RangePathsResult): {
    fn: NonNullable<RequestRebaseInternal['rangeReader']>
    seen: Array<[string, string]>
  } {
    const seen: Array<[string, string]> = []
    return { fn: (_r, base, head) => { seen.push([base, head]); return result }, seen }
  }

  // The two modes move in OPPOSITE directions. A single range for both would be
  // silently backwards for one of them and would still pass every other test in
  // this file, because an empty path list is skipped either way.
  // Breaks on: using one direction for both modes.
  it('reads <ref>...HEAD for mode=rebase', async () => {
    const spy = rangeSpy({ status: 'ok', paths: [] })
    await requestRebaseHandler(
      { project_root: tmpRoot, mode: 'rebase', ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: spy.fn }),
    )
    expect(spy.seen).toEqual([['main', 'HEAD']])
  })
  // Breaks on: using the rebase direction for a squash.
  it('reads HEAD...<ref> for mode=squash — the OPPOSITE direction', async () => {
    const spy = rangeSpy({ status: 'ok', paths: [] })
    await requestRebaseHandler(
      { project_root: tmpRoot, mode: 'squash', ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: spy.fn }),
    )
    expect(spy.seen).toEqual([['HEAD', 'main']])
  })

  // Breaks on: weakening fail-closed for rebase. Same measurement as merge:
  // the mutation can succeed where the range read cannot.
  it('fails CLOSED when the range cannot be read', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ rangeReader: () => ({ status: 'unavailable' }) }),
    )) as RequestRebaseOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
  })

  // Breaks on: dropping carriedPaths from the rebase evaluator call.
  it('rejects when a carried path was never attested', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: 'main', dev_approval: approval(), pre_merge_ack: ack({ files_swept: [] }) },
      internal({ rangeReader: () => ({ status: 'ok', paths: ['src/z.ts'] }) }),
    )) as RequestRebaseOutput
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('src/z.ts')
  })

  // Rv-D. This test previously asserted `expect(bad).toEqual([])` over the spied
  // argv — "git was never invoked" — and CALLED that the load-bearing line. It was
  // vacuous, measured: delete `isSafeRevisionToken` from `getRangePaths` and the
  // test still passes, byte-identical. Two reasons, and both matter:
  //   1. `tmpRoot` is a bare mkdtemp directory. With the predicate gone, the flow
  //      falls through to the `isGitRepo` check, still returns `unavailable`, and
  //      still rejects `hygiene_range_unreadable` — same status, same shape.
  //   2. `bad` can never be non-empty ANYWAY. The real `getRangePaths` runs
  //      through `execFileSync` inside `lib/git.ts`, a different seam entirely
  //      from the injected `gitExecutor`, so the spy cannot observe it. The
  //      argv-empty assertion was true by construction, not by protection.
  //
  // What actually distinguishes the two outcomes is the REJECT PROSE:
  // `crossCheckBlockedReason` names the offending revision on the
  // `unsafe_revision` branch and nowhere else. So asserting the crafted token
  // appears in `reason` is the assertion with teeth, and the reject-kind check
  // that reads stronger is the one that proves nothing.
  //
  // The exec-site half of the barrier is pinned separately and against a REAL
  // repository, at `tests/unit/git.test.ts` — that is where "no PWNED file was
  // created" is a real observation rather than a fixture's.
  // Breaks on: removing isSafeRevisionToken from getRangePaths.
  it('refuses an option-shaped ref by NAME, not merely as an unreadable range', async () => {
    const out = (await requestRebaseHandler(
      { project_root: tmpRoot, ref: '--exec=touch PWNED', dev_approval: approval(), pre_merge_ack: ack() },
      internal({ gitStateOverride: gitState('feat/x'), rangeReader: undefined }),
    )) as RequestRebaseOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    // The token itself. Only the unsafe_revision branch emits it; the
    // `unavailable` branch produces prose that never names the input.
    expect(out.reason).toContain('--exec=touch PWNED')
    expect(out.reason).toContain('OPTION')
  })

  // CONTROL for the test above: an ordinary ref in the same non-repo directory
  // reaches the SAME reject_kind by the other route, and its prose does NOT name
  // the ref. Without this, the assertion above could be passing for the generic
  // reason rather than the specific one.
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

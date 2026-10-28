import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestMergeHandler,
  requestMergeTool,
  type RequestMergeInternal,
  type RequestMergeOutput,
} from '../../src/tools/request-merge.js'
import type {
  GitExecResult,
  GitExecutor,
  GitState,
  RangePathsResult,
} from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { preMergeAckSchema } from '../../src/lib/pre-merge-ack.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rm-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const VALID_TS = '2026-06-03T11:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'merge:feat/foo->feat/integration',
    reason: 'merge checkpoint for unit test coverage',
    ...overrides,
  }
}

function ack(overrides: Record<string, unknown> = {}) {
  return {
    plan_complete: true,
    adr_confirmed: true,
    issues_resolved: true,
    hygiene_swept: true,
    note: 'PH-5 hygiene: plan done, ADRs recorded, issues closed, files swept (unit test)',
    ...overrides,
  }
}

function countingPrompt(): {
  fn: (opts: DialogOptions) => Promise<DialogResult>
  calls: () => number
} {
  let n = 0
  return {
    fn: async () => {
      n += 1
      return { response: 'yes', channel: 'windows' }
    },
    calls: () => n,
  }
}

function gitState(branch: string | null): GitState {
  return {
    available: branch !== null,
    branch,
    head_sha: branch !== null ? 'aaaa111' : null,
    is_clean: true,
  }
}

function gitExec(spec: Record<string, GitExecResult> = {}, fallback?: GitExecResult): GitExecutor {
  return (_root, args) => {
    const key = args.join(' ')
    if (key in spec) return spec[key]!
    if (fallback) return fallback
    return { ok: true, stdout: '', stderr: '', exitCode: 0 }
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(r: DialogResult): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => r
}

function writeConfig(root: string, body: Record<string, unknown>): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify(body), 'utf8')
}

const MERGE_OK: GitExecResult = {
  ok: true,
  stdout: 'Merge made by the \'recursive\' strategy.',
  stderr: '',
  exitCode: 0,
}

const emptyRange: RequestMergeInternal['rangeReader'] = () => ({ status: 'ok', paths: [] })

const BASE_CONFIG = {
  rsct_version: '1.0.0',
  app: { name: 'test-app', org: 'test-org' },
}

describe('rsct_request_merge — the dialog is required', () => {
  it('refuses with no dialog channel even when trust_allowed_for lists the merge', async () => {
    writeConfig(tmpRoot, { ...BASE_CONFIG, approval_modes: { trust_allowed_for: ['rsct_request_merge'] } })
    const merges: string[] = []
    const exec = gitExec({
      'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
      'merge --no-ff -- feat/foo': MERGE_OK,
    }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: (root, args) => {
          if (args[0] === 'merge') merges.push(args.join(' '))
          return exec(root, args)
        },
        promptFn: async () => ({ response: 'no-channel', channel: 'none', error: 'no display' }),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(merges).toEqual([])
  })
})

describe('rsct_request_merge — happy path', () => {
  it('merges feature into integration with --no-ff by default', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
      rangeReader: emptyRange,
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff -- feat/foo': MERGE_OK,
      }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      internal,
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.target_branch).toBe('feat/integration')
    expect(out.source_branch).toBe('feat/foo')
    expect(out.channel).toBe('windows')
    expect(out.audit_path).toBeTruthy()
  })

  it('CAP-33: emits bootstrap warning audit when bootstrap_at is missing', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
      rangeReader: emptyRange,
      gitStateOverride: gitState('feat/cap33-int'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff -- feat/foo': MERGE_OK,
      }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      internal,
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.bootstrap_marker?.status).toBe('missing')
    expect(out.hints.some((h) => h.includes('bootstrap not detected'))).toBe(true)

    const auditLines = require('node:fs')
      .readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l))
    expect(
      auditLines.some(
        (l: { event: string; bootstrap_status?: string }) =>
          l.event === 'request_merge.bootstrap_warning' &&
          l.bootstrap_status === 'missing',
      ),
    ).toBe(true)
  })

  it('respects no_ff=false (fast-forward merge)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    let mergeArgs = ''
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        no_ff: false,
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: (_root, args) => {
          if (args[0] === 'merge') mergeArgs = args.join(' ')
          return { ok: true, stdout: '', stderr: '', exitCode: 0 }
        },
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(mergeArgs).toBe('merge -- feat/foo')
    expect(mergeArgs).not.toContain('--no-ff')
  })
})

describe('rsct_request_merge — branch protection on the TARGET', () => {
  it('rejects when merging into a protected target without override', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('main'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(out.target_branch).toBe('main')
  })

  it('merges into protected target with override and audits', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'release/2.0',
        dev_approval: approval({
          override_protected_branch: { reason: 'shipping the 2.0 release branch into main' },
        }),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('main'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(out.branch_check.protected).toBe(true)
    expect(out.branch_check.override_used).toBe(true)
    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('request_merge.override_invoked')
    expect(audit).toContain('shipping the 2.0 release branch into main')
  })
})

describe('rsct_request_merge — extra-strict refusals', () => {
  it('rejects with same_branch when source equals target', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('same_branch')
  })

  it('rejects a target branch that has no commit yet, as before its name could be read', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      {
        rangeReader: emptyRange,
        gitStateOverride: { ...gitState('feat/new'), head_sha: null },
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('detached_head')
  })

  it('rejects with detached_head when target_branch is null', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState(null),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('detached_head')
  })

  it('rejects --allow-unrelated-histories without override even on a non-protected target', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        allow_unrelated_histories: true,
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('unrelated_histories_without_override')
  })

  it('allows --allow-unrelated-histories with override and passes the flag through to git', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    let mergeArgs = ''
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        allow_unrelated_histories: true,
        dev_approval: approval({
          override_protected_branch: { reason: 'monorepo merge of imported history' },
        }),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: (_root, args) => {
          if (args[0] === 'merge') mergeArgs = args.join(' ')
          return { ok: true, stdout: '', stderr: '', exitCode: 0 }
        },
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(mergeArgs).toContain('--allow-unrelated-histories')
  })
})

describe('rsct_request_merge — failure surfaces', () => {
  it('rejected/dialog_no when dev declines', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: dialog({ response: 'no', channel: 'windows' }),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dialog_no')
  })

  it('mutation_failed on merge conflict — approval NOT consumed', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const conflict: GitExecResult = {
      ok: false,
      stdout: '',
      stderr: 'CONFLICT (content): Merge conflict in src/foo.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
      exitCode: 1,
    }
    const internal: RequestMergeInternal = {
      rangeReader: emptyRange,
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff -- feat/foo': conflict,
      }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      internal,
    )) as RequestMergeOutput
    expect(out.status).toBe('mutation_failed')
    expect(out.reason).toContain('CONFLICT')

    const out2 = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      { ...internal, gitExecutor: gitExec({}, MERGE_OK) },
    )) as RequestMergeOutput
    expect(out2.status).toBe('merged')
  })
})

describe('rsct_request_merge — schema', () => {
  it('rejects when source_branch is missing', async () => {
    await expect(
      requestMergeHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
        pre_merge_ack: ack(),
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      requestMergeHandler({
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
        bogus: true,
      }),
    ).rejects.toThrow()
  })

  it('exposes pre_merge_ack in inputSchema, all-optional (parity with the Zod schema)', () => {
    const schema = requestMergeTool.inputSchema as {
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
})

describe('rsct_request_merge — post-mutation write failures (HIGH-2 / HIGH-3)', () => {
  it('surfaces anti_replay_error + warning hint when approvals-seen write fails after a successful merge', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
      rangeReader: emptyRange,
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({}, MERGE_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      approvalRecorder: () => ({
        ok: false,
        path: join(tmpRoot, '.rsct', 'approvals-seen.json'),
        error: 'simulated atomic rename failed',
      }),
    }
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      internal,
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.anti_replay_persisted).toBe(false)
    expect(out.anti_replay_error).toBe('simulated atomic rename failed')
    expect(
      out.hints.some((h) => h.includes('could not record this approval as used')),
    ).toBe(true)
  })

  it('surfaces audit_error + warning hint when audit append fails after a successful merge', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
      rangeReader: emptyRange,
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({}, MERGE_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      auditWriter: () => ({
        ok: false,
        reason: 'write_failed',
        path: join(tmpRoot, '.rsct', 'audit.log'),
        error: 'simulated read-only fs',
      }),
    }
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      internal,
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.anti_replay_persisted).toBe(true)
    expect(out.audit_error).toBe('simulated read-only fs')
    expect(
      out.hints.some(
        (h) => h.includes('audit log write failed') && h.includes('simulated read-only fs'),
      ),
    ).toBe(true)
  })
})

describe('rsct_request_merge — CAP-55 post-merge cleanup hint', () => {
  const mergeInternal = (): RequestMergeInternal => ({
    rangeReader: emptyRange,
    gitStateOverride: gitState('feat/integration'),
    gitExecutor: gitExec(
      {
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff -- feat/foo': MERGE_OK,
      },
      { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 },
    ),
    promptFn: alwaysYes(),
    now: FIXED_NOW,
  })

  it('surfaces the artifact-cleanup advisory (suggest delete) after a merge when progress is all-closed', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    writeFileSync(join(tmpRoot, 'plan_foo.md'), '# Plan\n\n| Branch | feat/foo |\n| Status | completed |\n')
    writeFileSync(join(tmpRoot, 'progress_foo.md'), '- [x] done\n')
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      mergeInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(out.hints.some((h) => h.includes('rsct_plan_dispose'))).toBe(true)
    expect(out.hints.some((h) => h.includes('looks complete'))).toBe(true)
  })

  it('REJECTS the merge when plan_complete is attested but the plan progress has open items', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    writeFileSync(join(tmpRoot, 'plan_foo.md'), '# Plan\n\n| Branch | feat/foo |\n| Status | in progress |\n')
    writeFileSync(join(tmpRoot, 'progress_foo.md'), '- [ ] still open\n')
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      mergeInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
  })
})

describe('rsct_request_merge — PH-5 pre_merge_ack hygiene gate', () => {
  const okInternal = (branch = 'feat/integration'): RequestMergeInternal => ({
    rangeReader: emptyRange,
    gitStateOverride: gitState(branch),
    gitExecutor: gitExec({}, MERGE_OK),
    promptFn: alwaysYes(),
    now: FIXED_NOW,
  })

  it('rejects pre_merge_ack_missing when the ack is absent — and NO OS dialog is shown', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const prompt = countingPrompt()
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      { rangeReader: emptyRange, gitStateOverride: gitState('feat/integration'), gitExecutor: gitExec({}, MERGE_OK), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
    expect(prompt.calls()).toBe(0)
    expect(out.channel).toBeNull()
  })

  it('rejects pre_merge_ack_incomplete when plan_complete is false', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ plan_complete: false }) },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('plan_complete')
  })

  it('rejects pre_merge_ack_incomplete when adr_confirmed is false', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ adr_confirmed: false }) },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('adr_confirmed')
  })

  it('rejects pre_merge_ack_incomplete when issues_resolved is false (the third lock)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ issues_resolved: false }) },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('issues_resolved')
  })

  it('lists all three items in failing when every attestation is false', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack({ plan_complete: false, adr_confirmed: false, issues_resolved: false }),
      },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    for (const item of ['plan_complete', 'adr_confirmed', 'issues_resolved']) {
      expect(out.reason).toContain(item)
    }
  })

  it('requires a non-empty note when adr_confirmed or issues_resolved is true', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ note: '   ' }) },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('note')
  })

  it('merges when the ack is fully satisfied (all true + note)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      okInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
  })

  it('rejects an unknown key inside pre_merge_ack (nested .strict())', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    await expect(
      requestMergeHandler({
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: { ...ack(), bogus: true },
      }),
    ).rejects.toThrow()
  })

  it('the ack-check precedes the structural rejects: detached HEAD without ack ⇒ pre_merge_ack_missing', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      { rangeReader: emptyRange, gitStateOverride: gitState(null), gitExecutor: gitExec({}, MERGE_OK), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
  })

  it('audits the ack reject with the self-attested label', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      okInternal(),
    )
    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('pre_merge_ack_missing')
    expect(audit).toContain('pre_merge_ack_self_attested')
  })

  it('audits the incomplete reject with the failing items', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ plan_complete: false }) },
      okInternal(),
    )
    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('pre_merge_ack_incomplete')
    expect(audit).toContain('plan_complete')
  })

  it('an ack reject does NOT consume the dev_approval — the same approval works on retry', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const appr = approval()
    const out1 = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: appr },
      okInternal(),
    )) as RequestMergeOutput
    expect(out1.status).toBe('rejected')
    expect(out1.reject_kind).toBe('pre_merge_ack_missing')
    const out2 = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: appr, pre_merge_ack: ack() },
      okInternal(),
    )) as RequestMergeOutput
    expect(out2.status).toBe('merged')
  })

  it('shows the OS dialog exactly once on a satisfied ack (pairs the 0-call reject test)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const prompt = countingPrompt()
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: emptyRange, gitStateOverride: gitState('feat/integration'), gitExecutor: gitExec({}, MERGE_OK), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(prompt.calls()).toBe(1)
  })
})

describe('rsct_request_merge — install-drift advisory (#25)', () => {
  const SECURITY = /SECURITY: RSCT enforcement is not running/

  it('prepends the advisory on a successful merge and audits the detection', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({
          'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
          'merge --no-ff -- feat/foo': MERGE_OK,
        }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.hints[0]).toMatch(SECURITY)

    const entry = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === 'install.drift_detected')
    expect(entry?.tool).toBe('rsct_request_merge')
    expect(entry?.severity).toBe('security')
  })

  it('carries the advisory when the merge is REJECTED before the dialog', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({}),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput

    expect(out.status).toBe('rejected')
    expect(out.hints[0]).toMatch(SECURITY)
  })

  it('puts one line in the OS dialog', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    let seen = ''
    await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: emptyRange,
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({
          'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
          'merge --no-ff -- feat/foo': MERGE_OK,
        }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
        promptFn: async (opts: DialogOptions) => {
          seen = opts.message
          return { response: 'yes', channel: 'windows' }
        },
        now: FIXED_NOW,
      },
    )
    expect(seen).toContain('Approve merge')
    expect(seen).toContain('RSCT enforcement is NOT running')
    const advisoryLines = seen
      .split('\n')
      .filter((l) => l.includes('RSCT enforcement is NOT running'))
    expect(advisoryLines).toHaveLength(1)
  })
})

describe('rsct_request_merge — #62 carried-path coverage cross-check', () => {
  function rangeSpy(result: RangePathsResult): {
    fn: NonNullable<RequestMergeInternal['rangeReader']>
    seen: Array<[string, string]>
  } {
    const seen: Array<[string, string]> = []
    return {
      fn: (_root, base, head) => {
        seen.push([base, head])
        return result
      },
      seen,
    }
  }
  const mergeExec = () =>
    gitExec(
      {
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff -- feat/foo': MERGE_OK,
      },
      { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 },
    )

  it('reads the range as HEAD...<source_branch>', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const spy = rangeSpy({ status: 'ok', paths: [] })
    await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )
    expect(spy.seen).toEqual([['HEAD', 'feat/foo']])
  })

  it('rejects when a carried path was never attested in files_swept', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const prompt = countingPrompt()
    const spy = rangeSpy({ status: 'ok', paths: ['src/a.ts', 'src/b.ts'] })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ files_swept: ['src/a.ts'] }) },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestMergeOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('src/b.ts')
    expect(prompt.calls()).toBe(0)
  })

  it('merges when every carried path was attested', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const spy = rangeSpy({ status: 'ok', paths: ['src/a.ts'] })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ files_swept: ['src/a.ts'] }) },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
  })

  it('records the FULL unswept list on the audit entry', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const paths = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`)
    const spy = rangeSpy({ status: 'ok', paths })
    await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ files_swept: [] }) },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )
    const entry = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8').trim().split('\n').pop() as string,
    )
    expect(entry.files_unswept).toHaveLength(14)
    expect(entry.path_crosscheck).toBe('enforced')
  })

  it('fails CLOSED when the range cannot be read, without popping the dialog', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const prompt = countingPrompt()
    const spy = rangeSpy({ status: 'unavailable' })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestMergeOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(prompt.calls()).toBe(0)
    const entry = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8').trim().split('\n').pop() as string,
    )
    expect(entry.path_crosscheck).toBe('degraded')
  })

  it('audits a refused revision as rejected_revision, not degraded', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const spy = rangeSpy({ status: 'unsafe_revision', revision: '--exec=touch PWNED' })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestMergeOutput

    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).toContain('--exec=touch PWNED')
    const entry = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8').trim().split('\n').pop() as string,
    )
    expect(entry.path_crosscheck).toBe('rejected_revision')
  })

  it('audits path_crosscheck on the merge that LANDED', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const spy = rangeSpy({ status: 'ok', paths: ['src/a.ts'] })
    await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack({ files_swept: ['src/a.ts'] }) },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )
    const done = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'request_merge.merged')
    expect(done.path_crosscheck).toBe('enforced')
    expect(done.carried_paths).toBe(1)
  })

  it('reports a MISSING ack ahead of an unreadable range', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const spy = rangeSpy({ status: 'unavailable' })
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      { rangeReader: spy.fn, gitStateOverride: gitState('feat/integration'), gitExecutor: mergeExec(), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
  })

  it('Rv-B: allow_unrelated_histories reaches the merge despite an unreadable range', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        allow_unrelated_histories: true,
        dev_approval: approval({ override_protected_branch: { reason: 'monorepo import of unrelated history' } }),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: () => ({ status: 'unavailable' }),
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: gitExec({
          'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
          'merge --no-ff --allow-unrelated-histories -- feat/foo': MERGE_OK,
        }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.hints.some((h) => h.includes('coverage check SKIPPED'))).toBe(true)
    const degraded = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
      .find((e) => e.event === 'request_merge.pre_merge_ack_degraded')
    expect(degraded.path_crosscheck).toBe('degraded')
  })

  it('Rv-B: the exemption does NOT cover a refused revision', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      {
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        allow_unrelated_histories: true,
        dev_approval: approval({ override_protected_branch: { reason: 'monorepo import of unrelated history' } }),
        pre_merge_ack: ack(),
      },
      {
        rangeReader: () => ({ status: 'unsafe_revision', revision: '--exec=touch PWNED' }),
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: mergeExec(),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput

    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).toContain('--exec=touch PWNED')
  })

  it('Rv-B: an unreadable range without the flag still fails CLOSED', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval(), pre_merge_ack: ack() },
      {
        rangeReader: () => ({ status: 'unavailable' }),
        gitStateOverride: gitState('feat/integration'),
        gitExecutor: mergeExec(),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
  })
})

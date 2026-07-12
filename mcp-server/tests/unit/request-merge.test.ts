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
} from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

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

// PH-5: a fully-satisfied pre_merge_ack (all self-attestations true + a note, so
// the note-when-attested rule is met). Override individual fields per test.
function ack(overrides: Record<string, unknown> = {}) {
  return {
    plan_complete: true,
    adr_confirmed: true,
    issues_resolved: true,
    note: 'PH-5 hygiene: plan done, ADRs recorded, issues closed (unit test)',
    ...overrides,
  }
}

// A promptFn seam that counts invocations — proves the OS dialog is NOT shown on
// an ack reject (the ack-check returns before gateRequest).
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

const BASE_CONFIG = {
  rsct_version: '1.0.0',
  app: { name: 'test-app', org: 'test-org' },
}

describe('rsct_request_merge — happy path', () => {
  it('merges feature into integration with --no-ff by default', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff feat/foo': MERGE_OK,
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
      gitStateOverride: gitState('feat/cap33-int'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff feat/foo': MERGE_OK,
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
    expect(mergeArgs).toBe('merge feat/foo')
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
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({}, MERGE_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('same_branch')
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
      gitStateOverride: gitState('feat/integration'),
      gitExecutor: gitExec({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff feat/foo': conflict,
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

    // Retry with same approval after conflict resolution — should NOT be 'reused'.
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
    for (const k of ['plan_complete', 'adr_confirmed', 'issues_resolved', 'note']) {
      expect(ackProp.properties?.[k]).toBeDefined()
    }
    // parity: neither the outer key nor any inner key is required
    expect(schema.required ?? []).not.toContain('pre_merge_ack')
    expect(ackProp.required).toBeUndefined()
  })
})

describe('rsct_request_merge — post-mutation write failures (HIGH-2 / HIGH-3)', () => {
  it('surfaces anti_replay_error + warning hint when approvals-seen write fails after a successful merge', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestMergeInternal = {
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
    gitStateOverride: gitState('feat/integration'),
    gitExecutor: gitExec(
      {
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'merge --no-ff feat/foo': MERGE_OK,
      },
      { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 },
    ),
    promptFn: alwaysYes(),
    now: FIXED_NOW,
  })

  // plan-lifecycle-v2 (Bloco 2.3): the cleanup trigger moved from the plan
  // FILE's Status field to the plan_complete ACK (a merge only reaches
  // post-success when the ack passed), and the hint now comes from
  // planCleanupReport + points at rsct_plan_dispose (advisory-only).
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

  // plan-lifecycle-v2 (Bloco 2.2): a plan_complete:true attestation that
  // contradicts visible open `- [ ]` items in the plan's progress is now
  // rejected mechanically, BEFORE the OS dialog.
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
      { gitStateOverride: gitState('feat/integration'), gitExecutor: gitExec({}, MERGE_OK), promptFn: prompt.fn, now: FIXED_NOW },
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
      { gitStateOverride: gitState(null), gitExecutor: gitExec({}, MERGE_OK), promptFn: alwaysYes(), now: FIXED_NOW },
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
    // retry with the SAME approval + a valid ack — must NOT be 'reused'
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
      { gitStateOverride: gitState('feat/integration'), gitExecutor: gitExec({}, MERGE_OK), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(prompt.calls()).toBe(1)
  })
})

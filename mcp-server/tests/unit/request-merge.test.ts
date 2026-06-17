import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestMergeHandler,
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
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      requestMergeHandler({
        project_root: tmpRoot,
        source_branch: 'feat/foo',
        dev_approval: approval(),
        bogus: true,
      }),
    ).rejects.toThrow()
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
      },
      internal,
    )) as RequestMergeOutput

    expect(out.status).toBe('merged')
    expect(out.anti_replay_persisted).toBe(false)
    expect(out.anti_replay_error).toBe('simulated atomic rename failed')
    expect(
      out.hints.some((h) => h.includes('anti-replay store update failed')),
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

  it('suggests deleting the working branch + plan files when the plan is complete', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    writeFileSync(
      join(tmpRoot, 'plan_foo.md'),
      '# Plan\n\n| Field | Value |\n|---|---|\n| Status | completed |\n',
    )
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      mergeInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(out.hints.some((h) => h.includes("working branch 'feat/foo'"))).toBe(true)
    expect(out.hints.some((h) => h.includes('squash, or rebase'))).toBe(true)
  })

  it('does NOT suggest cleanup when the plan is not complete', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    writeFileSync(
      join(tmpRoot, 'plan_foo.md'),
      '# Plan\n\n| Field | Value |\n|---|---|\n| Status | in progress |\n',
    )
    const out = (await requestMergeHandler(
      { project_root: tmpRoot, source_branch: 'feat/foo', dev_approval: approval() },
      mergeInternal(),
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(out.hints.some((h) => h.includes('working branch'))).toBe(false)
  })
})

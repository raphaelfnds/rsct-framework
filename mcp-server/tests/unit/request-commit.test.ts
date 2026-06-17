import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestCommitHandler,
  type RequestCommitOutput,
  type RequestCommitInternal,
} from '../../src/tools/request-commit.js'
import type {
  GitExecResult,
  GitExecutor,
  GitState,
} from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { recordConsumedApproval } from '../../src/lib/dev-approval.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rc-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const VALID_TS = '2026-06-03T11:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'commit:feat/foo:abc1234',
    reason: 'commit checkpoint covering happy-path tests',
    ...overrides,
  }
}

function gitState(branch: string | null): GitState {
  return {
    available: branch !== null,
    branch,
    head_sha: branch !== null ? 'aaaa111' : null,
    is_clean: false,
  }
}

function gitExecutorMock(
  spec: Record<string, GitExecResult> = {},
  fallback?: GitExecResult,
): GitExecutor {
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

function rsctConfig(overrides: Record<string, unknown> = {}) {
  return {
    rsct_version: '1.0.0',
    app: { name: 'test-app', org: 'test-org' },
    ...overrides,
  }
}

function writeConfig(root: string, body: Record<string, unknown>): void {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify(body), 'utf8')
}

// Minimal staged diff that triggers a value-shape (sk-) finding.
function dirtyDiff(): string {
  return [
    'diff --git a/app.env b/app.env',
    '--- a/app.env',
    '+++ b/app.env',
    '@@ -1 +1 @@',
    '+API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA',
  ].join('\n')
}

function cleanDiff(): string {
  return [
    'diff --git a/src/feature.ts b/src/feature.ts',
    '--- a/src/feature.ts',
    '+++ b/src/feature.ts',
    '@@ -1 +1 @@',
    '+export const greeting = "hello"',
  ].join('\n')
}

const COMMIT_OK: GitExecResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }

describe('rsct_request_commit — happy path', () => {
  it('commits on a non-protected branch with no findings and writes audit', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExecutorMock({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'commit -m feat: x': COMMIT_OK,
      }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.branch).toBe('feat/foo')
    expect(out.channel).toBe('windows')
    expect(out.secrets_check.findings_count).toBe(0)
    expect(out.branch_check.protected).toBe(false)
    expect(out.audit_path).toBeTruthy()
    expect(existsSync(join(tmpRoot, '.rsct', 'audit.log'))).toBe(true)

    // Approval consumed: a second call with the same approval must reject as 'reused'.
    const out2 = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      { ...internal, promptFn: alwaysYes() },
    )) as RequestCommitOutput
    expect(out2.status).toBe('rejected')
    expect(out2.reject_kind).toBe('reused')
  })
})

describe('rsct_request_commit — CAP-53 plan-tracking reminder', () => {
  const COMMIT_INTERNAL = (branch: string): RequestCommitInternal => ({
    gitStateOverride: gitState(branch),
    gitExecutor: gitExecutorMock(
      {
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'commit -m feat: x': COMMIT_OK,
      },
      { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 },
    ),
    promptFn: alwaysYes(),
    now: FIXED_NOW,
  })

  it('hints to update progress when an active plan file exists', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writeFileSync(
      join(tmpRoot, 'plan_foo.md'),
      '# Plan\n\n| Field | Value |\n|---|---|\n| Status | in progress |\n',
    )
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval(), staged_diff_override: cleanDiff() },
      COMMIT_INTERNAL('feat/foo'),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.some((h) => h.includes("Active plan 'foo'"))).toBe(true)
  })

  it('does NOT hint when no plan/spec file exists', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval(), staged_diff_override: cleanDiff() },
      COMMIT_INTERNAL('feat/bar'),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.some((h) => h.includes('Active plan'))).toBe(false)
  })
})

describe('rsct_request_commit — CAP-33 bootstrap visibility', () => {
  it('emits bootstrap warning hint + audit when bootstrap_at is missing', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/cap33'),
      gitExecutor: gitExecutorMock({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'commit -m feat: x': COMMIT_OK,
      }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.bootstrap_marker).toBeDefined()
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
          l.event === 'request_commit.bootstrap_warning' &&
          l.bootstrap_status === 'missing',
      ),
    ).toBe(true)
  })

  it('no bootstrap warning when bootstrap_at is fresh', async () => {
    writeConfig(tmpRoot, rsctConfig())
    // Pre-stamp a fresh bootstrap_at
    const fresh = new Date(FIXED_NOW.getTime() - 60 * 1000).toISOString()
    require('node:fs').mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    require('node:fs').writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify({ bootstrap_at: fresh }),
      'utf8',
    )
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/cap33-fresh'),
      gitExecutor: gitExecutorMock({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'commit -m feat: x': COMMIT_OK,
      }, { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.bootstrap_marker?.status).toBe('fresh')
    expect(out.hints.some((h) => h.includes('bootstrap'))).toBe(false)
  })
})

describe('rsct_request_commit — branch protection (INV-5)', () => {
  it('rejects with protected_branch when on main without override', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      {
        gitStateOverride: gitState('main'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(out.branch_check.protected).toBe(true)
    expect(out.branch_check.override_used).toBe(false)
  })

  it('commits on a protected branch when override_protected_branch is provided', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'hotfix: x',
        dev_approval: approval({
          override_protected_branch: { reason: 'release branch hotfix' },
        }),
        staged_diff_override: cleanDiff(),
      },
      {
        gitStateOverride: gitState('main'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.branch_check.override_used).toBe(true)

    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('request_commit.override_invoked')
    expect(audit).toContain('"override_kind":"protected_branch"')
    expect(audit).toContain('release branch hotfix')
  })
})

describe('rsct_request_commit — secrets scan (INV-6)', () => {
  it('rejects with secrets when staged diff contains a credential and no override', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: dirtyDiff(),
      },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('secrets')
    expect(out.secrets_check.findings_count).toBeGreaterThanOrEqual(1)
    expect(out.secrets_check.override_used).toBe(false)
  })

  it('commits when override_secrets_check is provided', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval({
          override_secrets_check: { reason: 'sample placeholder in fixture' },
        }),
        staged_diff_override: dirtyDiff(),
      },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.secrets_check.override_used).toBe(true)

    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('"override_kind":"secrets_check"')
  })
})

describe('rsct_request_commit — dialog refusal', () => {
  it('rejects with dialog_no when the dev says No', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: dialog({ response: 'no', channel: 'windows' }),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dialog_no')
  })
})

describe('rsct_request_commit — mutation_failed preserves approval', () => {
  it('returns mutation_failed and does NOT consume the approval when git commit fails', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const commitFail: GitExecResult = {
      ok: false,
      stdout: '',
      stderr: 'nothing to commit, working tree clean',
      exitCode: 1,
    }
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExecutorMock({
        'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        'commit -m feat: x': commitFail,
      }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('mutation_failed')
    expect(out.reason).toContain('nothing to commit')

    // Retry with the SAME approval should NOT be 'reused' — mutation_failed
    // does not burn the approval. (We swap the executor to a success path.)
    const out2 = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      {
        ...internal,
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
      },
    )) as RequestCommitOutput
    expect(out2.status).toBe('committed')
  })
})

describe('rsct_request_commit — schema validation', () => {
  it('rejects unknown input keys (zod strict)', async () => {
    await expect(
      requestCommitHandler({
        project_root: tmpRoot,
        message: 'm',
        dev_approval: approval(),
        unknown_field: 'x',
      }),
    ).rejects.toThrow()
  })

  it('rejects when message is missing', async () => {
    await expect(
      requestCommitHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
      }),
    ).rejects.toThrow()
  })
})

describe('rsct_request_commit — reused detection via external pre-seed', () => {
  it('rejects when the approval was previously consumed (seeded in store)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const a = approval()
    recordConsumedApproval(a, {
      projectRoot: tmpRoot,
      now: new Date(FIXED_NOW.getTime() - 10_000),
    })
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: a,
        staged_diff_override: cleanDiff(),
      },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExecutorMock({}, COMMIT_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('reused')
  })
})

describe('rsct_request_commit — post-mutation write failures (HIGH-2 / HIGH-3)', () => {
  it('surfaces audit_error and warning hint when audit append fails after a successful commit', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExecutorMock({}, COMMIT_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      auditWriter: () => ({
        ok: false,
        reason: 'write_failed',
        path: join(tmpRoot, '.rsct', 'audit.log'),
        error: 'simulated disk full',
      }),
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.audit_path).toBeTruthy()
    expect(out.audit_error).toBe('simulated disk full')
    expect(out.anti_replay_persisted).toBe(true)
    expect(
      out.hints.some(
        (h) =>
          h.includes('audit log write failed') && h.includes('simulated disk full'),
      ),
    ).toBe(true)
  })

  it('surfaces anti_replay_error and warning hint when approvals-seen write fails', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExecutorMock({}, COMMIT_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      approvalRecorder: () => ({
        ok: false,
        path: join(tmpRoot, '.rsct', 'approvals-seen.json'),
        error: 'simulated atomic rename failed',
      }),
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.anti_replay_persisted).toBe(false)
    expect(out.anti_replay_error).toBe('simulated atomic rename failed')
    expect(
      out.hints.some(
        (h) =>
          h.includes('anti-replay store update failed') &&
          h.includes('simulated atomic rename failed') &&
          h.includes('commit:feat/foo:abc1234'),
      ),
    ).toBe(true)
  })

  it('rejected path keeps anti_replay_persisted=null (approval never attempted)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const internal: RequestCommitInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExecutorMock({}, COMMIT_OK),
      promptFn: dialog({ response: 'no', channel: 'windows' }),
      now: FIXED_NOW,
    }
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      internal,
    )) as RequestCommitOutput

    expect(out.status).toBe('rejected')
    expect(out.anti_replay_persisted).toBeNull()
    expect(out.anti_replay_error).toBeNull()
    expect(out.audit_error).toBeNull()
  })
})

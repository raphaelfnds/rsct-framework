import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PhaseState, PlanAuthorizationBlock } from '../../src/lib/phase-scope.js'
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

// A2 (INV-6 hardening): `staged_diff_override` is no longer a PUBLIC MCP input —
// the staged-diff test seam now lives on `internal.stagedDiffOverride`. This
// adapter keeps the existing call-sites readable by lifting a `staged_diff_override`
// key from the input object into the internal seam. Tests that assert the PUBLIC
// input is now rejected call `requestCommitHandler` DIRECTLY (see the A2 test below).
function callCommit(
  input: Record<string, unknown>,
  internal: RequestCommitInternal = {},
): Promise<RequestCommitOutput> {
  const { staged_diff_override, ...rest } = input
  const merged: RequestCommitInternal =
    typeof staged_diff_override === 'string'
      ? { ...internal, stagedDiffOverride: staged_diff_override }
      : internal
  return requestCommitHandler(rest, merged)
}

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
    const out = (await callCommit(
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
    const out2 = (await callCommit(
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
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval(), staged_diff_override: cleanDiff() },
      COMMIT_INTERNAL('feat/foo'),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.some((h) => h.includes("Active plan 'foo'"))).toBe(true)
  })

  it('does NOT hint when no plan/spec file exists', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out2 = (await callCommit(
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
      callCommit({
        project_root: tmpRoot,
        message: 'm',
        dev_approval: approval(),
        unknown_field: 'x',
      }),
    ).rejects.toThrow()
  })

  it('rejects when message is missing', async () => {
    await expect(
      callCommit({
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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
    const out = (await callCommit(
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

// ---------------------------------------------------------------------------
// T3 — plan-token authorization path (dev_approval omitted)
// ---------------------------------------------------------------------------

function tokenBlock(over: Partial<PlanAuthorizationBlock> = {}): PlanAuthorizationBlock {
  return {
    plan_slug: 't3',
    branch: 'feat/foo',
    covers: ['commit'],
    authorized_at: FIXED_NOW.toISOString(),
    expires_at: new Date(FIXED_NOW.getTime() + 60 * 60_000).toISOString(),
    max_actions: 5,
    actions_used: 0,
    approval_ref: { action_scope: 'plan_authorize:t3', timestamp: VALID_TS },
    ...over,
  }
}

function seedState(state: PhaseState): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
}

function readPhaseState(): PhaseState | null {
  const p = join(tmpRoot, '.rsct/phase-state.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as PhaseState
}

function writePlanFile(slug = 't3', status = 'in progress'): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Status | ${status} |\n`)
}

function tokenInternal(over: Partial<RequestCommitInternal> = {}): RequestCommitInternal {
  return {
    gitStateOverride: gitState('feat/foo'),
    gitExecutor: gitExecutorMock(
      { 'commit -m feat: x': COMMIT_OK },
      { ok: true, stdout: 'bbbb222\n', stderr: '', exitCode: 0 },
    ),
    now: FIXED_NOW,
    ...over,
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const GIT = hasGit()

describe('rsct_request_commit — plan-token path (T3)', () => {
  it('commits with NO dev_approval when a valid token covers it; debits one action', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock() })

    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.authorized_via).toBe('plan_token')
    expect(out.channel).toBe('plan_token')
    expect(out.plan_token?.actions_used).toBe(1)
    expect(out.plan_token?.max_actions).toBe(5)
    // debit-first persisted the increment
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(1)
  })

  it('a second token commit debits again (2/5)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ actions_used: 1 }) })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.plan_token?.actions_used).toBe(2)
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(2)
  })

  it('rejects when no dev_approval and no token (absent)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('rejects an exhausted token (actions_used >= max_actions)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ actions_used: 5, max_actions: 5 }) })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('rejects an expired token', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({
      plan_authorization: tokenBlock({
        expires_at: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
      }),
    })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('rejects on branch mismatch (token auto-revokes on branch switch)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ branch: 'feat/foo' }) })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal({ gitStateOverride: gitState('feat/other') }),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('rejects when the token plan_/spec_ file is gone (plan_gone)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    // no plan_t3.md written
    seedState({ plan_authorization: tokenBlock() })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('INV-5: token NEVER covers a protected branch (rejects, no override possible)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ branch: 'main' }) })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal({ gitStateOverride: gitState('main') }),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    // token not debited on an INV-5 reject
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(0)
  })

  it('A2: staged_diff_override is no longer a PUBLIC input (zod strict rejects it)', async () => {
    // The fabricated-diff INV-6 bypass is closed: the diff seam moved to the
    // test-only internal arg, so passing staged_diff_override as MCP input is now
    // an unknown key. Call the handler DIRECTLY (bypass the callCommit adapter,
    // which would strip the key) to prove the raw input is rejected.
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock() })
    await expect(
      requestCommitHandler(
        { project_root: tmpRoot, message: 'feat: x', staged_diff_override: dirtyDiff() },
        tokenInternal(),
      ),
    ).rejects.toThrow()
  })

  it.skipIf(!GIT)('INV-6: token path rejects a REAL staged secret (scans git diff --cached)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock() })
    // real git repo with a staged secret so getStagedDiff returns it
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: tmpRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpRoot, stdio: 'ignore' })
    writeFileSync(join(tmpRoot, 'app.env'), 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA\n')
    execFileSync('git', ['add', 'app.env'], { cwd: tmpRoot, stdio: 'ignore' })

    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('secrets')
    // token not debited on an INV-6 reject
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(0)
  })

  it('RV3: a failed commit REFUNDS the reserved token action (debit-first)', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ actions_used: 2 }) })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal({
        gitExecutor: gitExecutorMock(
          { 'commit -m feat: x': { ok: false, stdout: '', stderr: 'nothing to commit', exitCode: 1 } },
          { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 },
        ),
      }),
    )) as RequestCommitOutput
    expect(out.status).toBe('mutation_failed')
    // reserved action refunded → counter back to 2
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(2)
  })

  it('precedence: a dev_approval present uses the per-action path; token untouched', async () => {
    writeConfig(tmpRoot, rsctConfig())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock({ actions_used: 1 }) })
    const out = (await callCommit(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval(),
        staged_diff_override: cleanDiff(),
      },
      tokenInternal({ promptFn: alwaysYes() }),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.authorized_via).toBe('dev_approval')
    expect(out.channel).toBe('windows')
    // token counter NOT touched by the per-action path
    expect(readPhaseState()?.plan_authorization?.actions_used).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// T2 — INV-7 contract-surface gate (multi-repo only)
// ---------------------------------------------------------------------------

const UNIVERSE_FX = join(__dirname, '..', 'fixtures', 'sample-universe')

function multiRepoCfg(over: Record<string, unknown> = {}) {
  return {
    rsct_version: '1.0.0',
    app: { name: 'registered-app', org: 'acme' },
    topology: { mode: 'multi-repo' },
    universe: { local: UNIVERSE_FX },
    ...over,
  }
}

// INV-7 gate internal: a clean staged diff (passes INV-6) + an injected staged
// path list (the gate's real input is git diff --cached --name-only; the override
// is a test-only seam, same posture as stagedDiffOverride).
function gateInternal(
  stagedPaths: string[],
  over: Partial<RequestCommitInternal> = {},
): RequestCommitInternal {
  return {
    gitStateOverride: gitState('feat/api'),
    stagedPathsOverride: stagedPaths,
    stagedDiffOverride: cleanDiff(),
    gitExecutor: gitExecutorMock(
      { 'rev-parse --short HEAD': { ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 } },
      COMMIT_OK,
    ),
    promptFn: alwaysYes(),
    now: FIXED_NOW,
    ...over,
  }
}

describe('rsct_request_commit — INV-7 contract-surface gate (T2)', () => {
  it('multi-repo + produced surface touched + no override → BLOCK with consumers', async () => {
    writeConfig(tmpRoot, multiRepoCfg())
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: api', dev_approval: approval() },
      gateInternal(['src/api/orders.ts']),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('contract_surface')
    expect(out.contract_check?.touched).toEqual(['orders-api'])
    expect(out.contract_check?.consumers).toEqual(['reporting', 'web-frontend'])
  })

  it('mono + surface touched → NO-OP (commits); contract_check.mode = mono', async () => {
    writeConfig(tmpRoot, multiRepoCfg({ topology: { mode: 'mono' } }))
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['src/api/orders.ts']),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.contract_check?.mode).toBe('mono')
    expect(out.contract_check?.touched).toEqual([])
  })

  it('multi-repo + non-surface path → NO-OP (commits)', async () => {
    writeConfig(tmpRoot, multiRepoCfg())
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['README.md']),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.contract_check?.mode).toBe('multi-repo')
    expect(out.contract_check?.touched).toEqual([])
  })

  it('unconfirmed topology + surface touched → NO-OP (gate off until confirmed)', async () => {
    writeConfig(tmpRoot, multiRepoCfg({ topology: undefined }))
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['src/api/orders.ts']),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.contract_check?.mode).toBeNull()
  })

  it('override_contract_surface → commits + records override_used', async () => {
    writeConfig(tmpRoot, multiRepoCfg())
    const out = (await callCommit(
      {
        project_root: tmpRoot,
        message: 'feat: x',
        dev_approval: approval({ override_contract_surface: { reason: 'coordinated cross-repo bump' } }),
      },
      gateInternal(['src/api/orders.ts']),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.contract_check?.override_used).toBe(true)
    expect(out.contract_check?.touched).toEqual(['orders-api'])
  })

  it('INV-6 secrets still enforced under multi-repo (rejects before INV-7)', async () => {
    writeConfig(tmpRoot, multiRepoCfg())
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['src/api/orders.ts'], { stagedDiffOverride: dirtyDiff() }),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('secrets')
  })

  it('token path + surface touched → HARD BLOCK (token carries no override)', async () => {
    writeConfig(tmpRoot, multiRepoCfg())
    writePlanFile()
    seedState({ plan_authorization: tokenBlock() })
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x' },
      tokenInternal({ stagedPathsOverride: ['src/api/orders.ts'], stagedDiffOverride: cleanDiff() }),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('contract_surface')
  })

  it('RV3: multi-repo + no contracts.json → NO-OP commit + inactive-gate hint', async () => {
    const uni = mkdtempSync(join(tmpdir(), 'rsct-uni-nc-'))
    mkdirSync(join(uni, 'applications', 'registered-app'), { recursive: true })
    writeFileSync(join(uni, '.universe.json'), '{"name":"x","registered_apps":["registered-app"]}')
    writeConfig(tmpRoot, multiRepoCfg({ universe: { local: uni } }))
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['src/api/orders.ts']),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.join(' ')).toMatch(/did NOT enforce/)
  })

  it('INV-5 protected branch takes precedence over INV-7 (rejects protected_branch first)', async () => {
    writeConfig(tmpRoot, multiRepoCfg({ protected_branches: ['main'] }))
    const out = (await callCommit(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval() },
      gateInternal(['src/api/orders.ts'], { gitStateOverride: gitState('main') }),
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch') // INV-5 runs before the INV-7 gate
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestPushHandler,
  requestPushTool,
  type RequestPushInternal,
  type RequestPushOutput,
} from '../../src/tools/request-push.js'
import type {
  GitExecResult,
  GitExecutor,
  GitState,
} from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rp-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const VALID_TS = '2026-06-03T11:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'push:feat/foo:abc1234',
    reason: 'push checkpoint for unit test coverage',
    ...overrides,
  }
}

// PH-5: a fully-satisfied pre_merge_ack (all self-attestations true + a note).
function ack(overrides: Record<string, unknown> = {}) {
  return {
    plan_complete: true,
    adr_confirmed: true,
    issues_resolved: true,
    note: 'PH-5 hygiene: plan done, ADRs recorded, issues closed (unit test)',
    ...overrides,
  }
}

// promptFn seam that counts invocations — proves no OS dialog on an ack reject.
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

const PUSH_OK: GitExecResult = {
  ok: true,
  stdout: 'Everything up-to-date',
  stderr: '',
  exitCode: 0,
}

const BASE_CONFIG = {
  rsct_version: '1.0.0',
  app: { name: 'test-app', org: 'test-org' },
}

describe('rsct_request_push — happy path', () => {
  it('pushes a non-protected branch and writes audit', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExec({ 'push origin feat/foo': PUSH_OK }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal,
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
    expect(out.branch).toBe('feat/foo')
    expect(out.remote).toBe('origin')
    expect(out.channel).toBe('windows')
    expect(out.audit_path).toBeTruthy()
    expect(existsSync(join(tmpRoot, '.rsct', 'audit.log'))).toBe(true)
  })

  it('CAP-33: emits bootstrap warning audit when bootstrap_at is missing', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('feat/cap33-push'),
      gitExecutor: gitExec({ 'push origin feat/cap33-push': PUSH_OK }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal,
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
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
          l.event === 'request_push.bootstrap_warning' &&
          l.bootstrap_status === 'missing',
      ),
    ).toBe(true)
  })

  it('honors custom remote/branch input', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      {
        project_root: tmpRoot,
        dev_approval: approval(),
        remote: 'upstream',
        branch: 'release/2.0',
      },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({ 'push upstream release/2.0': PUSH_OK }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
    expect(out.remote).toBe('upstream')
    expect(out.branch).toBe('release/2.0')
  })
})

describe('rsct_request_push — branch protection', () => {
  it('rejects when pushing to a protected branch without override', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack() },
      {
        gitStateOverride: gitState('main'),
        gitExecutor: gitExec({}, PUSH_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(out.branch_check.protected).toBe(true)
    expect(out.branch_check.override_used).toBe(false)
  })

  it('pushes a protected branch with override_protected_branch and audits the override', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      {
        project_root: tmpRoot,
        dev_approval: approval({
          override_protected_branch: { reason: 'release tag push' },
        }),
        pre_merge_ack: ack(),
      },
      {
        gitStateOverride: gitState('main'),
        gitExecutor: gitExec({ 'push origin main': PUSH_OK }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(out.branch_check.override_used).toBe(true)
    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('request_push.override_invoked')
    expect(audit).toContain('release tag push')
  })
})

describe('rsct_request_push — failure surfaces', () => {
  it('returns rejected/dialog_no when dev declines the dialog', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({}, PUSH_OK),
        promptFn: dialog({ response: 'no', channel: 'windows' }),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dialog_no')
  })

  it('returns mutation_failed when git push fails and does NOT consume the approval', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const pushFail: GitExecResult = {
      ok: false,
      stdout: '',
      stderr: '! [rejected] feat/foo -> feat/foo (non-fast-forward)',
      exitCode: 1,
    }
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExec({ 'push origin feat/foo': pushFail }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal,
    )) as RequestPushOutput

    expect(out.status).toBe('mutation_failed')
    expect(out.reason).toContain('non-fast-forward')

    // Retry with the SAME approval (success this time) — must NOT be 'reused'.
    const out2 = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      { ...internal, gitExecutor: gitExec({ 'push origin feat/foo': PUSH_OK }) },
    )) as RequestPushOutput
    expect(out2.status).toBe('pushed')
  })
})

describe('rsct_request_push — schema', () => {
  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      requestPushHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
        bogus: true,
      }),
    ).rejects.toThrow()
  })

  it('returns rejected/schema when dev_approval is missing', async () => {
    // `z.unknown()` accepts undefined at the input-schema layer, so the handler
    // does not throw — instead it surfaces the missing-approval as a
    // rejection from validateDevApproval (reject_kind = 'schema').
    const out = (await requestPushHandler(
      { project_root: tmpRoot },
      {
        gitStateOverride: gitState('feat/foo'),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('schema')
  })

  it('exposes pre_merge_ack in inputSchema, all-optional (parity with the Zod schema)', () => {
    const schema = requestPushTool.inputSchema as {
      properties: Record<string, { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: unknown }>
      required?: string[]
    }
    const ackProp = schema.properties.pre_merge_ack
    expect(ackProp).toBeDefined()
    expect(ackProp.additionalProperties).toBe(false)
    for (const k of ['plan_complete', 'adr_confirmed', 'issues_resolved', 'note']) {
      expect(ackProp.properties?.[k]).toBeDefined()
    }
    expect(schema.required ?? []).not.toContain('pre_merge_ack')
    expect(ackProp.required).toBeUndefined()
  })
})

describe('rsct_request_push — post-mutation write failures (HIGH-2 / HIGH-3)', () => {
  it('surfaces anti_replay_error + warning hint when approvals-seen write fails after a successful push', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExec({}, PUSH_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      approvalRecorder: () => ({
        ok: false,
        path: join(tmpRoot, '.rsct', 'approvals-seen.json'),
        error: 'simulated atomic rename failed',
      }),
    }
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal,
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
    expect(out.anti_replay_persisted).toBe(false)
    expect(out.anti_replay_error).toBe('simulated atomic rename failed')
    expect(
      out.hints.some((h) => h.includes('could not record this approval as used')),
    ).toBe(true)
  })

  it('surfaces audit_error + warning hint when audit append fails after a successful push', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('feat/foo'),
      gitExecutor: gitExec({}, PUSH_OK),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
      auditWriter: () => ({
        ok: false,
        reason: 'write_failed',
        path: join(tmpRoot, '.rsct', 'audit.log'),
        error: 'simulated read-only fs',
      }),
    }
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal,
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
    expect(out.anti_replay_persisted).toBe(true)
    expect(out.audit_error).toBe('simulated read-only fs')
    expect(
      out.hints.some(
        (h) => h.includes('audit log write failed') && h.includes('simulated read-only fs'),
      ),
    ).toBe(true)
  })
})

describe('rsct_request_push — PH-5 pre_merge_ack hygiene gate (protected-branch scope)', () => {
  it('does NOT require an ack for a non-protected (feature/WIP) push — scope MCP-P1-D', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({ 'push origin feat/foo': PUSH_OK }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
  })

  it('rejects pre_merge_ack_missing on a protected push with no ack — and shows NO dialog', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const prompt = countingPrompt()
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({}, PUSH_OK), promptFn: prompt.fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_missing')
    expect(prompt.calls()).toBe(0)
    expect(out.branch_check.protected).toBe(true)
  })

  it('rejects pre_merge_ack_incomplete on a protected push with issues_resolved false', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack({ issues_resolved: false }) },
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({}, PUSH_OK), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('issues_resolved')
  })

  it('requires a non-empty note when adr_confirmed is true (protected push)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack({ note: '' }) },
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({}, PUSH_OK), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('note')
  })

  it('pushes a protected branch when ack is satisfied AND override is present', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      {
        project_root: tmpRoot,
        dev_approval: approval({ override_protected_branch: { reason: 'release tag push' } }),
        pre_merge_ack: ack(),
      },
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({ 'push origin main': PUSH_OK }), promptFn: alwaysYes(), now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
  })

  it('rejects an unknown key inside pre_merge_ack (nested .strict())', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    await expect(
      requestPushHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
        pre_merge_ack: { ...ack(), bogus: true },
      }),
    ).rejects.toThrow()
  })

  it('audits the ack reject with the self-attested label', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({}, PUSH_OK), promptFn: alwaysYes(), now: FIXED_NOW },
    )
    const audit = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    expect(audit).toContain('pre_merge_ack_missing')
    expect(audit).toContain('pre_merge_ack_self_attested')
  })

  it('an ack reject does NOT consume the dev_approval (protected push retry)', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const appr = approval({ override_protected_branch: { reason: 'release tag push' } })
    const internal: RequestPushInternal = {
      gitStateOverride: gitState('main'),
      gitExecutor: gitExec({ 'push origin main': PUSH_OK }),
      promptFn: alwaysYes(),
      now: FIXED_NOW,
    }
    const out1 = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: appr },
      internal,
    )) as RequestPushOutput
    expect(out1.status).toBe('rejected')
    expect(out1.reject_kind).toBe('pre_merge_ack_missing')
    const out2 = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: appr, pre_merge_ack: ack() },
      internal,
    )) as RequestPushOutput
    expect(out2.status).toBe('pushed')
  })
})

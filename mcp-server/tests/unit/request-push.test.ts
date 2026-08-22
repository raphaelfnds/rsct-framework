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
import { preMergeAckSchema } from '../../src/lib/pre-merge-ack.js'
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
    hygiene_swept: true,
    note: 'PH-5 hygiene: plan done, ADRs recorded, issues closed, files swept (unit test)',
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
    // #62 B5: model a repo that HAS remotes. Without this the allow-list is built
    // from the empty fallback below and even 'origin' is refused — the reject is
    // then an artifact of the fake, not of the input under test.
    if (key === 'remote') return { ok: true, stdout: 'origin\nupstream\n', stderr: '', exitCode: 0 }
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
      gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }),
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
      gitExecutor: gitExec({ 'push -- origin feat/cap33-push': PUSH_OK }),
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
        gitExecutor: gitExec({ 'push -- upstream release/2.0': PUSH_OK }),
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
        gitExecutor: gitExec({ 'push -- origin main': PUSH_OK }),
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
      gitExecutor: gitExec({ 'push -- origin feat/foo': pushFail }),
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
      { ...internal, gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }) },
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
    // DERIVED from the Zod shape — see the same assertion in request-merge.test.ts
    // for why a hardcoded key list here would permanently block every protected
    // push behind a green suite.
    // Breaks on: adding a field to preMergeAckSchema without mirroring it.
    const zodKeys = Object.keys(preMergeAckSchema.shape)
    expect(zodKeys.length).toBeGreaterThan(0)
    expect(Object.keys(ackProp.properties ?? {}).sort()).toEqual([...zodKeys].sort())
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
        gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }),
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
      { gitStateOverride: gitState('main'), gitExecutor: gitExec({ 'push -- origin main': PUSH_OK }), promptFn: alwaysYes(), now: FIXED_NOW },
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
      gitExecutor: gitExec({ 'push -- origin main': PUSH_OK }),
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

describe('rsct_request_push — install-drift advisory (#25)', () => {
  // tmpRoot has a .rsct.json and no .rsct/scripts, so both enforcement scripts
  // read as absent → severity 'security'. Push is outward-facing and hard to
  // reverse, which is why degraded enforcement matters MORE here than at commit
  // — and it is exactly where the warning used to be silent.
  const SECURITY = /SECURITY: RSCT enforcement is not running/

  it('prepends the advisory on a successful push and audits the detection', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput

    expect(out.status).toBe('pushed')
    // Prepended: it outranks the routine tail, it does not trail behind it.
    expect(out.hints[0]).toMatch(SECURITY)

    const entry = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === 'install.drift_detected')
    expect(entry).toBeDefined()
    expect(entry?.tool).toBe('rsct_request_push')
    expect(entry?.severity).toBe('security')
  })

  it('carries the advisory when the push is REJECTED before the dialog', async () => {
    // The pre-gate reject path: a protected branch missing its pre_merge_ack
    // rejects in chat WITHOUT popping the dialog. That return must still drain
    // the advisory, or the one path where enforcement matters most is the one
    // that stays quiet.
    writeConfig(tmpRoot, { ...BASE_CONFIG, protected_branches: ['main'] })
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('main'),
        gitExecutor: gitExec({}),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput

    expect(out.status).toBe('rejected')
    expect(out.hints[0]).toMatch(SECURITY)
  })

  it('puts one line in the OS dialog — the channel the agent cannot rewrite', async () => {
    writeConfig(tmpRoot, BASE_CONFIG)
    let seen = ''
    await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }),
        promptFn: async (opts: DialogOptions) => {
          seen = opts.message
          return { response: 'yes', channel: 'windows' }
        },
        now: FIXED_NOW,
      },
    )
    expect(seen).toContain('Approve push')
    expect(seen).toContain('RSCT enforcement is NOT running')
    // One line, not the whole hint — the dialog is a decision surface.
    expect(seen.split('\n')).toHaveLength(2)
  })

  it('says nothing when the project is not rsct-managed', async () => {
    // No .rsct.json at all: nothing was observed, so nothing is claimed.
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({ 'push -- origin feat/foo': PUSH_OK }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.hints.join(' ')).not.toMatch(SECURITY)
  })
})

// ============================================================================
// #62 B5 — the ref/remote injection class.
//
// Every shape below was measured against a real bare remote on git
// 2.45.1.windows.1: each lands on the remote's protected `main` while
// `isProtectedBranch` (an exact string compare over the raw agent input)
// returns false, so the whole protected block — ack AND override — is skipped.
// ============================================================================

/** A fake that THROWS on an argv it does not model, naming the argv it saw.
 *  The permissive `gitExec` above answers everything, which is how 21 of 22
 *  push argv sites went stale without one test noticing. Where the argv itself
 *  is the thing under test, silence is not an acceptable answer. */
function strictGitExec(spec: Record<string, GitExecResult>): GitExecutor {
  return (_root, args) => {
    const key = args.join(' ')
    if (key in spec) return spec[key]!
    throw new Error(`strictGitExec: unmodelled argv ${JSON.stringify(args)}`)
  }
}

describe('rsct_request_push — B5 destination resolution', () => {
  const attempt = (branch: string, over: Record<string, unknown> = {}) =>
    requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack(), branch, ...over },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: gitExec({}, PUSH_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    ) as Promise<RequestPushOutput>

  beforeEach(() => writeConfig(tmpRoot, BASE_CONFIG))

  // Breaks on: comparing the raw agent string against the protected list, i.e.
  // reverting to `isProtectedBranch(input.branch)`. Each of these was measured
  // rc=0 onto the remote's main with no ack and no override.
  it.each([
    ['+main', 'the force marker hides it from an exact compare'],
    ['HEAD:main', 'a src:dst refspec puts the destination after the colon'],
    ['HEAD:a:refs/heads/main', 'git splits on the LAST colon, not the first'],
    ['refs/heads/main', 'the fully-qualified form'],
    ['heads/main', 'the half-qualified form'],
  ])('treats %s as protected — %s', async (branch) => {
    const out = await attempt(branch)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(out.branch_check.protected).toBe(true)
  })

  // Breaks on: dropping the second leading-'-' check, the one applied to the
  // DERIVED destination. Also asserts the poisoned value never reaches git:
  // `rev-parse --symbolic-full-name --all` returns rc=0 and a list of every ref.
  it('refuses +main:--all and never hands --all to git', async () => {
    const seen: string[][] = []
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack(), branch: '+main:--all' },
      {
        gitStateOverride: gitState('feat/foo'),
        // Must answer `remote` honestly: the remote allow-list runs first, so a
        // fake that garbles it would reject as unknown_remote and this test would
        // pass for the wrong reason.
        gitExecutor: (_r, args) => {
          seen.push(args)
          return args[0] === 'remote'
            ? { ok: true, stdout: 'origin\n', stderr: '', exitCode: 0 }
            : PUSH_OK
        },
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('unsafe_push_target')
    expect(seen.some((a) => a.includes('--all'))).toBe(false)
  })

  // Breaks on: removing the glob reject. Measured rc=0 force-updating protected
  // main while the plain push of the same state was refused.
  it('refuses a glob refspec', async () => {
    const out = await attempt('+refs/heads/main*:refs/heads/main*')
    expect(out.reject_kind).toBe('unsafe_push_target')
  })

  // Breaks on: removing the empty-destination reject.
  it('refuses the bare-colon matching refspec', async () => {
    expect((await attempt(':')).reject_kind).toBe('unsafe_push_target')
  })

  // VACUITY CONTROL. A reject-everything validator passes every test above.
  // This is what it cannot pass.
  it('VACUITY: an ordinary branch still pushes', async () => {
    const out = await attempt('release/2.0')
    expect(out.status).toBe('pushed')
  })

  // VACUITY CONTROL. Protection must still be overridable, or the new resolution
  // has quietly turned every protected push into a hard stop.
  it('VACUITY: a protected destination still pushes WITH the override', async () => {
    const out = await attempt('main', {
      dev_approval: approval({ override_protected_branch: { reason: 'shipping the release' } }),
    })
    expect(out.status).toBe('pushed')
    expect(out.branch_check.override_used).toBe(true)
  })
})

describe('rsct_request_push — B5 remote allow-list', () => {
  beforeEach(() => writeConfig(tmpRoot, BASE_CONFIG))
  const withRemote = (remote: string, exec?: GitExecutor) =>
    requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack(), remote, branch: 'feat/foo' },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: exec ?? gitExec({}, PUSH_OK),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    ) as Promise<RequestPushOutput>

  // Breaks on: omitting the allow-list, or implementing it as "reject
  // option-shaped remotes" instead of "must be a configured remote". Measured:
  // `git push <arbitrary-bare-path> main` lands the repo in a foreign
  // repository, and `--` does NOT protect that slot.
  it('refuses a path or URL remote — this is the exfiltration vector', async () => {
    const out = await withRemote('/tmp/anywhere.git')
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('unknown_remote')
    expect(out.reason).toContain('NAMED remotes')
  })

  // Breaks on: relying on `--` alone for the remote slot. Measured:
  // `git push --mirror -- origin` is rc=0 and DELETES remote branches.
  it('refuses an option-shaped remote before git is ever run', async () => {
    const seen: string[][] = []
    const out = await withRemote('--mirror', (_r, args) => { seen.push(args); return PUSH_OK })
    expect(out.reject_kind).toBe('unknown_remote')
    expect(seen.some((a) => a[0] === 'push')).toBe(false)
  })

  // Breaks on: SKIPPING the check when the list comes back empty. That was the
  // tempting reading of "degrade gracefully", and it is wrong: a repo with no
  // configured remotes is exactly the shape a path remote exploits. Only an
  // UNREADABLE list (ok:false) may skip.
  it('an EMPTY remote list rejects; an UNREADABLE one skips the check', async () => {
    const empty = await withRemote('origin', (_r, args) =>
      args[0] === 'remote' ? { ok: true, stdout: '', stderr: '', exitCode: 0 } : PUSH_OK)
    expect(empty.reject_kind).toBe('unknown_remote')

    const unreadable = await withRemote('origin', (_r, args) =>
      args[0] === 'remote'
        ? { ok: false, stdout: '', stderr: 'not a git repository', exitCode: 128 }
        : PUSH_OK)
    expect(unreadable.status).toBe('pushed')
  })

  // VACUITY CONTROL: a configured non-default remote still works.
  it('VACUITY: a configured remote still pushes', async () => {
    expect((await withRemote('upstream')).status).toBe('pushed')
  })
})

describe('rsct_request_push — B5 argv shape', () => {
  beforeEach(() => writeConfig(tmpRoot, BASE_CONFIG))

  // Breaks on: moving `--` after the remote, i.e. ['push', remote, '--', branch].
  // That was the first authorized form and it does NOT close the hole: measured,
  // `git push --exec=<program> -- main` RUNS THE PROGRAM, because the remote is
  // an agent slot too and still sits in an option position.
  // The strict fake is what makes this assertion real — under the permissive one
  // a wrong argv is answered ok and the test passes.
  it('runs git push with -- BEFORE the remote', async () => {
    const out = (await requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack(), branch: 'feat/foo' },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: strictGitExec({
          remote: { ok: true, stdout: 'origin\n', stderr: '', exitCode: 0 },
          'rev-parse --symbolic-full-name -- feat/foo': { ok: true, stdout: 'refs/heads/feat/foo\n', stderr: '', exitCode: 0 },
          'push -- origin feat/foo': PUSH_OK,
        }),
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
  })
})

describe('rsct_request_push — B5 ref-store resolution arm', () => {
  beforeEach(() => writeConfig(tmpRoot, BASE_CONFIG))
  /** rev-parse answers `resolved`; everything else succeeds. */
  const withResolver = (branch: string, resolved: string) =>
    requestPushHandler(
      { project_root: tmpRoot, dev_approval: approval(), pre_merge_ack: ack(), branch },
      {
        gitStateOverride: gitState('feat/foo'),
        gitExecutor: (_r, args) => {
          if (args[0] === 'remote') return { ok: true, stdout: 'origin\n', stderr: '', exitCode: 0 }
          if (args[0] === 'rev-parse') return { ok: true, stdout: resolved, stderr: '', exitCode: 0 }
          return PUSH_OK
        },
        promptFn: alwaysYes(),
        now: FIXED_NOW,
      },
    ) as Promise<RequestPushOutput>

  // Breaks on: removing the ref-store resolution arm.
  // This is the ONLY shape resolution catches on its own: the string candidates
  // for 'HEAD' are just ['HEAD'], which is in no protected list. `git push origin
  // HEAD` while standing on main is an ordinary thing to type, and without this
  // arm it reaches the remote's main with no ack and no override.
  // The mutation harness caught that every other destination test passed through
  // the STRING candidates, leaving this arm entirely unexercised.
  it('catches a destination only the ref store can resolve', async () => {
    const out = await withResolver('HEAD', 'refs/heads/main\n')
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
  })

  // Breaks on: guarding the resolution on `rp.ok` instead of on the output
  // starting with 'refs/'. rc=0 does NOT mean "canonicalised" — measured,
  // `rev-parse --symbolic-full-name` returns rc=0 with EMPTY stdout for
  // 'main@{0}', rc=0 echoing 'HEAD' on a detached HEAD, rc=0 echoing '--mirror'
  // unchanged, and on FAILURE it still echoes its argument. Feeding any of that
  // into the candidate set is how a NON-protected branch becomes protected — a
  // hard stop on legitimate work, with no override path.
  it('ignores an rc=0 answer that is not a ref', async () => {
    const out = await withResolver('feat/foo', 'main\n')
    expect(out.status).toBe('pushed')
  })

  // VACUITY CONTROL for this arm: resolution that DOES return a ref, for an
  // ordinary branch, must still push.
  it('VACUITY: a resolved non-protected ref still pushes', async () => {
    const out = await withResolver('feat/foo', 'refs/heads/feat/foo\n')
    expect(out.status).toBe('pushed')
  })
})

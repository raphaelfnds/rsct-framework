import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { planAuthorizeHandler, type PlanAuthorizeInternal } from '../../src/tools/plan-authorize.js'
import { requestCommitHandler } from '../../src/tools/request-commit.js'
import { phaseStatusHandler } from '../../src/tools/phase-status.js'
import { readPlanPhases } from '../../src/lib/plan.js'
import { defaultGitExecutor, type GitState } from '../../src/lib/git.js'
import { repositoryDialogLine } from '../../src/lib/repo-anchor.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import type { PhaseState, PlanAuthorizationBlock } from '../../src/lib/phase-scope.js'
import { planRevokeHandler } from '../../src/tools/plan-revoke.js'
import { resolveProjectRoot } from '../../src/lib/project-root.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'
import { recordMint } from '../plan-token-fixture.js'

const NOW = new Date('2026-06-22T12:00:00.000Z')
const HOUR = 60 * 60_000
let tmpRoot: string
let counter = 0

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-lock-'))
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }), 'utf8')
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function approval(scope = 'plan_authorize:t3'): Record<string, unknown> {
  counter += 1
  return { timestamp: new Date(NOW.getTime() - (5 + counter) * 1000).toISOString(), action_scope: scope, reason: `developer authorizes the batch for the plan, step ${counter}` }
}

function gitState(branch: string | null): GitState {
  return { available: branch !== null, branch, head_sha: branch ? 'aaaa111' : null, is_clean: false }
}

function phasesTable(rows: string[]): string {
  return ['## Phases & parallelization', '', '| Phase | Goal | File group (scope_globs) | Group | Depends on |', '|---|---|---|---|---|', ...rows, ''].join('\n')
}

const TWO = phasesTable(['| 1 | model | src/model/** | A | — |', '| 2 | api | src/api/** | B | 1 |'])

function writePlan(slug: string, body: string): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Status | in progress |\n\n${body}`, 'utf8')
}

function readState(): PhaseState | null {
  const p = join(tmpRoot, '.rsct/phase-state.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as PhaseState) : null
}

function auditEvents(): Array<Record<string, unknown>> {
  const p = join(tmpRoot, '.rsct/audit.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
}

function recorder(answer: DialogResult['response'] = 'yes') {
  const prompts: DialogOptions[] = []
  return {
    prompts,
    fn: async (o: DialogOptions): Promise<DialogResult> => {
      prompts.push(o)
      return answer === 'no-channel' ? { response: 'no-channel', channel: 'none', error: 'no display' } : { response: answer, channel: 'windows' }
    },
  }
}

async function authorize(input: Record<string, unknown> = {}, over: Partial<PlanAuthorizeInternal> = {}, answer: DialogResult['response'] = 'yes') {
  const r = recorder(answer)
  const out = await planAuthorizeHandler(
    { project_root: tmpRoot, dev_approval: approval(), ...input },
    { gitStateOverride: gitState('feat/t3'), promptFn: r.fn, now: NOW, ...over },
  )
  return { out, prompts: r.prompts }
}

describe('readPlanPhases — the "## Phases" table of the plan template', () => {
  it('reads the filled rows by the Phase and Goal headers', () => {
    expect(readPlanPhases(`# P\n\n${TWO}`)).toEqual([{ id: '1', goal: 'model' }, { id: '2', goal: 'api' }])
  })

  it('reads CRLF files and keeps an escaped pipe inside a cell', () => {
    const crlf = phasesTable(['| 1 | a ESC b | x | A | — |'.replace('ESC', `${String.fromCharCode(92)}|`), '| 2 | c | y | B | — |']).split('\n').join(String.fromCharCode(13, 10))
    expect(readPlanPhases(crlf)).toEqual([{ id: '1', goal: 'a | b' }, { id: '2', goal: 'c' }])
  })

  it('skips placeholder rows', () => {
    const rows = ['| 1 | <TODO> | x | A | — |', '| 2 | <TODO: name it> | x | A | — |', '| 3 | TBD | x | A | — |', '| <TODO> | model | x | A | — |', '| 4 | — | x | A | — |', '| 6 | todo | x | A | — |', '| 7 | N/A | x | A | — |', '| 8 | - | x | A | — |', '| 9 | – | x | A | — |', '| 10 |  | x | A | — |', '| 5 | real | x | A | — |']
    expect(readPlanPhases(phasesTable(rows))).toEqual([{ id: '5', goal: 'real' }])
  })

  it('ignores a table inside a code fence, another heading, and a table without the headers', () => {
    const fenced = ['```', TWO, '```'].join('\n')
    expect(readPlanPhases(fenced)).toEqual([])
    expect(readPlanPhases(TWO.replace('## Phases & parallelization', '## Steps'))).toEqual([])
    expect(readPlanPhases(TWO.replace('| Phase | Goal |', '| Step | What |'))).toEqual([])
    const afterNext = ['## Phases', '', 'none yet', '', '## Other', '', ...TWO.split('\n').slice(2)].join('\n')
    expect(readPlanPhases(afterNext)).toEqual([])
    const headingInFence = ['```', '## Phases', '```', '', ...TWO.split('\n').slice(2)].join('\n')
    expect(readPlanPhases(headingInFence)).toEqual([])
  })

  it('reads a file whose lines end with a lone CR', () => {
    expect(readPlanPhases(TWO.split('\n').join(String.fromCharCode(13)))).toEqual([{ id: '1', goal: 'model' }, { id: '2', goal: 'api' }])
  })
})

describe('rsct_plan_authorize — a forced dialog, for a multi-phase plan only', () => {
  it('mints for a plan with two phases, and the dialog says what it grants, framework text first', async () => {
    writePlan('t3', TWO)
    const { out, prompts } = await authorize({ max_actions: 5 })
    expect(out.status).toBe('authorized')
    expect(prompts).toHaveLength(1)
    const m = prompts[0]!.message
    expect(m.startsWith(`Authorize up to 5 commits with NO dialog, until ${new Date(NOW.getTime() + 8 * HOUR).toISOString()} UTC (8 h at most, never extended), on branch 'feat/t3'?`)).toBe(true)
    expect(m).toContain('Commit only: merge, rebase and push keep their own dialog.')
    expect(m).toContain(repositoryDialogLine(tmpRoot))
    expect(m.indexOf(repositoryDialogLine(tmpRoot))).toBeLessThan(m.indexOf("Plan: 't3'"))
    expect(m.endsWith("Plan: 't3' — 2 phases:\n• 1: model\n• 2: api")).toBe(true)
    expect(new Date(readState()!.plan_authorization!.expires_at).getTime()).toBe(NOW.getTime() + 8 * HOUR)
  })

  it('uses plan_token_ttl_minutes from the config, in the token and in the dialog', async () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, approval_modes: { plan_token_ttl_minutes: 90 } }), 'utf8')
    writePlan('t3', TWO)
    const { out, prompts } = await authorize()
    expect(out.status).toBe('authorized')
    const until = new Date(NOW.getTime() + 90 * 60_000).toISOString()
    expect(readState()!.plan_authorization!.expires_at).toBe(until)
    expect(prompts[0]!.message).toContain(`until ${until} UTC`)
  })

  it('caps what the dialog shows: eight phases at most, each on one line, capped, with no invisible characters', async () => {
    const hidden = String.fromCharCode(0x202e)
    const longGoal = `${'g'.repeat(150)}${String.fromCharCode(0x2028)}fake line${hidden}${'h'.repeat(150)}`
    const marks = String.fromCharCode(0x202e, 0x061c, 0x2060, 0x2064, 0x200b)
    const rows = [`| 1 | ${longGoal} | x | A | — |`, `| 2 | go${marks}al 2 | x | A | — |`, ...[3, 4, 5, 6, 7, 8, 9].map((n) => `| ${n} | goal ${n} | x | A | — |`)]
    writePlan('t3', phasesTable(rows))
    const { prompts } = await authorize()
    const m = prompts[0]!.message
    const firstPhase = m.split('\n').find((l) => l.startsWith('• 1: '))!
    expect(firstPhase.length).toBe('• 1: '.length + 100)
    expect(firstPhase).not.toContain(hidden)
    expect(m).not.toContain(`${String.fromCharCode(0x2028)}fake`)
    expect(m).toContain('• 2: goal 2')
    expect(m).toContain('• 8: goal 8')
    expect(m).not.toContain('• 9: goal 9')
    expect(m.endsWith('… and 1 more')).toBe(true)
  })

  it('takes the newest plan_*.md when no plan_slug is given', async () => {
    writePlan('old', TWO)
    writePlan('new', TWO)
    utimesSync(join(tmpRoot, 'plan_old.md'), new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR))
    utimesSync(join(tmpRoot, 'plan_new.md'), NOW, NOW)
    expect((await authorize()).out.plan_slug).toBe('new')
    utimesSync(join(tmpRoot, 'plan_old.md'), new Date(NOW.getTime() + HOUR), new Date(NOW.getTime() + HOUR))
    rmSync(join(tmpRoot, '.rsct/phase-state.json'))
    expect((await authorize()).out.plan_slug).toBe('old')
  })

  it('refuses an unreadable state before any dialog', async () => {
    writePlan('t3', TWO)
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), '{ "phase": ', 'utf8')
    const { out, prompts } = await authorize()
    expect(out.status).toBe('state_write_failed')
    expect(prompts).toHaveLength(0)
  })

  it('refuses a single-phase plan, and a plan with no Phases table, before any dialog', async () => {
    writePlan('t3', phasesTable(['| 1 | only | x | A | — |']))
    const one = await authorize()
    expect(one.out.reject_kind).toBe('not_multi_phase')
    expect(one.prompts).toHaveLength(0)
    writePlan('t3', 'no table here')
    const none = await authorize()
    expect(none.out.reject_kind).toBe('not_multi_phase')
    expect(none.prompts).toHaveLength(0)
    expect(readState()).toBeNull()
  })

  it('is forced: with no dialog channel no token is minted, whatever trust_allowed_for says', async () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, approval_modes: { trust_allowed_for: ['rsct_plan_authorize', 'rsct_request_commit', 'rsct_request_push', 'rsct_request_merge'] } }), 'utf8')
    expect(resolveProjectRoot(tmpRoot).rsct_installed).toBe(true)
    writePlan('t3', TWO)
    const { out } = await authorize({}, {}, 'no-channel')
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(readState()?.plan_authorization).toBeUndefined()
  })

  it('refuses the branch checks before any dialog', async () => {
    writePlan('t3', TWO)
    const detached = await authorize({}, { gitStateOverride: gitState(null) })
    expect(detached.out.reject_kind).toBe('no_branch')
    expect(detached.prompts).toHaveLength(0)
    const protectedOne = await authorize({}, { gitStateOverride: gitState('main') })
    expect(protectedOne.out.reject_kind).toBe('protected_branch')
    expect(protectedOne.prompts).toHaveLength(0)
  })

  it('takes plan_slug by name, refuses an unsafe one, and never takes a spec_ file for the plan', async () => {
    writePlan('a', TWO)
    writePlan('b', TWO)
    const named = await authorize({ plan_slug: 'a' })
    expect(named.out.plan_slug).toBe('a')
    const otherCase = await authorize({ plan_slug: 'A' })
    expect(otherCase.out.reject_kind).toBe('no_active_plan')
    for (const bad of ['../x', 'a/b', '..', '.hidden', 'a..b', `a${String.fromCharCode(10)}b`]) {
      const r = await authorize({ plan_slug: bad })
      expect(r.out.reject_kind).toBe('invalid_plan_slug')
      expect(r.prompts).toHaveLength(0)
    }
    rmSync(join(tmpRoot, 'plan_a.md'))
    rmSync(join(tmpRoot, 'plan_b.md'))
    writeFileSync(join(tmpRoot, 'spec_c.md'), `# Spec\n\n${TWO}`, 'utf8')
    const specOnly = await authorize()
    expect(specOnly.out.reject_kind).toBe('no_active_plan')
    const missing = await authorize({ plan_slug: 'c' })
    expect(missing.out.reject_kind).toBe('no_active_plan')
  })

  it('records the mint in the audit log before the state, and mints nothing when that line cannot be written', async () => {
    writePlan('t3', TWO)
    const ok = await authorize()
    expect(ok.out.status).toBe('authorized')
    const line = auditEvents().find((e) => e.event === 'plan_authorize.authorized')!
    const t = readState()!.plan_authorization!
    expect(line).toMatchObject({ plan_slug: 't3', branch: 'feat/t3', authorized_at: t.authorized_at, approval_action_scope: t.approval_ref.action_scope, approval_timestamp: t.approval_ref.timestamp, phases: 2 })
    rmSync(join(tmpRoot, '.rsct/phase-state.json'))
    const failing = await authorize({}, {
      auditWriter: (root, entry, cfg) => (entry.event === 'plan_authorize.authorized' ? { ok: false, path: 'x', error: 'disk full' } : { ok: true, path: join(root, '.rsct/audit.log') }) as never,
    })
    expect(failing.out.status).toBe('state_write_failed')
    expect(readState()?.plan_authorization).toBeUndefined()
  })
})

describe('rsct_request_commit — the token path', () => {
  function repo(): void {
    initSweepRepo(tmpRoot)
    commitAll(tmpRoot)
    git(tmpRoot, 'checkout', '-q', '-b', 'feat/x')
    writeFileSync(join(tmpRoot, 'NOTES.md'), 'docs\n', 'utf8')
    git(tmpRoot, 'add', 'NOTES.md')
  }

  function token(over: Partial<PlanAuthorizationBlock> = {}): PlanAuthorizationBlock {
    return {
      plan_slug: 'p',
      branch: 'feat/x',
      covers: ['commit'],
      authorized_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      max_actions: 5,
      actions_used: 0,
      approval_ref: { action_scope: 'plan_authorize:p', timestamp: new Date(Date.now() - 60_000).toISOString() },
      ...over,
    }
  }

  function seed(t: PlanAuthorizationBlock, recorded = true): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({ plan_authorization: t }), 'utf8')
    if (recorded) recordMint(tmpRoot, t)
  }

  it('commits under a recorded token', async () => {
    repo()
    writePlan('p', TWO)
    seed(token())
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.status).toBe('committed')
    expect(out.authorized_via).toBe('plan_token')
  })

  it('refuses a token the audit log does not show as minted', async () => {
    repo()
    writePlan('p', TWO)
    seed(token(), false)
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.reason).toContain('no plan_authorize.authorized line')
  })

  it.each([
    ['plan_slug', 'other'],
    ['branch', 'feat/y'],
    ['authorized_at', new Date(Date.now() - 120_000).toISOString()],
    ['expires_at', new Date(Date.now() + 2 * HOUR).toISOString()],
    ['max_actions', 50],
    ['approval_action_scope', 'plan_authorize:other'],
    ['approval_timestamp', new Date(Date.now() - 30_000).toISOString()],
  ])('refuses a token whose recorded grant differs in %s', async (field, value) => {
    repo()
    writePlan('p', TWO)
    const t = token()
    seed(t, false)
    recordMint(tmpRoot, t, { [field]: value })
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.reason).toContain('no plan_authorize.authorized line')
  })

  it('refuses a token the developer revoked, even when it is written back', async () => {
    repo()
    writePlan('p', TWO)
    const t = token()
    seed(t)
    const revoked = await planRevokeHandler({ project_root: tmpRoot, reason: 'stop the batch' })
    expect(revoked.status).toBe('revoked')
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({ plan_authorization: t }), 'utf8')
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('records the revoke before it clears the token, so a revoke whose state write fails still ends it', async () => {
    repo()
    writePlan('p', TWO)
    seed(token())
    writeFileSync(join(tmpRoot, '.rsct/phase-state.lock'), JSON.stringify({ session_id: 'other', locked_at: new Date().toISOString() }), 'utf8')
    const revoked = await planRevokeHandler({ project_root: tmpRoot, reason: 'stop the batch' })
    expect(revoked.status).toBe('state_write_failed')
    expect(revoked.hints[0]).toContain('the revoke is recorded in the audit log, so the token no longer counts')
    rmSync(join(tmpRoot, '.rsct/phase-state.lock'))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
  })

  it('still clears the token when the audit log cannot record the revoke, and says what that leaves open', async () => {
    repo()
    writePlan('p', TWO)
    seed(token())
    const revoked = await planRevokeHandler(
      { project_root: tmpRoot },
      { auditWriter: (root, entry) => (entry.event === 'plan_revoke.revoked' ? { ok: false, path: 'x', error: 'disk full' } : { ok: true, path: join(root, '.rsct/audit.log') }) as never },
    )
    expect(revoked.status).toBe('revoked')
    expect(revoked.audit_error).toContain('disk full')
    expect(revoked.hints.join('\n')).toContain('a copy written back into it would count again')
    const state = JSON.parse(readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8')) as Record<string, unknown>
    expect(state['plan_authorization']).toBeUndefined()
  })

  it('reports the 8-hour expiry in the commit output for an older token', async () => {
    repo()
    writePlan('p', TWO)
    const authorized = new Date(Date.now() - HOUR)
    seed(token({ authorized_at: authorized.toISOString(), expires_at: new Date(authorized.getTime() + 24 * HOUR).toISOString() }))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.status).toBe('committed')
    expect(out.plan_token?.expires_at).toBe(new Date(authorized.getTime() + 8 * HOUR).toISOString())
  })

  it('does not refund over a token re-minted while a failing commit ran', async () => {
    repo()
    writePlan('p', TWO)
    seed(token({ actions_used: 1 }))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {
      gitExecutor: (root, args) => {
        if (args[0] === 'commit') {
          writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({ plan_authorization: token({ actions_used: 2, authorized_at: new Date().toISOString() }) }), 'utf8')
          return { ok: false, stdout: '', stderr: 'boom', exitCode: 1 }
        }
        return defaultGitExecutor(root, args)
      },
    })
    expect(out.status).toBe('mutation_failed')
    expect(readState()?.plan_authorization?.actions_used).toBe(2)
  })

  it('looks the plan up as plan_<slug>.md only', async () => {
    repo()
    writeFileSync(join(tmpRoot, 'spec_p.md'), `# Spec\n\n${TWO}`, 'utf8')
    seed(token())
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.reason).toContain('plan_<slug>.md file no longer exists')
  })

  it('ends 8 hours after the approval even when an older token stored a later expiry', async () => {
    repo()
    writePlan('p', TWO)
    seed(token({ authorized_at: new Date(Date.now() - 8 * HOUR - 1000).toISOString(), expires_at: new Date(Date.now() + 10 * HOUR).toISOString() }))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.reason).toContain('expired')
  })

  it('does not bring back a token revoked while a failing commit ran', async () => {
    repo()
    writePlan('p', TWO)
    seed(token())
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {
      gitExecutor: (root, args) => {
        if (args[0] === 'commit') {
          const s = readState() ?? {}
          delete s.plan_authorization
          writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(s), 'utf8')
          return { ok: false, stdout: '', stderr: 'boom', exitCode: 1 }
        }
        return defaultGitExecutor(root, args)
      },
    })
    expect(out.status).toBe('mutation_failed')
    expect(readState()?.plan_authorization).toBeUndefined()
    expect(out.hints.join('\n')).toContain('nothing was refunded')
  })

  it('still refunds the reserved action when nothing else touched the token', async () => {
    repo()
    writePlan('p', TWO)
    seed(token({ actions_used: 2 }))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {
      gitExecutor: (root, args) => (args[0] === 'commit' ? { ok: false, stdout: '', stderr: 'boom', exitCode: 1 } : defaultGitExecutor(root, args)),
    })
    expect(out.status).toBe('mutation_failed')
    expect(readState()?.plan_authorization?.actions_used).toBe(2)
  })

  it('does not refund the reserved action when a commit landed during the failing attempt', async () => {
    repo()
    writePlan('p', TWO)
    seed(token({ actions_used: 2 }))
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {
      gitExecutor: (root, args) => {
        if (args[0] === 'commit') {
          defaultGitExecutor(root, ['commit', '-q', '--no-verify', '-m', 'landed anyway'])
          return { ok: false, stdout: '', stderr: 'boom', exitCode: 1 }
        }
        return defaultGitExecutor(root, args)
      },
    })
    expect(out.status).toBe('mutation_failed')
    expect(git(tmpRoot, 'log', '-1', '--format=%s').trim()).toBe('landed anyway')
    expect(readState()?.plan_authorization?.actions_used).toBe(3)
    expect(out.hints.join('\n')).toContain('The reserved token action was NOT refunded.')
  })

  it('a landed commit does not extend the token, even one an older server gave a sliding window', async () => {
    repo()
    writePlan('p', TWO)
    const t = { ...token(), slide_minutes: 480 } as PlanAuthorizationBlock
    seed(t)
    const out = await requestCommitHandler({ project_root: tmpRoot, message: 'docs: notes' }, {})
    expect(out.status).toBe('committed')
    expect(readState()?.plan_authorization?.expires_at).toBe(t.expires_at)
  })
})

describe('rsct_phase_status — the expiry it shows is the one that holds', () => {
  it('shows 8 hours after the approval for an older token that stored a later expiry', async () => {
    const authorized = new Date(Date.now() - HOUR)
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({
      plan_authorization: {
        plan_slug: 'p', branch: 'feat/x', covers: ['commit'], authorized_at: authorized.toISOString(),
        expires_at: new Date(authorized.getTime() + 24 * HOUR).toISOString(), max_actions: 5, actions_used: 0,
        approval_ref: { action_scope: 'plan_authorize:p', timestamp: authorized.toISOString() },
      },
    }), 'utf8')
    const out = await phaseStatusHandler({ project_root: tmpRoot })
    expect(out.plan_authorization?.expires_at).toBe(new Date(authorized.getTime() + 8 * HOUR).toISOString())
    expect(out.hints.join('\n')).toContain('NOT usable (no matching plan_authorize.authorized line')
  })

  it('calls a token ACTIVE only when it is in time and recorded, and expired otherwise', async () => {
    const authorized = new Date(Date.now() - HOUR)
    const t: PlanAuthorizationBlock = {
      plan_slug: 'p', branch: 'feat/x', covers: ['commit'], authorized_at: authorized.toISOString(),
      expires_at: new Date(authorized.getTime() + 2 * HOUR).toISOString(), max_actions: 5, actions_used: 0,
      approval_ref: { action_scope: 'plan_authorize:p', timestamp: authorized.toISOString() },
    }
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({ plan_authorization: t }), 'utf8')
    recordMint(tmpRoot, t)
    expect((await phaseStatusHandler({ project_root: tmpRoot })).hints.join('\n')).toContain('Plan-scoped batch token ACTIVE')
    const old = { ...t, authorized_at: new Date(Date.now() - 9 * HOUR).toISOString(), expires_at: new Date(Date.now() + HOUR).toISOString() }
    writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify({ plan_authorization: old }), 'utf8')
    recordMint(tmpRoot, old)
    expect((await phaseStatusHandler({ project_root: tmpRoot })).hints.join('\n')).toContain('NOT usable (expired)')
  })
})

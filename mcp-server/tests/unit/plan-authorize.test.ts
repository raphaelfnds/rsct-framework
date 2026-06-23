import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planAuthorizeHandler,
  type PlanAuthorizeOutput,
  type PlanAuthorizeInternal,
} from '../../src/tools/plan-authorize.js'
import type { GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import type { PhaseState } from '../../src/lib/phase-scope.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pa-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
    'utf8',
  )
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-22T12:00:00.000Z')
const VALID_TS = '2026-06-22T11:59:45.000Z'

function approval(over: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'plan_authorize:t3',
    reason: 'authorize a batch of commits for the t3 plan run',
    ...over,
  }
}
function gitState(branch: string | null): GitState {
  return { available: branch !== null, branch, head_sha: branch ? 'aaaa111' : null, is_clean: false }
}
function alwaysYes(): (o: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}
function writePlan(slug = 't3', status = 'in progress'): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Status | ${status} |\n`)
}
function readState(): PhaseState | null {
  const p = join(tmpRoot, '.rsct/phase-state.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as PhaseState
}
function internal(over: Partial<PlanAuthorizeInternal> = {}): PlanAuthorizeInternal {
  return { gitStateOverride: gitState('feat/t3'), promptFn: alwaysYes(), now: FIXED_NOW, ...over }
}

describe('rsct_plan_authorize', () => {
  it('mints a token on a non-protected branch with an active plan, persisting it', async () => {
    writePlan()
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval(), ttl_minutes: 120, max_actions: 5 },
      internal(),
    )) as PlanAuthorizeOutput

    expect(out.status).toBe('authorized')
    expect(out.plan_slug).toBe('t3')
    expect(out.branch).toBe('feat/t3')
    expect(out.max_actions).toBe(5)
    expect(out.covers).toEqual(['commit'])
    expect(out.anti_replay_persisted).toBe(true)

    const token = readState()?.plan_authorization
    expect(token?.plan_slug).toBe('t3')
    expect(token?.branch).toBe('feat/t3')
    expect(token?.actions_used).toBe(0)
    expect(new Date(token!.expires_at).getTime()).toBe(FIXED_NOW.getTime() + 120 * 60_000)
  })

  it('consumes the emitting approval: re-minting with the SAME payload is reused-rejected (FV4)', async () => {
    writePlan()
    const first = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal(),
    )) as PlanAuthorizeOutput
    expect(first.status).toBe('authorized')

    const second = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal(),
    )) as PlanAuthorizeOutput
    expect(second.status).toBe('rejected')
    expect(second.reject_kind).toBe('reused')
  })

  it('rejects when the §C dialog is declined; no token written, approval not consumed', async () => {
    writePlan()
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal({ promptFn: async () => ({ response: 'no', channel: 'windows' }) }),
    )) as PlanAuthorizeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dialog_no')
    expect(readState()?.plan_authorization).toBeUndefined()
  })

  it('rejects on a protected branch (batch only on derived branches)', async () => {
    writePlan()
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal({ gitStateOverride: gitState('main') }),
    )) as PlanAuthorizeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('protected_branch')
    expect(readState()?.plan_authorization).toBeUndefined()
  })

  it('rejects when there is no active plan', async () => {
    // no plan_/spec_ file written
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal(),
    )) as PlanAuthorizeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('no_active_plan')
    expect(readState()?.plan_authorization).toBeUndefined()
  })

  it('rejects when no branch resolves (detached HEAD / not a worktree)', async () => {
    writePlan()
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal({ gitStateOverride: gitState(null) }),
    )) as PlanAuthorizeOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('no_branch')
  })

  it('rejects out-of-range ttl/max_actions at the input boundary (FV5)', async () => {
    writePlan()
    await expect(
      planAuthorizeHandler(
        { project_root: tmpRoot, dev_approval: approval(), ttl_minutes: 1 },
        internal(),
      ),
    ).rejects.toThrow()
    await expect(
      planAuthorizeHandler(
        { project_root: tmpRoot, dev_approval: approval(), max_actions: 9999 },
        internal(),
      ),
    ).rejects.toThrow()
  })

  it('preserves sibling phase-state fields when minting', async () => {
    writePlan()
    // seed an existing phase block
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct/phase-state.json'),
      JSON.stringify({ phase: 'code', spec_slug: 't3', bootstrap_at: FIXED_NOW.toISOString() }),
      'utf8',
    )
    const out = (await planAuthorizeHandler(
      { project_root: tmpRoot, dev_approval: approval() },
      internal(),
    )) as PlanAuthorizeOutput
    expect(out.status).toBe('authorized')
    const st = readState()
    expect(st?.phase).toBe('code')
    expect(st?.spec_slug).toBe('t3')
    expect(st?.bootstrap_at).toBe(FIXED_NOW.toISOString())
    expect(st?.plan_authorization?.plan_slug).toBe('t3')
  })
})

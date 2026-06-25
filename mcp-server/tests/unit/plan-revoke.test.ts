import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planRevokeHandler,
  type PlanRevokeOutput,
} from '../../src/tools/plan-revoke.js'
import type { PhaseState, PlanAuthorizationBlock } from '../../src/lib/phase-scope.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pr-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
    'utf8',
  )
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function token(): PlanAuthorizationBlock {
  return {
    plan_slug: 't3',
    branch: 'feat/t3',
    covers: ['commit'],
    authorized_at: '2026-06-22T12:00:00.000Z',
    expires_at: '2026-06-22T14:00:00.000Z',
    max_actions: 5,
    actions_used: 2,
    approval_ref: { action_scope: 'plan_authorize:t3', timestamp: '2026-06-22T11:59:00.000Z' },
  }
}
function seedState(state: PhaseState): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct/phase-state.json'), JSON.stringify(state), 'utf8')
}
function readState(): PhaseState | null {
  const p = join(tmpRoot, '.rsct/phase-state.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as PhaseState
}

describe('rsct_plan_revoke', () => {
  it('clears an active token and reports the slug; preserves sibling fields', async () => {
    seedState({ phase: 'code', spec_slug: 't3', plan_authorization: token() })
    const out = (await planRevokeHandler({ project_root: tmpRoot, reason: 'done early' })) as PlanRevokeOutput
    expect(out.status).toBe('revoked')
    expect(out.revoked_plan_slug).toBe('t3')
    const st = readState()
    expect(st?.plan_authorization).toBeUndefined()
    expect(st?.phase).toBe('code')
    expect(st?.spec_slug).toBe('t3')
  })

  it('is a no-op when no token is present', async () => {
    seedState({ phase: 'code', spec_slug: 't3' })
    const out = (await planRevokeHandler({ project_root: tmpRoot })) as PlanRevokeOutput
    expect(out.status).toBe('no_token')
    expect(out.revoked_plan_slug).toBeNull()
  })

  it('is a no-op when there is no phase-state at all', async () => {
    const out = (await planRevokeHandler({ project_root: tmpRoot })) as PlanRevokeOutput
    expect(out.status).toBe('no_token')
  })
})

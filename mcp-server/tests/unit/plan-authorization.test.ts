import { describe, it, expect } from 'vitest'
import {
  emitToken,
  validateToken,
  consumeTokenAction,
  readToken,
  clearTokenFromState,
  resolveTtlMinutes,
  resolveMaxActions,
  PLAN_TOKEN_TTL_DEFAULT_MIN,
  PLAN_TOKEN_TTL_MIN,
  PLAN_TOKEN_TTL_MAX,
  PLAN_TOKEN_MAX_ACTIONS_DEFAULT,
  PLAN_TOKEN_MAX_ACTIONS_MIN,
  PLAN_TOKEN_MAX_ACTIONS_MAX,
} from '../../src/lib/plan-authorization.js'
import type { PhaseState, PlanAuthorizationBlock } from '../../src/lib/phase-scope.js'
import type { ActivePlan } from '../../src/lib/plan.js'

const NOW = new Date('2026-06-22T12:00:00.000Z')

function baseToken(over: Partial<PlanAuthorizationBlock> = {}): PlanAuthorizationBlock {
  return {
    plan_slug: 't3',
    branch: 'feat/t3',
    covers: ['commit'],
    authorized_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    max_actions: 20,
    actions_used: 0,
    approval_ref: { action_scope: 'plan_authorize:t3', timestamp: NOW.toISOString() },
    ...over,
  }
}

function plan(status: string | null): ActivePlan {
  return {
    slug: 't3',
    plan_path: '/x/plan_t3.md',
    progress_path: null,
    status,
    branch: 'feat/t3',
    created: null,
  }
}

const ctxOK = {
  now: NOW,
  branch: 'feat/t3',
  tokenPlan: plan('in progress'),
  action: 'commit',
}

describe('lib/plan-authorization — emitToken', () => {
  it('computes expires_at = authorized_at + ttl, starts at 0 actions, covers commit', () => {
    const t = emitToken({
      planSlug: 't3',
      branch: 'feat/t3',
      ttlMinutes: 120,
      maxActions: 20,
      approvalRef: { action_scope: 'plan_authorize:t3', timestamp: NOW.toISOString() },
      now: NOW,
    })
    expect(t.actions_used).toBe(0)
    expect(t.covers).toEqual(['commit'])
    expect(t.authorized_at).toBe(NOW.toISOString())
    expect(new Date(t.expires_at).getTime()).toBe(NOW.getTime() + 120 * 60_000)
    expect(t.session_id).toBeUndefined()
  })

  it('includes session_id only when provided', () => {
    const t = emitToken({
      planSlug: 't3',
      branch: 'feat/t3',
      ttlMinutes: 5,
      maxActions: 1,
      approvalRef: { action_scope: 'plan_authorize:t3', timestamp: NOW.toISOString() },
      now: NOW,
      sessionId: 'sess-1',
    })
    expect(t.session_id).toBe('sess-1')
  })
})

describe('lib/plan-authorization — validateToken', () => {
  it('valid token passes', () => {
    expect(validateToken(baseToken(), ctxOK)).toEqual({ valid: true, token: baseToken() })
  })

  it('absent → reason absent', () => {
    expect(validateToken(null, ctxOK)).toEqual({ valid: false, reason: 'absent' })
    expect(validateToken(undefined, ctxOK)).toEqual({ valid: false, reason: 'absent' })
  })

  it('action not in covers → not_covered', () => {
    expect(validateToken(baseToken(), { ...ctxOK, action: 'push' })).toEqual({
      valid: false,
      reason: 'not_covered',
    })
  })

  it('missing/non-array covers → not_covered (never throws)', () => {
    const bad = { ...baseToken(), covers: undefined } as unknown as PlanAuthorizationBlock
    expect(() => validateToken(bad, ctxOK)).not.toThrow()
    expect(validateToken(bad, ctxOK)).toEqual({ valid: false, reason: 'not_covered' })
  })

  it('expired when now >= expires_at', () => {
    expect(
      validateToken(baseToken(), { ...ctxOK, now: new Date(NOW.getTime() + 2 * 60 * 60_000) }),
    ).toEqual({ valid: false, reason: 'expired' })
  })

  it('expired when expires_at is unparseable (NaN-safe)', () => {
    expect(validateToken(baseToken({ expires_at: 'not-a-date' }), ctxOK)).toEqual({
      valid: false,
      reason: 'expired',
    })
  })

  it('branch_mismatch when current branch differs from token branch', () => {
    expect(validateToken(baseToken(), { ...ctxOK, branch: 'main' })).toEqual({
      valid: false,
      reason: 'branch_mismatch',
    })
    expect(validateToken(baseToken(), { ...ctxOK, branch: null })).toEqual({
      valid: false,
      reason: 'branch_mismatch',
    })
  })

  it('plan_gone when the token plan no longer resolves', () => {
    expect(validateToken(baseToken(), { ...ctxOK, tokenPlan: null })).toEqual({
      valid: false,
      reason: 'plan_gone',
    })
  })

  it('plan_complete when the token plan is marked done', () => {
    expect(validateToken(baseToken(), { ...ctxOK, tokenPlan: plan('completed') })).toEqual({
      valid: false,
      reason: 'plan_complete',
    })
  })

  it('exhausted when actions_used >= max_actions', () => {
    expect(validateToken(baseToken({ actions_used: 20, max_actions: 20 }), ctxOK)).toEqual({
      valid: false,
      reason: 'exhausted',
    })
  })

  it('returns the FIRST failing reason (expired wins over branch/exhausted)', () => {
    const t = baseToken({ actions_used: 99, max_actions: 1 })
    expect(
      validateToken(t, {
        ...ctxOK,
        now: new Date(NOW.getTime() + 9e9),
        branch: 'other',
      }),
    ).toEqual({ valid: false, reason: 'expired' })
  })
})

describe('lib/plan-authorization — consume / read / clear', () => {
  it('consumeTokenAction increments actions_used by exactly 1 (immutably)', () => {
    const t = baseToken({ actions_used: 5 })
    const c = consumeTokenAction(t)
    expect(c.actions_used).toBe(6)
    expect(t.actions_used).toBe(5) // original untouched
  })

  it('readToken returns the token or null', () => {
    const state: PhaseState = { plan_authorization: baseToken() }
    expect(readToken(state)?.plan_slug).toBe('t3')
    expect(readToken({})).toBeNull()
    expect(readToken(null)).toBeNull()
  })

  it('clearTokenFromState removes only the token, preserving siblings', () => {
    const state: PhaseState = {
      phase: 'code',
      spec_slug: 't3',
      bootstrap_at: NOW.toISOString(),
      plan_authorization: baseToken(),
    }
    const cleared = clearTokenFromState(state)
    expect(cleared.plan_authorization).toBeUndefined()
    expect(cleared.phase).toBe('code')
    expect(cleared.spec_slug).toBe('t3')
    expect(cleared.bootstrap_at).toBe(NOW.toISOString())
    expect(state.plan_authorization).toBeDefined() // original untouched
  })
})

describe('lib/plan-authorization — bounds resolution (RV5 clamp)', () => {
  it('ttl: input > config > default; clamps out-of-range; NaN → default', () => {
    expect(resolveTtlMinutes(60, 200)).toBe(60)
    expect(resolveTtlMinutes(undefined, 200)).toBe(200)
    expect(resolveTtlMinutes(undefined, undefined)).toBe(PLAN_TOKEN_TTL_DEFAULT_MIN)
    expect(resolveTtlMinutes(1, undefined)).toBe(PLAN_TOKEN_TTL_MIN) // clamp up
    expect(resolveTtlMinutes(99999, undefined)).toBe(PLAN_TOKEN_TTL_MAX) // clamp down
    expect(resolveTtlMinutes(Number.NaN, undefined)).toBe(PLAN_TOKEN_TTL_DEFAULT_MIN)
  })

  it('max_actions: input > config > default; clamps; NaN → default', () => {
    expect(resolveMaxActions(10, 50)).toBe(10)
    expect(resolveMaxActions(undefined, 50)).toBe(50)
    expect(resolveMaxActions(undefined, undefined)).toBe(PLAN_TOKEN_MAX_ACTIONS_DEFAULT)
    expect(resolveMaxActions(0, undefined)).toBe(PLAN_TOKEN_MAX_ACTIONS_MIN) // clamp up
    expect(resolveMaxActions(1000, undefined)).toBe(PLAN_TOKEN_MAX_ACTIONS_MAX) // clamp down
    expect(resolveMaxActions(Number.NaN, undefined)).toBe(PLAN_TOKEN_MAX_ACTIONS_DEFAULT)
  })
})

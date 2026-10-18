import { describe, it, expect } from 'vitest'
import {
  emitToken,
  resolveTtlMinutes,
  tokenExpiryMs,
  validateToken,
  PLAN_TOKEN_TTL_DEFAULT_MIN,
  PLAN_TOKEN_TTL_MAX,
} from '../../src/lib/plan-authorization.js'
import type { PlanAuthorizationBlock } from '../../src/lib/phase-scope.js'
import type { ActivePlan } from '../../src/lib/plan.js'

const NOW = new Date('2026-07-11T12:00:00.000Z')
const HOUR = 60 * 60_000
const approvalRef = { action_scope: 'plan_authorize:p', timestamp: NOW.toISOString() }

function plan(): ActivePlan {
  return { slug: 'p', plan_path: '/p', progress_path: null, status: 'In Progress', branch: null, created: null }
}

function token(over: Partial<PlanAuthorizationBlock> = {}): PlanAuthorizationBlock {
  return { ...emitToken({ planSlug: 'p', branch: 'feat/x', ttlMinutes: 480, maxActions: 20, approvalRef, now: NOW }), ...over }
}

function ctx(at: Date, mintRecorded = true) {
  return { now: at, branch: 'feat/x', tokenPlan: plan(), action: 'commit', mintRecorded }
}

describe('lib/plan-authorization — the token lives 8 hours at most from its approval', () => {
  it('mints a fixed window from the approval, with nothing that extends it', () => {
    const t = emitToken({ planSlug: 'p', branch: 'feat/x', ttlMinutes: 90, maxActions: 3, approvalRef, now: NOW })
    expect(new Date(t.expires_at).getTime()).toBe(NOW.getTime() + 90 * 60_000)
    expect(t).not.toHaveProperty('slide_minutes')
    expect(t).not.toHaveProperty('absolute_expires_at')
  })

  it('defaults to 8 hours and never resolves past them', () => {
    expect(PLAN_TOKEN_TTL_DEFAULT_MIN).toBe(480)
    expect(PLAN_TOKEN_TTL_MAX).toBe(480)
    expect(resolveTtlMinutes(undefined, undefined)).toBe(480)
    expect(resolveTtlMinutes(10_000, undefined)).toBe(480)
    expect(resolveTtlMinutes(undefined, 60)).toBe(60)
    expect(resolveTtlMinutes(Number.NaN, undefined)).toBe(480)
  })

  it('caps an older token whose stored expiry is later than 8 hours after its approval', () => {
    const old = token({ expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString() })
    expect(tokenExpiryMs(old, NOW)).toBe(NOW.getTime() + 8 * HOUR)
    expect(validateToken(old, ctx(new Date(NOW.getTime() + 8 * HOUR - 1000))).valid).toBe(true)
    expect(validateToken(old, ctx(new Date(NOW.getTime() + 8 * HOUR)))).toEqual({ valid: false, reason: 'expired' })
  })

  it('keeps an older absolute cap when it is earlier', () => {
    const old = token({ expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(), absolute_expires_at: new Date(NOW.getTime() + 2 * HOUR).toISOString() })
    expect(tokenExpiryMs(old, NOW)).toBe(NOW.getTime() + 2 * HOUR)
  })

  it('treats a missing, unreadable or future approval time as expired', () => {
    expect(validateToken(token({ authorized_at: 'not a date' }), ctx(NOW))).toEqual({ valid: false, reason: 'expired' })
    expect(validateToken(token({ authorized_at: undefined as unknown as string }), ctx(NOW))).toEqual({ valid: false, reason: 'expired' })
    const ahead = token({ authorized_at: new Date(NOW.getTime() + 6 * 60_000).toISOString() })
    expect(validateToken(ahead, ctx(NOW))).toEqual({ valid: false, reason: 'expired' })
    const slightlyAhead = token({ authorized_at: new Date(NOW.getTime() + 4 * 60_000).toISOString() })
    expect(validateToken(slightlyAhead, ctx(NOW)).valid).toBe(true)
  })

  it('refuses a token the audit log does not show as minted', () => {
    expect(validateToken(token(), ctx(NOW, false))).toEqual({ valid: false, reason: 'unrecorded' })
    expect(validateToken(token(), ctx(NOW, true)).valid).toBe(true)
  })
})

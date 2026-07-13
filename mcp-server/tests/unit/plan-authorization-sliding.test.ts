import { describe, it, expect } from 'vitest'
import {
  emitToken,
  rearmToken,
  validateToken,
  resolveSlideMinutes,
  resolveAbsTtlMinutes,
} from '../../src/lib/plan-authorization.js'
import type { ActivePlan } from '../../src/lib/plan.js'

const NOW = new Date('2026-07-11T12:00:00.000Z')
const approvalRef = { action_scope: 'commit:feat/x:abc', timestamp: NOW.toISOString() }

function activePlan(): ActivePlan {
  return { slug: 'p', status: 'In Progress', path: '/p', progress_path: null } as unknown as ActivePlan
}

describe('lib/plan-authorization — sliding window (Bloco 1.4)', () => {
  it('legacy mint (no slide/abs) keeps fixed-TTL semantics', () => {
    const t = emitToken({ planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW })
    expect(t.slide_minutes).toBeUndefined()
    expect(t.absolute_expires_at).toBeUndefined()
    expect(new Date(t.expires_at).getTime()).toBe(NOW.getTime() + 120 * 60_000)
  })

  it('sliding mint stamps slide_minutes, absolute cap, and an initial sliding window', () => {
    const t = emitToken({
      planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW,
      slideMinutes: 480, absTtlMinutes: 1440,
    })
    expect(t.slide_minutes).toBe(480)
    expect(new Date(t.expires_at).getTime()).toBe(NOW.getTime() + 480 * 60_000)
    expect(new Date(t.absolute_expires_at!).getTime()).toBe(NOW.getTime() + 1440 * 60_000)
  })

  it('rearmToken extends expires_at forward, capped at the absolute ceiling', () => {
    const t = emitToken({
      planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW,
      slideMinutes: 480, absTtlMinutes: 1440,
    })
    // 6h later: now+slide (6h+8h=14h) exceeds the 24h absolute? no — cap is 24h from mint.
    const later = new Date(NOW.getTime() + 6 * 60 * 60_000)
    const armed = rearmToken(t, later)
    expect(new Date(armed.expires_at).getTime()).toBe(later.getTime() + 480 * 60_000)
    // near the cap: now+slide would exceed absolute → clamped to absolute.
    const nearCap = new Date(NOW.getTime() + 23 * 60 * 60_000)
    const armed2 = rearmToken(t, nearCap)
    expect(new Date(armed2.expires_at).getTime()).toBe(new Date(t.absolute_expires_at!).getTime())
  })

  it('rearmToken never moves expires_at backward', () => {
    const t = emitToken({
      planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW,
      slideMinutes: 480, absTtlMinutes: 1440,
    })
    // A re-arm computed at an EARLIER instant would shrink the window — must no-op.
    const earlier = new Date(NOW.getTime() - 60 * 60_000)
    expect(rearmToken(t, earlier).expires_at).toBe(t.expires_at)
  })

  it('rearmToken leaves a legacy (no-slide) token untouched', () => {
    const t = emitToken({ planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW })
    expect(rearmToken(t, new Date(NOW.getTime() + 1000)).expires_at).toBe(t.expires_at)
  })

  it('validateToken rejects once the ABSOLUTE cap passes even if the sliding window is future', () => {
    const t = emitToken({
      planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW,
      slideMinutes: 480, absTtlMinutes: 1440,
    })
    // Forge a re-armed token whose sliding expires_at is far future but abs cap is past.
    const zombie = { ...t, expires_at: new Date(NOW.getTime() + 100 * 60 * 60_000).toISOString() }
    const past = new Date(NOW.getTime() + 25 * 60 * 60_000) // past the 24h cap
    const v = validateToken(zombie, { now: past, branch: 'feat/x', tokenPlan: activePlan(), action: 'commit' })
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('expired')
  })

  it('validateToken accepts a sliding-fresh token still within the cap', () => {
    const t = emitToken({
      planSlug: 'p', branch: 'feat/x', ttlMinutes: 120, maxActions: 20, approvalRef, now: NOW,
      slideMinutes: 480, absTtlMinutes: 1440,
    })
    const soon = new Date(NOW.getTime() + 60 * 60_000)
    const v = validateToken(t, { now: soon, branch: 'feat/x', tokenPlan: activePlan(), action: 'commit' })
    expect(v.valid).toBe(true)
  })

  it('resolvers clamp to bounds', () => {
    expect(resolveSlideMinutes(undefined, undefined)).toBe(480)
    expect(resolveSlideMinutes(99999, undefined)).toBe(1440)
    expect(resolveSlideMinutes(1, undefined)).toBe(5)
    expect(resolveAbsTtlMinutes(undefined, undefined)).toBe(1440)
    expect(resolveAbsTtlMinutes(99999999, undefined)).toBe(10080)
  })
})

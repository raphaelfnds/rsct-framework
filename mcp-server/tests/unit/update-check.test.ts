import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declineUpdateTag,
  getUpdateNotice,
  isNewer,
  isUpdateCheckKilled,
  normalizeTag,
  setUpdateCheckConsent,
  type FetchLike,
} from '../../src/lib/update-check.js'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'

// Versions relative to the running version → robust to future bumps.
const MAJ = Number(RSCT_MCP_VERSION.split('.')[0])
const NEWER = `v${MAJ + 1}.0.0`
const NEWEST = `v${MAJ + 2}.0.0`
const EQUAL = `v${RSCT_MCP_VERSION}`
const OLDER = 'v0.0.1'

// tests/setup.ts sets RSCT_UPDATE_CHECK=off for the whole suite so nothing reaches
// the network by accident. Tests that exercise the check pass an empty env to opt in.
const ON = { env: {} as NodeJS.ProcessEnv }

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-upd-'))
}
function seedCache(h: string, data: Record<string, unknown>): void {
  mkdirSync(join(h, '.rsct'), { recursive: true })
  writeFileSync(join(h, '.rsct', 'update-check.json'), JSON.stringify(data, null, 2))
}
function seedRaw(h: string, raw: string): void {
  mkdirSync(join(h, '.rsct'), { recursive: true })
  writeFileSync(join(h, '.rsct', 'update-check.json'), raw)
}
function readCache(h: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h, '.rsct', 'update-check.json'), 'utf8'))
}
const okFetcher = (tag: string): (() => Promise<FetchLike>) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: tag }) }))
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
const NOW = 1_000_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()
/** Fresh cache: both timestamps at `now` so no refresh fires. */
const fresh = (now: number): Record<string, string> => ({
  last_checked: iso(now),
  last_attempt: iso(now),
})

describe('lib/update-check — isNewer', () => {
  it('compares semver field-wise (numeric, not string)', () => {
    expect(isNewer('v1.10.0', '1.1.0')).toBe(true) // 10 > 1 numerically
    expect(isNewer('v1.2.0', '1.1.0')).toBe(true)
    expect(isNewer('v2.0.0', '1.1.0')).toBe(true)
    expect(isNewer('v1.1.0', '1.1.0')).toBe(false) // equal
    expect(isNewer('v1.0.0', '1.1.0')).toBe(false)
  })
  it('unparseable / incomplete tags are never "newer" (fail-silent)', () => {
    for (const bad of ['garbage', '', 'v1.1', 'v1', 'latest']) {
      expect(isNewer(bad, '1.1.0')).toBe(false)
    }
  })
})

describe('lib/update-check — normalizeTag', () => {
  it('strips a leading v/V and surrounding whitespace', () => {
    for (const form of ['v2.6.0', 'V2.6.0', '2.6.0', ' v2.6.0 ', '\t2.6.0\n']) {
      expect(normalizeTag(form)).toBe('2.6.0')
    }
  })
})

describe('lib/update-check — consult by default (#38)', () => {
  it('absent consent + a newer cached tag → the update hint (the headline case)', () => {
    const h = home()
    try {
      seedCache(h, { ...fresh(NOW), latest_tag: NEWER })
      const r = getUpdateNotice({ ...ON, home: h, fetcher: okFetcher(NEWER), now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('no cache file at all → consults (fires the refresh), no hint on that first call', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('fresh cache at the current version → no update hint', () => {
    const h = home()
    try {
      seedCache(h, { consent: 'yes', ...fresh(NOW), latest_tag: EQUAL })
      const r = getUpdateNotice({ ...ON, home: h, fetcher: okFetcher(EQUAL), now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('stale cache → non-blocking refresh whose result lands for the next call', async () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { consent: 'yes', last_attempt: '2000-01-01T00:00:00Z' })
      const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await flush()
      expect(readCache(h).latest_tag).toBe(NEWER)
      const r2 = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW + 1000 })
      expect(r2.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1) // still fresh → no second fetch
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — opt-out branch', () => {
  // The cache is deliberately STALE: with a fresh one no refresh would fire in any
  // build, so `not.toHaveBeenCalled()` would pass even if the consent gate were
  // removed. Staleness is what makes the assertion bite.
  it('consent "no" → the one-shot notice, no network, count persisted', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { consent: 'no', latest_tag: NEWER, last_attempt: '2000-01-01T00:00:00Z' })
      const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(r.hints).toHaveLength(1)
      expect(r.hints[0]).toMatch(/update check is OFF on this machine/)
      expect(r.hints[0]).not.toMatch(/newer RSCT release/) // opt-out wins over the tag
      expect(fetcher).not.toHaveBeenCalled()
      expect(readCache(h).optout_notice_count).toBe(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('the opt-out notice stops after 3 emissions', () => {
    const h = home()
    try {
      // No timestamps → maximally stale, so the opt-out gate is the only thing that
      // can prevent a fetch.
      const fetcher = okFetcher(NEWER)
      seedCache(h, { consent: 'no' })
      for (let i = 1; i <= 3; i++) {
        expect(getUpdateNotice({ ...ON, home: h, fetcher, now: NOW }).hints).toHaveLength(1)
        expect(readCache(h).optout_notice_count).toBe(i)
      }
      expect(getUpdateNotice({ ...ON, home: h, fetcher, now: NOW }).hints).toHaveLength(0)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('any present non-"yes" consent opts out (fail-closed against hand edits)', () => {
    for (const value of ['no', 'No', 'NO', 'false', '', 'off', 0, false, null, 42]) {
      const h = home()
      const fetcher = okFetcher(NEWER)
      try {
        // Stale on purpose — see the note above: a fresh cache makes the network
        // assertion vacuous because nothing would fetch in either build.
        seedCache(h, { consent: value, latest_tag: NEWER, last_attempt: '2000-01-01T00:00:00Z' })
        const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
        expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
        expect(fetcher).not.toHaveBeenCalled()
      } finally {
        rmSync(h, { recursive: true, force: true })
      }
    }
  })

  it('consent "yes" in any case is honoured as consult', () => {
    const h = home()
    try {
      seedCache(h, { consent: 'YES', latest_tag: NEWER, ...fresh(NOW) })
      const r = getUpdateNotice({ ...ON, home: h, now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // A read-only $HOME cannot persist the counter; emitting anyway would turn a
  // bounded notice into an unbounded nag on every status call.
  it.skipIf(process.platform === 'win32')(
    'a notice whose counter cannot be persisted is NOT emitted',
    () => {
      const h = home()
      try {
        seedCache(h, { consent: 'no' })
        chmodSync(join(h, '.rsct'), 0o500) // r-x: no writes, still readable
        expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints).toHaveLength(0)
      } finally {
        try {
          chmodSync(join(h, '.rsct'), 0o700)
        } catch {
          /* best effort */
        }
        rmSync(h, { recursive: true, force: true })
      }
    },
  )
})

describe('lib/update-check — per-version declines', () => {
  it('a declined tag is silent; a NEWER tag asks again', () => {
    const h = home()
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW), consent: 'yes' })
      expect(declineUpdateTag(NEWER, { ...ON, home: h })).toEqual({ ok: true, tag: normalizeTag(NEWER) })
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(false)

      // A newer release arrives → asks once more, declines accumulate.
      seedCache(h, {
        latest_tag: NEWEST,
        ...fresh(NOW),
        consent: 'yes',
        declined_tags: [normalizeTag(NEWER)],
      })
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(true)
      expect(declineUpdateTag(NEWEST, { ...ON, home: h }).ok).toBe(true)
      expect(readCache(h).declined_tags).toEqual([normalizeTag(NEWER), normalizeTag(NEWEST)])
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a decline that is not the offered release is REJECTED, nothing written', () => {
    const h = home()
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW) })
      const r = declineUpdateTag('v99.99.99', { ...ON, home: h })
      expect(r).toEqual({ ok: false, reason: 'mismatch', tag: normalizeTag(NEWER) })
      expect(readCache(h).declined_tags).toBeUndefined()
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a decline with nothing on offer is rejected', () => {
    const h = home()
    try {
      seedCache(h, { ...fresh(NOW) })
      expect(declineUpdateTag(NEWER, { ...ON, home: h })).toEqual({ ok: false, reason: 'no_offer' })
      expect(declineUpdateTag('', { ...ON, home: h })).toEqual({ ok: false, reason: 'no_offer' })
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('tag forms are one decline: v2.6.0 / 2.6.0 / V2.6.0 / padded', () => {
    for (const form of [NEWER, normalizeTag(NEWER), NEWER.toUpperCase(), ` ${NEWER} `]) {
      const h = home()
      try {
        seedCache(h, { latest_tag: NEWER, ...fresh(NOW) })
        expect(declineUpdateTag(form, { ...ON, home: h }).ok).toBe(true)
        expect(readCache(h).declined_tags).toEqual([normalizeTag(NEWER)])
        expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(false)
      } finally {
        rmSync(h, { recursive: true, force: true })
      }
    }
  })

  it('declining twice is idempotent (no duplicate entry)', () => {
    const h = home()
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW) })
      expect(declineUpdateTag(NEWER, { ...ON, home: h }).ok).toBe(true)
      expect(declineUpdateTag(NEWER, { ...ON, home: h }).ok).toBe(true)
      expect(readCache(h).declined_tags).toEqual([normalizeTag(NEWER)])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('malformed declined_tags: non-strings are filtered, real declines survive', () => {
    const h = home()
    try {
      seedCache(h, {
        latest_tag: NEWER,
        ...fresh(NOW),
        declined_tags: [42, null, { tag: 'x' }, '1.0.0'],
      })
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(true)
      expect(declineUpdateTag(NEWER, { ...ON, home: h }).ok).toBe(true)
      expect(readCache(h).declined_tags).toEqual(['1.0.0', normalizeTag(NEWER)])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('declined_tags that is not an array does not throw and does not silence', () => {
    const h = home()
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW), declined_tags: 'nope' })
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — the opt-out switch', () => {
  it('"off" silences everything AND spends the opt-out notice (no undo pitch)', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW) })
      expect(setUpdateCheckConsent('off', { ...ON, home: h }).ok).toBe(true)
      const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(r.hints).toHaveLength(0)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('"on" re-enables and restores the opt-out notice budget', () => {
    const h = home()
    try {
      seedCache(h, { consent: 'no', optout_notice_count: 3, latest_tag: NEWER, ...fresh(NOW) })
      expect(setUpdateCheckConsent('on', { ...ON, home: h }).ok).toBe(true)
      const c = readCache(h)
      expect(c.consent).toBe('yes')
      expect(c.optout_notice_count).toBe(0)
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('the switch preserves declines and unknown fields', () => {
    const h = home()
    try {
      seedCache(h, { declined_tags: ['1.0.0'], future_field: 'keep me', latest_tag: NEWER })
      setUpdateCheckConsent('off', { ...ON, home: h })
      const c = readCache(h)
      expect(c.declined_tags).toEqual(['1.0.0'])
      expect(c.future_field).toBe('keep me')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // This switch is the whole test suite's barrier against the real API and the
  // contributor's real ~/.rsct (tests/setup.ts), so it is asserted on all three
  // effects — no hint, no network, no write — against a STALE cache with no consent
  // recorded, which is the state where all three would otherwise happen.
  it('RSCT_UPDATE_CHECK=off short-circuits the hint, the network AND the write', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    const seed = { latest_tag: NEWER, last_attempt: '2000-01-01T00:00:00Z' }
    try {
      seedCache(h, seed)
      for (const value of ['off', 'OFF', '0', 'false', 'no']) {
        const r = getUpdateNotice({ home: h, fetcher, now: NOW, env: { RSCT_UPDATE_CHECK: value } })
        expect(r.hints).toHaveLength(0)
      }
      expect(fetcher).not.toHaveBeenCalled()
      expect(readCache(h)).toEqual(seed) // no posture-notice counter written
      // Any other value leaves the check on: hint + posture notice + a fetch.
      const on = getUpdateNotice({ home: h, fetcher, now: NOW, env: { RSCT_UPDATE_CHECK: 'on' } })
      expect(on.hints).toHaveLength(2)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('the kill switch also blocks the mutators from being reported as effective', () => {
    const h = home()
    try {
      seedCache(h, { latest_tag: NEWER, ...fresh(NOW) })
      expect(isUpdateCheckKilled({ env: { RSCT_UPDATE_CHECK: 'off' } })).toBe(true)
      expect(isUpdateCheckKilled({ env: {} })).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — the refresh never destroys state', () => {
  it('preserves consent, declines, notice counts and unknown fields', async () => {
    const h = home()
    try {
      seedCache(h, {
        consent: 'yes',
        last_attempt: '2000-01-01T00:00:00Z',
        declined_tags: ['1.0.0'],
        optout_notice_count: 2,
        posture_notice_count: 1,
        future_field: 'keep me',
      })
      getUpdateNotice({ ...ON, home: h, fetcher: okFetcher(NEWER), now: NOW })
      await flush()
      const c = readCache(h)
      expect(c.consent).toBe('yes')
      expect(c.declined_tags).toEqual(['1.0.0'])
      expect(c.optout_notice_count).toBe(2)
      expect(c.posture_notice_count).toBe(1)
      expect(c.future_field).toBe('keep me')
      expect(c.latest_tag).toBe(NEWER)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('never invents a consent that was absent', async () => {
    const h = home()
    try {
      seedCache(h, { last_attempt: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ ...ON, home: h, fetcher: okFetcher(NEWER), now: NOW })
      await flush()
      expect('consent' in readCache(h)).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // The lost-update race: the dev declines while the request is in flight.
  it('a decline written DURING the fetch survives the refresh', async () => {
    const h = home()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slowFetcher = async (): Promise<FetchLike> => {
      await gate
      return { ok: true, json: async () => ({ tag_name: NEWER }) }
    }
    try {
      seedCache(h, { last_attempt: '2000-01-01T00:00:00Z', latest_tag: NEWER })
      getUpdateNotice({ ...ON, home: h, fetcher: slowFetcher, now: NOW }) // refresh in flight
      expect(declineUpdateTag(NEWER, { ...ON, home: h }).ok).toBe(true) // dev declines meanwhile
      release()
      await flush()
      expect(readCache(h).declined_tags).toEqual([normalizeTag(NEWER)]) // not erased
      expect(
        getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT/.test(x)),
      ).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('an opt-out written DURING the fetch survives the refresh', async () => {
    const h = home()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slowFetcher = async (): Promise<FetchLike> => {
      await gate
      return { ok: true, json: async () => ({ tag_name: NEWER }) }
    }
    try {
      seedCache(h, { last_attempt: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ ...ON, home: h, fetcher: slowFetcher, now: NOW })
      expect(setUpdateCheckConsent('off', { ...ON, home: h }).ok).toBe(true)
      release()
      await flush()
      expect(readCache(h).consent).toBe('no')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — TTL, failure and clock', () => {
  it('a failed refresh records last_attempt so it does not retry on every call', async () => {
    const h = home()
    const fetcher = vi.fn(async () => {
      throw new Error('network down')
    })
    try {
      seedCache(h, { consent: 'yes', last_attempt: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      await flush()
      const c = readCache(h)
      expect(c.last_attempt).toBe(iso(NOW))
      expect(c.last_checked).toBeUndefined() // failure never counts as a check
      // Next call within the TTL → no second attempt.
      getUpdateNotice({ ...ON, home: h, fetcher, now: NOW + 1000 })
      await flush()
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a non-2xx response does not update latest_tag but does bound the retry', async () => {
    const h = home()
    const fetcher = vi.fn(async (): Promise<FetchLike> => ({ ok: false, json: async () => ({}) }))
    try {
      seedCache(h, { consent: 'yes', latest_tag: OLDER, last_attempt: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      await flush()
      const c = readCache(h)
      expect(c.latest_tag).toBe(OLDER) // not overwritten
      expect(c.last_attempt).toBe(iso(NOW))
      expect(c.last_checked).toBeUndefined()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a last_attempt in the future is treated as stale, not as permanently fresh', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { consent: 'yes', last_attempt: iso(NOW + 10 * 365 * 24 * 3600 * 1000) })
      getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a legacy cache with only last_checked still bounds the TTL', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { consent: 'yes', last_checked: iso(NOW), latest_tag: NEWER })
      const r = getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      expect(fetcher).not.toHaveBeenCalled() // fresh by last_checked alone
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — the first-consult transparency notice', () => {
  it('fires when consent is absent, at most 3 times, and never with consent recorded', () => {
    const h = home()
    try {
      seedCache(h, { ...fresh(NOW) })
      for (let i = 1; i <= 3; i++) {
        const r = getUpdateNotice({ ...ON, home: h, now: NOW })
        expect(r.hints.some((x) => /checks GitHub about once a day/.test(x))).toBe(true)
        expect(readCache(h).posture_notice_count).toBe(i)
      }
      expect(
        getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /once a day/.test(x)),
      ).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('is not shown to someone who recorded consent', () => {
    const h = home()
    try {
      seedCache(h, { consent: 'yes', ...fresh(NOW) })
      expect(
        getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /once a day/.test(x)),
      ).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a first consult can carry BOTH the posture notice and an update hint', () => {
    const h = home()
    try {
      seedCache(h, { ...fresh(NOW), latest_tag: NEWER })
      const r = getUpdateNotice({ ...ON, home: h, now: NOW })
      expect(r.hints).toHaveLength(2)
      expect(r.hints.some((x) => /once a day/.test(x))).toBe(true)
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('lib/update-check — fail-silent and migration', () => {
  it('a corrupt cache fails CLOSED: no hint, no network, file untouched', async () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedRaw(h, '{ not valid json')
      expect(getUpdateNotice({ ...ON, home: h, fetcher, now: NOW }).hints).toHaveLength(0)
      expect(fetcher).not.toHaveBeenCalled()
      await flush()
      expect(readFileSync(join(h, '.rsct', 'update-check.json'), 'utf8')).toBe('{ not valid json')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a JSON array (valid JSON, wrong shape) is treated as unreadable', () => {
    const h = home()
    try {
      seedRaw(h, '["nope"]')
      expect(getUpdateNotice({ ...ON, home: h, now: NOW }).hints).toHaveLength(0)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a UTF-8 BOM does not make the file unreadable', () => {
    const h = home()
    try {
      const bom = String.fromCharCode(0xfeff)
      seedRaw(h, bom + JSON.stringify({ consent: 'yes', latest_tag: NEWER, ...fresh(NOW) }))
      expect(
        getUpdateNotice({ ...ON, home: h, now: NOW }).hints.some((x) => /newer RSCT release/.test(x)),
      ).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('mutators refuse to clobber an unreadable file', () => {
    const h = home()
    try {
      seedRaw(h, '{ not valid json')
      // `unreadable`, not `write_failed`: the file is perfectly writable, and telling
      // the dev to check permissions would send them after the wrong cause. The
      // recovery is to delete the file.
      expect(declineUpdateTag(NEWER, { ...ON, home: h })).toEqual({
        ok: false,
        reason: 'unreadable',
      })
      expect(setUpdateCheckConsent('off', { ...ON, home: h })).toEqual({ ok: false, reason: 'unreadable' })
      expect(readFileSync(join(h, '.rsct', 'update-check.json'), 'utf8')).toBe('{ not valid json')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a throwing fetcher never throws out of getUpdateNotice', () => {
    const h = home()
    const fetcher = vi.fn(async () => {
      throw new Error('network down')
    })
    try {
      seedCache(h, { consent: 'yes', last_attempt: '2000-01-01T00:00:00Z' })
      expect(() => getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })).not.toThrow()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a non-string tag_name never lands as latest_tag', async () => {
    const h = home()
    const fetcher = vi.fn(async (): Promise<FetchLike> => ({ ok: true, json: async () => ({ tag_name: 123 }) }))
    try {
      seedCache(h, { consent: 'yes', last_attempt: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ ...ON, home: h, fetcher, now: NOW })
      await flush()
      expect('latest_tag' in readCache(h)).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a v2.5.1-era cache (consent + last_checked + latest_tag only) keeps working', () => {
    const h = home()
    try {
      seedCache(h, { consent: 'yes', last_checked: iso(NOW), latest_tag: NEWER })
      const r = getUpdateNotice({ ...ON, home: h, now: NOW })
      expect(r.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
      expect(r.hints.some((x) => /once a day/.test(x))).toBe(false) // consent recorded
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

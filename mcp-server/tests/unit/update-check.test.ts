import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUpdateNotice, isNewer, type FetchLike } from '../../src/lib/update-check.js'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'

// Versions relative to the running version → robust to future bumps.
const MAJ = Number(RSCT_MCP_VERSION.split('.')[0])
const NEWER = `v${MAJ + 1}.0.0`
const EQUAL = `v${RSCT_MCP_VERSION}`
const OLDER = 'v0.0.1'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-upd-'))
}
function seedCache(h: string, data: Record<string, unknown>): void {
  mkdirSync(join(h, '.rsct'), { recursive: true })
  writeFileSync(join(h, '.rsct', 'update-check.json'), JSON.stringify(data, null, 2))
}
function readCache(h: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h, '.rsct', 'update-check.json'), 'utf8'))
}
const okFetcher = (tag: string): (() => Promise<FetchLike>) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: tag }) }))
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15))

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

describe('lib/update-check — getUpdateNotice (opt-in, cached, fail-silent)', () => {
  it('no cache file → no hint, no network', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      expect(getUpdateNotice({ home: h, fetcher }).hint).toBeNull()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('consent "no" → no hint, no network (opt-in gate)', () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      seedCache(h, { consent: 'no', latest_tag: NEWER, last_checked: new Date().toISOString() })
      expect(getUpdateNotice({ home: h, fetcher, now: Date.now() }).hint).toBeNull()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('consent "yes" + fresh cache with a newer tag → suggestion hint', () => {
    const h = home()
    const now = 1_000_000_000_000
    try {
      seedCache(h, { consent: 'yes', latest_tag: NEWER, last_checked: new Date(now).toISOString() })
      const r = getUpdateNotice({ home: h, fetcher: okFetcher(NEWER), now })
      expect(r.hint).toMatch(/newer RSCT release/)
      expect(r.hint).toContain(RSCT_MCP_VERSION)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('consent "yes" + fresh cache at the current version → no hint', () => {
    const h = home()
    const now = 1_000_000_000_000
    try {
      seedCache(h, { consent: 'yes', latest_tag: EQUAL, last_checked: new Date(now).toISOString() })
      expect(getUpdateNotice({ home: h, fetcher: okFetcher(EQUAL), now }).hint).toBeNull()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('stale cache → fires a non-blocking background refresh that updates the cache', async () => {
    const h = home()
    const fetcher = okFetcher(NEWER)
    try {
      // last_checked far in the past → stale; no latest_tag yet → returns null now.
      seedCache(h, { consent: 'yes', last_checked: '2000-01-01T00:00:00Z' })
      const r = getUpdateNotice({ home: h, fetcher, now: Date.parse('2026-06-22T00:00:00Z') })
      expect(r.hint).toBeNull() // first call: cache had no tag → no hint synchronously
      expect(fetcher).toHaveBeenCalledTimes(1) // refresh fired (not awaited)
      await flush()
      const c = readCache(h)
      expect(c.latest_tag).toBe(NEWER)
      expect(typeof c.last_checked).toBe('string')
      // Next call (cache now populated + fresh) → hint, no new fetch.
      const r2 = getUpdateNotice({ home: h, fetcher, now: Date.parse('2026-06-22T00:00:01Z') })
      expect(r2.hint).toMatch(/newer RSCT release/)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('A1: refresh with a non-string tag_name and no prior tag writes a cache WITHOUT latest_tag', async () => {
    const h = home()
    // tag_name is not a string → tag falls back to prev.latest_tag (absent) → omit the key.
    const fetcher = vi.fn(
      async (): Promise<FetchLike> => ({ ok: true, json: async () => ({ tag_name: 123 }) }),
    )
    try {
      seedCache(h, { consent: 'yes', last_checked: '2000-01-01T00:00:00Z' }) // stale, no latest_tag
      expect(() =>
        getUpdateNotice({ home: h, fetcher, now: Date.parse('2026-06-22T00:00:00Z') }),
      ).not.toThrow()
      await flush()
      const c = readCache(h)
      expect('latest_tag' in c).toBe(false) // omitted, never written as present-undefined
      expect(c.consent).toBe('yes')
      expect(typeof c.last_checked).toBe('string')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('fail-silent: a throwing fetcher never throws and leaves the cache intact', async () => {
    const h = home()
    const fetcher = vi.fn(async () => {
      throw new Error('network down')
    })
    try {
      seedCache(h, { consent: 'yes', last_checked: '2000-01-01T00:00:00Z' })
      expect(() => getUpdateNotice({ home: h, fetcher, now: Date.now() })).not.toThrow()
      await flush()
      expect(readCache(h).latest_tag).toBeUndefined() // unchanged
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('fail-silent: a non-2xx response does not update the cache', async () => {
    const h = home()
    const fetcher = vi.fn(async (): Promise<FetchLike> => ({ ok: false, json: async () => ({}) }))
    try {
      seedCache(h, { consent: 'yes', latest_tag: OLDER, last_checked: '2000-01-01T00:00:00Z' })
      getUpdateNotice({ home: h, fetcher, now: Date.now() })
      await flush()
      expect(readCache(h).latest_tag).toBe(OLDER) // not overwritten
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('corrupt cache JSON → no hint, no throw', () => {
    const h = home()
    try {
      mkdirSync(join(h, '.rsct'), { recursive: true })
      writeFileSync(join(h, '.rsct', 'update-check.json'), '{ not valid json')
      expect(getUpdateNotice({ home: h, fetcher: okFetcher(NEWER) }).hint).toBeNull()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

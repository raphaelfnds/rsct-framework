import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RSCT_MCP_VERSION } from './version.js'

// T4 — session-start update check. Surfaced as a hint by rsct_status. Fully
// OPT-IN (no network/file writes until `consent: "yes"` is recorded at
// /rsct-setup), CACHED (~/.rsct/update-check.json, 24h TTL), FAIL-SILENT (any
// error → no hint, never throws into the status bootstrap), and SUGGEST-ONLY.
// rsct_status reads ONLY the cache (zero added latency); a stale cache fires a
// non-blocking background refresh whose result lands for the next call.

const REPO = 'raphaelfnds/rsct-framework'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const TTL_MS = 24 * 60 * 60 * 1000

interface UpdateCheckFile {
  consent?: 'yes' | 'no'
  last_checked?: string // ISO-8601
  latest_tag?: string
}

/** Minimal shape of what a fetcher must return (a `fetch` Response satisfies it). */
export interface FetchLike {
  ok: boolean
  json: () => Promise<unknown>
}

export interface UpdateOptions {
  /** Override $HOME for hermetic tests. */
  home?: string
  /** Injectable network call (tests never hit the real API). */
  fetcher?: () => Promise<FetchLike>
  /** Injectable clock (ms) for TTL tests. */
  now?: number
}

export interface UpdateResult {
  hint: string | null
}

function cachePath(home: string): string {
  return join(home, '.rsct', 'update-check.json')
}

function readCache(home: string): UpdateCheckFile | null {
  try {
    const p = cachePath(home)
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as UpdateCheckFile) : null
  } catch {
    return null
  }
}

function writeCacheAtomic(home: string, data: UpdateCheckFile): void {
  try {
    mkdirSync(join(home, '.rsct'), { recursive: true })
    const p = cachePath(home)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, p)
  } catch {
    /* fail-silent — a missing cache just means we re-check next time */
  }
}

function parseSemver(v: string): [number, number, number] | null {
  const m = String(v)
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True iff `latestTag` (e.g. "v1.2.0") is a strictly-higher semver than `current`. */
export function isNewer(latestTag: string, current: string): boolean {
  const a = parseSemver(latestTag)
  const b = parseSemver(current)
  if (!a || !b) return false // unparseable → never a false "update available"
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true
    if (a[i]! < b[i]!) return false
  }
  return false
}

function defaultFetcher(): Promise<FetchLike> {
  return fetch(LATEST_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `rsct-mcp/${RSCT_MCP_VERSION}` },
    signal: AbortSignal.timeout(2000),
  })
}

async function backgroundRefresh(
  home: string,
  fetcher: () => Promise<FetchLike>,
  nowIso: string,
  prev: UpdateCheckFile,
): Promise<void> {
  try {
    const res = await fetcher()
    if (!res.ok) return
    const body = (await res.json()) as { tag_name?: unknown }
    const tag = typeof body.tag_name === 'string' ? body.tag_name : prev.latest_tag
    // exactOptionalPropertyTypes: include latest_tag ONLY when known — never write a
    // present-undefined. (JSON.stringify omits undefined, so the on-disk file is identical.)
    const next: UpdateCheckFile = { consent: 'yes', last_checked: nowIso }
    if (tag !== undefined) next.latest_tag = tag
    writeCacheAtomic(home, next)
  } catch {
    /* fail-silent — leave the cache as-is, retry next session */
  }
}

/**
 * The single source for the update hint. NEVER throws. Returns `{hint:null}`
 * unless consent is "yes" AND the cached latest tag is newer than the running
 * version. A stale cache triggers a fire-and-forget refresh (not awaited).
 */
export function getUpdateNotice(opts: UpdateOptions = {}): UpdateResult {
  try {
    const home = opts.home ?? process.env.HOME ?? homedir()
    const cache = readCache(home)
    if (!cache || cache.consent !== 'yes') return { hint: null } // opt-in gate

    const now = opts.now ?? Date.now()
    const last = cache.last_checked ? Date.parse(cache.last_checked) : NaN
    const stale = !Number.isFinite(last) || now - last > TTL_MS
    if (stale) {
      // Fire-and-forget: do NOT await — rsct_status must add zero network latency.
      void backgroundRefresh(home, opts.fetcher ?? defaultFetcher, new Date(now).toISOString(), cache)
    }

    if (cache.latest_tag && isNewer(cache.latest_tag, RSCT_MCP_VERSION)) {
      const tag = cache.latest_tag.replace(/^v/, '')
      return {
        hint:
          `A newer RSCT release (v${tag}) is available — you have ${RSCT_MCP_VERSION}. ` +
          `Update the framework (git pull + reinstall) then run /rsct-setup to apply it. (suggestion only)`,
      }
    }
    return { hint: null }
  } catch {
    return { hint: null }
  }
}

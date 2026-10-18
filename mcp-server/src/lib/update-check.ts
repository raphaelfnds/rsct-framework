import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RSCT_MCP_VERSION } from './version.js'

const REPO = 'raphaelfnds/rsct-framework'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const TTL_MS = 24 * 60 * 60 * 1000
const ENV_KILL_SWITCH = 'RSCT_UPDATE_CHECK'

const NOTICE_MAX_SHOWS = 3

type NoticeKey = 'optout_notice_count' | 'posture_notice_count'

interface UpdateCheckFile {
  consent?: unknown
  last_checked?: string
  last_attempt?: string
  latest_tag?: string
  declined_tags?: unknown
  optout_notice_count?: number
  posture_notice_count?: number
  [key: string]: unknown
}

export interface FetchLike {
  ok: boolean
  json: () => Promise<unknown>
}

export interface UpdateOptions {
  home?: string
  fetcher?: () => Promise<FetchLike>
  now?: number
  env?: NodeJS.ProcessEnv
}

export interface UpdateResult {
  hints: string[]
}

export interface DeclineResult {
  ok: boolean
  reason?: 'no_offer' | 'mismatch' | 'write_failed' | 'unreadable'
  tag?: string
}

type CacheRead = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; data: UpdateCheckFile }

const attemptMemo = new Map<string, number>()

function cachePath(home: string): string {
  return join(home, '.rsct', 'update-check.json')
}

function readCacheState(home: string): CacheRead {
  let raw: string
  try {
    raw = readFileSync(cachePath(home), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
  try {
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(noBom) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' }
    return { kind: 'ok', data: parsed as UpdateCheckFile }
  } catch {
    return { kind: 'unreadable' }
  }
}

function writeCacheAtomic(home: string, data: UpdateCheckFile): boolean {
  const target = cachePath(home)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(join(home, '.rsct'), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
    }
    return false
  }
}

export function normalizeTag(tag: unknown): string {
  return String(tag ?? '')
    .trim()
    .replace(/^[vV]/, '')
}

function resolveHome(opts: UpdateOptions): string {
  const env = opts.env ?? process.env
  return opts.home ?? env.HOME ?? homedir()
}

function killSwitchOn(env: NodeJS.ProcessEnv): boolean {
  const v = String(env[ENV_KILL_SWITCH] ?? '')
    .trim()
    .toLowerCase()
  return v === 'off' || v === '0' || v === 'false' || v === 'no'
}

function consentState(data: UpdateCheckFile): 'yes' | 'off' | 'absent' {
  if (!('consent' in data)) return 'absent'
  const c = data.consent
  return typeof c === 'string' && c.trim().toLowerCase() === 'yes' ? 'yes' : 'off'
}

function declinedList(data: UpdateCheckFile): string[] {
  if (!Array.isArray(data.declined_tags)) return []
  const out: string[] = []
  for (const entry of data.declined_tags) {
    if (typeof entry !== 'string') continue
    const t = normalizeTag(entry)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function noticeCount(data: UpdateCheckFile, key: NoticeKey): number {
  const v = data[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function withinTtl(raw: unknown, now: number): boolean {
  const t = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(t)) return false
  if (t > now) return false
  return now - t <= TTL_MS
}

function isStale(data: UpdateCheckFile, now: number): boolean {
  return !withinTtl(data.last_attempt, now) && !withinTtl(data.last_checked, now)
}

function parseSemver(v: string): [number, number, number] | null {
  const m = normalizeTag(v).match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isNewer(latestTag: string, current: string): boolean {
  const a = parseSemver(latestTag)
  const b = parseSemver(current)
  if (!a || !b) return false
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

const OPTOUT_NOTICE =
  "RSCT's update check is OFF on this machine, so new releases — including security " +
  'patches — are never reported, and no network call is made. This was recorded during ' +
  '/rsct-setup; on installs up to v2.5.1 "off" is also what got recorded when the question ' +
  'went unanswered, so it may not have been a deliberate choice. To turn it on, call ' +
  'rsct_status with update_check:"on"; to leave it off, do nothing.'

const POSTURE_NOTICE =
  'RSCT now checks GitHub about once a day for a newer release, unless turned off. It is ' +
  'an unauthenticated GET of the latest-release tag: no project data, no code and no ' +
  'telemetry are sent — GitHub sees the IP, the time, and a User-Agent naming rsct-mcp and ' +
  'its version. To turn it off, call rsct_status with update_check:"off", or set ' +
  'RSCT_UPDATE_CHECK=off in the environment.'

function updateHint(tag: string): string {
  const clean = normalizeTag(tag)
  return (
    `A newer RSCT release (v${clean}) is available — you have ${RSCT_MCP_VERSION}. ` +
    'Update the framework (git pull --ff-only + reinstall) then run /rsct-setup to apply it. ' +
    `(suggestion only) If the dev declines THIS release, call rsct_status with ` +
    `decline_update:"v${clean}" — only the release named here is accepted, it will not be ` +
    'raised again, and a newer one will ask once.'
  )
}

function emitNotice(home: string, data: UpdateCheckFile, key: NoticeKey, text: string): string[] {
  const count = noticeCount(data, key)
  if (count >= NOTICE_MAX_SHOWS) return []
  const next: UpdateCheckFile = { ...data }
  next[key] = count + 1
  return writeCacheAtomic(home, next) ? [text] : []
}

async function backgroundRefresh(
  home: string,
  fetcher: () => Promise<FetchLike>,
  nowIso: string,
): Promise<void> {
  let succeeded = false
  let tag: string | undefined
  try {
    const res = await fetcher()
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown }
      if (typeof body.tag_name === 'string') tag = body.tag_name
      succeeded = true
    }
  } catch {
  }

  const read = readCacheState(home)
  if (read.kind === 'unreadable') return
  const next: UpdateCheckFile = { ...(read.kind === 'ok' ? read.data : {}), last_attempt: nowIso }
  if (succeeded) {
    next.last_checked = nowIso
    if (tag !== undefined) next.latest_tag = tag
  }
  writeCacheAtomic(home, next)
}

export function getUpdateNotice(opts: UpdateOptions = {}): UpdateResult {
  try {
    const env = opts.env ?? process.env
    if (killSwitchOn(env)) return { hints: [] }

    const home = resolveHome(opts)
    const read = readCacheState(home)
    if (read.kind === 'unreadable') return { hints: [] }
    const data = read.kind === 'ok' ? read.data : {}

    const consent = consentState(data)
    if (consent === 'off') {
      return { hints: emitNotice(home, data, 'optout_notice_count', OPTOUT_NOTICE) }
    }

    const hints: string[] =
      consent === 'absent' ? emitNotice(home, data, 'posture_notice_count', POSTURE_NOTICE) : []

    const now = opts.now ?? Date.now()
    if (isStale(data, now) && !withinTtl(attemptMemo.get(home), now)) {
      attemptMemo.set(home, now)
      void backgroundRefresh(home, opts.fetcher ?? defaultFetcher, new Date(now).toISOString())
    }

    const tag = typeof data.latest_tag === 'string' ? data.latest_tag : ''
    if (tag && isNewer(tag, RSCT_MCP_VERSION) && !declinedList(data).includes(normalizeTag(tag))) {
      hints.push(updateHint(tag))
    }
    return { hints }
  } catch {
    return { hints: [] }
  }
}

export function declineUpdateTag(tag: string, opts: UpdateOptions = {}): DeclineResult {
  try {
    const home = resolveHome(opts)
    const read = readCacheState(home)
    if (read.kind === 'unreadable') return { ok: false, reason: 'unreadable' }
    const data = read.kind === 'ok' ? read.data : {}

    const cached = typeof data.latest_tag === 'string' ? data.latest_tag : ''
    const offered = cached && isNewer(cached, RSCT_MCP_VERSION) ? normalizeTag(cached) : ''
    if (!offered) return { ok: false, reason: 'no_offer' }

    const wanted = normalizeTag(tag)
    if (!wanted || wanted !== offered) return { ok: false, reason: 'mismatch', tag: offered }

    const list = declinedList(data)
    if (list.includes(wanted)) return { ok: true, tag: wanted }

    const next: UpdateCheckFile = { ...data, declined_tags: [...list, wanted] }
    return writeCacheAtomic(home, next)
      ? { ok: true, tag: wanted }
      : { ok: false, reason: 'write_failed' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export function setUpdateCheckConsent(
  mode: 'on' | 'off',
  opts: UpdateOptions = {},
): { ok: boolean; reason?: 'unreadable' | 'write_failed' } {
  try {
    const home = resolveHome(opts)
    const read = readCacheState(home)
    if (read.kind === 'unreadable') return { ok: false, reason: 'unreadable' }
    const next: UpdateCheckFile = { ...(read.kind === 'ok' ? read.data : {}) }
    if (mode === 'off') {
      next.consent = 'no'
      next.optout_notice_count = NOTICE_MAX_SHOWS
    } else {
      next.consent = 'yes'
      next.optout_notice_count = 0
    }
    return writeCacheAtomic(home, next) ? { ok: true } : { ok: false, reason: 'write_failed' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export function isUpdateCheckKilled(opts: UpdateOptions = {}): boolean {
  return killSwitchOn(opts.env ?? process.env)
}

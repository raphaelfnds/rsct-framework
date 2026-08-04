import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RSCT_MCP_VERSION } from './version.js'

// Session-start update check, surfaced as hints by rsct_status.
//
// CONSULT BY DEFAULT (#38): the check runs unless it is turned OFF. Two decisions
// that used to be one flag are now separate — "may I ask GitHub" (opt-OUT, below)
// and "do you want THIS release" (per-tag, `declined_tags`). Declining a release
// silences that release only; a newer one asks once more.
//
// Still CACHED (~/.rsct/update-check.json, 24h TTL), FAIL-SILENT (any error → no
// hint, never throws into the status bootstrap), and SUGGEST-ONLY — it never
// downloads or updates anything. rsct_status reads ONLY the cache (zero added
// network latency); a stale cache fires a non-blocking background refresh whose
// result lands for the next call.
//
// Three ways to turn it off, in precedence order: the RSCT_UPDATE_CHECK=off
// environment variable (the only one reachable before a session exists — CI,
// headless, a machine that must never emit the request at all), `rsct_status` with
// update_check:"off", and the `consent` field in the cache file itself.

const REPO = 'raphaelfnds/rsct-framework'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const TTL_MS = 24 * 60 * 60 * 1000
const ENV_KILL_SWITCH = 'RSCT_UPDATE_CHECK'

/**
 * How many times a one-shot notice may be emitted. It is a count, not a boolean,
 * because a notice is delivered as a `hints[]` string that the agent may never
 * relay to the human — a flag burned on generation can be spent with nobody having
 * read it, and it is unrecoverable.
 */
const NOTICE_MAX_SHOWS = 3

type NoticeKey = 'optout_notice_count' | 'posture_notice_count'

/**
 * On-disk shape. Every field is optional and hostile-tolerant: this file is shared
 * by every project on the machine AND by every rsct-mcp version installed on it, so
 * it may legitimately carry fields this build knows nothing about.
 */
interface UpdateCheckFile {
  /** Absent means consult. Any PRESENT value other than "yes" means off. */
  consent?: unknown
  /** ISO-8601 of the last SUCCESSFUL fetch. */
  last_checked?: string
  /** ISO-8601 of the last attempt, success or failure — this is what bounds the TTL. */
  last_attempt?: string
  latest_tag?: string
  declined_tags?: unknown
  optout_notice_count?: number
  posture_notice_count?: number
  [key: string]: unknown
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
  /** Injectable environment — carries the RSCT_UPDATE_CHECK kill switch. */
  env?: NodeJS.ProcessEnv
}

export interface UpdateResult {
  /** Zero, one or two hints — a first consult can carry the posture notice AND an update. */
  hints: string[]
}

export interface DeclineResult {
  ok: boolean
  /**
   * `no_offer` — nothing is currently being offered; `mismatch` — the tag is not the
   * release being offered (see `declineUpdateTag`); `write_failed` — could not persist.
   */
  reason?: 'no_offer' | 'mismatch' | 'write_failed' | 'unreadable'
  /** On success the normalized tag recorded; on `mismatch` the tag actually offered. */
  tag?: string
}

type CacheRead = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; data: UpdateCheckFile }

/**
 * In-process attempt memo, keyed by home. `last_attempt` on disk is the durable
 * bound, but it only bounds anything if the write LANDS — on a read-only $HOME, a
 * root-owned ~/.rsct or a Windows file held by AV/sync, it never does, and every
 * single rsct_status call would fire a fresh request. That is strictly worse than
 * the behaviour this replaced, and consult-by-default exposes everyone to it. The
 * memo also de-duplicates refreshes fired inside one fetch window.
 */
const attemptMemo = new Map<string, number>()

function cachePath(home: string): string {
  return join(home, '.rsct', 'update-check.json')
}

/**
 * Tri-state read. "Absent" and "present but unreadable" must NOT collapse into one
 * value: under consult-by-default, treating an unreadable file as absent would make
 * a transient lock (OneDrive/AV on Windows, a root-owned ~/.rsct on Linux) both fire
 * a network call the dev opted out of AND overwrite their recorded choice on the
 * next refresh. Unreadable therefore fails CLOSED and is never clobbered.
 */
function readCacheState(home: string): CacheRead {
  let raw: string
  try {
    raw = readFileSync(cachePath(home), 'utf8')
  } catch (err) {
    // ENOENT is the only errno that means "there is nothing here".
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
  try {
    // BOM tolerance: a hand-edited file saved by a Windows editor would otherwise
    // parse-fail and, under fail-closed, silence the check for good.
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(noBom) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' }
    return { kind: 'ok', data: parsed as UpdateCheckFile }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** Returns whether the write actually landed — callers gate user-visible effects on it. */
function writeCacheAtomic(home: string, data: UpdateCheckFile): boolean {
  // pid-suffixed: the read path writes now, and two rsct-mcp processes (the global
  // binary is one symlink shared by every project) would race a fixed temp name.
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
      /* best effort — never leave a partial temp behind, never throw about it */
    }
    return false
  }
}

/** `v2.6.0`, `V2.6.0`, `" 2.6.0 "` are all the same release. */
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

/**
 * Absent → consult. Present-and-not-"yes" → off. Checking only for the literal
 * "no" would be fail-OPEN for every variant a hand edit produces (`"No"`, `false`,
 * `0`, `null`) — and hand-editing the file is the only opt-out that exists in
 * versions already shipped.
 */
function consentState(data: UpdateCheckFile): 'yes' | 'off' | 'absent' {
  if (!('consent' in data)) return 'absent'
  const c = data.consent
  return typeof c === 'string' && c.trim().toLowerCase() === 'yes' ? 'yes' : 'off'
}

/** Normalized, deduped. Non-string entries are filtered out, never a reason to reset. */
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

/**
 * Staleness is measured from the last ATTEMPT, not the last success. A failing
 * network (offline, or a 403 from a rate-limited shared IP) never advances
 * `last_checked`, so measuring success would re-fire the request on every single
 * rsct_status call, forever, on machines that today make none.
 */
/** A stamp is fresh when it parses, is not in the future, and is inside the TTL. */
function withinTtl(raw: unknown, now: number): boolean {
  const t = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(t)) return false
  // A stamp in the future (wrong clock, VM restore, dual boot) must not freeze the
  // check forever — that is silence about every future release, security included.
  if (t > now) return false
  return now - t <= TTL_MS
}

function isStale(data: UpdateCheckFile, now: number): boolean {
  // last_attempt wins when usable, but an unparseable one must fall THROUGH to
  // last_checked rather than force a refresh a fresh success already covered.
  return !withinTtl(data.last_attempt, now) && !withinTtl(data.last_checked, now)
}

function parseSemver(v: string): [number, number, number] | null {
  // normalizeTag, not a local /^v/: a release tagged "V9.0.0" would otherwise be
  // invisible to the offer path while `declineUpdateTag` happily accepted it —
  // one capital letter in a hand-made git tag silencing that release entirely.
  const m = normalizeTag(v).match(/^(\d+)\.(\d+)\.(\d+)/)
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
    'Update the framework (git pull + reinstall) then run /rsct-setup to apply it. ' +
    `(suggestion only) If the dev declines THIS release, call rsct_status with ` +
    `decline_update:"v${clean}" — only the release named here is accepted, it will not be ` +
    'raised again, and a newer one will ask once.'
  )
}

/**
 * Emit a bounded notice, but ONLY if the increment persisted. On a read-only $HOME
 * `writeCacheAtomic` swallows EROFS, and a counter that never lands would turn a
 * bounded notice into an unbounded nag on every single status call.
 */
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
    /* fail-silent — `last_attempt` below still bounds the retry */
  }

  // Re-read AFTER the await. A decline or an opt-out recorded while the request was
  // in flight is already on disk; writing a pre-await snapshot would erase it right
  // after the agent told the dev it had been recorded.
  const read = readCacheState(home)
  if (read.kind === 'unreadable') return
  // Spread, not a field list: this file is shared across rsct-mcp versions on one
  // machine, so enumerating fields strips whatever a newer binary wrote. It is also
  // the form that satisfies exactOptionalPropertyTypes without inventing values.
  const next: UpdateCheckFile = { ...(read.kind === 'ok' ? read.data : {}), last_attempt: nowIso }
  if (succeeded) {
    next.last_checked = nowIso
    if (tag !== undefined) next.latest_tag = tag
  }
  // NOTE: never writes `consent`. An absent consent must stay absent — recording a
  // "yes" nobody gave would erase the distinction the opt-out notice depends on.
  writeCacheAtomic(home, next)
}

/**
 * The single source for update hints. NEVER throws. Consults by default: a hint is
 * returned when the cached latest tag is newer than the running version and has not
 * been declined. A stale cache triggers a fire-and-forget refresh (not awaited).
 */
export function getUpdateNotice(opts: UpdateOptions = {}): UpdateResult {
  try {
    const env = opts.env ?? process.env
    if (killSwitchOn(env)) return { hints: [] }

    const home = resolveHome(opts)
    const read = readCacheState(home)
    if (read.kind === 'unreadable') return { hints: [] } // fail closed, never clobber
    const data = read.kind === 'ok' ? read.data : {}

    const consent = consentState(data)
    if (consent === 'off') {
      return { hints: emitNotice(home, data, 'optout_notice_count', OPTOUT_NOTICE) }
    }

    const hints: string[] =
      consent === 'absent' ? emitNotice(home, data, 'posture_notice_count', POSTURE_NOTICE) : []

    const now = opts.now ?? Date.now()
    if (isStale(data, now) && !withinTtl(attemptMemo.get(home), now)) {
      // Stamp the memo BEFORE firing: the request may take 2s, and every call in
      // that window would otherwise start its own.
      attemptMemo.set(home, now)
      // Fire-and-forget: do NOT await — rsct_status must add zero network latency.
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

/**
 * Record a per-release decline. The tag MUST be the release currently being offered:
 * a decline that does not match is rejected rather than stored. That is the one part
 * of this flow that can be mechanical instead of agent-honoured, and it closes three
 * failure modes — a typo'd tag that silently never matches while the dev is told the
 * matter is closed, a decline for a release never offered, and pre-emptive silencing
 * of releases that do not exist yet.
 */
export function declineUpdateTag(tag: string, opts: UpdateOptions = {}): DeclineResult {
  try {
    const home = resolveHome(opts)
    const read = readCacheState(home)
    if (read.kind === 'unreadable') return { ok: false, reason: 'unreadable' }
    const data = read.kind === 'ok' ? read.data : {}

    // "Offered" is the full condition the hint is emitted under, not just "the cache
    // holds this string". Accepting a tag that is not NEWER than what is running
    // lets a decline swallow a real future release: decline v2.6.0 while a branch
    // reports 3.0.0, check main back out at 2.5.1, and v2.6.0 is silenced for good.
    const cached = typeof data.latest_tag === 'string' ? data.latest_tag : ''
    const offered = cached && isNewer(cached, RSCT_MCP_VERSION) ? normalizeTag(cached) : ''
    if (!offered) return { ok: false, reason: 'no_offer' }

    const wanted = normalizeTag(tag)
    if (!wanted || wanted !== offered) return { ok: false, reason: 'mismatch', tag: offered }

    const list = declinedList(data)
    if (list.includes(wanted)) return { ok: true, tag: wanted } // idempotent

    const next: UpdateCheckFile = { ...data, declined_tags: [...list, wanted] }
    return writeCacheAtomic(home, next)
      ? { ok: true, tag: wanted }
      : { ok: false, reason: 'write_failed' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

/**
 * The opt-out switch. Turning it OFF also spends the opt-out notice: a dev who just
 * used the switch does not need the next session to pitch them how to undo it.
 * Turning it ON restores that budget. Note this only writes the FILE — the
 * RSCT_UPDATE_CHECK environment variable outranks it, so callers must report that
 * (see `isUpdateCheckKilled`) rather than promise an effect the env is overriding.
 */
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

/** Whether the environment kill switch is set — callers report it, they do not guess. */
export function isUpdateCheckKilled(opts: UpdateOptions = {}): boolean {
  return killSwitchOn(opts.env ?? process.env)
}

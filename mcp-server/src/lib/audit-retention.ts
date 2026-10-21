import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { decideAuditPath } from './audit-log.js'
import { ensureParentDir } from './io-utils.js'
import type { RsctAuditConfig } from './project-root.js'

export const AUDIT_RETENTION_DAYS = 10
export const AUDIT_PRUNED_EVENT = 'audit.pruned'

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = AUDIT_RETENTION_DAYS * DAY_MS
const DUE_MS = RETENTION_MS + DAY_MS
const ANNOUNCE_MS = 2 * RETENTION_MS
const LOCK_STALE_MS = 60 * 1000
const CATCH_UP_ROUNDS = 5
const LOOK_BACKS = 5
const LOOK_BACK_WAIT_MS = 20
const MAX_LOG_BYTES = 512 * 1024 * 1024
const NEWLINE = 0x0a
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin'
const PLAN9_VOLUME = 0x01021997
const STRICT_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const PRUNED_MARK = Buffer.from(`"event":"${AUDIT_PRUNED_EVENT}"`, 'utf8')
const NO_HARD_LINK_CODES: ReadonlySet<string> = new Set(
  process.platform === 'win32'
    ? ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']
    : ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM'],
)

export const PINNED_EVENTS: ReadonlySet<string> = new Set([
  'classify.verdict',
  'review.unverified_decision',
  'review.dead_code_kept',
  'review.public_api_approved',
  'review.commit_drift',
  'approval.consumed',
  'plan_authorize.authorized',
  'plan_revoke.revoked',
  'tutor.step',
  'free_commit.committed',
  'free_commit.locked',
  'sanitize.stripped',
  'audit_log.migrated',
])

export const NEWEST_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'settings.baseline',
  'rsct_json.malformed',
  'rsct_json.bounds_violation',
  'install.drift_detected',
  'sanitize.malformed',
  'sanitize.migration_skipped',
  'settings.drift_detected',
  AUDIT_PRUNED_EVENT,
])

export const PINNED_NAME_PARTS: readonly string[] = ['override', 'skip', 'degraded', 'bypass']

export type RetentionClass = 'pinned' | 'newest_only' | 'dated'

export function retentionClassOf(event: string): RetentionClass {
  if (NEWEST_ONLY_EVENTS.has(event)) return 'newest_only'
  if (PINNED_EVENTS.has(event)) return 'pinned'
  return PINNED_NAME_PARTS.some((part) => event.includes(part)) ? 'pinned' : 'dated'
}

interface CutPlan {
  due: boolean
  survivors: Buffer
  tailStart: number
  dropped: number
  kept: number
  oldestDroppedMs: number
}

interface Slice {
  start: number
  end: number
  keep: boolean
  age: number
}

interface StampedLine {
  event: string
  at: number
  entry: Record<string, unknown>
}

function readStampedLine(line: Buffer): StampedLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString('utf8').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const entry = parsed as Record<string, unknown>
  const event = entry.event
  const stamp = entry.ts
  if (typeof event !== 'string' || typeof stamp !== 'string' || !STRICT_STAMP.test(stamp)) return null
  const at = Date.parse(stamp)
  return Number.isNaN(at) ? null : { event, at, entry }
}

function countsAsNewest(line: StampedLine): boolean {
  if (line.event !== 'settings.baseline') return true
  const hash = line.entry.hash
  return typeof hash === 'string' && hash.length > 0
}

export function planCut(source: Buffer, nowMs: number): CutPlan {
  const slices: Slice[] = []
  const newest = new Map<string, Slice>()
  let offset = 0
  while (offset < source.length) {
    const newline = source.indexOf(NEWLINE, offset)
    if (newline < 0) break
    const end = newline + 1
    const line = readStampedLine(source.subarray(offset, newline))
    if (line === null) {
      slices.push({ start: offset, end, keep: true, age: 0 })
      offset = end
      continue
    }
    const age = nowMs - line.at
    if (age <= RETENTION_MS) break
    const kind = retentionClassOf(line.event)
    const slice: Slice = { start: offset, end, keep: kind === 'pinned', age }
    if (kind === 'newest_only' && countsAsNewest(line)) {
      const superseded = newest.get(line.event)
      if (superseded !== undefined) superseded.keep = false
      slice.keep = true
      newest.set(line.event, slice)
    }
    slices.push(slice)
    offset = end
  }
  const kept = slices.filter((slice) => slice.keep)
  const oldestDroppedMs = slices.reduce((oldest, slice) => (slice.keep ? oldest : Math.max(oldest, slice.age)), 0)
  return {
    due: oldestDroppedMs > DUE_MS,
    survivors: Buffer.concat(kept.map((slice) => source.subarray(slice.start, slice.end))),
    tailStart: offset,
    dropped: slices.length - kept.length,
    kept: kept.length,
    oldestDroppedMs,
  }
}

export type RetentionSkip =
  | 'anchor_unavailable'
  | 'working_path'
  | 'stream_path'
  | 'not_regular'
  | 'too_large'
  | 'busy'
  | 'unsupported'
  | 'not_atomic'
  | 'failed'

export type RetentionOutcome =
  | {
      status: 'pruned'
      path: string
      dropped: number
      kept: number
      cutoff: string
      bytes_before: number
      bytes_after: number
    }
  | { status: 'idle'; path: string; reason: 'absent' | 'not_due' | 'volume_refused' }
  | { status: 'skipped'; path: string; reason: RetentionSkip; detail: string | null }
  | { status: 'recovered'; path: string }

type RetentionStep = 'lock' | 'catch_up' | 'ready' | 'swapped' | 'rescued'

export interface RetentionSeams {
  onStep?: (step: RetentionStep, paths: { log: string; old: string; temp: string }) => void
  link?: (existing: string, created: string) => void
  rename?: (from: string, to: string) => void
  wait?: (ms: number) => void
  volumeType?: (path: string) => number
  maxBytes?: number
}

interface WorkingPaths {
  dir: string
  lock: string
  temp: string
  old: string
}

interface LockRecord {
  log: string
  cut: string
}

interface CutMarker {
  dropped_total: number
  first_cut_at: string | null
  source_bytes: number | null
  cut: string | null
}

type LinkSupport =
  | { linked: true }
  | { linked: false; reason: 'unsupported' | 'not_atomic'; code: string; reported: boolean }

const linkSupport = new Map<string, LinkSupport>()
const sleeper = new Int32Array(new SharedArrayBuffer(4))

export function clearRetentionMemo(): void {
  linkSupport.clear()
}

function workingPaths(base: string): WorkingPaths {
  const dir = join(base, '.rsct', 'reports')
  return {
    dir,
    lock: join(dir, 'audit-prune.lock'),
    temp: join(dir, 'audit-prune-new.log'),
    old: join(dir, 'audit-prune-old.log'),
  }
}

function skipped(path: string, reason: RetentionSkip, detail: string | null = null): RetentionOutcome {
  return { status: 'skipped', path, reason, detail }
}

function codeOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    return
  }
}

function removeEmptyDir(path: string): void {
  try {
    rmdirSync(path)
  } catch {
    return
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a, { bigint: true })
    const right = statSync(b, { bigint: true })
    return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

function sameSpelling(a: string, b: string): boolean {
  return a === b || (CASE_BLIND && a.toLowerCase() === b.toLowerCase())
}

function readRange(path: string, from: number, to: number): Buffer {
  const length = Math.max(0, to - from)
  const buffer = Buffer.alloc(length)
  if (length === 0) return buffer
  const fd = openSync(path, 'r')
  try {
    let done = 0
    while (done < length) {
      const got = readSync(fd, buffer, done, length - done, from + done)
      if (got === 0) break
      done += got
    }
    return buffer.subarray(0, done)
  } finally {
    closeSync(fd)
  }
}

function wholeLines(chunk: Buffer): Buffer {
  return chunk.subarray(0, chunk.lastIndexOf(NEWLINE) + 1)
}

function sizeOf(path: string): number {
  return statSync(path).size
}

function writeAll(fd: number, bytes: Buffer): void {
  let done = 0
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done)
}

function lastMarker(source: Buffer): CutMarker {
  const none: CutMarker = { dropped_total: 0, first_cut_at: null, source_bytes: null, cut: null }
  const mark = source.lastIndexOf(PRUNED_MARK)
  if (mark < 0) return none
  const start = source.lastIndexOf(NEWLINE, mark) + 1
  const newline = source.indexOf(NEWLINE, mark)
  const line = readStampedLine(source.subarray(start, newline < 0 ? source.length : newline))
  if (line === null || line.event !== AUDIT_PRUNED_EVENT) return none
  const total = line.entry.dropped_total
  const first = line.entry.first_cut_at
  const bytes = line.entry.source_bytes
  const cut = line.entry.cut
  return {
    dropped_total: typeof total === 'number' && Number.isFinite(total) ? total : 0,
    first_cut_at: typeof first === 'string' ? first : null,
    source_bytes: typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0 ? bytes : null,
    cut: typeof cut === 'string' ? cut : null,
  }
}

function rescueFrom(old: string, log: string, from: number, wait: (ms: number) => void): void {
  let offset = from
  let unterminated: Buffer = Buffer.alloc(0)
  for (let look = 0; look < LOOK_BACKS; look++) {
    if (look > 0) wait(LOOK_BACK_WAIT_MS)
    const chunk = readRange(old, offset, sizeOf(old))
    const arrived = wholeLines(chunk)
    unterminated = chunk.subarray(arrived.length)
    if (arrived.length > 0) {
      appendFileSync(log, arrived)
      offset += arrived.length
    } else if (look > 0) {
      break
    }
  }
  if (unterminated.length > 0) appendFileSync(log, Buffer.concat([unterminated, Buffer.from('\n', 'utf8')]))
}

function lockAge(paths: WorkingPaths): number | null {
  try {
    return Date.now() - statSync(paths.lock).mtimeMs
  } catch {
    return null
  }
}

function pendingSwap(paths: WorkingPaths): 'none' | 'fresh' | 'stale' {
  const age = lockAge(paths)
  if (age !== null) return Math.abs(age) < LOCK_STALE_MS ? 'fresh' : 'stale'
  if (!existsSync(paths.old) && !existsSync(paths.temp)) return 'none'
  return lockAge(paths) === null ? 'stale' : 'fresh'
}

function readLock(paths: WorkingPaths): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.lock, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    return typeof record.log === 'string' && typeof record.cut === 'string'
      ? { log: record.log, cut: record.cut }
      : null
  } catch {
    return null
  }
}

function takeLock(paths: WorkingPaths, log: string, cut: string, seams: RetentionSeams): boolean {
  ensureParentDir(paths.lock)
  seams.onStep?.('lock', { log, old: paths.old, temp: paths.temp })
  try {
    writeFileSync(paths.lock, JSON.stringify({ log, cut }), { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    const code = codeOf(error)
    if (code === 'EEXIST' || code === 'ENOENT') return false
    throw error
  }
}

function renewLock(paths: WorkingPaths, cut: string): boolean {
  if (readLock(paths)?.cut !== cut) return false
  const beat = new Date()
  utimesSync(paths.lock, beat, beat)
  return true
}

function soleIdentity(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true })
    return info.nlink === 1n && info.ino !== 0n ? `${info.dev}:${info.ino}` : null
  } catch {
    return null
  }
}

function soleNameOfALog(path: string, candidates: string[]): boolean {
  const held = soleIdentity(path)
  if (held === null) return false
  return candidates.some((log) => soleIdentity(log) === held) && soleIdentity(path) === held
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

function finishInterruptedSwap(paths: WorkingPaths, candidates: string[], wait: (ms: number) => void): void {
  const lock = readLock(paths)
  if (existsSync(paths.old)) {
    const owner = lock === null ? null : (candidates.find((candidate) => sameSpelling(candidate, lock.log)) ?? null)
    if (lock !== null && owner !== null && !sameFile(owner, paths.old)) {
      const marker = lastMarker(readFileSync(owner))
      if (marker.cut === lock.cut && marker.source_bytes !== null) {
        rescueFrom(paths.old, owner, marker.source_bytes, wait)
      }
    }
    unlinkSync(paths.old)
  }
  removeQuietly(paths.temp)
  removeQuietly(paths.lock)
  removeEmptyDir(paths.dir)
}

function inspect(log: string, maxBytes: number): { mode: number } | RetentionOutcome {
  const info = lstatSync(log, { throwIfNoEntry: false })
  if (info === undefined) return { status: 'idle', path: log, reason: 'absent' }
  if (!info.isFile()) return skipped(log, 'not_regular')
  if (info.size > maxBytes) return skipped(log, 'too_large')
  return { mode: info.mode & 0o777 }
}

function refuseSharedVolume(log: string, seams: RetentionSeams): void {
  if (process.platform !== 'linux' || linkSupport.get(log) !== undefined) return
  try {
    const type = (seams.volumeType ?? ((path: string) => statfsSync(path).type))(log)
    if (type === PLAN9_VOLUME) linkSupport.set(log, { linked: false, reason: 'not_atomic', code: '9p', reported: false })
  } catch {
    return
  }
}

function knownUnsupported(log: string): RetentionOutcome | null {
  const known = linkSupport.get(log)
  if (known === undefined || known.linked) return null
  if (known.reported) return { status: 'idle', path: log, reason: 'volume_refused' }
  known.reported = true
  return skipped(log, known.reason, known.code)
}

function tryLink(log: string, paths: WorkingPaths, seams: RetentionSeams, reported: boolean): string | null {
  try {
    ;(seams.link ?? linkSync)(log, paths.old)
    linkSupport.set(log, { linked: true })
    return null
  } catch (error) {
    const code = codeOf(error)
    if (code === null || !NO_HARD_LINK_CODES.has(code)) throw error
    linkSupport.set(log, { linked: false, reason: 'unsupported', code, reported })
    return code
  }
}

function probeLink(log: string, paths: WorkingPaths, seams: RetentionSeams): void {
  const cut = randomUUID()
  if (!takeLock(paths, log, cut, seams)) return
  let linked = false
  try {
    linked = tryLink(log, paths, seams, false) === null
  } finally {
    if (readLock(paths)?.cut === cut) {
      if (linked) removeQuietly(paths.old)
      removeQuietly(paths.lock)
      removeEmptyDir(paths.dir)
    }
  }
}

function cutOne(
  log: string,
  paths: WorkingPaths,
  candidates: string[],
  nowMs: number,
  seams: RetentionSeams,
): RetentionOutcome {
  const wait = seams.wait ?? ((ms: number) => void Atomics.wait(sleeper, 0, 0, ms))
  refuseSharedVolume(log, seams)
  const unsupported = knownUnsupported(log)
  if (unsupported !== null) return unsupported
  const state = inspect(log, seams.maxBytes ?? MAX_LOG_BYTES)
  if ('status' in state) return state

  const pending = pendingSwap(paths)
  if (pending !== 'none' && [paths.lock, paths.temp, paths.old].some((path) => soleNameOfALog(path, candidates))) {
    return skipped(log, 'working_path')
  }
  if (pending === 'fresh') return skipped(log, 'busy')
  if (pending === 'stale') {
    finishInterruptedSwap(paths, candidates, wait)
    return { status: 'recovered', path: log }
  }

  if (!planCut(readFileSync(log), nowMs).due) return { status: 'idle', path: log, reason: 'not_due' }

  const cut = randomUUID()
  if (!takeLock(paths, log, cut, seams)) return skipped(log, 'busy')

  let linked = false
  let tempCreated = false
  let swapped = false
  let rescued = false
  let finished = false
  try {
    const refused = tryLink(log, paths, seams, true)
    if (refused !== null) return skipped(log, 'unsupported', refused)
    linked = true

    const source = readFileSync(log)
    const plan = planCut(source, nowMs)
    if (!plan.due) return { status: 'idle', path: log, reason: 'not_due' }

    const fd = openSync(paths.temp, 'wx', state.mode)
    tempCreated = true
    let copied = wholeLines(source).length
    let written = 0
    try {
      if (process.platform !== 'win32') fchmodSync(fd, state.mode)
      const body = source.subarray(plan.tailStart, copied)
      writeAll(fd, plan.survivors)
      writeAll(fd, body)
      written = plan.survivors.length + body.length
      for (let round = 0; ; round++) {
        seams.onStep?.('catch_up', { log, old: paths.old, temp: paths.temp })
        const arrived = wholeLines(readRange(log, copied, sizeOf(log)))
        if (arrived.length === 0) break
        if (round === CATCH_UP_ROUNDS) return skipped(log, 'busy')
        writeAll(fd, arrived)
        written += arrived.length
        copied += arrived.length
      }
      const before = lastMarker(source)
      const stamp = new Date(nowMs).toISOString()
      const marker = Buffer.from(
        `${JSON.stringify({
          event: AUDIT_PRUNED_EVENT,
          dropped: plan.dropped,
          kept: plan.kept,
          cutoff: new Date(nowMs - RETENTION_MS).toISOString(),
          source_bytes: copied,
          dropped_total: before.dropped_total + plan.dropped,
          first_cut_at: before.first_cut_at ?? stamp,
          cut,
          ts: stamp,
        })}\n`,
        'utf8',
      )
      writeAll(fd, marker)
      written += marker.length
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    seams.onStep?.('ready', { log, old: paths.old, temp: paths.temp })
    if (!renewLock(paths, cut)) return skipped(log, 'busy')
    ;(seams.rename ?? renameSync)(paths.temp, log)
    swapped = true
    seams.onStep?.('swapped', { log, old: paths.old, temp: paths.temp })
    rescueFrom(paths.old, log, copied, wait)
    rescued = true
    seams.onStep?.('rescued', { log, old: paths.old, temp: paths.temp })
    unlinkSync(paths.old)
    finished = true
    return {
      status: 'pruned',
      path: log,
      dropped: plan.dropped,
      kept: plan.kept,
      cutoff: new Date(nowMs - RETENTION_MS).toISOString(),
      bytes_before: source.length,
      bytes_after: written,
    }
  } finally {
    if (readLock(paths)?.cut === cut) {
      if (!swapped) {
        if (tempCreated) removeQuietly(paths.temp)
        if (linked) removeQuietly(paths.old)
      }
      if (!swapped || rescued) removeQuietly(paths.lock)
      if (!swapped || finished) removeEmptyDir(paths.dir)
    }
  }
}

function candidatesFor(
  projectRoot: string,
  config: RsctAuditConfig | undefined,
): { logs: string[]; named: string[]; paths: WorkingPaths; refusal: RetentionSkip | null } {
  const configured = decideAuditPath(projectRoot, config)
  const fallback = decideAuditPath(projectRoot, undefined)
  const named = [configured.path, fallback.path]
  const oneLog =
    sameSpelling(configured.path, fallback.path) || soleNameOfALog(configured.path, [fallback.path])
  const logs = oneLog ? [isRegularFile(fallback.path) ? fallback.path : configured.path] : named
  const paths = workingPaths(configured.base)
  const working = [paths.lock, paths.temp, paths.old]
  const refusal =
    configured.anchor === 'unavailable'
      ? 'anchor_unavailable'
      : configured.unusable?.reason === 'stream'
        ? 'stream_path'
        : named.some((log) => working.some((path) => sameSpelling(log, path)))
          ? 'working_path'
          : null
  return { logs, named, paths, refusal }
}

export function pruneAuditLog(
  projectRoot: string,
  config: RsctAuditConfig | undefined,
  now: Date,
  seams: RetentionSeams = {},
): RetentionOutcome[] {
  const { logs, named, paths, refusal } = candidatesFor(projectRoot, config)
  if (refusal !== null) return logs.map((log) => skipped(log, refusal))
  const outcomes: RetentionOutcome[] = []
  for (const log of logs) {
    let outcome: RetentionOutcome
    try {
      outcome = cutOne(log, paths, named, now.getTime(), seams)
    } catch (error) {
      outcome = skipped(log, 'failed', error instanceof Error ? error.message : String(error))
    }
    outcomes.push(outcome)
    if (outcome.status === 'recovered') break
  }
  return outcomes
}

export function previewRetention(
  projectRoot: string,
  config: RsctAuditConfig | undefined,
  now: Date,
  seams: RetentionSeams = {},
): number {
  try {
    const { logs, paths, refusal } = candidatesFor(projectRoot, config)
    if (refusal !== null || pendingSwap(paths) !== 'none') return 0
    return logs.reduce((due, log) => due + forecastFor(log, paths, now.getTime(), seams), 0)
  } catch {
    return 0
  }
}

function forecastFor(log: string, paths: WorkingPaths, nowMs: number, seams: RetentionSeams): number {
  try {
    refuseSharedVolume(log, seams)
    if (linkSupport.get(log)?.linked === false) return 0
    const state = inspect(log, seams.maxBytes ?? MAX_LOG_BYTES)
    if ('status' in state) return 0
    const plan = planCut(readFileSync(log), nowMs)
    if (plan.oldestDroppedMs <= ANNOUNCE_MS) return 0
    if (linkSupport.get(log) === undefined) probeLink(log, paths, seams)
    return linkSupport.get(log)?.linked === true ? plan.dropped : 0
  } catch {
    return 0
  }
}

function countOf(lines: number): string {
  return lines === 1 ? '1 line' : `${lines} lines`
}

export function retentionDialogLine(due: number): string | null {
  if (due <= 0) return null
  return `Audit log: ${countOf(due)} older than ${AUDIT_RETENTION_DAYS} days ${due === 1 ? 'is' : 'are'} due for removal with this commit.`
}

function noteFor(outcome: RetentionOutcome): string | null {
  if (outcome.status === 'recovered') {
    return 'an audit-log cut that an earlier call left interrupted was finished or undone; a later commit cuts.'
  }
  if (outcome.status !== 'skipped') return null
  const detail = String(outcome.detail)
  switch (outcome.reason) {
    case 'unsupported':
      return `the audit log is not cut on this volume — it cannot hard-link (${detail}) — and keeps growing.`
    case 'not_atomic':
      return `the audit log is not cut on this volume — replacing a file is not atomic on a ${detail} share, such as a Windows disk seen from WSL — and keeps growing.`
    case 'too_large':
      return `the audit log is larger than ${MAX_LOG_BYTES / (1024 * 1024)} MB and is not cut; what to do with it is the developer's decision, not the agent's.`
    case 'not_regular':
      return 'the audit log path is not a regular file and is not cut.'
    case 'working_path':
      return "audit.path names one of the cut's own working files, so no audit log is cut."
    case 'stream_path':
      return 'audit.path names a stream inside a file, so no audit log is cut.'
    case 'anchor_unavailable':
      return 'git could not report the repository, so the audit log is not cut in this session.'
    case 'failed':
      return `the cut did not complete (${detail}); a later commit finishes or retries it.`
    case 'busy':
      return null
  }
}

export function describeRetention(outcomes: RetentionOutcome[]): string | null {
  const notes: string[] = []
  const dropped = outcomes.reduce((sum, outcome) => sum + (outcome.status === 'pruned' ? outcome.dropped : 0), 0)
  if (dropped > 0) {
    notes.push(
      `${countOf(dropped)} older than ${AUDIT_RETENTION_DAYS} days ${dropped === 1 ? 'was' : 'were'} removed from the audit log. Kept whatever their age: the entries a gate can still use, the entries named as an override, skip, degraded check or bypass, and the newest of each repeating state record. An audit.pruned entry records the cut.`,
    )
  }
  for (const outcome of outcomes) {
    const note = noteFor(outcome)
    if (note !== null && !notes.includes(note)) notes.push(note)
  }
  return notes.length === 0 ? null : `Audit log retention (ADR-025): ${notes.join(' Also: ')}`
}

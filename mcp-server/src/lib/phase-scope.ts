import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { ensureParentDir } from './io-utils.js'

const SESSION_ID = randomUUID()

const LOCK_RELATIVE_PATH = '.rsct/phase-state.lock'

const LOCK_STALE_MS = 30000

interface LockContent {
  session_id: string
  locked_at: string
}

function phaseStateLockPath(projectRoot: string): string {
  return join(projectRoot, LOCK_RELATIVE_PATH)
}

type AcquireResult =
  | { ok: true }
  | {
      ok: false
      reason: 'locked'
      lock_age_ms: number
      held_by_session: string | null
    }
  | { ok: false; reason: 'error'; error: string }

function tryAcquireLock(lockPath: string, now: Date): AcquireResult {
  const content: LockContent = {
    session_id: SESSION_ID,
    locked_at: now.toISOString(),
  }
  const json = JSON.stringify(content)

  try {
    ensureParentDir(lockPath)
    writeFileSync(lockPath, json, { encoding: 'utf8', flag: 'wx' })
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'EEXIST') {
      return {
        ok: false,
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  let existing: LockContent | null = null
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      existing = parsed as LockContent
    }
  } catch {
  }

  const lockedAtMs = existing?.locked_at
    ? new Date(existing.locked_at).getTime()
    : 0
  const ageMs = Math.max(0, now.getTime() - lockedAtMs)

  if (ageMs >= LOCK_STALE_MS || Number.isNaN(lockedAtMs)) {
    try {
      writeFileSync(lockPath, json, { encoding: 'utf8', flag: 'w' })
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return {
    ok: false,
    reason: 'locked',
    lock_age_ms: ageMs,
    held_by_session: existing?.session_id ?? null,
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
  }
}

export interface PhaseVerificationBlock {
  spec_ref?: string
  spec_tier?: string
  persona?: string
  declared_paths?: string[]
  discovered_importers?: unknown[]
  findings?: unknown[]
  findings_run_id?: string
  head_sha?: string
  observed_at?: string
  started_at?: string
  completed_at?: string
}

export interface LastClassifyBlock {
  tier: string
  tier_max: string
  classified_at: string
  signals_summary?: string
}

export interface PlanAuthorizationBlock {
  plan_slug: string
  branch: string
  covers: string[]
  authorized_at: string
  expires_at: string
  max_actions: number
  actions_used: number
  approval_ref: { action_scope: string; timestamp: string }
  session_id?: string
  absolute_expires_at?: string
  slide_minutes?: number
}

export interface FreeCommitBudget {
  plan_slug: string
  files_touched_paths: string[]
  commits_used: number
  lines_changed: number
  locked: boolean
  locked_reason?: 'commit_cap' | 'volume_cap' | 'tier_divergence'
}

export interface PhaseReviewBlock {
  spec_ref: string
  completed_at?: string
}

export type SweepVerdict = 'clean' | 'unverified_authorized'

export interface SweepLedgerEntry {
  blob: string
  verdict: SweepVerdict
  migrations: Array<{ destination: string; body: string }>
  channel: string
  spec_ref: string
  at: string
}

export type SweepLedger = Record<string, SweepLedgerEntry[]>

export interface DeadCodeKeepRecord {
  path: string
  name: string
  declaration_sha256: string
  note: string
  spec_ref: string
  at: string
}

export interface ReviewDriftBlock {
  sha: string
  paths: string[]
  at: string
}

export interface PhaseFindingsBlock {
  spec_ref: string
  run_id: string
  findings: unknown[]
  declared_at: string
  head_sha?: string
  observed_at?: string
}

export interface PlanDispositionBlock {
  plan_slug: string
  decision: 'keep' | 'delete'
  decided_at: string
}

export interface ContextStaleBlock {
  since: string
  reason: 'plan_closed' | 'pivot'
}

export interface PhaseState {
  spec_slug?: string
  phase?: string
  scope_globs?: string[]
  started_at?: string
  verification?: PhaseVerificationBlock
  review?: PhaseReviewBlock
  review_findings?: PhaseFindingsBlock
  review_sweep?: SweepLedger
  review_drift?: ReviewDriftBlock
  dead_code_keeps?: DeadCodeKeepRecord[]
  last_classify?: LastClassifyBlock
  plan_authorization?: PlanAuthorizationBlock
  free_commit_budget?: FreeCommitBudget
  disposition?: PlanDispositionBlock
  context_stale?: ContextStaleBlock
  bootstrap_at?: string
}

export function headStaleness(
  stampedSha: string | undefined,
  currentSha: string | null,
): { head_stale: boolean | null; head_sha_at_start: string | null; head_sha_now: string | null } {
  const at_start = stampedSha ?? null
  return {
    head_stale: at_start === null || currentSha === null ? null : at_start !== currentSha,
    head_sha_at_start: at_start,
    head_sha_now: currentSha,
  }
}

export const PHASE_STATE_PRESERVED_ON_ABANDON: readonly (keyof PhaseState)[] = [
  'bootstrap_at',
  'context_stale',
  'review_sweep',
  'review_drift',
  'last_classify',
  'dead_code_keeps',
]

function copyIfPresent<K extends keyof PhaseState>(
  from: PhaseState,
  to: PhaseState,
  key: K,
): void {
  const value = from[key]
  if (value !== undefined) to[key] = value
}

export function preserveAcrossAbandon(
  state: PhaseState | null | undefined,
): PhaseState {
  const next: PhaseState = {}
  if (!state) return next
  for (const key of PHASE_STATE_PRESERVED_ON_ABANDON) {
    copyIfPresent(state, next, key)
  }
  return next
}

const PHASE_STATE_RELATIVE = '.rsct/phase-state.json'

export function phaseStatePath(projectRoot: string): string {
  return join(projectRoot, PHASE_STATE_RELATIVE)
}

export interface PhaseStateReadResult {
  exists: boolean
  state: PhaseState | null
  parse_error?: string
}

export type WritePhaseStateResult =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: 'write_failed'; error: string }
  | { ok: false; path: string; reason: 'unreadable_state'; parse_error: string; error: string }
  | {
      ok: false
      path: string
      reason: 'locked'
      lock_age_ms: number
      held_by_session: string | null
    }

export function writePhaseState(
  projectRoot: string,
  state: PhaseState,
): WritePhaseStateResult {
  const path = phaseStatePath(projectRoot)
  const lockPath = phaseStateLockPath(projectRoot)
  const now = new Date()

  const acquired = tryAcquireLock(lockPath, now)
  if (!acquired.ok) {
    if (acquired.reason === 'locked') {
      return {
        ok: false,
        path,
        reason: 'locked',
        lock_age_ms: acquired.lock_age_ms,
        held_by_session: acquired.held_by_session,
      }
    }
    return {
      ok: false,
      path,
      reason: 'write_failed',
      error: `lock acquisition failed: ${acquired.error}`,
    }
  }

  try {
    ensureParentDir(path)
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return { ok: true, path }
  } catch (err) {
    return {
      ok: false,
      path,
      reason: 'write_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    releaseLock(lockPath)
  }
}

export function readPhaseState(projectRoot: string): PhaseStateReadResult {
  const path = phaseStatePath(projectRoot)
  if (!existsSync(path)) {
    return { exists: false, state: null }
  }
  try {
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
    if (raw.trim() === '') return { exists: true, state: null }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, state: null, parse_error: 'top-level value is not an object' }
    }
    return { exists: true, state: parsed as PhaseState }
  } catch (err) {
    return {
      exists: true,
      state: null,
      parse_error: err instanceof Error ? err.message : String(err),
    }
  }
}

const globRegexCache = new Map<string, RegExp>()

export function globToRegex(glob: string): RegExp {
  const cached = globRegexCache.get(glob)
  if (cached) return cached
  let out = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        const followedBySlash = glob[i + 2] === '/'
        if (atSegmentStart && followedBySlash && i + 3 < glob.length) {
          out += '(?:[^/]*/)*'
          i += 3
        } else {
          out += '.*'
          i += followedBySlash ? 3 : 2
        }
      } else {
        out += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      out += '[^/]'
      i++
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`
      i++
    } else {
      out += ch
      i++
    }
  }
  out += '$'
  const re = new RegExp(out)
  globRegexCache.set(glob, re)
  return re
}

export interface ScopeMatch {
  matched: boolean
  matched_glob?: string
}

const LINE_TERMINATORS = [0x0a, 0x0d, 0x2028, 0x2029].map((code) => String.fromCharCode(code))

export function pathCarriesLineTerminator(path: string): boolean {
  return LINE_TERMINATORS.some((terminator) => path.includes(terminator))
}

export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function normForMatch(p: string): string {
  let s = toPosix(p)
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (/^[A-Za-z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  return s
}

export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
  projectRoot?: string,
): ScopeMatch {
  const candidates: string[] = [toPosix(path)]

  if (projectRoot !== undefined && projectRoot.length > 0) {
    const nf = normForMatch(path)
    const nr = normForMatch(projectRoot)
    if (nf === nr) {
      candidates.push('')
    } else if (nf.startsWith(`${nr}/`)) {
      candidates.push(nf.slice(nr.length + 1))
    }
  }

  for (const glob of globs) {
    const re = globToRegex(glob.replace(/\\/g, '/'))
    for (const candidate of candidates) {
      if (re.test(candidate)) return { matched: true, matched_glob: glob }
    }
  }
  return { matched: false }
}

const TIER_RANK: Record<string, number> = {
  trivial: 0,
  small: 1,
  standard: 2,
  complex: 3,
}

export function tierRank(tier: string | undefined | null): number {
  if (!tier) return 0
  return TIER_RANK[tier] ?? 0
}

export function refuseUnreadableState(
  projectRoot: string,
  read: PhaseStateReadResult,
): WritePhaseStateResult | null {
  if (read.parse_error === undefined) return null
  const path = phaseStatePath(projectRoot)
  return {
    ok: false,
    path,
    reason: 'unreadable_state',
    parse_error: read.parse_error,
    error: `${path} could not be read (${read.parse_error}) — nothing was overwritten. Repair or delete that file; deleting it is a safe recovery.`,
  }
}

export const BOOTSTRAP_STALE_MS = 4 * 60 * 60 * 1000

export function stampBootstrapMarker(
  projectRoot: string,
  opts: { now?: Date; clearStale?: boolean } = {},
): WritePhaseStateResult {
  const now = opts.now ?? new Date()
  const existing = readPhaseState(projectRoot)
  const baseState: PhaseState = existing.state ?? {}
  const newState: PhaseState = {
    ...baseState,
    bootstrap_at: now.toISOString(),
  }
  if (opts.clearStale) delete newState.context_stale
  return writePhaseState(projectRoot, newState)
}

export function stampContextStale(
  projectRoot: string,
  reason: ContextStaleBlock['reason'],
  now: Date = new Date(),
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, existing)
  if (refusal) return refusal
  const baseState: PhaseState = existing.state ?? {}
  return writePhaseState(projectRoot, {
    ...baseState,
    context_stale: { since: now.toISOString(), reason },
  })
}

export function readContextStale(
  state: PhaseState | null | undefined,
): ContextStaleBlock | null {
  return state?.context_stale ?? null
}

export type BootstrapStatus = 'fresh' | 'stale' | 'missing'

export interface BootstrapMarker {
  status: BootstrapStatus
  bootstrap_at: string | null
  age_ms: number | null
  hint: string | null
}

export function evaluateBootstrapMarker(args: {
  projectRoot: string
  now?: Date
}): BootstrapMarker {
  const now = (args.now ?? new Date()).getTime()
  const stateRead = readPhaseState(args.projectRoot)
  const stamped = stateRead.state?.bootstrap_at
  if (!stamped) {
    return {
      status: 'missing',
      bootstrap_at: null,
      age_ms: null,
      hint: `⚠ bootstrap not detected (no rsct_status / rsct_load_context call recorded in this project's phase-state). Run rsct_status and rsct_load_context first — they establish the session baseline RSCT needs.`,
    }
  }
  const stampedMs = new Date(stamped).getTime()
  if (Number.isNaN(stampedMs)) {
    return {
      status: 'missing',
      bootstrap_at: stamped,
      age_ms: null,
      hint: `⚠ bootstrap_at value '${stamped}' is unparseable. Re-run rsct_status to restamp.`,
    }
  }
  const age = Math.max(0, now - stampedMs)
  if (age > BOOTSTRAP_STALE_MS) {
    return {
      status: 'stale',
      bootstrap_at: stamped,
      age_ms: age,
      hint: `⚠ bootstrap_at is ${Math.round(age / 60000)} min old (stale window=${Math.round(BOOTSTRAP_STALE_MS / 60000)} min). Recommend re-running rsct_status + rsct_load_context to refresh session context.`,
    }
  }
  return {
    status: 'fresh',
    bootstrap_at: stamped,
    age_ms: age,
    hint: null,
  }
}

export interface BootstrapRefresh {
  marker: BootstrapMarker
  read: PhaseStateReadResult
  write: WritePhaseStateResult | null
}

export function readThenStampBootstrap(
  projectRoot: string,
  opts: { now?: Date; clearStale?: boolean } = {},
): BootstrapRefresh {
  const read = readPhaseState(projectRoot)
  const marker = evaluateBootstrapMarker({
    projectRoot,
    ...(opts.now !== undefined && { now: opts.now }),
  })
  if (read.parse_error !== undefined) {
    return { marker, read, write: null }
  }
  return { marker, read, write: stampBootstrapMarker(projectRoot, opts) }
}

export function truncateForHint(value: unknown, max = 80): string {
  const s = typeof value === 'string' ? value : String(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function bootstrapWriteFailureHint(
  write: WritePhaseStateResult,
  toolName: string,
  markerFresh: boolean,
): string | null {
  if (write.ok) return null
  if (write.reason === 'locked') {
    return `ℹ Another session holds .rsct/phase-state.lock (acquired ${write.lock_age_ms}ms ago) — the §0 marker for this call was not recorded. Harmless when two sessions share one worktree; the next ${toolName} records it.`
  }
  const consequence = markerFresh
    ? 'The marker already on record still stands and will go stale at the usual window.'
    : `Until a write succeeds, rsct_phase_code_start and the rsct_request_* gates keep reporting bootstrap as missing or stale.`
  return `⚠ The §0 bootstrap marker could not be written to .rsct/phase-state.json: ${truncateForHint(write.error)}. ${consequence}`
}

export function stampClassifyVerdict(
  projectRoot: string,
  args: {
    tier: string
    signalsSummary?: string
    now?: Date
  },
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, existing)
  if (refusal) return refusal
  const baseState: PhaseState = existing.state ?? {}
  const prevMaxRank = tierRank(baseState.last_classify?.tier_max)
  const currentRank = tierRank(args.tier)
  const tier_max =
    currentRank > prevMaxRank
      ? args.tier
      : (baseState.last_classify?.tier_max ?? args.tier)
  const now = (args.now ?? new Date()).toISOString()
  const block: LastClassifyBlock = {
    tier: args.tier,
    tier_max,
    classified_at: now,
  }
  if (args.signalsSummary !== undefined) {
    block.signals_summary = args.signalsSummary
  }
  const newState: PhaseState = {
    ...baseState,
    last_classify: block,
  }
  return writePhaseState(projectRoot, newState)
}

export function stampReviewCompleted(
  projectRoot: string,
  patch: { spec_ref: string; completed_at: string },
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, existing)
  if (refusal) return refusal
  const baseState: PhaseState = existing.state ?? {}
  return writePhaseState(projectRoot, {
    ...baseState,
    review: { spec_ref: patch.spec_ref, completed_at: patch.completed_at },
  })
}

export function stampPlanDisposition(
  projectRoot: string,
  patch: { plan_slug: string; decision: 'keep' | 'delete'; decided_at: string },
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, existing)
  if (refusal) return refusal
  const baseState: PhaseState = existing.state ?? {}
  const merged: PlanDispositionBlock = {
    plan_slug: patch.plan_slug,
    decision: patch.decision,
    decided_at: patch.decided_at,
  }
  return writePhaseState(projectRoot, { ...baseState, disposition: merged })
}

export function readPlanDisposition(
  state: PhaseState | null | undefined,
  slug: string,
): PlanDispositionBlock | null {
  const d = state?.disposition
  return d && d.plan_slug === slug ? d : null
}

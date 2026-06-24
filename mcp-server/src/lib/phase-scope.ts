import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { ensureParentDir } from './io-utils.js'

/**
 * Per-process session ID used as the writer identity in the file lock.
 * Generated once at module load; survives across all writePhaseState calls
 * from the same Node process so a stale lock can be attributed back to a
 * dead session in diagnostics.
 */
const SESSION_ID = randomUUID()

const LOCK_RELATIVE_PATH = '.rsct/phase-state.lock'

/**
 * Maximum age before a lock is considered stale and may be overwritten.
 * 30s covers the worst-case slow tool invocation while bounding the
 * window during which a crashed writer blocks future writers.
 */
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
    // Corrupt lock — treat as stale and overwrite.
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
    // Lock already gone — fine. Either another writer cleaned up after
    // detecting our stale lock, or the disk was unmounted between write
    // and unlink. Either way, nothing to do here.
  }
}

/**
 * `.rsct/phase-state.json` — written by the M3 phase machine. The first
 * writer to land is the V phase (rsct_phase_verification_start). The
 * schema is intentionally forgiving so subsequent phase tools (R/S/C/T
 * pairs) can extend it without breaking earlier callers.
 *
 * `verification` is an optional sub-block populated while the V phase is
 * active and cleared by `rsct_phase_verification_complete`. The reader
 * treats inner arrays as opaque (`unknown[]`) so the V-phase tool layer
 * owns the precise shape via `verification-checklist` and
 * `reverse-dep-walk` types.
 */
export interface PhaseVerificationBlock {
  spec_ref?: string
  spec_tier?: string
  persona?: string
  declared_paths?: string[]
  discovered_importers?: unknown[]
  findings?: unknown[]
  started_at?: string
  completed_at?: string
}

/**
 * CAP-30: persisted classify_task verdict, used by phase-code-start
 * to enforce mechanical link between classifier tier and the gate.
 * `tier_max` is the highest tier ever recorded for this project's
 * state — a later classify_task call CANNOT lower it (defends against
 * downgrade attacks where the agent re-runs classify with a weaker
 * description to bypass the V gate).
 */
export interface LastClassifyBlock {
  tier: string
  tier_max: string
  classified_at: string
  signals_summary?: string
}

/**
 * T3: plan-scoped batch authorization token. When present + valid,
 * `rsct_request_commit` authorizes a commit WITHOUT a fresh per-action
 * dev_approval — one approval (minted by `rsct_plan_authorize` under the full
 * §C gate) covers up to `max_actions` commits within the plan+branch+time
 * window. Covers COMMIT only (push/merge keep per-action §C). Cleared by
 * `rsct_plan_revoke` / `rsct_phase_abandon`, and auto-revoked on branch
 * switch, plan completion/deletion, expiry, or exhaustion. The token never
 * bypasses INV-5 (branch protection) or INV-6 (secrets): the token path
 * carries no dev_approval, hence no overrides. See lib/plan-authorization.ts.
 */
export interface PlanAuthorizationBlock {
  plan_slug: string
  branch: string
  covers: string[]
  authorized_at: string
  expires_at: string
  max_actions: number
  actions_used: number
  approval_ref: { action_scope: string; timestamp: string }
  /** Diagnostic only — the session that minted the token. Not used for validation. */
  session_id?: string
}

export interface PhaseState {
  spec_slug?: string
  phase?: string
  scope_globs?: string[]
  started_at?: string
  verification?: PhaseVerificationBlock
  /** CAP-30: most-recent classify_task verdict (with tier_max ratchet). */
  last_classify?: LastClassifyBlock
  /** T3: active plan-scoped batch authorization token (see PlanAuthorizationBlock). */
  plan_authorization?: PlanAuthorizationBlock
  /**
   * CAP-31: timestamp of the most-recent rsct_status / rsct_load_context
   * call. Mutating tools (phase_code_start, request_*) surface a warning
   * if absent or older than the bootstrap stale window, encouraging
   * agents to run §0 bootstrap before deeper phase work.
   */
  bootstrap_at?: string
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
  | {
      ok: false
      path: string
      reason: 'locked'
      lock_age_ms: number
      held_by_session: string | null
    }

/**
 * Atomically-ish write the phase-state file, guarded by an advisory file
 * lock (`.rsct/phase-state.lock`). Creates `.rsct/` if missing. Never
 * throws — failures return `{ ok: false }` so the caller can surface the
 * error in its tool output (alongside an audit entry). Pretty-prints with
 * 2-space indent + trailing newline so diffs and audit-log scrubs are
 * predictable.
 *
 * Lock semantics (CAP-3 hardening, v0.4.0):
 *  - Acquire via exclusive-create (`flag: 'wx'`); on EEXIST, peek at the
 *    existing lock and overwrite if its `locked_at` is older than
 *    `LOCK_STALE_MS` (30s) — covers crashed-writer cases without an OS
 *    cleanup loop.
 *  - On busy (non-stale) lock, return `reason: 'locked'` with the age so
 *    the caller can surface a wait-and-retry hint instead of overwriting
 *    a peer session's in-flight write.
 *  - Lock is released in `finally` so a failed write still unlocks.
 */
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

/**
 * Read `.rsct/phase-state.json`. Returns `{ exists: false, state: null }` if
 * the file is absent. If present but unparseable, returns `{ exists: true,
 * state: null, parse_error }` so callers can surface the diagnostic.
 * Never throws.
 */
export function readPhaseState(projectRoot: string): PhaseStateReadResult {
  const path = phaseStatePath(projectRoot)
  if (!existsSync(path)) {
    return { exists: false, state: null }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
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

/**
 * Minimal glob-to-regex converter for scope-glob matching.
 *
 *  - `**` matches any number of path segments (including slashes)
 *  - `*`  matches any characters except `/`
 *  - `?`  matches exactly one character except `/`
 *  - everything else is matched literally
 *
 * Bracket expressions (`[abc]`) and brace alternation (`{a,b}`) are NOT
 * supported in v1 — most M3 scope lists are expected to be path-shaped
 * patterns that the three operators above cover. Future versions can
 * extend this without changing the {@link matchesAnyGlob} contract.
 */
export function globToRegex(glob: string): RegExp {
  let out = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 2
        if (glob[i] === '/') i++ // consume the slash after `**/`
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
  return new RegExp(out)
}

export interface ScopeMatch {
  matched: boolean
  matched_glob?: string
}

export function matchesAnyGlob(path: string, globs: readonly string[]): ScopeMatch {
  const normalized = path.replace(/\\/g, '/')
  for (const glob of globs) {
    const re = globToRegex(glob.replace(/\\/g, '/'))
    if (re.test(normalized)) return { matched: true, matched_glob: glob }
  }
  return { matched: false }
}

/**
 * Canonical tier ranking. trivial=0 < small=1 < standard=2 < complex=3.
 * Used by `tierRank` (CAP-30) to detect downgrades.
 */
const TIER_RANK: Record<string, number> = {
  trivial: 0,
  small: 1,
  standard: 2,
  complex: 3,
}

/**
 * Ordinal rank of a tier string. Unknown tiers fall back to 0 (most
 * permissive) so a malformed state never falsely rejects code_start.
 */
export function tierRank(tier: string | undefined | null): number {
  if (!tier) return 0
  return TIER_RANK[tier] ?? 0
}

/**
 * CAP-31: stale window for `bootstrap_at`. Past this threshold, mutating
 * tools surface a warning that §0 bootstrap should be re-run. 4 hours
 * matches a typical agent session; tunable in future via .rsct.json.
 */
export const BOOTSTRAP_STALE_MS = 4 * 60 * 60 * 1000

/**
 * CAP-31: stamp `bootstrap_at` on the current phase-state. Called by
 * `rsct_status` and `rsct_load_context` so downstream mutating tools
 * can detect when §0 was skipped or stale.
 *
 * Failures are swallowed — bootstrap stamping is best-effort metadata,
 * never the reason a status/load_context call fails. Callers may
 * inspect the returned `WritePhaseStateResult` for diagnostics.
 */
export function stampBootstrapMarker(
  projectRoot: string,
  now: Date = new Date(),
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
  const baseState: PhaseState = existing.state ?? {}
  const newState: PhaseState = {
    ...baseState,
    bootstrap_at: now.toISOString(),
  }
  return writePhaseState(projectRoot, newState)
}

/**
 * CAP-31 / CAP-33 bootstrap marker reader. Returns whether §0 was
 * performed and how recently. Soft signal — callers surface a hint
 * and audit entry but do NOT reject. Shared across `phase_code_start`
 * (CAP-31) and `request_commit/_push/_merge` (CAP-33).
 */
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

/**
 * CAP-30: persist the classify_task verdict with a tier-ratchet on
 * `tier_max`. Subsequent classify_task calls cannot lower `tier_max`
 * — only `tier` reflects the latest call. `phase_code_start` compares
 * against `tier_max`, blocking downgrades unless the dev passes
 * `override_classify_downgrade: true`.
 */
export function stampClassifyVerdict(
  projectRoot: string,
  args: {
    tier: string
    signalsSummary?: string
    now?: Date
  },
): WritePhaseStateResult {
  const existing = readPhaseState(projectRoot)
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

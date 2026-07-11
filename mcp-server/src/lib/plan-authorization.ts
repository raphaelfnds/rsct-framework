import type { ActivePlan } from './plan.js'
import { isPlanComplete } from './plan.js'
import type { PhaseState, PlanAuthorizationBlock } from './phase-scope.js'

/**
 * T3 — plan-scoped batch authorization token logic. Pure functions (never
 * throw, never touch the filesystem); the tool layer owns reads/writes via
 * the locked `writePhaseState`.
 *
 * The token is a DELIBERATE, BOUNDED exception to the per-action §C contract:
 * one strong dev_approval (minted via the full gate by `rsct_plan_authorize`)
 * lets `rsct_request_commit` authorize up to `max_actions` commits within a
 * plan+branch+time window WITHOUT a fresh approval each time. It NEVER bypasses
 * INV-5/INV-6 (the token path carries no overrides) and auto-revokes on branch
 * switch, plan completion/deletion, expiry, or exhaustion.
 */

/** Actions a plan token may cover. Commit only this delivery (decision #1). */
export const PLAN_TOKEN_COVERS = ['commit'] as const

export const PLAN_TOKEN_TTL_DEFAULT_MIN = 120
export const PLAN_TOKEN_TTL_MIN = 5
export const PLAN_TOKEN_TTL_MAX = 480
export const PLAN_TOKEN_MAX_ACTIONS_DEFAULT = 20
export const PLAN_TOKEN_MAX_ACTIONS_MIN = 1
export const PLAN_TOKEN_MAX_ACTIONS_MAX = 100

// plan-lifecycle-v2 (Bloco 1.4): sliding-window re-arm width + absolute cap.
export const PLAN_TOKEN_TTL_SLIDE_DEFAULT_MIN = 480
export const PLAN_TOKEN_TTL_SLIDE_MIN = 5
export const PLAN_TOKEN_TTL_SLIDE_MAX = 1440
export const PLAN_TOKEN_TTL_ABS_DEFAULT_MIN = 1440
export const PLAN_TOKEN_TTL_ABS_MIN = 5
export const PLAN_TOKEN_TTL_ABS_MAX = 10080

export type TokenInvalidReason =
  | 'absent'
  | 'not_covered'
  | 'expired'
  | 'branch_mismatch'
  | 'plan_gone'
  | 'plan_complete'
  | 'exhausted'

export interface EmitTokenArgs {
  planSlug: string
  branch: string
  ttlMinutes: number
  maxActions: number
  approvalRef: { action_scope: string; timestamp: string }
  now: Date
  sessionId?: string
  /**
   * plan-lifecycle-v2: sliding-window width (minutes). When provided, the
   * initial `expires_at` uses this window (instead of `ttlMinutes`) and the
   * token re-arms to it on each successful commit. Omit for pre-v2 fixed-TTL
   * semantics.
   */
  slideMinutes?: number
  /** plan-lifecycle-v2: absolute cap (minutes) the sliding window can never exceed. */
  absTtlMinutes?: number
}

/**
 * Build a fresh token block. Caller persists it via `writePhaseState`
 * (merged into the existing PhaseState). `actions_used` starts at 0.
 *
 * plan-lifecycle-v2: when `slideMinutes`/`absTtlMinutes` are supplied the
 * token carries a sliding window (re-armed by {@link rearmToken} on each
 * successful commit) bounded by an immutable absolute cap. The initial
 * `expires_at` is `min(now + slide, now + abs)`. Omitting them yields the
 * pre-v2 fixed-`ttlMinutes` window with no cap (backward-compatible).
 */
export function emitToken(args: EmitTokenArgs): PlanAuthorizationBlock {
  const nowMs = args.now.getTime()
  const windowMin = args.slideMinutes ?? args.ttlMinutes
  let expiresMs = nowMs + windowMin * 60_000
  let absMs: number | null = null
  if (args.absTtlMinutes !== undefined) {
    absMs = nowMs + args.absTtlMinutes * 60_000
    if (expiresMs > absMs) expiresMs = absMs // clamp the initial window to the cap
  }
  const block: PlanAuthorizationBlock = {
    plan_slug: args.planSlug,
    branch: args.branch,
    covers: [...PLAN_TOKEN_COVERS],
    authorized_at: args.now.toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    max_actions: args.maxActions,
    actions_used: 0,
    approval_ref: args.approvalRef,
  }
  if (args.sessionId !== undefined) block.session_id = args.sessionId
  if (args.slideMinutes !== undefined) block.slide_minutes = args.slideMinutes
  if (absMs !== null) block.absolute_expires_at = new Date(absMs).toISOString()
  return block
}

/**
 * plan-lifecycle-v2 (Bloco 1.4): return a copy of the token with `expires_at`
 * re-armed to `min(now + slide_minutes, absolute_expires_at)`. Caller invokes
 * this ONLY in the post-commit success path (never in the pre-commit reserve),
 * so a failed/refunded commit never leaves an extended window. A pre-v2 token
 * (no `slide_minutes`) is returned unchanged, as is a re-arm that would move
 * `expires_at` backward (the window only ever extends, up to the cap).
 */
export function rearmToken(
  token: PlanAuthorizationBlock,
  now: Date,
): PlanAuthorizationBlock {
  if (token.slide_minutes === undefined || !Number.isFinite(token.slide_minutes)) {
    return token
  }
  let nextMs = now.getTime() + token.slide_minutes * 60_000
  if (token.absolute_expires_at) {
    const absMs = new Date(token.absolute_expires_at).getTime()
    if (Number.isFinite(absMs)) nextMs = Math.min(nextMs, absMs)
  }
  const currentMs = new Date(token.expires_at).getTime()
  if (Number.isFinite(currentMs) && nextMs <= currentMs) return token
  return { ...token, expires_at: new Date(nextMs).toISOString() }
}

export interface ValidateTokenCtx {
  now: Date
  branch: string | null
  /** Result of `findPlanBySlug(token.plan_slug)` — the token's OWN plan (FV1). */
  tokenPlan: ActivePlan | null
  /** Action being authorized, e.g. 'commit'. */
  action: string
}

export type ValidateTokenResult =
  | { valid: true; token: PlanAuthorizationBlock }
  | { valid: false; reason: TokenInvalidReason }

/**
 * Validate a token against the current context. Returns the FIRST failing
 * reason (ordering: absent → not_covered → expired → branch_mismatch →
 * plan_gone → plan_complete → exhausted) so the caller can surface a precise
 * hint. Pure — `ctx.tokenPlan` is supplied by the caller (it resolves the
 * token's plan_slug via `findPlanBySlug`, NOT `findActivePlan`).
 */
export function validateToken(
  token: PlanAuthorizationBlock | null | undefined,
  ctx: ValidateTokenCtx,
): ValidateTokenResult {
  if (!token) return { valid: false, reason: 'absent' }
  // Guard a malformed/hand-edited token (missing `covers`) so this stays
  // never-throw: treat absent coverage as not_covered rather than deref-crash.
  if (!Array.isArray(token.covers) || !token.covers.includes(ctx.action)) {
    return { valid: false, reason: 'not_covered' }
  }
  const expiresMs = new Date(token.expires_at).getTime()
  if (Number.isNaN(expiresMs) || ctx.now.getTime() >= expiresMs) {
    return { valid: false, reason: 'expired' }
  }
  // plan-lifecycle-v2 (Bloco 1.4): the sliding window can never live past the
  // absolute cap even if repeatedly re-armed. Optional + NaN-guarded so pre-v2
  // tokens (no cap) keep pure fixed-`expires_at` semantics. Folded into the
  // same first-fail `expired` reason so ordering stays coherent.
  if (token.absolute_expires_at) {
    const absMs = new Date(token.absolute_expires_at).getTime()
    if (!Number.isNaN(absMs) && ctx.now.getTime() >= absMs) {
      return { valid: false, reason: 'expired' }
    }
  }
  if (ctx.branch !== token.branch) return { valid: false, reason: 'branch_mismatch' }
  if (!ctx.tokenPlan) return { valid: false, reason: 'plan_gone' }
  if (isPlanComplete(ctx.tokenPlan.status)) return { valid: false, reason: 'plan_complete' }
  if (token.actions_used >= token.max_actions) return { valid: false, reason: 'exhausted' }
  return { valid: true, token }
}

/**
 * Return a copy of the token with `actions_used` incremented by one. Caller
 * persists AFTER the commit lands (a failed commit must not burn an action).
 */
export function consumeTokenAction(
  token: PlanAuthorizationBlock,
): PlanAuthorizationBlock {
  return { ...token, actions_used: token.actions_used + 1 }
}

/** Read the token from a PhaseState (null when absent). */
export function readToken(
  state: PhaseState | null | undefined,
): PlanAuthorizationBlock | null {
  return state?.plan_authorization ?? null
}

/** Return a copy of the state with the token removed (for revoke). */
export function clearTokenFromState(state: PhaseState): PhaseState {
  const next: PhaseState = { ...state }
  delete next.plan_authorization
  return next
}

/**
 * Resolve the effective TTL minutes: tool input > config default > built-in
 * default. The tool input and config are bounds-checked upstream (zod on the
 * tool schema; RsctApprovalModesSchema on config), so this only picks; the
 * fallback default is in-bounds by construction.
 */
export function resolveTtlMinutes(
  input: number | undefined,
  configDefault: number | undefined,
): number {
  const v = input ?? configDefault ?? PLAN_TOKEN_TTL_DEFAULT_MIN
  // Defense-in-depth clamp: input/config are bounds-checked upstream (zod), but
  // make the bound a property of the token itself so no future caller can mint
  // an out-of-range window. NaN/non-finite → fall back to the default.
  if (!Number.isFinite(v)) return PLAN_TOKEN_TTL_DEFAULT_MIN
  return Math.min(PLAN_TOKEN_TTL_MAX, Math.max(PLAN_TOKEN_TTL_MIN, v))
}

/** Resolve the effective max_actions: tool input > config default > built-in default. */
export function resolveMaxActions(
  input: number | undefined,
  configDefault: number | undefined,
): number {
  const v = input ?? configDefault ?? PLAN_TOKEN_MAX_ACTIONS_DEFAULT
  if (!Number.isFinite(v)) return PLAN_TOKEN_MAX_ACTIONS_DEFAULT
  return Math.min(
    PLAN_TOKEN_MAX_ACTIONS_MAX,
    Math.max(PLAN_TOKEN_MAX_ACTIONS_MIN, v),
  )
}

/** plan-lifecycle-v2: resolve the sliding-window width (minutes), clamped to bounds. */
export function resolveSlideMinutes(
  input: number | undefined,
  configDefault: number | undefined,
): number {
  const v = input ?? configDefault ?? PLAN_TOKEN_TTL_SLIDE_DEFAULT_MIN
  if (!Number.isFinite(v)) return PLAN_TOKEN_TTL_SLIDE_DEFAULT_MIN
  return Math.min(PLAN_TOKEN_TTL_SLIDE_MAX, Math.max(PLAN_TOKEN_TTL_SLIDE_MIN, v))
}

/** plan-lifecycle-v2: resolve the absolute cap (minutes), clamped to bounds. */
export function resolveAbsTtlMinutes(
  input: number | undefined,
  configDefault: number | undefined,
): number {
  const v = input ?? configDefault ?? PLAN_TOKEN_TTL_ABS_DEFAULT_MIN
  if (!Number.isFinite(v)) return PLAN_TOKEN_TTL_ABS_DEFAULT_MIN
  return Math.min(PLAN_TOKEN_TTL_ABS_MAX, Math.max(PLAN_TOKEN_TTL_ABS_MIN, v))
}

import type { ActivePlan } from './plan.js'
import { isPlanComplete } from './plan.js'
import type { PhaseState, PlanAuthorizationBlock } from './phase-scope.js'

export const PLAN_TOKEN_COVERS = ['commit'] as const

export const PLAN_TOKEN_TTL_DEFAULT_MIN = 480
export const PLAN_TOKEN_TTL_MIN = 5
export const PLAN_TOKEN_TTL_MAX = 480
export const PLAN_TOKEN_MAX_ACTIONS_DEFAULT = 20
export const PLAN_TOKEN_MAX_ACTIONS_MIN = 1
export const PLAN_TOKEN_MAX_ACTIONS_MAX = 100

const PLAN_TOKEN_CLOCK_AHEAD_MS = 5 * 60_000

export type TokenInvalidReason =
  | 'absent'
  | 'not_covered'
  | 'expired'
  | 'branch_mismatch'
  | 'plan_gone'
  | 'plan_complete'
  | 'exhausted'
  | 'unrecorded'

export interface EmitTokenArgs {
  planSlug: string
  branch: string
  ttlMinutes: number
  maxActions: number
  approvalRef: { action_scope: string; timestamp: string }
  now: Date
  sessionId?: string
}

export function emitToken(args: EmitTokenArgs): PlanAuthorizationBlock {
  const block: PlanAuthorizationBlock = {
    plan_slug: args.planSlug,
    branch: args.branch,
    covers: [...PLAN_TOKEN_COVERS],
    authorized_at: args.now.toISOString(),
    expires_at: new Date(args.now.getTime() + args.ttlMinutes * 60_000).toISOString(),
    max_actions: args.maxActions,
    actions_used: 0,
    approval_ref: args.approvalRef,
  }
  if (args.sessionId !== undefined) block.session_id = args.sessionId
  return block
}

export function tokenExpiryMs(token: PlanAuthorizationBlock, now: Date): number | null {
  const authorizedMs = new Date(token.authorized_at).getTime()
  const expiresMs = new Date(token.expires_at).getTime()
  if (!Number.isFinite(authorizedMs) || !Number.isFinite(expiresMs)) return null
  if (authorizedMs > now.getTime() + PLAN_TOKEN_CLOCK_AHEAD_MS) return null
  let ms = Math.min(expiresMs, authorizedMs + PLAN_TOKEN_TTL_MAX * 60_000)
  if (token.absolute_expires_at) {
    const absMs = new Date(token.absolute_expires_at).getTime()
    if (Number.isFinite(absMs)) ms = Math.min(ms, absMs)
  }
  return ms
}

export interface ValidateTokenCtx {
  now: Date
  branch: string | null
  tokenPlan: ActivePlan | null
  action: string
  mintRecorded: boolean
}

export type ValidateTokenResult =
  | { valid: true; token: PlanAuthorizationBlock }
  | { valid: false; reason: TokenInvalidReason }

export function validateToken(
  token: PlanAuthorizationBlock | null | undefined,
  ctx: ValidateTokenCtx,
): ValidateTokenResult {
  if (!token) return { valid: false, reason: 'absent' }
  if (!Array.isArray(token.covers) || !token.covers.includes(ctx.action)) {
    return { valid: false, reason: 'not_covered' }
  }
  const expiryMs = tokenExpiryMs(token, ctx.now)
  if (expiryMs === null || ctx.now.getTime() >= expiryMs) {
    return { valid: false, reason: 'expired' }
  }
  if (!ctx.mintRecorded) return { valid: false, reason: 'unrecorded' }
  if (ctx.branch !== token.branch) return { valid: false, reason: 'branch_mismatch' }
  if (!ctx.tokenPlan) return { valid: false, reason: 'plan_gone' }
  if (isPlanComplete(ctx.tokenPlan.status)) return { valid: false, reason: 'plan_complete' }
  if (token.actions_used >= token.max_actions) return { valid: false, reason: 'exhausted' }
  return { valid: true, token }
}

export function consumeTokenAction(
  token: PlanAuthorizationBlock,
): PlanAuthorizationBlock {
  return { ...token, actions_used: token.actions_used + 1 }
}

export function readToken(
  state: PhaseState | null | undefined,
): PlanAuthorizationBlock | null {
  return state?.plan_authorization ?? null
}

export function clearTokenFromState(state: PhaseState): PhaseState {
  const next: PhaseState = { ...state }
  delete next.plan_authorization
  return next
}

export function resolveTtlMinutes(
  input: number | undefined,
  configDefault: number | undefined,
): number {
  const v = input ?? configDefault ?? PLAN_TOKEN_TTL_DEFAULT_MIN
  if (!Number.isFinite(v)) return PLAN_TOKEN_TTL_DEFAULT_MIN
  return Math.min(PLAN_TOKEN_TTL_MAX, Math.max(PLAN_TOKEN_TTL_MIN, v))
}

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

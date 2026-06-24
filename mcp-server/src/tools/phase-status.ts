import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import { readPhaseState } from '../lib/phase-scope.js'
import { readWorktreeInfo, type WorktreeInfo } from '../lib/git.js'
import { readToken } from '../lib/plan-authorization.js'
import {
  RSCT_PHASES,
  nextPhase,
  type RsctPhase,
} from '../lib/phase-machine.js'

export const phaseStatusInputSchema = z
  .object({
    project_root: z.string().optional(),
  })
  .strict()

export type PhaseStatusInput = z.infer<typeof phaseStatusInputSchema>

export interface PhaseStatusVerificationSummary {
  spec_ref: string | null
  spec_tier: string | null
  findings_count: number
  started_at: string | null
}

export interface PhaseStatusReviewSummary {
  spec_ref: string
  decision: 'yes' | 'no'
  completed: boolean
  decided_at: string | null
  completed_at: string | null
}

export interface PhaseStatusPlanAuthSummary {
  plan_slug: string
  branch: string
  covers: string[]
  expires_at: string
  max_actions: number
  actions_used: number
}

export interface PhaseStatusOutput {
  rsct_installed: boolean
  phase_state_exists: boolean
  active_phase: RsctPhase | null
  spec_slug: string | null
  started_at: string | null
  scope_globs: string[]
  verification: PhaseStatusVerificationSummary | null
  /** DX-4: the REVIEW-before-Tests decision (null when none recorded). */
  review: PhaseStatusReviewSummary | null
  /** T3: active plan-scoped batch token (null when none). */
  plan_authorization: PhaseStatusPlanAuthSummary | null
  /** T3: git worktree context (linked worktree → isolated rsct state). */
  worktree: WorktreeInfo
  next_recommended_phase: RsctPhase | null
  rsct_phase_order: readonly RsctPhase[]
  hints: string[]
}

export const phaseStatusTool: Tool = {
  name: 'rsct_phase_status',
  description:
    'Pure query: returns the current state of the RSCT phase machine from .rsct/phase-state.json. Reports the active phase (or null), spec_slug, scope globs, verification block summary when active, the recorded review decision when present, and the next recommended phase per the canonical R→S→V→C→REVIEW→T order. Use to check where the task is mid-session before starting a new phase.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: { type: 'string' },
    },
    additionalProperties: false,
  },
}

function isKnownPhase(value: string | undefined): value is RsctPhase {
  return value !== undefined && (RSCT_PHASES as readonly string[]).includes(value)
}

export async function phaseStatusHandler(
  rawInput: unknown,
): Promise<PhaseStatusOutput> {
  const input = phaseStatusInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const read = readPhaseState(resolution.root)
  const worktree = readWorktreeInfo(resolution.root)

  const hints: string[] = []
  if (!resolution.rsct_installed) {
    hints.push(
      'Project is not rsct-managed — phase machine state will be unknown. Run /rsct-setup before relying on this tool.',
    )
  }
  if (!read.exists) {
    hints.push(
      'No .rsct/phase-state.json yet — no active phase. Call rsct_classify_task to choose a tier, then rsct_phase_<phase>_start.',
    )
    return {
      rsct_installed: resolution.rsct_installed,
      phase_state_exists: false,
      active_phase: null,
      spec_slug: null,
      started_at: null,
      scope_globs: [],
      verification: null,
      review: null,
      plan_authorization: null,
      worktree,
      next_recommended_phase: null,
      rsct_phase_order: RSCT_PHASES,
      hints,
    }
  }

  const state = read.state
  const phaseValue = state?.phase
  const active: RsctPhase | null = isKnownPhase(phaseValue) ? phaseValue : null

  let verification: PhaseStatusVerificationSummary | null = null
  if (state?.verification) {
    const findings = state.verification.findings
    verification = {
      spec_ref: state.verification.spec_ref ?? null,
      spec_tier: state.verification.spec_tier ?? null,
      findings_count: Array.isArray(findings) ? findings.length : 0,
      started_at: state.verification.started_at ?? null,
    }
  }

  let review: PhaseStatusReviewSummary | null = null
  if (state?.review) {
    review = {
      spec_ref: state.review.spec_ref,
      decision: state.review.decision,
      completed: state.review.completed_at != null,
      decided_at: state.review.decided_at ?? null,
      completed_at: state.review.completed_at ?? null,
    }
  }

  const recommended = active ? nextPhase(active) : null

  if (active === null && phaseValue !== undefined) {
    hints.push(
      `phase-state.json holds an unrecognized phase value '${phaseValue}'. Either the file was hand-edited or a future phase tool wrote it; M3 expects one of [${RSCT_PHASES.join(', ')}].`,
    )
  } else if (active) {
    hints.push(
      `Active phase: ${active}${state?.spec_slug ? ` (spec_slug='${state.spec_slug}')` : ''}.${
        recommended
          ? ` Next recommended: '${recommended}' — call rsct_phase_${active}_complete before rsct_phase_${recommended}_start.`
          : ' This is the last phase; rsct_phase_test_complete ends the cycle.'
      }`,
    )
    if (active === 'verification' && verification) {
      hints.push(
        `Verification has ${verification.findings_count} finding(s). Resolve actions and call rsct_phase_verification_complete with findings_actions[] + dev_approval.`,
      )
    }
  } else {
    hints.push(
      'phase-state.json present but no active phase field. Start a phase with rsct_phase_<phase>_start.',
    )
  }

  // T3: surface an active plan-scoped batch token (execution mode = batch).
  const token = readToken(state)
  let planAuth: PhaseStatusPlanAuthSummary | null = null
  if (token) {
    planAuth = {
      plan_slug: token.plan_slug,
      branch: token.branch,
      covers: token.covers,
      expires_at: token.expires_at,
      max_actions: token.max_actions,
      actions_used: token.actions_used,
    }
    hints.push(
      `Plan-scoped batch token ACTIVE for '${token.plan_slug}' on '${token.branch}' (${token.actions_used}/${token.max_actions} commits used, expires ${token.expires_at}). rsct_request_commit needs no per-action dev_approval within scope; rsct_plan_revoke ends it early.`,
    )
  }
  if (worktree.is_worktree) {
    hints.push(
      `Linked git worktree${worktree.name ? ` ('${worktree.name}')` : ''} — this phase-state + token are isolated to THIS worktree.`,
    )
  }

  return {
    rsct_installed: resolution.rsct_installed,
    phase_state_exists: true,
    active_phase: active,
    spec_slug: state?.spec_slug ?? null,
    started_at: state?.started_at ?? null,
    scope_globs: state?.scope_globs ?? [],
    verification,
    review,
    plan_authorization: planAuth,
    worktree,
    next_recommended_phase: recommended,
    rsct_phase_order: RSCT_PHASES,
    hints,
  }
}

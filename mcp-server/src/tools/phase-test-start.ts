import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'
import { readPhaseState } from '../lib/phase-scope.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

/**
 * DX-4: tiers that bypass the REVIEW gate. Mirrors the V gate's tier
 * table — trivial + small skip the review decision entirely; standard +
 * complex must have a recorded review decision (yes → completed, or no →
 * skipped) before tests can start.
 */
const TIERS_BYPASSING_REVIEW_GATE: ReadonlySet<Tier> = new Set([
  'trivial',
  'small',
])

export const phaseTestStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
    spec_tier: z
      .enum(TIER_VALUES)
      .default('standard')
      .describe(
        'Tier per rsct_classify_task. trivial+small bypass the review gate; standard+complex require a recorded review decision (from rsct_phase_spec_complete include_review). Missing → standard → gated.',
      ),
    override_review_skip: z
      .boolean()
      .default(false)
      .describe(
        'When true, allows the test phase to start without honoring the review decision for tier ∈ {standard, complex}. The override is logged to audit; use sparingly when the dev has explicitly chosen to bypass the review gate.',
      ),
  })
  .strict()

export type PhaseTestStartInput = z.infer<typeof phaseTestStartInputSchema>

export type ReviewGateStatus =
  | 'bypassed_tier'
  | 'bypassed_declined'
  | 'passed'
  | 'overridden'
  | 'rejected_undecided'
  | 'rejected_incomplete'

export interface ReviewGate {
  status: ReviewGateStatus
  spec_tier: Tier
  review_block_found: boolean
  review_spec_ref: string | null
  review_decision: 'yes' | 'no' | null
  review_completed_at: string | null
  hint: string
}

export interface PhaseTestStartGateRejectedOutput {
  status: 'review_gate_rejected'
  reject_kind: 'review_undecided' | 'review_incomplete'
  reason: string
  spec_ref: string
  review_gate: ReviewGate
  phase_state_path: string
  phase_state_written: false
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export type PhaseTestStartOutput =
  | (StartPhaseResult & { review_gate: ReviewGate })
  | PhaseTestStartGateRejectedOutput

export const phaseTestStartTool: Tool = {
  name: 'rsct_phase_test_start',
  description:
    'Start the T (Test) phase. Writes phase="test" into .rsct/phase-state.json and emits test.start audit. Use after the code (and review) phase is complete to add unit/integration tests + run the suite end-to-end before sign-off. **DX-4: review gate** — for spec_tier ∈ {standard, complex} this tool reads the review decision recorded at rsct_phase_spec_complete (include_review) and rejects unless it is honored: decision=no proceeds (review skipped); decision=yes requires a completed rsct_phase_review_complete for this spec_ref; no decision → rejects asking you to record one. Pass override_review_skip=true to bypass (audit-logged). For spec_tier ∈ {trivial, small} the gate is automatically bypassed.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      spec_slug: { type: 'string' },
      scope_globs: { type: 'array', items: { type: 'string' } },
      persona: { type: 'string' },
      spec_tier: {
        type: 'string',
        enum: [...TIER_VALUES],
        default: 'standard',
        description:
          'trivial+small bypass the review gate; standard+complex require a recorded review decision (or override).',
      },
      override_review_skip: {
        type: 'boolean',
        default: false,
        description:
          'When true, bypass the review gate for standard+complex (audit-logged).',
      },
    },
    additionalProperties: false,
  },
}

function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
}

/**
 * DX-4 hard gate, mirroring the code-start verification gate
 * (evaluateVerificationGate). Determines if the test phase may proceed
 * based on the recorded REVIEW decision:
 *  - tier (trivial/small bypass)
 *  - a review block whose spec_ref STRICTLY matches (a stale block from a
 *    re-planned spec_ref is ignored — same keying as the V gate's
 *    vMatchesSpec)
 *  - decision=no → proceed (review intentionally skipped, never run)
 *  - decision=yes + completed_at → proceed
 *  - decision=yes + not completed → reject (run the review first)
 *  - no matching decision → reject (record one at spec_complete)
 *  - override_review_skip=true is a universal escape over both reject
 *    cases (allow + audit)
 *
 * Pure function — does not write state or audit; caller wires up audit
 * events after deciding.
 */
export function evaluateReviewGate(args: {
  projectRoot: string
  specRef: string
  specTier: Tier
  overrideReviewSkip: boolean
}): ReviewGate {
  const { specRef, specTier, overrideReviewSkip } = args

  if (TIERS_BYPASSING_REVIEW_GATE.has(specTier)) {
    return {
      status: 'bypassed_tier',
      spec_tier: specTier,
      review_block_found: false,
      review_spec_ref: null,
      review_decision: null,
      review_completed_at: null,
      hint: `tier=${specTier} bypasses the review gate per canonical tier table.`,
    }
  }

  const stateRead = readPhaseState(args.projectRoot)
  const review = stateRead.state?.review
  const reviewSpecRef = review?.spec_ref ?? null
  // Strict spec_ref match — a review block for a DIFFERENT spec_ref (a
  // re-plan) must NOT satisfy or poison this gate. Mirrors vMatchesSpec.
  const matchesSpec = reviewSpecRef !== null && reviewSpecRef === specRef
  const decision = matchesSpec ? (review?.decision ?? null) : null
  const completedAt = matchesSpec ? (review?.completed_at ?? null) : null

  if (decision === 'no') {
    return {
      status: 'bypassed_declined',
      spec_tier: specTier,
      review_block_found: true,
      review_spec_ref: reviewSpecRef,
      review_decision: 'no',
      review_completed_at: completedAt,
      hint: `Review was declined for this spec_ref (include_review=false at spec_complete). Test phase may proceed; the review is intentionally skipped.`,
    }
  }

  if (decision === 'yes' && completedAt !== null) {
    return {
      status: 'passed',
      spec_tier: specTier,
      review_block_found: true,
      review_spec_ref: reviewSpecRef,
      review_decision: 'yes',
      review_completed_at: completedAt,
      hint: `Review phase completed at ${completedAt} for this spec_ref. Test phase may proceed.`,
    }
  }

  // From here the gate would reject; the override is a universal escape.
  if (overrideReviewSkip) {
    return {
      status: 'overridden',
      spec_tier: specTier,
      review_block_found: review !== undefined,
      review_spec_ref: reviewSpecRef,
      review_decision: decision,
      review_completed_at: completedAt,
      hint: `override_review_skip=true acknowledged. Override logged to audit (.rsct/audit.log).`,
    }
  }

  if (decision === 'yes' && completedAt === null) {
    return {
      status: 'rejected_incomplete',
      spec_tier: specTier,
      review_block_found: true,
      review_spec_ref: reviewSpecRef,
      review_decision: 'yes',
      review_completed_at: null,
      hint: `A code review was requested (include_review=true) for spec_ref='${specRef}' but not completed. Run rsct_phase_review_start → (do the review) → rsct_phase_review_complete first, OR pass override_review_skip=true to bypass.`,
    }
  }

  return {
    status: 'rejected_undecided',
    spec_tier: specTier,
    review_block_found: review !== undefined,
    review_spec_ref: reviewSpecRef,
    review_decision: null,
    review_completed_at: null,
    hint: `tier='${specTier}' needs a recorded review decision for spec_ref='${specRef}' before tests. Re-run rsct_phase_spec_complete with include_review=true (do a code review — strongly recommended) or include_review=false (skip it), OR pass override_review_skip=true (logged to audit).`,
  }
}

export async function phaseTestStartHandler(
  rawInput: unknown,
): Promise<PhaseTestStartOutput> {
  const input = phaseTestStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  const gate = evaluateReviewGate({
    projectRoot: resolution.root,
    specRef: input.spec_ref,
    specTier: input.spec_tier,
    overrideReviewSkip: input.override_review_skip,
  })

  if (gate.status === 'rejected_undecided' || gate.status === 'rejected_incomplete') {
    const rejectKind =
      gate.status === 'rejected_undecided' ? 'review_undecided' : 'review_incomplete'
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: 'test.start.rejected',
        tool: 'rsct_phase_test_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: rejectKind,
        review_block_found: gate.review_block_found,
        review_spec_ref: gate.review_spec_ref,
        review_decision: gate.review_decision,
        review_completed_at: gate.review_completed_at,
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'review_gate_rejected',
      reject_kind: rejectKind,
      reason: gate.hint,
      spec_ref: input.spec_ref,
      review_gate: gate,
      phase_state_path: '',
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [gate.hint],
    }
  }

  if (gate.status === 'overridden') {
    appendAuditEntry(
      resolution.root,
      {
        event: 'test.start.review_override',
        tool: 'rsct_phase_test_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        review_block_found: gate.review_block_found,
        review_spec_ref: gate.review_spec_ref,
        review_decision: gate.review_decision,
      },
      resolution.config?.audit,
    )
  } else if (gate.status === 'bypassed_declined') {
    appendAuditEntry(
      resolution.root,
      {
        event: 'test.start.review_skipped_declined',
        tool: 'rsct_phase_test_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
      },
      resolution.config?.audit,
    )
  }

  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'test',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona
  const result = startPhaseGeneric(args, resolution.config)
  return { ...result, review_gate: gate }
}

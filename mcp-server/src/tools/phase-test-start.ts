import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'
import { readPhaseState } from '../lib/phase-scope.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { evaluateEvidenceGate, gateCeremonyBypass } from '../lib/ceremony-gate.js'
import type { GateRejectKind } from '../lib/request-gate.js'
import type { DialogOptions, DialogResult } from '../lib/os-dialog.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

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
        'When true, allows the test phase to start without honoring the review decision for tier ∈ {standard, complex}. Requires dev_approval and always forces the OS dialog. The override is logged to audit.',
      ),
    dev_approval: z
      .unknown()
      .optional()
      .describe(
        'Required only when override_review_skip is true. Validated via lib/dev-approval; the OS dialog is forced and trust_allowed_for is ignored, because skipping the REVIEW phase is a per-call decision, not a pre-authorised tool.',
      ),
  })
  .strict()

export type PhaseTestStartInput = z.infer<typeof phaseTestStartInputSchema>

export type ReviewGateStatus =
  | 'not_evaluated'
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
  reject_kind:
    | 'review_undecided'
    | 'review_incomplete'
    | 'classify_evidence_absent'
    | GateRejectKind
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
    'Start the T (Test) phase. Writes phase="test" into .rsct/phase-state.json and emits test.start audit. Use after the code (and review) phase is complete to add unit/integration tests + run the suite end-to-end before sign-off. **DX-4: review gate** — for spec_tier ∈ {standard, complex} this tool reads the review decision recorded at rsct_phase_spec_complete (include_review) and rejects unless it is honored: decision=no proceeds (review skipped); decision=yes requires a completed rsct_phase_review_complete for this spec_ref; no decision → rejects asking you to record one. Pass override_review_skip=true to bypass — it requires `dev_approval` and FORCES the OS dialog (`trust_allowed_for` is ignored), because skipping a review is a per-call decision. For spec_tier ∈ {trivial, small} the gate is automatically bypassed, but only when an rsct_classify_task verdict is on record; a low tier declared with no classification is refused (`classify_evidence_absent`).',
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
          'When true, bypass the review gate for standard+complex. Requires dev_approval and forces the OS dialog (audit-logged).',
      },
      dev_approval: {
        type: 'object',
        description:
          'The dev_approval payload (timestamp, action_scope, reason). Required only when override_review_skip is true.',
      },
    },
    additionalProperties: false,
  },
}

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

  const pendingFindings = matchesSpec
    ? ((stateRead.state?.review_findings?.findings as unknown[] | undefined)?.length ?? 0)
    : 0

  if (decision === 'yes' && completedAt !== null && pendingFindings === 0) {
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

  if (decision === 'yes' && completedAt !== null && pendingFindings > 0) {
    return {
      status: 'rejected_incomplete',
      spec_tier: specTier,
      review_block_found: true,
      review_spec_ref: reviewSpecRef,
      review_decision: 'yes',
      review_completed_at: completedAt,
      hint: `The review for spec_ref='${specRef}' is stamped complete but still holds ${pendingFindings} unanswered finding(s). Re-open it with rsct_phase_review_start (pass the same findings — rsct_phase_status lists them), then rsct_phase_review_complete with an action for each. OR pass override_review_skip=true to bypass.`,
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

export interface PhaseTestStartInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
}

export async function phaseTestStartHandler(
  rawInput: unknown,
  internal: PhaseTestStartInternal = {},
): Promise<PhaseTestStartOutput> {
  const input = phaseTestStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  const evidenceGate = evaluateEvidenceGate({
    projectRoot: resolution.root,
    config: resolution.config,
    specTier: input.spec_tier,
    toolName: 'rsct_phase_test_start',
  })

  if (evidenceGate.status === 'absent') {
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: 'test.start.rejected',
        tool: 'rsct_phase_test_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: 'classify_evidence_absent',
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'review_gate_rejected',
      reject_kind: 'classify_evidence_absent',
      reason: evidenceGate.hint,
      spec_ref: input.spec_ref,
      review_gate: {
        status: 'not_evaluated',
        spec_tier: input.spec_tier,
        review_block_found: false,
        review_spec_ref: null,
        review_decision: null,
        review_completed_at: null,
        hint: evidenceGate.hint,
      },
      phase_state_path: '',
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [evidenceGate.hint],
    }
  }

  const bypassGate = await gateCeremonyBypass({
    projectRoot: resolution.root,
    config: resolution.config,
    toolName: 'rsct_phase_test_start',
    specRef: input.spec_ref,
    specTier: input.spec_tier,
    bypasses: input.override_review_skip ? ['review_skip'] : [],
    devApproval: input.dev_approval,
    ...(internal.promptFn !== undefined && { promptFn: internal.promptFn }),
    ...(internal.now !== undefined && { now: internal.now }),
  })

  if (bypassGate.status === 'rejected') {
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: 'test.start.rejected',
        tool: 'rsct_phase_test_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: bypassGate.reject_kind,
        reason: bypassGate.reason,
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'review_gate_rejected',
      reject_kind: bypassGate.reject_kind,
      reason: bypassGate.reason,
      spec_ref: input.spec_ref,
      review_gate: {
        status: 'not_evaluated',
        spec_tier: input.spec_tier,
        review_block_found: false,
        review_spec_ref: null,
        review_decision: null,
        review_completed_at: null,
        hint: bypassGate.reason,
      },
      phase_state_path: '',
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [bypassGate.reason],
    }
  }

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

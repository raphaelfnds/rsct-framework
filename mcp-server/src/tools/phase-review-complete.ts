import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'
import { stampReviewDecision } from '../lib/phase-scope.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import {
  FINDING_ACTIONS,
  emptyActionsSummary,
  type ActionsSummary,
} from '../lib/findings.js'

/**
 * #19. REVIEW was defined by its POSITION in the cycle — between Code and Test —
 * but never given anywhere to put what it found. `rsct_phase_review_complete`
 * took only `spec_ref` + `dev_approval`, so a review that found dead code, an
 * abandoned scaffold or a comment describing behaviour the code no longer has had
 * nowhere to record it. The phase rested entirely on the agent remembering the
 * tool description, which is exactly the behavioural slack the mechanical layer
 * exists to close.
 *
 * This gives it the V phase's shape: per-finding actions, `block` aborts, one
 * audit entry per finding. It does NOT give it a mechanical checklist — see the
 * tool description for why that half was split out.
 */
const findingActionSchema = z
  .object({
    finding_id: z.string().min(1, 'finding_id required'),
    action: z.enum(FINDING_ACTIONS),
    note: z.string().optional(),
  })
  .strict()

export const phaseReviewCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
    findings_actions: z
      .array(findingActionSchema)
      .default([])
      .describe('Per-finding actions chosen by the dev. Any action="block" aborts completion.'),
  })
  .strict()

export type PhaseReviewCompleteInput = z.infer<typeof phaseReviewCompleteInputSchema>

export type PhaseReviewCompleteOutput = CompletePhaseResult & {
  actions_summary: ActionsSummary
}

export const phaseReviewCompleteTool: Tool = {
  name: 'rsct_phase_review_complete',
  description:
    '§C-gated REVIEW phase closure. Reads .rsct/phase-state.json (must hold phase="review" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. On success it also stamps completed_at into the review decision block so rsct_phase_test_start sees the review actually ran. Pass findings_actions[] to record what the review found and what the dev decided about each item — dead code, leftover scaffolding from an abandoned approach inside this same task, and comments or tool/parameter descriptions that no longer match the code are the hygiene items worth recording, alongside correctness and security findings. Any entry with action="block" aborts completion BEFORE the §C dialog. Suggested action_scope: "review_complete:spec_ref=<X>". Next recommended phase: test.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      dev_approval: { type: 'object' },
      findings_actions: {
        type: 'array',
        description: 'Per-finding actions. action="block" aborts completion.',
        items: {
          type: 'object',
          required: ['finding_id', 'action'],
          properties: {
            finding_id: { type: 'string' },
            action: { type: 'string', enum: [...FINDING_ACTIONS] },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
}

export async function phaseReviewCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseReviewCompleteOutput> {
  const input = phaseReviewCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const appendAudit = internal.auditWriter ?? appendAuditEntry

  const actions_summary = emptyActionsSummary()
  for (const fa of input.findings_actions) actions_summary[fa.action]++

  // `block` aborts BEFORE the §C gate, mirroring the V phase: the dialog is a
  // decision surface, and asking the dev to approve a completion that is already
  // refused wastes an approval and trains them to click through.
  if (actions_summary.block > 0) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'review.complete.rejected',
        tool: 'rsct_phase_review_complete',
        spec_ref: input.spec_ref,
        reject_kind: 'block_actions_present',
        blocked_count: actions_summary.block,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      phase: 'review',
      spec_ref: input.spec_ref,
      channel: null,
      reject_kind: 'block_actions_present',
      reason: `${actions_summary.block} review finding(s) marked action="block". Resolve them, then re-run rsct_phase_review_complete.`,
      fabrication_signals: [],
      cleared: false,
      next_recommended_phase: 'review',
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `REVIEW is not complete: ${actions_summary.block} finding(s) are blocking. Fix them or downgrade the action with the dev — a blocking finding is the one thing this phase will not wave through.`,
      ],
      actions_summary,
    }
  }

  const result = await gatePhaseComplete(
    {
      projectRoot,
      phase: 'review',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )

  // Stamp completed_at ONLY when the complete genuinely succeeded; a
  // rejected/failed complete must not mark the review as done. Additive
  // upsert (preserves the decision/decided_at recorded at spec_complete).
  if (result.status === 'completed') {
    const completedAt = (internal.now ?? new Date()).toISOString()
    const stamp = stampReviewDecision(projectRoot, {
      spec_ref: input.spec_ref,
      completed_at: completedAt,
    })
    if (!stamp.ok) {
      result.hints.push(
        `⚠ review phase completed but I could not stamp completed_at into the review block (${stamp.reason}). rsct_phase_test_start may still report the review as incomplete — retry by re-running rsct_phase_review_complete, or check .rsct/phase-state.json.`,
      )
    }

    // One audit entry per finding, AFTER the gate: a rejected complete must not
    // leave the log asserting decisions that were never approved.
    for (const fa of input.findings_actions) {
      appendAudit(
        projectRoot,
        {
          event: 'review.action',
          tool: 'rsct_phase_review_complete',
          spec_ref: input.spec_ref,
          finding_id: fa.finding_id,
          action: fa.action,
          ...(fa.note ? { note: fa.note } : {}),
        },
        config?.audit,
      )
    }
  }

  return { ...result, actions_summary }
}

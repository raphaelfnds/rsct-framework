import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'
import { stampReviewDecision } from '../lib/phase-scope.js'

export const phaseReviewCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
  })
  .strict()

export type PhaseReviewCompleteInput = z.infer<
  typeof phaseReviewCompleteInputSchema
>
export type PhaseReviewCompleteOutput = CompletePhaseResult

export const phaseReviewCompleteTool: Tool = {
  name: 'rsct_phase_review_complete',
  description:
    '§C-gated REVIEW phase closure. Reads .rsct/phase-state.json (must hold phase="review" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. On success it also stamps completed_at into the review decision block so rsct_phase_test_start sees the review actually ran. Suggested action_scope: "review_complete:spec_ref=<X>". Next recommended phase: test.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      dev_approval: { type: 'object' },
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
  const result = await gatePhaseComplete(
    {
      projectRoot: resolution.root,
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
    const stamp = stampReviewDecision(resolution.root, {
      spec_ref: input.spec_ref,
      completed_at: completedAt,
    })
    if (!stamp.ok) {
      result.hints.push(
        `⚠ review phase completed but I could not stamp completed_at into the review block (${stamp.reason}). rsct_phase_test_start may still report the review as incomplete — retry by re-running rsct_phase_review_complete, or check .rsct/phase-state.json.`,
      )
    }
  }

  return result
}

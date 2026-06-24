import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'
import { stampReviewDecision } from '../lib/phase-scope.js'

export const phaseSpecCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
    include_review: z
      .boolean()
      .optional()
      .describe(
        'DX-4: the ask-once REVIEW decision. true = include a code review of the diff before tests (strongly recommended for standard+complex); false = skip it. Recorded into the review block keyed by spec_ref; rsct_phase_test_start enforces it. Omit only if the decision is deferred — the test-start gate then asks for it.',
      ),
  })
  .strict()

export type PhaseSpecCompleteInput = z.infer<
  typeof phaseSpecCompleteInputSchema
>
export type PhaseSpecCompleteOutput = CompletePhaseResult

export const phaseSpecCompleteTool: Tool = {
  name: 'rsct_phase_spec_complete',
  description:
    '§C-gated S phase closure. Reads .rsct/phase-state.json (must hold phase="spec" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "spec_complete:spec_ref=<X>". Next recommended phase: verification (optional — call rsct_phase_verification_start to run the audit-level sweep) or code (skip V phase). **DX-4: pass `include_review` here** to record the ask-once REVIEW decision (a code review of the diff before tests — strongly recommended for standard+complex); the recommended cycle is R→S→V→C→REVIEW→T.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      dev_approval: { type: 'object' },
      include_review: {
        type: 'boolean',
        description:
          'DX-4 ask-once REVIEW decision: true = include a code review before tests (recommended for standard+complex); false = skip. Recorded keyed by spec_ref; enforced by rsct_phase_test_start.',
      },
    },
    additionalProperties: false,
  },
}

export async function phaseSpecCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseSpecCompleteOutput> {
  const input = phaseSpecCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const result = await gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: 'spec',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )

  // DX-4: record the ask-once REVIEW decision — ONLY when the spec
  // complete genuinely succeeded (never stamp a decision on a rejected /
  // failed complete). Additive upsert keyed by spec_ref. A failed stamp is
  // non-fatal: the complete already succeeded; surface a hint and let the
  // test-start gate ask for the decision again.
  if (input.include_review !== undefined && result.status === 'completed') {
    const decidedAt = (internal.now ?? new Date()).toISOString()
    const stamp = stampReviewDecision(resolution.root, {
      spec_ref: input.spec_ref,
      decision: input.include_review ? 'yes' : 'no',
      decided_at: decidedAt,
    })
    if (stamp.ok) {
      result.hints.push(
        input.include_review
          ? `Review decision recorded: a code review of the diff is included before tests (run rsct_phase_review_start after code, then rsct_phase_review_complete).`
          : `Review decision recorded: the code review is skipped for this spec_ref.`,
      )
    } else {
      result.hints.push(
        `⚠ spec complete succeeded but I could not record the review decision (${stamp.reason}). rsct_phase_test_start will ask for it — retry by re-running rsct_phase_spec_complete with include_review, or set it then.`,
      )
    }
  }

  return result
}

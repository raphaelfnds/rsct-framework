import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'

export const phaseReviewStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
  })
  .strict()

export type PhaseReviewStartInput = z.infer<typeof phaseReviewStartInputSchema>
export type PhaseReviewStartOutput = StartPhaseResult

export const phaseReviewStartTool: Tool = {
  name: 'rsct_phase_review_start',
  description:
    'Start the REVIEW phase — an adversarial code review of the diff, between Code and Test (cycle: R→S→V→C→REVIEW→T). Writes phase="review" into .rsct/phase-state.json and emits review.start audit. Run it after rsct_phase_code_complete when the review decision (recorded at rsct_phase_spec_complete via include_review) was YES. Do the review here (hunt correctness/security/regression/cross-OS bugs in the diff — e.g. via the qa + senior-dev personas or /code-review), then call rsct_phase_review_complete. NOTE: this is the review PHASE, distinct from rsct_persona_review (a stateless advisory lens). Refuses if a different phase is already active.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      spec_slug: { type: 'string' },
      scope_globs: { type: 'array', items: { type: 'string' } },
      persona: { type: 'string' },
    },
    additionalProperties: false,
  },
}

export async function phaseReviewStartHandler(
  rawInput: unknown,
): Promise<PhaseReviewStartOutput> {
  const input = phaseReviewStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'review',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona
  return startPhaseGeneric(args, resolution.config)
}

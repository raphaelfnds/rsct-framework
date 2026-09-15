import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'
import { detectRemovedOptions, type RemovedOptionsRejection } from '../lib/removed-options.js'

export const PHASE_TEST_START_REMOVED_OPTIONS = ['override_review_skip', 'spec_tier', 'dev_approval'] as const

export const phaseTestStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
  })
  .strict()

export type PhaseTestStartInput = z.infer<typeof phaseTestStartInputSchema>

export type PhaseTestStartOutput = StartPhaseResult | RemovedOptionsRejection

export const phaseTestStartTool: Tool = {
  name: 'rsct_phase_test_start',
  description:
    'Start the T (Test) phase. Writes phase="test" into .rsct/phase-state.json and emits test.start audit. Use after rsct_phase_code_complete to add unit/integration tests and run the suite end-to-end. The cycle is R→S→V→C→T→REVIEW: the mandatory REVIEW runs after the tests, over code and tests together, and rsct_request_commit refuses code that no completed REVIEW covers. Refuses if a different phase is already active. override_review_skip, spec_tier and dev_approval were removed in 2.11.0 and are rejected with reject_kind="review_option_removed".',
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

export async function phaseTestStartHandler(rawInput: unknown): Promise<PhaseTestStartOutput> {
  const removed = detectRemovedOptions(rawInput, PHASE_TEST_START_REMOVED_OPTIONS)
  if (removed) return removed
  const input = phaseTestStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'test',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona
  return startPhaseGeneric(args, resolution.config)
}

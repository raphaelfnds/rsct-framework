import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'

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
export type PhaseTestStartOutput = StartPhaseResult

export const phaseTestStartTool: Tool = {
  name: 'rsct_phase_test_start',
  description:
    'Start the T (Test) phase. Writes phase="test" into .rsct/phase-state.json and emits test.start audit. Use after code phase is complete to add unit/integration tests + run the test suite end-to-end before sign-off.',
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

export async function phaseTestStartHandler(
  rawInput: unknown,
): Promise<PhaseTestStartOutput> {
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

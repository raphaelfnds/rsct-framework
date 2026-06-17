import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'

export const phaseSpecStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
  })
  .strict()

export type PhaseSpecStartInput = z.infer<typeof phaseSpecStartInputSchema>
export type PhaseSpecStartOutput = StartPhaseResult

export const phaseSpecStartTool: Tool = {
  name: 'rsct_phase_spec_start',
  description:
    'Start the S (Spec) phase. Writes phase="spec" into .rsct/phase-state.json and emits spec.start audit. Use after research is complete (or skipped) to formalize the plan with the §B "2 options + reuse analysis" template. Refuses if a different phase is already active.',
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

export async function phaseSpecStartHandler(
  rawInput: unknown,
): Promise<PhaseSpecStartOutput> {
  const input = phaseSpecStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'spec',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona
  return startPhaseGeneric(args, resolution.config)
}

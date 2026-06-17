import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'

export const phaseResearchStartInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    spec_ref: z
      .string()
      .min(1, 'spec_ref required')
      .describe(
        'Free-form spec identifier — typically the plan slug (e.g., "feat-foo") or a path to plan_<slug>.md. Correlates start/complete and used as audit key.',
      ),
    spec_slug: z
      .string()
      .optional()
      .describe(
        'Optional spec_slug to write into phase-state.json. Defaults to spec_ref if absent.',
      ),
    scope_globs: z
      .array(z.string())
      .optional()
      .describe(
        'Optional scope globs for rsct_check_edit_scope. Research is exploratory — usually omitted at this phase.',
      ),
    persona: z
      .string()
      .optional()
      .describe(
        'Optional persona slug. No-op until F3; logged into audit as requested_persona.',
      ),
  })
  .strict()

export type PhaseResearchStartInput = z.infer<
  typeof phaseResearchStartInputSchema
>
export type PhaseResearchStartOutput = StartPhaseResult

export const phaseResearchStartTool: Tool = {
  name: 'rsct_phase_research_start',
  description:
    'Start the R (Research) phase of the RSCT cycle. Writes phase="research" into .rsct/phase-state.json and emits research.start to the audit log. Use for exploratory work before committing to a spec — read code, look at decisions, scan for prior art. Refuses if a different phase is already active.',
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

export async function phaseResearchStartHandler(
  rawInput: unknown,
): Promise<PhaseResearchStartOutput> {
  const input = phaseResearchStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'research',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona

  return startPhaseGeneric(args, resolution.config)
}

import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'

export const phaseResearchCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z
      .string()
      .min(1, 'spec_ref required')
      .describe('Must match the spec_slug of the active research phase.'),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload. action_scope SHOULD start with "research_complete:" (INV-2.2 scope_mismatch detection).',
      ),
  })
  .strict()

export type PhaseResearchCompleteInput = z.infer<
  typeof phaseResearchCompleteInputSchema
>
export type PhaseResearchCompleteOutput = CompletePhaseResult

export const phaseResearchCompleteTool: Tool = {
  name: 'rsct_phase_research_complete',
  description:
    '§C-gated R phase closure. Reads .rsct/phase-state.json (must hold phase="research" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "research_complete:spec_ref=<X>". Next recommended phase: spec.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      dev_approval: {
        type: 'object',
        description:
          'dev_approval payload (timestamp, action_scope, reason, optional overrides).',
      },
    },
    additionalProperties: false,
  },
}

export async function phaseResearchCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseResearchCompleteOutput> {
  const input = phaseResearchCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: 'research',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )
}

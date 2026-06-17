import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'

export const phaseCodeCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
  })
  .strict()

export type PhaseCodeCompleteInput = z.infer<
  typeof phaseCodeCompleteInputSchema
>
export type PhaseCodeCompleteOutput = CompletePhaseResult

export const phaseCodeCompleteTool: Tool = {
  name: 'rsct_phase_code_complete',
  description:
    '§C-gated C phase closure. Reads .rsct/phase-state.json (must hold phase="code" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "code_complete:spec_ref=<X>". Next recommended phase: test.',
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

export async function phaseCodeCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseCodeCompleteOutput> {
  const input = phaseCodeCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: 'code',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )
}

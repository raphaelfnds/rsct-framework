import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'

export const phaseTestCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
  })
  .strict()

export type PhaseTestCompleteInput = z.infer<
  typeof phaseTestCompleteInputSchema
>
export type PhaseTestCompleteOutput = CompletePhaseResult

export const phaseTestCompleteTool: Tool = {
  name: 'rsct_phase_test_complete',
  description:
    '§C-gated T phase closure — the task-completion event. Reads .rsct/phase-state.json (must hold phase="test" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "test_complete:spec_ref=<X>". This is the last phase in the cycle — next_recommended_phase will be null.',
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

export async function phaseTestCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseTestCompleteOutput> {
  const input = phaseTestCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: 'test',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )
}

import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'

export const phaseSpecCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
  })
  .strict()

export type PhaseSpecCompleteInput = z.infer<
  typeof phaseSpecCompleteInputSchema
>
export type PhaseSpecCompleteOutput = CompletePhaseResult

export const phaseSpecCompleteTool: Tool = {
  name: 'rsct_phase_spec_complete',
  description:
    '§C-gated S phase closure. Reads .rsct/phase-state.json (must hold phase="spec" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "spec_complete:spec_ref=<X>". Next recommended phase: verification (optional — call rsct_phase_verification_start to run the audit-level sweep) or code (skip V phase).',
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

export async function phaseSpecCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseSpecCompleteOutput> {
  const input = phaseSpecCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: 'spec',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    internal,
  )
}

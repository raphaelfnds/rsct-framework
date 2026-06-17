import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import {
  PERSONA_SLUGS,
  scorePersonas,
  type PersonaMatchScore,
  type PersonaSlug,
} from '../lib/personas.js'

export const autoPersonaInputSchema = z
  .object({
    project_root: z.string().optional(),
    task_description: z
      .string()
      .min(10, 'task_description must be ≥10 chars')
      .describe(
        'Natural-language description of the task or subject being reviewed. The heuristic scans for each persona\'s keyword set (substring, case-insensitive).',
      ),
  })
  .strict()

export type AutoPersonaInput = z.infer<typeof autoPersonaInputSchema>

export interface AutoPersonaOutput {
  recommended_persona: PersonaSlug | null
  recommendation_score: number
  reasoning: string
  alternatives: PersonaMatchScore[]
  all_persona_slugs: readonly PersonaSlug[]
  hints: string[]
}

export const autoPersonaTool: Tool = {
  name: 'rsct_auto_persona',
  description:
    "Heuristic recommendation of the best-fit persona for a task. Scans the task description for each persona's keyword set (substring, case-insensitive) and returns the top match plus ranked alternatives. Returns recommended_persona=null when no persona keyword matches — that usually means the task description is too short or generic; consider rephrasing or calling rsct_persona_review with an explicit choice (e.g., 'senior-dev' as the default reviewer).",
  inputSchema: {
    type: 'object',
    required: ['task_description'],
    properties: {
      project_root: { type: 'string' },
      task_description: { type: 'string', minLength: 10 },
    },
    additionalProperties: false,
  },
}

export async function autoPersonaHandler(
  rawInput: unknown,
): Promise<AutoPersonaOutput> {
  const input = autoPersonaInputSchema.parse(rawInput ?? {})
  const ranked = scorePersonas(input.task_description)
  const top = ranked[0]
  const alternatives = ranked.slice(1)

  const hints: string[] = []

  if (!top) {
    hints.push(
      "No persona keyword matched the task description. The description may be too short or too abstract. Default to 'senior-dev' as a generalist reviewer, or pass an explicit slug to rsct_persona_review.",
    )
    return {
      recommended_persona: null,
      recommendation_score: 0,
      reasoning: 'no persona keywords matched the task description',
      alternatives: [],
      all_persona_slugs: PERSONA_SLUGS,
      hints,
    }
  }

  hints.push(
    `Recommended persona: '${top.persona}' (${top.score} keyword hit(s): ${top.matched_keywords.join(', ')}). ${alternatives.length > 0 ? `${alternatives.length} alternative(s) available.` : 'No alternatives matched.'}`,
  )

  return {
    recommended_persona: top.persona,
    recommendation_score: top.score,
    reasoning: `Top persona '${top.persona}' matched ${top.score} keyword(s): ${top.matched_keywords.join(', ')}.`,
    alternatives,
    all_persona_slugs: PERSONA_SLUGS,
    hints,
  }
}

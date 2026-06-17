import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import {
  PERSONA_SLUGS,
  getPersonaBySlug,
  scorePersonas,
  type PersonaSlug,
} from '../lib/personas.js'

export const personaReviewInputSchema = z
  .object({
    project_root: z.string().optional(),
    subject: z
      .string()
      .min(10, 'subject must be ≥10 chars')
      .describe(
        'The thing being reviewed — a task description, a spec excerpt, a code block, a diff summary. The persona returns a checklist tailored to it.',
      ),
    persona: z
      .enum(PERSONA_SLUGS as unknown as [PersonaSlug, ...PersonaSlug[]])
      .describe(
        `Persona slug. One of: ${PERSONA_SLUGS.join(', ')}. Call rsct_auto_persona first if you do not know which to use.`,
      ),
  })
  .strict()

export type PersonaReviewInput = z.infer<typeof personaReviewInputSchema>

export interface PersonaReviewOutput {
  persona: PersonaSlug
  name: string
  one_liner: string
  focus_areas: string[]
  questions_to_ask: string[]
  anti_patterns_to_check: string[]
  knowledge_categories_to_consult: string[]
  /** Persona keywords that hit the subject (subset of `lib/personas` `keywords`). */
  subject_signals: string[]
  hints: string[]
}

export const personaReviewTool: Tool = {
  name: 'rsct_persona_review',
  description:
    'Returns the chosen persona\'s lens (focus areas + questions + anti-patterns + knowledge categories) tailored to a subject. Read-only, no §C-gate, no state. Use when you have a concrete subject (a spec, a code block, a diff) and want to review it through a specific lens. Call rsct_auto_persona first if you need help picking the persona.',
  inputSchema: {
    type: 'object',
    required: ['subject', 'persona'],
    properties: {
      project_root: { type: 'string' },
      subject: { type: 'string', minLength: 10 },
      persona: { type: 'string', enum: [...PERSONA_SLUGS] },
    },
    additionalProperties: false,
  },
}

export async function personaReviewHandler(
  rawInput: unknown,
): Promise<PersonaReviewOutput> {
  const input = personaReviewInputSchema.parse(rawInput ?? {})
  const persona = getPersonaBySlug(input.persona)
  if (persona === null) {
    throw new Error(
      `unknown persona slug: ${input.persona} (this should be unreachable via Zod enum)`,
    )
  }

  // Find which of this persona's keywords appear in the subject —
  // not for ranking (single persona), just to surface to the dev.
  const lower = input.subject.toLowerCase()
  const subjectSignals = persona.keywords.filter((kw) => lower.includes(kw))

  const hints: string[] = []
  if (subjectSignals.length === 0) {
    // Other personas may be a better fit — surface the top one as a soft hint.
    const ranked = scorePersonas(input.subject)
    const top = ranked[0]
    if (top && top.persona !== persona.slug) {
      hints.push(
        `None of '${persona.slug}'s keywords matched the subject. The '${top.persona}' persona has ${top.score} keyword hit(s) — consider rsct_persona_review with persona='${top.persona}' for a more relevant lens.`,
      )
    } else {
      hints.push(
        `None of '${persona.slug}'s keywords matched the subject — the lens is still valid, but the persona may not be the best fit. Try rsct_auto_persona to see alternatives.`,
      )
    }
  } else {
    hints.push(
      `Persona '${persona.slug}' matched ${subjectSignals.length} signal(s): ${subjectSignals.join(', ')}. Review the subject against the listed questions and anti-patterns; consult the named knowledge categories before proceeding.`,
    )
  }

  return {
    persona: persona.slug,
    name: persona.name,
    one_liner: persona.one_liner,
    focus_areas: [...persona.focus_areas],
    questions_to_ask: [...persona.questions_to_ask],
    anti_patterns_to_check: [...persona.anti_patterns_to_check],
    knowledge_categories_to_consult: [...persona.knowledge_categories_to_consult],
    subject_signals: subjectSignals,
    hints,
  }
}

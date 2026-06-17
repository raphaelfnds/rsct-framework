import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import {
  readDecisions,
  type DecisionEntry,
  type DecisionStatus,
} from '../lib/decisions.js'

const filterSchema = z
  .object({
    kind: z.enum(['premise', 'adr']).optional(),
    tag: z.string().min(1).optional(),
    status: z.enum(['active', 'superseded', 'deprecated']).optional(),
  })
  .strict()

export const getDecisionsInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    filter: filterSchema.optional(),
  })
  .strict()

export type GetDecisionsInput = z.infer<typeof getDecisionsInputSchema>
type DecisionsFilter = NonNullable<GetDecisionsInput['filter']>

export interface GetDecisionsOutput {
  rsct_installed: boolean
  decisions_file: {
    exists: boolean
    path: string | null
  }
  total: number
  filtered_count: number
  decisions: DecisionEntry[]
  hints: string[]
}

export const getDecisionsTool: Tool = {
  name: 'rsct_get_decisions',
  description:
    'Returns architectural decisions (firm premises + ADRs) from documentation/decisions.md, optionally filtered by kind, tag, or status. Use this to verify whether a proposed change conflicts with existing premises, surface the rationale behind a prior choice, or sweep for superseded ADRs. Returns an empty list (not an error) when the file is missing.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      filter: {
        type: 'object',
        description: 'Optional filter — all fields combined as AND.',
        properties: {
          kind: {
            type: 'string',
            enum: ['premise', 'adr'],
            description: 'Restrict to firm premises (#N) or durable ADRs.',
          },
          tag: {
            type: 'string',
            description:
              'Match entries whose **Tags** line includes this exact tag (case-sensitive).',
          },
          status: {
            type: 'string',
            enum: ['active', 'superseded', 'deprecated'],
            description: 'Match entries whose **Status** line equals this value.',
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
}

export async function getDecisionsHandler(
  rawInput: unknown,
): Promise<GetDecisionsOutput> {
  const input = getDecisionsInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const snapshot = readDecisions(resolution.root)

  const all: DecisionEntry[] = [...snapshot.premises, ...snapshot.adrs]
  const filtered = applyFilter(all, input.filter)

  return {
    rsct_installed: resolution.rsct_installed,
    decisions_file: { exists: snapshot.exists, path: snapshot.path },
    total: all.length,
    filtered_count: filtered.length,
    decisions: filtered,
    hints: buildHints(snapshot, input.filter, filtered.length),
  }
}

function applyFilter(
  entries: DecisionEntry[],
  filter: DecisionsFilter | undefined,
): DecisionEntry[] {
  if (!filter) return entries
  return entries.filter((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return false
    if (filter.status && entry.status !== (filter.status as DecisionStatus)) return false
    if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false
    return true
  })
}

function buildHints(
  snapshot: ReturnType<typeof readDecisions>,
  filter: DecisionsFilter | undefined,
  filteredCount: number,
): string[] {
  const hints: string[] = []

  if (!snapshot.exists) {
    hints.push(
      'documentation/decisions.md not found — run /rsct-setup to scaffold the file before proposing decisions-dependent work.',
    )
    return hints
  }

  if (filter && filteredCount === 0) {
    hints.push(
      'Filter matched zero decisions. Re-run without the filter to see everything, or verify spelling of tag/status values.',
    )
  }

  return hints
}

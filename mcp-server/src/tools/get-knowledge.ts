import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import {
  KNOWN_CATEGORIES,
  readKnowledgeFile,
  readKnowledgeIndex,
  type KnowledgeSection,
} from '../lib/knowledge.js'

export const getKnowledgeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    category: z
      .string()
      .min(1)
      .describe(
        'Knowledge category file slug, matching documentation/knowledge/<category>.md. Canonical categories: ' +
          KNOWN_CATEGORIES.join(', '),
      ),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional case-insensitive substring filter; matches sections whose heading or body contain the query.',
      ),
  })
  .strict()

export type GetKnowledgeInput = z.infer<typeof getKnowledgeInputSchema>

export interface GetKnowledgeOutput {
  rsct_installed: boolean
  category: string
  is_canonical_category: boolean
  file: { exists: boolean; path: string | null }
  query: string | null
  sections_total: number
  sections_returned: number
  sections: KnowledgeSection[]
  available_categories: string[]
  hints: string[]
}

export const getKnowledgeTool: Tool = {
  name: 'rsct_get_knowledge',
  description:
    'Reads documentation/knowledge/<category>.md and returns its sections (split by ## and ### headings). Optional query performs a case-insensitive substring filter across heading and body. Use to recall business rules, anti-decisions, incidents, vendor history, or any other knowledge-graph category before making design choices that depend on institutional context. Returns empty sections (not an error) when the file is missing.',
  inputSchema: {
    type: 'object',
    required: ['category'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      category: {
        type: 'string',
        description:
          'Knowledge category file slug — documentation/knowledge/<category>.md. Canonical: ' +
          KNOWN_CATEGORIES.join(', '),
      },
      query: {
        type: 'string',
        description:
          'Optional case-insensitive substring; only sections whose heading or body matches are returned.',
      },
    },
    additionalProperties: false,
  },
}

export async function getKnowledgeHandler(
  rawInput: unknown,
): Promise<GetKnowledgeOutput> {
  const input = getKnowledgeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const index = readKnowledgeIndex(resolution.root)
  const file = readKnowledgeFile(resolution.root, input.category)

  const isCanonical = (KNOWN_CATEGORIES as readonly string[]).includes(input.category)
  const sections = filterSections(file.sections, input.query)

  return {
    rsct_installed: resolution.rsct_installed,
    category: input.category,
    is_canonical_category: isCanonical,
    file: { exists: file.exists, path: file.path },
    query: input.query ?? null,
    sections_total: file.sections.length,
    sections_returned: sections.length,
    sections,
    available_categories: index.categories_present,
    hints: buildHints({
      rsctInstalled: resolution.rsct_installed,
      category: input.category,
      isCanonical,
      fileExists: file.exists,
      sectionsTotal: file.sections.length,
      sectionsReturned: sections.length,
      query: input.query,
      availableCategories: index.categories_present,
    }),
  }
}

function filterSections(
  sections: KnowledgeSection[],
  query: string | undefined,
): KnowledgeSection[] {
  if (!query) return sections
  const needle = query.toLowerCase()
  return sections.filter(
    (s) =>
      s.heading.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle),
  )
}

interface HintArgs {
  rsctInstalled: boolean
  category: string
  isCanonical: boolean
  fileExists: boolean
  sectionsTotal: number
  sectionsReturned: number
  query: string | undefined
  availableCategories: string[]
}

function buildHints(args: HintArgs): string[] {
  const hints: string[] = []

  if (!args.rsctInstalled) {
    hints.push(
      'Project is not rsct-managed — knowledge graph likely absent. Run /rsct-setup before relying on this tool.',
    )
    return hints
  }

  if (!args.fileExists) {
    if (!args.isCanonical) {
      hints.push(
        `Category '${args.category}' is not canonical and the file does not exist. Canonical categories: ${KNOWN_CATEGORIES.join(', ')}.`,
      )
    } else {
      hints.push(
        `documentation/knowledge/${args.category}.md does not exist yet. ` +
          `Available now: ${
            args.availableCategories.length > 0
              ? args.availableCategories.join(', ')
              : '(none)'
          }. Bootstrap with /rsct-setup or capture inline during conversation.`,
      )
    }
    return hints
  }

  if (args.sectionsTotal === 0) {
    hints.push(
      `${args.category}.md exists but has no ## or ### sections — file may only contain a top-level intro. Consider capturing structured entries.`,
    )
    return hints
  }

  if (args.query && args.sectionsReturned === 0) {
    hints.push(
      `Query '${args.query}' did not match any section in ${args.category}.md (${args.sectionsTotal} sections scanned). Try a broader term or call without query to see all sections.`,
    )
  }

  return hints
}

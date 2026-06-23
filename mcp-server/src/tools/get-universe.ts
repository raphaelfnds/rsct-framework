import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { getUniverse } from '../lib/universe.js'
import {
  readUniverseDoc,
  KNOWN_GOVERNANCE_DOCS,
  type UniverseDocFile,
  type UniverseGovernanceIndex,
} from '../lib/universe-content.js'
import type { MarkdownSection } from '../lib/markdown.js'

const SCOPES = ['governance', 'index', 'all'] as const

export const getUniverseInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    scope: z
      .enum(SCOPES)
      .default('governance')
      .describe(
        'governance: read docs/governance/*.md. index: read docs/INDEX.md. all: both.',
      ),
    doc: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional governance doc slug to narrow scope=governance to one file ' +
          '(docs/governance/<doc>.md). Canonical docs: ' +
          KNOWN_GOVERNANCE_DOCS.join(', ') +
          '. Ignored for scope=index.',
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

export type GetUniverseInput = z.infer<typeof getUniverseInputSchema>

export interface GetUniverseOutput {
  rsct_installed: boolean
  universe_available: boolean
  universe_path: string | null
  /** Degraded / configured-missing / reconciliation diagnostic from the block. */
  universe_note: string | null
  scope: (typeof SCOPES)[number]
  doc: string | null
  query: string | null
  governance: UniverseGovernanceIndex
  docs: UniverseDocFile[]
  hints: string[]
}

export const getUniverseTool: Tool = {
  name: 'rsct_get_universe',
  description:
    "Reads the linked org-level universe's governance content. scope=governance reads docs/governance/*.md (all unless doc narrows it); scope=index reads docs/INDEX.md; scope=all reads both. Optional query is a case-insensitive substring filter over section heading + body. Use this when rsct_status reports a universe available, to consult org naming standards / canonical-sources map / governance before proposing new structure (the §0 rule treats org standards as authoritative over local guesses). Returns empty docs (not an error) when no universe is linked or governance is unscaffolded.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        default: 'governance',
        description:
          'governance: docs/governance/*.md. index: docs/INDEX.md. all: both.',
      },
      doc: {
        type: 'string',
        description:
          'Optional governance doc slug; narrows scope=governance to one file (docs/governance/<doc>.md). Canonical: ' +
          KNOWN_GOVERNANCE_DOCS.join(', ') +
          '. Ignored for scope=index.',
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

/** Which doc slugs to read, given the scope/doc and the disk-driven index (V FV5). */
function resolveRequestedSlugs(
  scope: (typeof SCOPES)[number],
  doc: string | undefined,
  index: UniverseGovernanceIndex,
): string[] {
  if (scope === 'index') return ['INDEX']
  const governance = doc ? (index.docs.includes(doc) ? [doc] : []) : index.docs
  if (scope === 'all') return ['INDEX', ...governance]
  return governance // 'governance'
}

function filterSections(
  sections: MarkdownSection[],
  query: string | undefined,
): MarkdownSection[] {
  if (!query) return sections
  const needle = query.toLowerCase()
  return sections.filter(
    (s) =>
      s.heading.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle),
  )
}

export async function getUniverseHandler(rawInput: unknown): Promise<GetUniverseOutput> {
  const input = getUniverseInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  // Single source: getUniverse resolves the universe + computes the governance
  // index (on the found+readable path). block.local_path is the universe root.
  const { block } = getUniverse(resolution.config, resolution.root)
  const hints: string[] = []

  if (!block.available || !block.local_path) {
    if (block.note) {
      hints.push(`${block.note}.`)
    } else {
      hints.push(
        'No universe is linked to this project. Run /rsct-canonical-source to link the org universe, then this tool can read its governance docs.',
      )
    }
    return {
      rsct_installed: resolution.rsct_installed,
      universe_available: false,
      universe_path: block.local_path,
      universe_note: block.note,
      scope: input.scope,
      doc: input.doc ?? null,
      query: input.query ?? null,
      governance: block.governance,
      docs: [],
      hints,
    }
  }

  const index = block.governance
  const slugs = resolveRequestedSlugs(input.scope, input.doc, index)
  const docs = slugs.map((slug) => {
    const file = readUniverseDoc(block.local_path as string, slug)
    return { ...file, sections: filterSections(file.sections, input.query) }
  })

  // Hints (content-focused; the index never adds a status/load_context hint — V FV4).
  if (input.scope !== 'index' && index.docs.length === 0) {
    hints.push(
      `Universe at ${block.local_path} has no governance docs (docs/governance/ ${index.available ? 'is empty' : 'is missing'}). Run /rsct-init-universe to scaffold them.`,
    )
  }
  if (input.doc && input.scope !== 'index' && !index.docs.includes(input.doc)) {
    hints.push(
      `No docs/governance/${input.doc}.md in the universe. Available: ${
        index.docs.length > 0 ? index.docs.join(', ') : '(none)'
      }.`,
    )
  }
  if (input.scope === 'index' && docs[0] && !docs[0].exists) {
    hints.push(
      `Universe at ${block.local_path} has no docs/INDEX.md. Run /rsct-init-universe to scaffold it.`,
    )
  }
  if (input.query && docs.length > 0 && docs.every((d) => d.sections.length === 0)) {
    hints.push(
      `Query '${input.query}' matched no section in the requested doc(s). Try a broader term or omit query.`,
    )
  }

  return {
    rsct_installed: resolution.rsct_installed,
    universe_available: true,
    universe_path: block.local_path,
    universe_note: block.note,
    scope: input.scope,
    doc: input.doc ?? null,
    query: input.query ?? null,
    governance: index,
    docs,
    hints,
  }
}

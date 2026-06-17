import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import {
  readArchitectureModules,
  readArchitectureOverview,
  type ArchitectureFile,
  type ArchitectureModuleFile,
  type ArchitectureModuleSet,
} from '../lib/architecture.js'

const SCOPES = ['overview', 'module', 'impact', 'all'] as const

export const getArchitectureInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    scope: z.enum(SCOPES).default('overview'),
    module_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional module slug to narrow scope=module or scope=impact to a single file. Matches the basename without .md.',
      ),
  })
  .strict()

export type GetArchitectureInput = z.infer<typeof getArchitectureInputSchema>

export interface GetArchitectureOutput {
  rsct_installed: boolean
  scope: (typeof SCOPES)[number]
  module_name: string | null
  overview?: ArchitectureFile
  modules?: FilteredModuleSet
  impacts?: FilteredModuleSet
  hints: string[]
}

interface FilteredModuleSet extends ArchitectureModuleSet {
  filtered_by_name: boolean
}

export const getArchitectureTool: Tool = {
  name: 'rsct_get_architecture',
  description:
    'Returns architectural reference material. scope=overview reads documentation/architecture.md; scope=module reads documentation/modules/*.md (all modules unless module_name narrows it); scope=impact reads documentation/impact/*.md the same way; scope=all returns everything. Use this before proposing changes that touch a module — especially to check the impact file for non-obvious couplings and pre-merge checklists.',
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
        default: 'overview',
        description:
          'overview: read architecture.md. module: read modules/*.md. impact: read impact/*.md. all: read all three.',
      },
      module_name: {
        type: 'string',
        description:
          'Optional module slug; narrows scope=module or scope=impact to one file (basename without .md). Ignored for overview.',
      },
    },
    additionalProperties: false,
  },
}

export async function getArchitectureHandler(
  rawInput: unknown,
): Promise<GetArchitectureOutput> {
  const input = getArchitectureInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const hints: string[] = []

  const result: GetArchitectureOutput = {
    rsct_installed: resolution.rsct_installed,
    scope: input.scope,
    module_name: input.module_name ?? null,
    hints,
  }

  const wantsOverview = input.scope === 'overview' || input.scope === 'all'
  const wantsModules = input.scope === 'module' || input.scope === 'all'
  const wantsImpact = input.scope === 'impact' || input.scope === 'all'

  if (wantsOverview) {
    const overview = readArchitectureOverview(resolution.root)
    result.overview = overview
    if (!overview.exists) {
      hints.push(
        'documentation/architecture.md not found — bootstrap with /rsct-setup or capture inline.',
      )
    } else if (overview.sections.length === 0) {
      hints.push(
        'architecture.md exists but contains no ## or ### sections — likely still on TODO scaffolding.',
      )
    }
  }

  if (wantsModules) {
    result.modules = applyNameFilter(
      readArchitectureModules(resolution.root, 'modules'),
      input.module_name,
    )
    surfaceFilterHints(hints, 'modules', result.modules, input.module_name)
  }

  if (wantsImpact) {
    result.impacts = applyNameFilter(
      readArchitectureModules(resolution.root, 'impact'),
      input.module_name,
    )
    surfaceFilterHints(hints, 'impacts', result.impacts, input.module_name)
  }

  if (!resolution.rsct_installed) {
    hints.unshift(
      'Project is not rsct-managed — architecture docs likely absent. Run /rsct-setup before relying on this tool.',
    )
  }

  return result
}

function applyNameFilter(
  set: ArchitectureModuleSet,
  moduleName: string | undefined,
): FilteredModuleSet {
  if (!moduleName) return { ...set, filtered_by_name: false }
  const files: ArchitectureModuleFile[] = set.files.filter((f) => f.name === moduleName)
  return { ...set, files, filtered_by_name: true }
}

function surfaceFilterHints(
  hints: string[],
  label: 'modules' | 'impacts',
  set: FilteredModuleSet,
  moduleName: string | undefined,
): void {
  const subdirLabel = label === 'modules' ? 'documentation/modules' : 'documentation/impact'
  if (!set.directory_exists) {
    hints.push(
      `${subdirLabel}/ directory missing — bootstrap with /rsct-setup or capture inline.`,
    )
    return
  }
  if (moduleName && set.files.length === 0) {
    hints.push(
      `No ${subdirLabel}/${moduleName}.md found. List of available ${label}: read with the same scope and no module_name to see all.`,
    )
  }
  if (!moduleName && set.files.length === 0) {
    hints.push(
      `${subdirLabel}/ exists but contains zero .md files (besides README). Likely still on TODO scaffolding.`,
    )
  }
}

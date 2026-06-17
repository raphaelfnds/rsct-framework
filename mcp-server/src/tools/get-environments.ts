import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import {
  computeProfileDeltas,
  discoverEnvFiles,
  parseEnvFileAt,
  type ParsedEnvFile,
  type ProfileDelta,
} from '../lib/env-files.js'
import {
  readInfrastructure,
  type InfrastructureEntry,
} from '../lib/infrastructure.js'

const SCOPES = ['profiles', 'infrastructure', 'all'] as const

export const getEnvironmentsInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    scope: z.enum(SCOPES),
  })
  .strict()

export type GetEnvironmentsInput = z.infer<typeof getEnvironmentsInputSchema>

export interface ProfilesSection {
  search_paths: string[]
  detected_profiles: string[]
  files: ParsedEnvFile[]
  profile_deltas: ProfileDelta[]
  yaml_files_detected_but_not_parsed: string[]
}

export interface InfrastructureSection {
  file: { exists: boolean; path: string | null }
  entries: InfrastructureEntry[]
}

export interface GetEnvironmentsOutput {
  rsct_installed: boolean
  scope: (typeof SCOPES)[number]
  profiles?: ProfilesSection
  infrastructure?: InfrastructureSection
  hints: string[]
}

export const getEnvironmentsTool: Tool = {
  name: 'rsct_get_environments',
  description:
    'Returns N2 environment profiles (application.properties / .env*) and/or N3 infrastructure inventory (documentation/infrastructure.md). Profile values matching INV-6 secret patterns are masked. Use scope=profiles to compare prod/dev/test config deltas, scope=infrastructure to recall what runtime services exist before proposing new ones, or scope=all for both. YAML files are detected but not parsed in v1 (limitation surfaced via hint).',
  inputSchema: {
    type: 'object',
    required: ['scope'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        description:
          'profiles: parse .properties + .env*. infrastructure: parse documentation/infrastructure.md. all: both.',
      },
    },
    additionalProperties: false,
  },
}

export async function getEnvironmentsHandler(
  rawInput: unknown,
): Promise<GetEnvironmentsOutput> {
  const input = getEnvironmentsInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const hints: string[] = []

  if (!resolution.rsct_installed) {
    hints.push(
      'Project is not rsct-managed — env discovery still runs but results may be incomplete. Run /rsct-setup before relying on this tool.',
    )
  }

  const result: GetEnvironmentsOutput = {
    rsct_installed: resolution.rsct_installed,
    scope: input.scope,
    hints,
  }

  if (input.scope === 'profiles' || input.scope === 'all') {
    result.profiles = collectProfiles(resolution.root, hints)
  }

  if (input.scope === 'infrastructure' || input.scope === 'all') {
    result.infrastructure = collectInfrastructure(resolution.root, hints)
  }

  return result
}

function collectProfiles(projectRoot: string, hints: string[]): ProfilesSection {
  const discovered = discoverEnvFiles(projectRoot)
  const allPaths = [...discovered.properties_files, ...discovered.env_files]
  const files: ParsedEnvFile[] = []
  for (const rel of allPaths) {
    const parsed = parseEnvFileAt(projectRoot, rel)
    if (parsed) files.push(parsed)
  }

  const detected_profiles = Array.from(
    new Set(files.map((f) => f.profile).filter((p): p is string => p !== null)),
  ).sort()

  const profile_deltas = computeProfileDeltas(files)

  if (files.length === 0 && discovered.yaml_files.length === 0) {
    hints.push(
      'No application.properties / .env / application.yml files detected in standard locations (project root, src/main/resources, src/main/resources/config, config, resources). Confirm naming/location with dev before drawing conclusions.',
    )
  }
  if (discovered.yaml_files.length > 0) {
    hints.push(
      `YAML config files detected (${discovered.yaml_files.length}) but not parsed in v1 — open F2.3.1 to add YAML support if needed. Affected: ${discovered.yaml_files.join(', ')}.`,
    )
  }
  const maskedCount = files.reduce(
    (n, f) => n + f.entries.filter((e) => e.masked).length,
    0,
  )
  if (maskedCount > 0) {
    hints.push(
      `${maskedCount} env value(s) masked under INV-6 secret patterns; the canonical regex lives in mcp-server/src/lib/secrets.ts.`,
    )
  }

  return {
    search_paths: discovered.search_paths,
    detected_profiles,
    files,
    profile_deltas,
    yaml_files_detected_but_not_parsed: discovered.yaml_files,
  }
}

function collectInfrastructure(
  projectRoot: string,
  hints: string[],
): InfrastructureSection {
  const snapshot = readInfrastructure(projectRoot)
  if (!snapshot.exists) {
    hints.push(
      'documentation/infrastructure.md does not exist — scope=infrastructure returned empty. Bootstrap via /rsct-setup (Phase 4.5b) or capture inline.',
    )
  } else if (snapshot.entries.length === 0) {
    hints.push(
      'documentation/infrastructure.md exists but contains zero `### INFRA-NNN — ...` entries. Likely still on TODO scaffolding.',
    )
  }
  return {
    file: { exists: snapshot.exists, path: snapshot.path },
    entries: snapshot.entries,
  }
}

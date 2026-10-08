import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { judgeEditScope } from '../lib/edit-guard.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readPhaseState, type PhaseState } from '../lib/phase-scope.js'

const phaseStateOverrideSchema = z
  .object({
    spec_slug: z.string().optional(),
    phase: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    started_at: z.string().optional(),
    context_stale: z
      .object({ since: z.string(), reason: z.enum(['plan_closed', 'pivot']) })
      .strict()
      .optional(),
  })
  .strict()

export const checkEditScopeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    file_path: z
      .string()
      .min(1, 'file_path required')
      .describe('Path to check against the active spec scope. Forward and backslash both accepted.'),
    phase_state_override: phaseStateOverrideSchema
      .optional()
      .describe(
        'Programmatic override of `.rsct/phase-state.json`. When provided, the file is NOT read from disk.',
      ),
  })
  .strict()

export type CheckEditScopeInput = z.infer<typeof checkEditScopeInputSchema>

export type ScopeStatus = 'in_scope' | 'out_of_scope' | 'unknown' | 'stale_context'

export interface CheckEditScopeOutput {
  rsct_installed: boolean
  phase_state_exists: boolean
  phase_state_parse_error?: string
  spec_slug: string | null
  phase: string | null
  file_path: string
  status: ScopeStatus
  matched_glob: string | null
  scope_globs: string[]
  hints: string[]
}

export const checkEditScopeTool: Tool = {
  name: 'rsct_check_edit_scope',
  description:
    'Pure query: returns whether `file_path` falls inside the active spec phase scope (`.rsct/phase-state.json` `scope_globs[]`). Until the M3 phase machine writes that file, this tool returns status="unknown" and a hint explaining why. Pass `phase_state_override` to test scoping without writing to disk.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      file_path: {
        type: 'string',
        description: 'Path to check against the active spec scope.',
      },
      phase_state_override: {
        type: 'object',
        description:
          'Programmatic override of `.rsct/phase-state.json`. When provided, the file is NOT read from disk.',
        properties: {
          spec_slug: { type: 'string' },
          phase: { type: 'string' },
          scope_globs: { type: 'array', items: { type: 'string' } },
          started_at: { type: 'string' },
          context_stale: {
            type: 'object',
            properties: {
              since: { type: 'string' },
              reason: { type: 'string', enum: ['plan_closed', 'pivot'] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
}

export async function checkEditScopeHandler(
  rawInput: unknown,
): Promise<CheckEditScopeOutput> {
  const input = checkEditScopeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  let phase_state_exists: boolean
  let state: PhaseState | null
  let parse_error: string | undefined

  if (input.phase_state_override !== undefined) {
    phase_state_exists = true
    const override = input.phase_state_override
    const rebuilt: PhaseState = {}
    if (override.spec_slug !== undefined) rebuilt.spec_slug = override.spec_slug
    if (override.phase !== undefined) rebuilt.phase = override.phase
    if (override.scope_globs !== undefined) rebuilt.scope_globs = override.scope_globs
    if (override.started_at !== undefined) rebuilt.started_at = override.started_at
    if (override.context_stale !== undefined) rebuilt.context_stale = override.context_stale
    state = rebuilt
  } else {
    const read = readPhaseState(resolution.root)
    phase_state_exists = read.exists
    state = read.state
    parse_error = read.parse_error
  }

  const scope_globs = state?.scope_globs ?? []
  const verdict = judgeEditScope({
    projectRoot: resolution.root,
    filePath: input.file_path,
    state,
    stateExists: phase_state_exists,
  })
  const status: ScopeStatus = verdict.status
  const matched_glob = verdict.status === 'in_scope' ? verdict.matched_glob : null

  const output: CheckEditScopeOutput = {
    rsct_installed: resolution.rsct_installed,
    phase_state_exists,
    spec_slug: state?.spec_slug ?? null,
    phase: state?.phase ?? null,
    file_path: input.file_path,
    status,
    matched_glob,
    scope_globs,
    hints: buildHints({
      rsct_installed: resolution.rsct_installed,
      phase_state_exists,
      state,
      parse_error,
      status,
      file_path: input.file_path,
      matched_glob,
      outside_project: verdict.status === 'unknown' && verdict.why === 'outside_project',
      network_path: verdict.status === 'out_of_scope' && verdict.why === 'network_path',
      judged_as: verdict.status === 'out_of_scope' && verdict.why === 'not_listed' ? verdict.judged_as : null,
    }),
  }
  if (parse_error !== undefined) output.phase_state_parse_error = parse_error
  return output
}

interface HintInputs {
  rsct_installed: boolean
  phase_state_exists: boolean
  state: PhaseState | null
  parse_error: string | undefined
  status: ScopeStatus
  file_path: string
  matched_glob: string | null
  outside_project: boolean
  network_path: boolean
  judged_as: string | null
}

function buildHints(input: HintInputs): string[] {
  const hints: string[] = []
  if (!input.rsct_installed) {
    hints.push('No .rsct.json — running scope check with no project context.')
  }
  if (input.status === 'stale_context') {
    hints.push(
      '⛔ Context is STALE — a plan closed (or a pivot was declared). Run rsct_status + rsct_load_context to re-read plan / universe / decisions before editing. This edit is blocked until context is reloaded.',
    )
    return hints
  }
  if (!input.phase_state_exists) {
    hints.push(
      'No .rsct/phase-state.json yet — the phase machine ships in M3. Until then, this tool always returns status=unknown for live queries; pass `phase_state_override` for what-if checks.',
    )
    return hints
  }
  if (input.parse_error) {
    hints.push(
      `.rsct/phase-state.json exists but failed to parse (${input.parse_error}). Treating scope as unknown.`,
    )
    return hints
  }
  if (input.state && (!input.state.scope_globs || input.state.scope_globs.length === 0)) {
    hints.push(
      '.rsct/phase-state.json is present but scope_globs is empty — cannot evaluate. Update the phase state to declare scope.',
    )
    return hints
  }
  if (input.outside_project) {
    hints.push(
      `File '${input.file_path}' is outside the project root — the phase scope does not govern it.`,
    )
  } else if (input.status === 'in_scope') {
    hints.push(
      input.matched_glob === null
        ? 'File is a plan-tracking file (plan_*.md, progress_*.md or spec_*.md at the project root) — always editable while a scope is active.'
        : `File is in scope via glob '${input.matched_glob}'. Edits proceed normally.`,
    )
  } else if (input.network_path) {
    hints.push(
      `File '${input.file_path}' is a network-style path on another root than the project — it cannot be compared with the project root, so it is treated as out of scope. Use the file's path under the project root, or a path on a local drive.`,
    )
  } else if (input.status === 'out_of_scope') {
    hints.push(
      `File '${input.file_path}' is OUTSIDE the active spec scope. Either expand scope_globs in the phase state with explicit dev approval, or pause and re-plan before editing.`,
    )
    if (input.judged_as !== null) {
      hints.push(
        `It was judged as '${input.judged_as}' below the project root; list entries are relative to that root and compared case-sensitively with the spelling on disk.`,
      )
    }
  }
  return hints
}

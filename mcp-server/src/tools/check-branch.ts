import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState } from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
  type ProtectedListSource,
} from '../lib/branch-protection.js'

export const checkBranchInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    branch: z
      .string()
      .optional()
      .describe(
        'Optional branch name to check instead of the current git HEAD. Useful for what-if queries.',
      ),
  })
  .strict()

export type CheckBranchInput = z.infer<typeof checkBranchInputSchema>

export interface CheckBranchOutput {
  rsct_installed: boolean
  in_git_repo: boolean
  branch: string | null
  is_protected: boolean
  protected_list: string[]
  source: ProtectedListSource
  hints: string[]
}

export const checkBranchTool: Tool = {
  name: 'rsct_check_branch',
  description:
    'Pure query: returns whether the current (or given) branch is in the protected list. Reads `protected_branches` and `protected_patterns_extra` from .rsct.json (falls back to the default list main/master/test/dev). Does NOT block — use rsct_request_commit/push/merge to actually gate a mutation. Always succeeds; degrades gracefully outside git or outside an rsct project.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      branch: {
        type: 'string',
        description:
          'Optional branch name to check instead of the current git HEAD. Useful for what-if queries.',
      },
    },
    additionalProperties: false,
  },
}

export async function checkBranchHandler(rawInput: unknown): Promise<CheckBranchOutput> {
  const input = checkBranchInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const git = readGitState(resolution.root)

  const { list, source } = effectiveProtectedList(resolution.config ?? undefined)

  const branch = input.branch ?? git.branch
  const in_git_repo = git.available
  const is_protected = isProtectedBranch(branch, list)

  return {
    rsct_installed: resolution.rsct_installed,
    in_git_repo,
    branch,
    is_protected,
    protected_list: list,
    source,
    hints: buildHints({
      rsct_installed: resolution.rsct_installed,
      in_git_repo,
      branch,
      is_protected,
      explicitBranch: input.branch !== undefined,
    }),
  }
}

interface HintInputs {
  rsct_installed: boolean
  in_git_repo: boolean
  branch: string | null
  is_protected: boolean
  explicitBranch: boolean
}

function buildHints(input: HintInputs): string[] {
  const hints: string[] = []

  if (!input.rsct_installed) {
    hints.push(
      'No .rsct.json — using the default protected list (main/master/test/dev). Run /rsct-setup to customize.',
    )
  }

  if (!input.in_git_repo && !input.explicitBranch) {
    hints.push(
      'Not inside a git repository — branch protection cannot be evaluated against a live HEAD. Pass `branch` explicitly for a what-if check.',
    )
    return hints
  }

  if (input.branch === null) {
    hints.push(
      'Could not resolve a branch name (detached HEAD?). Treating as unprotected.',
    )
    return hints
  }

  if (input.is_protected) {
    hints.push(
      `Branch '${input.branch}' is protected. Mutating tools (rsct_request_commit / _push / _merge) will reject unless dev_approval includes override_protected_branch: { reason }. Prefer creating a derived branch first: git checkout -b <slug>.`,
    )
  } else {
    hints.push(`Branch '${input.branch}' is not in the protected list.`)
  }

  return hints
}

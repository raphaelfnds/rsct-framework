import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState, readWorktreeInfo, type WorktreeInfo } from '../lib/git.js'
import { stampBootstrapMarker } from '../lib/phase-scope.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
import { getUniverse, type UniverseBlock } from '../lib/universe.js'
import { getUpdateNotice } from '../lib/update-check.js'

export const statusInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
  })
  .strict()

export type StatusInput = z.infer<typeof statusInputSchema>

export interface StatusOutput {
  mcp_server: { name: string; version: string }
  rsct_installed: boolean
  project: {
    root: string
    app_name: string | null
    org_slug: string | null
    rsct_version: string | null
    protected_branches: string[]
    test_framework: string | null
  }
  git: ReturnType<typeof readGitState>
  /** T3: git worktree context (is this a linked worktree? — isolated rsct state). */
  worktree: WorktreeInfo
  universe: UniverseBlock
  hints: string[]
}

export const statusTool: Tool = {
  name: 'rsct_status',
  description:
    'Bootstrap check: returns whether the current project is rsct-managed (has .rsct.json), the project identity, protected branches, current git branch, and one-line hints for Claude. Always succeeds — degrades gracefully when not in an rsct project. Call this near the start of any session in an unfamiliar project.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
    },
    additionalProperties: false,
  },
}

const MCP_VERSION = RSCT_MCP_VERSION

export async function statusHandler(rawInput: unknown): Promise<StatusOutput> {
  const input = statusInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const git = readGitState(resolution.root)

  // CAP-31: stamp bootstrap marker so downstream mutating tools can
  // detect whether §0 was performed in this session window. Stamping is
  // best-effort — a write failure is swallowed silently (status itself
  // is a read-only diagnostic and never fails on metadata write).
  if (resolution.rsct_installed) {
    stampBootstrapMarker(resolution.root)
  }

  const hints = buildStatusHints(resolution, git)

  // T3: worktree context. When running inside a LINKED worktree, the rsct
  // runtime state (.rsct/phase-state.json incl. any plan-authorization token,
  // .rsct/approvals-seen.json) is isolated to THIS worktree — surfacing this
  // helps an agent reason about parallel/isolated execution. Never throws.
  const worktree = readWorktreeInfo(resolution.root)
  if (worktree.is_worktree) {
    hints.push(
      `Running in a linked git worktree${worktree.name ? ` ('${worktree.name}')` : ''} — RSCT phase-state, any plan-authorization token, and the anti-reuse store are isolated to THIS worktree (independent of the main worktree and sibling worktrees).`,
    )
  }

  // T1.a: surface the org-level universe (single source — load_context calls the
  // same getUniverse). Fail-graceful: never throws; absent universe → behaves as
  // before (available:false, no hint).
  const universe = getUniverse(resolution.config, resolution.root)
  if (universe.hint) hints.push(universe.hint)

  // T4: opt-in, cached, fail-silent "a newer RSCT release is available" hint.
  // Reads only the ~/.rsct cache (zero network latency); a stale cache fires a
  // non-blocking background refresh. No-op unless consent was granted at /rsct-setup.
  const update = getUpdateNotice()
  if (update.hint) hints.push(update.hint)

  return {
    mcp_server: { name: 'rsct-mcp', version: MCP_VERSION },
    rsct_installed: resolution.rsct_installed,
    project: {
      root: resolution.root,
      app_name: resolution.config?.app?.name ?? null,
      org_slug: resolution.config?.app?.org ?? null,
      rsct_version: resolution.config?.rsct_version ?? null,
      protected_branches: resolution.config?.protected_branches ?? [],
      test_framework: resolution.config?.test_framework ?? null,
    },
    git,
    worktree,
    universe: universe.block,
    hints,
  }
}

function buildStatusHints(
  resolution: ReturnType<typeof resolveProjectRoot>,
  git: ReturnType<typeof readGitState>,
): string[] {
  const hints: string[] = []

  if (!resolution.rsct_installed) {
    hints.push(
      'No .rsct.json found in this project — rsct-mcp tools are available but project-level governance is not configured. Suggest running /rsct-setup to initialize.',
    )
    return hints
  }

  const protected_branches = resolution.config?.protected_branches ?? []
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `Current branch '${git.branch}' is in protected_branches. §D requires a derived branch (feat/, fix/, chore/, docs/) for any mutating work — confirm with dev before proposing changes.`,
    )
  }

  if (git.available && git.is_clean === false) {
    hints.push(
      'Working tree has uncommitted changes — surface them in the next plan/spec phase so they are not lost.',
    )
  }

  if (!resolution.config?.test_framework) {
    hints.push(
      'No test_framework recorded in .rsct.json — §G testing strategy will need explicit dev input until detected.',
    )
  }

  return hints
}

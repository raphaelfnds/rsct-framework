import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState, readWorktreeInfo, type WorktreeInfo } from '../lib/git.js'
import { effectiveProtectedList } from '../lib/branch-protection.js'
import {
  BOOTSTRAP_STALE_MS,
  bootstrapWriteFailureHint,
  readThenStampBootstrap,
  truncateForHint,
  UNREADABLE_STATE_ADVICE,
  type BootstrapRefresh,
} from '../lib/phase-scope.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
import { getUniverse, type UniverseBlock } from '../lib/universe.js'
import { detectTopology, type TopologyBlock } from '../lib/topology.js'
import {
  declineUpdateTag,
  getUpdateNotice,
  isUpdateCheckKilled,
  setUpdateCheckConsent,
  type UpdateOptions,
} from '../lib/update-check.js'
import { getInstallDriftNotice } from '../lib/version-drift.js'

export const statusInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    update_check: z.coerce.string().optional(),
    decline_update: z.coerce.string().optional(),
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
  worktree: WorktreeInfo
  universe: UniverseBlock
  topology: TopologyBlock
  hints: string[]
}

export const statusTool: Tool = {
  name: 'rsct_status',
  description:
    'Bootstrap check: returns whether the current project is rsct-managed (has .rsct.json), the project identity, protected branches, current git branch, and one-line hints for Claude. Always succeeds — degrades gracefully when not in an rsct project. Call this near the start of any session in an unfamiliar project. Some hints are addressed to the DEV, not to you (a newer release is available, the update check is off, install drift): surface those to them and let them answer — do not consume them silently, since they are emitted a bounded number of times and are then gone for good.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      update_check: {
        type: 'string',
        enum: ['on', 'off'],
        description:
          'Turn the GitHub update check on or off for this machine. It is ON by default (an unauthenticated GET of the latest release tag, once a day, cached, suggestion-only — no project data is sent). Pass "off" only when the dev asks for it; "on" re-enables it.',
      },
      decline_update: {
        type: 'string',
        description:
          'Record that the dev declined a specific release, e.g. "v2.6.0" — that release is never raised again, a newer one asks once more. Only the release currently being offered is accepted; any other tag is rejected. Pass this ONLY when the dev has actually declined.',
      },
    },
    additionalProperties: false,
  },
}

const MCP_VERSION = RSCT_MCP_VERSION

export async function statusHandler(
  rawInput: unknown,
  deps: { update?: UpdateOptions } = {},
): Promise<StatusOutput> {
  const input = statusInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const git = readGitState(resolution.root)

  const bootstrap: BootstrapRefresh | null = resolution.rsct_installed
    ? readThenStampBootstrap(resolution.root)
    : null

  const hints = buildStatusHints(resolution, git)
  if (bootstrap) hints.push(...bootstrapHints(bootstrap))

  const worktree = readWorktreeInfo(resolution.root)
  if (worktree.is_worktree) {
    hints.push(
      `Running in a linked git worktree${worktree.name ? ` ('${worktree.name}')` : ''} — RSCT phase-state, any plan-authorization token, and the anti-reuse store are isolated to THIS worktree (independent of the main worktree and sibling worktrees).`,
    )
  }

  const universe = getUniverse(resolution.config, resolution.root)
  if (universe.hint) hints.push(universe.hint)

  const topology = detectTopology(resolution.config, resolution.root, {}, universe)
  if (topology.hint) hints.push(topology.hint)

  applyUpdateMutations(input, deps.update, hints)
  hints.push(...getUpdateNotice(deps.update).hints)

  if (resolution.rsct_installed) {
    const drift = getInstallDriftNotice({
      projectRoot: resolution.root,
      projectVersion: resolution.config?.rsct_version ?? null,
      mcpVersion: MCP_VERSION,
    })
    if (drift.hint) hints.push(drift.hint)
  }

  return {
    mcp_server: { name: 'rsct-mcp', version: MCP_VERSION },
    rsct_installed: resolution.rsct_installed,
    project: {
      root: resolution.root,
      app_name: resolution.config?.app?.name ?? null,
      org_slug: resolution.config?.app?.org ?? null,
      rsct_version: resolution.config?.rsct_version ?? null,
      protected_branches: resolution.rsct_installed
        ? effectiveProtectedList(resolution.config ?? undefined).list
        : [],
      test_framework: resolution.config?.test_framework ?? null,
    },
    git,
    worktree,
    universe: universe.block,
    topology: topology.block,
    hints,
  }
}

function applyUpdateMutations(input: StatusInput, opts: UpdateOptions | undefined, hints: string[]): void {
  if (input.update_check === undefined && input.decline_update === undefined) return

  const killed = isUpdateCheckKilled(opts)
  const CANNOT_READ =
    'The update-check cache (~/.rsct/update-check.json) exists but cannot be read or parsed — nothing was changed. Delete that file to reset it; the framework will recreate it.'
  const show = (v: string): string => (v.length > 40 ? `${v.slice(0, 40)}…` : v)

  let turnedOff = false
  if (input.update_check !== undefined) {
    const mode = input.update_check.trim().toLowerCase()
    if (mode === 'on' || mode === 'off') {
      const r = setUpdateCheckConsent(mode, opts)
      if (!r.ok) {
        hints.push(
          r.reason === 'unreadable'
            ? CANNOT_READ
            : 'Could not persist the update_check setting (the cache file is not writable) — the check is unchanged.',
        )
      } else if (mode === 'off') {
        turnedOff = true
        hints.push(
          'Update check turned OFF for this machine — no release will be reported and no network call is made. Reversible with update_check:"on".',
        )
      } else {
        hints.push(
          killed
            ? 'Update check turned ON in the config file, but RSCT_UPDATE_CHECK=off is set in this environment and takes precedence — no release will be reported until that variable is unset.'
            : 'Update check turned ON for this machine — new releases are reported once a day.',
        )
      }
    } else {
      hints.push(`Ignored update_check:"${show(input.update_check)}" — expected "on" or "off".`)
    }
  }

  if (input.decline_update !== undefined) {
    const r = declineUpdateTag(input.decline_update, opts)
    if (r.ok) {
      hints.push(
        turnedOff
          ? `Release v${r.tag} declined and recorded — though the update check was just turned off in this same call, so nothing will be reported until it is turned back on.`
          : `Release v${r.tag} declined — it will not be raised again on this machine; a newer release will ask once.`,
      )
    } else if (r.reason === 'mismatch') {
      hints.push(
        `Decline ignored: "${show(input.decline_update)}" is not the release being offered (v${r.tag}). Only the release named in the update hint can be declined — nothing was recorded.`,
      )
    } else if (r.reason === 'no_offer') {
      hints.push('Decline ignored: no newer release is currently being offered — nothing was recorded.')
    } else if (r.reason === 'unreadable') {
      hints.push(CANNOT_READ)
    } else {
      hints.push('Could not persist the decline (the cache file is not writable) — nothing was recorded.')
    }
  }
}

const BOOTSTRAP_STALE_MIN = Math.round(BOOTSTRAP_STALE_MS / 60000)

function bootstrapHints(refresh: BootstrapRefresh): string[] {
  const { marker, read, write } = refresh

  if (write === null) {
    return [
      `⚠ .rsct/phase-state.json exists but could not be parsed (${truncateForHint(read.parse_error ?? 'unknown error')}) — the §0 bootstrap marker was deliberately NOT written. Stamping it would have replaced the file with a fresh marker and nothing else, discarding whatever plan authorization or classify verdict it still holds. ${UNREADABLE_STATE_ADVICE}`,
    ]
  }

  const hints: string[] = []
  const recorded = write.ok

  if (marker.status === 'missing' && marker.bootstrap_at !== null) {
    hints.push(
      `⚠ The recorded bootstrap_at value ('${truncateForHint(marker.bootstrap_at, 40)}') is not a parseable timestamp${recorded ? ' — this rsct_status call replaced it' : ', and this call could not replace it (see below)'}.`,
    )
  } else if (marker.status === 'missing') {
    hints.push(
      recorded
        ? `ℹ No §0 bootstrap marker was on record for this project — this rsct_status call recorded one, so the session baseline starts now. Next: rsct_load_context, which loads plan, decisions and knowledge.`
        : `ℹ No §0 bootstrap marker is on record for this project, and this call could not record one (see below). Next: rsct_load_context, which loads plan, decisions and knowledge.`,
    )
  } else if (marker.status === 'stale') {
    const min = Math.round((marker.age_ms ?? 0) / 60000)
    hints.push(
      recorded
        ? `ℹ §0 was last recorded ${min} min ago (stale window ${BOOTSTRAP_STALE_MIN} min) — this rsct_status call refreshed it. If this session has been running since then, re-run rsct_load_context so plan, decisions and knowledge are current too.`
        : `ℹ §0 was last recorded ${min} min ago (stale window ${BOOTSTRAP_STALE_MIN} min) and this call could not refresh it (see below). Re-run rsct_load_context so plan, decisions and knowledge are current.`,
    )
  }

  const writeHint = bootstrapWriteFailureHint(
    write,
    'rsct_status',
    marker.status === 'fresh',
  )
  if (writeHint) hints.push(writeHint)

  return hints
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

  const protected_branches = effectiveProtectedList(resolution.config ?? undefined).list
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `Working on the protected branch '${git.branch}' needs a derived branch (feat/, fix/, chore/, docs/) for any mutating work — confirm with the dev before proposing changes.`,
    )
  }

  if (git.available && git.is_clean === false) {
    hints.push(
      'Working tree has uncommitted changes — surface them in the next plan/spec phase so they are not lost.',
    )
  }

  if (!resolution.config?.test_framework) {
    hints.push(
      'No test_framework recorded in .rsct.json — the testing strategy needs explicit dev input until detected.',
    )
  }

  return hints
}

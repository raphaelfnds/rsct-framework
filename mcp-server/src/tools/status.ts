import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState, readWorktreeInfo, type WorktreeInfo } from '../lib/git.js'
import { stampBootstrapMarker } from '../lib/phase-scope.js'
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
      .describe('Optional absolute path to override project root detection.'),
    // Values are deliberately LOOSE here while the exposed inputSchema advertises the
    // strict contract. rsct_status is the session-bootstrap tool documented "always
    // succeeds", and its .parse() is unguarded — a z.enum would turn a paraphrased
    // update_check:"On" into a hard failure that also loses git state, topology and
    // the install-drift security hint. `coerce` extends that to a `true` an agent
    // might infer from an on/off switch: it becomes "true", which is simply ignored
    // with a hint. Unknown KEYS still reject (.strict): loose values, strict shape.
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
  /** T3: git worktree context (is this a linked worktree? — isolated rsct state). */
  worktree: WorktreeInfo
  universe: UniverseBlock
  /** T2: repo topology (mono/monorepo/multi-repo) — what the contract gate diverges on. */
  topology: TopologyBlock
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

/**
 * `deps` is NOT part of the MCP surface — it is the injection seam that lets tests
 * exercise the update check against a temp $HOME and a fake fetcher. Without it the
 * suite would reach api.github.com and rewrite the contributor's real ~/.rsct.
 */
export async function statusHandler(
  rawInput: unknown,
  deps: { update?: UpdateOptions } = {},
): Promise<StatusOutput> {
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

  // T2: repo topology (single source — load_context calls the same detectTopology).
  // Fail-graceful: absent config / universe → mono, no hint. The FV1 hint fires only
  // when topology is confirmed multi-repo but the contract gate can't enforce.
  const topology = detectTopology(resolution.config, resolution.root, {}, universe)
  if (topology.hint) hints.push(topology.hint)

  // T4 / #38: consult-by-default, cached, fail-silent "a newer RSCT release is
  // available" hint. Reads only the ~/.rsct cache (zero network latency); a stale
  // cache fires a non-blocking background refresh. Turned off by update_check:"off",
  // by RSCT_UPDATE_CHECK=off, or by `consent` in the cache file.
  //
  // Mutations are applied BEFORE the read so they take effect in this same call:
  // turning the check off must not be followed by a notice pitching how to undo it,
  // and a decline must silence the very hint the dev is responding to.
  applyUpdateMutations(input, deps.update, hints)
  hints.push(...getUpdateNotice(deps.update).hints)

  // Install-drift: local compare of this project's stamped rsct_version and of
  // its installed enforcement scripts vs the running binary (no network / no
  // consent). Distinct axis from the T4 update check above. Only meaningful when
  // a project config exists.
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
      protected_branches: resolution.config?.protected_branches ?? [],
      test_framework: resolution.config?.test_framework ?? null,
    },
    git,
    worktree,
    universe: universe.block,
    topology: topology.block,
    hints,
  }
}

/**
 * Apply the two update-check mutations, in order, pushing one confirmation hint per
 * applied change. Every failure mode is reported rather than thrown: this runs inside
 * the tool the whole protocol calls at session start.
 */
function applyUpdateMutations(input: StatusInput, opts: UpdateOptions | undefined, hints: string[]): void {
  if (input.update_check === undefined && input.decline_update === undefined) return

  // The environment kill switch outranks the file, so a confirmation that ignored it
  // would tell the dev the opposite of the truth on any CI image or shell that
  // exports it — and they would have no way to discover why nothing happens.
  const killed = isUpdateCheckKilled(opts)
  const CANNOT_READ =
    'The update-check cache (~/.rsct/update-check.json) exists but cannot be read or parsed — nothing was changed. Delete that file to reset it; the framework will recreate it.'
  /** Caller input is echoed back into hints[], the agent's control channel — bound it. */
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

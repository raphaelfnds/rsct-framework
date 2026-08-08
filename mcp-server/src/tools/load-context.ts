import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState, gitBranchMerged } from '../lib/git.js'
import { effectiveProtectedList } from '../lib/branch-protection.js'
import { findActivePlan, type ActivePlan } from '../lib/plan.js'
import { readDecisions, type DecisionEntry } from '../lib/decisions.js'
import { readKnowledgeIndex, type KnowledgeIndex } from '../lib/knowledge.js'
import {
  readPhaseState,
  readPlanDisposition,
  stampBootstrapMarker,
} from '../lib/phase-scope.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
import { getInstallDriftNotice } from '../lib/version-drift.js'
import { appendAuditEntry } from '../lib/audit-log.js'
import { getUniverse, type UniverseBlock } from '../lib/universe.js'
import { detectTopology, type TopologyBlock } from '../lib/topology.js'

export const loadContextInputSchema = z
  .object({
    project_root: z.string().optional(),
    decisions_excerpt_count: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(3)
      .describe('How many recent firm-premise and ADR excerpts to include (default 3 each).'),
  })
  .strict()

export type LoadContextInput = z.infer<typeof loadContextInputSchema>

export interface ActivePhaseVerificationSummary {
  spec_ref: string | null
  spec_tier: string | null
  findings_count: number
  started_at: string | null
}

export interface ActivePhaseInfo {
  phase: string
  spec_slug: string | null
  started_at: string | null
  scope_globs: string[]
  verification: ActivePhaseVerificationSummary | null
}

export interface LoadContextOutput {
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
  active_plan: ActivePlan | null
  active_phase: ActivePhaseInfo | null
  decisions: {
    file_exists: boolean
    premises_count: number
    adrs_count: number
    recent_premises: DecisionEntry[]
    recent_adrs: DecisionEntry[]
  }
  knowledge: KnowledgeIndex
  universe: UniverseBlock
  /** T2: repo topology (mono/monorepo/multi-repo) — single source, parity with status. */
  topology: TopologyBlock
  next_action_hints: string[]
}

export const loadContextTool: Tool = {
  name: 'rsct_load_context',
  description:
    "Session-bootstrap call — returns a structured snapshot of the project's current rsct state: identity, git, active plan (slug/status/branch), decisions summary, available knowledge categories, and contextual hints. Call this at the start of any non-trivial conversation in an rsct project before formulating a plan. Always succeeds — degrades gracefully when not in an rsct project.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      decisions_excerpt_count: {
        type: 'number',
        description: 'How many recent firm-premise and ADR excerpts to include (default 3 each, max 20).',
        minimum: 0,
        maximum: 20,
        default: 3,
      },
    },
    additionalProperties: false,
  },
}

const MCP_VERSION = RSCT_MCP_VERSION

function buildActivePhase(projectRoot: string): ActivePhaseInfo | null {
  const read = readPhaseState(projectRoot)
  if (!read.exists || !read.state) return null
  const state = read.state
  if (!state.phase) return null

  let verification: ActivePhaseVerificationSummary | null = null
  if (state.verification) {
    const findings = state.verification.findings
    const findings_count = Array.isArray(findings) ? findings.length : 0
    verification = {
      spec_ref: state.verification.spec_ref ?? null,
      spec_tier: state.verification.spec_tier ?? null,
      findings_count,
      started_at: state.verification.started_at ?? null,
    }
  }

  return {
    phase: state.phase,
    spec_slug: state.spec_slug ?? null,
    started_at: state.started_at ?? null,
    scope_globs: state.scope_globs ?? [],
    verification,
  }
}

export async function loadContextHandler(rawInput: unknown): Promise<LoadContextOutput> {
  const input = loadContextInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const git = readGitState(resolution.root)
  const active_plan = findActivePlan(resolution.root)
  const active_phase = buildActivePhase(resolution.root)
  const decisionsSnapshot = readDecisions(resolution.root)
  const knowledge = readKnowledgeIndex(resolution.root)

  // CAP-31: stamp bootstrap marker — load_context is the §0 entry
  // point. Best-effort write; failures swallowed. plan-lifecycle-v2 (D4):
  // load_context is the ONLY caller that actually re-reads plan/decisions/
  // knowledge, so it (and only it) clears the context_stale re-bootstrap flag.
  if (resolution.rsct_installed) {
    stampBootstrapMarker(resolution.root, { clearStale: true })
  }

  const excerptCount = input.decisions_excerpt_count
  const recent_premises = decisionsSnapshot.premises.slice(-excerptCount).reverse()
  const recent_adrs = decisionsSnapshot.adrs.slice(-excerptCount).reverse()

  // T1.a: org-level universe via the single source (same getUniverse as status).
  const universe = getUniverse(resolution.config, resolution.root)
  // T2: repo topology via the single source (same detectTopology as status).
  // Reuse the already-resolved universe block (avoids a second resolution).
  const topology = detectTopology(resolution.config, resolution.root, {}, universe)
  const next_action_hints = buildHints({
    resolution,
    git,
    active_plan,
    active_phase,
    knowledge,
    decisions: decisionsSnapshot,
  })
  if (universe.hint) next_action_hints.push(universe.hint)
  if (topology.hint) next_action_hints.push(topology.hint)
  // plan-lifecycle-v2 (Bloco 2.4): retroactive reconciliation. If the active
  // plan's branch already looks integrated into the mainline and no keep|delete
  // disposition was recorded, nudge the dev to run rsct_plan_dispose. LOCAL
  // check only (offline; no `gh` round-trip on every bootstrap) — a squash/rebase
  // PR merge is blind to `git branch --merged` and is instead caught when the
  // dev runs rsct_plan_dispose explicitly (documented residual). Read-only; opens
  // no gate.
  // Only reconcile once you've LEFT the plan's branch (git.branch differs) — a
  // branch you're still on cannot already be integrated, so this skips the git
  // subprocess on every bootstrap during active feature work (the common case).
  if (
    resolution.rsct_installed &&
    active_plan?.branch &&
    git.branch !== active_plan.branch
  ) {
    const disposition = readPlanDisposition(
      readPhaseState(resolution.root).state,
      active_plan.slug,
    )
    if (!disposition) {
      const mainline = resolution.config?.protected_branches?.[0] ?? 'main'
      if (
        active_plan.branch !== mainline &&
        gitBranchMerged(resolution.root, active_plan.branch, mainline)
      ) {
        next_action_hints.push(
          `ℹ Plan '${active_plan.slug}' (branch '${active_plan.branch}') appears merged into '${mainline}' with no recorded disposition — run rsct_plan_dispose({ plan_slug: '${active_plan.slug}', decision: 'keep'|'delete' }) to confirm and get the cleanup advisory.`,
        )
      }
    }
  }
  // Install-drift: local compare of this project's stamped rsct_version and of
  // its installed enforcement scripts vs the running binary (parity with
  // rsct_status — same helper/text). Handler level.
  if (resolution.rsct_installed) {
    const drift = getInstallDriftNotice({
      projectRoot: resolution.root,
      projectVersion: resolution.config?.rsct_version ?? null,
      mcpVersion: MCP_VERSION,
    })
    if (drift.hint) next_action_hints.push(drift.hint)
    if (drift.severity === 'security') {
      // Recorded at every §0 bootstrap, not only at the commit gate: an escalated
      // state means the sanitizer failed to strip a `Bash(git commit)` allow-entry,
      // in which case commits bypass rsct_request_commit entirely and the exposure
      // window would leave no trail at all. One entry per load_context call.
      appendAuditEntry(
        resolution.root,
        {
          event: 'install.drift_detected',
          tool: 'rsct_load_context',
          project_version: resolution.config?.rsct_version ?? null,
          mcp_version: MCP_VERSION,
          severity: drift.severity,
          affected_components: drift.affected_components,
        },
        resolution.config?.audit,
      )
    }
  }

  return {
    mcp_server: { name: 'rsct-mcp', version: MCP_VERSION },
    rsct_installed: resolution.rsct_installed,
    project: {
      root: resolution.root,
      app_name: resolution.config?.app?.name ?? null,
      org_slug: resolution.config?.app?.org ?? null,
      rsct_version: resolution.config?.rsct_version ?? null,
      // #50: the enforced list, not the raw key — see the note in status.ts.
      protected_branches: resolution.rsct_installed
        ? effectiveProtectedList(resolution.config ?? undefined).list
        : [],
      test_framework: resolution.config?.test_framework ?? null,
    },
    git,
    active_plan,
    active_phase,
    decisions: {
      file_exists: decisionsSnapshot.exists,
      premises_count: decisionsSnapshot.premises.length,
      adrs_count: decisionsSnapshot.adrs.length,
      recent_premises,
      recent_adrs,
    },
    knowledge,
    universe: universe.block,
    topology: topology.block,
    next_action_hints,
  }
}

interface HintArgs {
  resolution: ReturnType<typeof resolveProjectRoot>
  git: ReturnType<typeof readGitState>
  active_plan: ActivePlan | null
  active_phase: ActivePhaseInfo | null
  knowledge: KnowledgeIndex
  decisions: ReturnType<typeof readDecisions>
}

function buildHints({
  resolution,
  git,
  active_plan,
  active_phase,
  knowledge,
  decisions,
}: HintArgs): string[] {
  const hints: string[] = []

  if (!resolution.rsct_installed) {
    hints.push(
      'Project is not rsct-managed yet — recommend `/rsct-setup` before applying the RSCT workflow.',
    )
    return hints
  }

  // #50: same effective list the §C gates use — past this point rsct_installed is true.
  const protected_branches = effectiveProtectedList(resolution.config ?? undefined).list
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `On the protected branch '${git.branch}' — mutating git ops need a per-action OK; suggest deriving a branch before the code phase.`,
    )
  }

  // #49 — bootstrap is where `adrs_count: 0` gets believed. A file with content and
  // no parsed entry is a parser miss, and saying nothing turns it into "this project
  // records no decisions" for the rest of the session.
  if (decisions.has_content && decisions.premises.length === 0 && decisions.adrs.length === 0) {
    hints.push(
      `${decisions.path ?? 'documentation/decisions.md'} has content, but no premise or ADR heading could be parsed — treat premises_count/adrs_count of 0 as UNKNOWN, not as "none". A heading must be '## ' or '### ' followed by '#N' or 'ADR-NNN', a separator (one of — – - :) and a title.`,
    )
  }

  if (active_phase) {
    if (active_phase.phase === 'verification' && active_phase.verification) {
      hints.push(
        `Active phase: verification (spec_ref='${active_phase.verification.spec_ref ?? '?'}', ${active_phase.verification.findings_count} finding(s)). Call rsct_phase_verification_complete with an action for EVERY finding + dev_approval before editing code — rsct_phase_status lists the open ids if you no longer have them.`,
      )
    } else if (active_phase.phase === 'review') {
      // #40: a resumed REVIEW needs the same steer. load_context is step 2 of the
      // mandatory bootstrap chain, so leaving it on the generic branch means the
      // tool that runs first every session says nothing about the state this gate
      // introduced.
      hints.push(
        `Active phase: review. Every finding declared at rsct_phase_review_start needs an action before rsct_phase_review_complete will close it — call rsct_phase_status to list the open ones and their findings_run_id.`,
      )
    } else {
      hints.push(
        `Active phase: ${active_phase.phase}${active_phase.spec_slug ? ` (spec_slug='${active_phase.spec_slug}')` : ''}. Read .rsct/phase-state.json before editing.`,
      )
    }
  }

  if (active_plan) {
    const status = active_plan.status ?? 'unknown'
    hints.push(
      `Active plan: ${active_plan.slug} (status: ${status}). Continue from progress file if status is 'approved' or 'in-progress'.`,
    )
    if (active_plan.branch && git.available && git.branch && active_plan.branch !== git.branch) {
      hints.push(
        `Plan branch '${active_plan.branch}' differs from the current branch '${git.branch}' — ask the dev which branch to continue in.`,
      )
    }
  } else {
    hints.push('No active plan file detected — a plan is required before code editing for tasks above the trivial tier.')
  }

  if (!knowledge.directory_exists) {
    hints.push(
      'Knowledge graph not scaffolded (documentation/knowledge/ missing) — recall tools will return empty results. Recommend `/rsct-setup` to scaffold; entries are then captured just-in-time during normal conversation (no daily ritual required).',
    )
  } else if (knowledge.categories_missing.length > 0) {
    hints.push(
      `Knowledge graph partial — ${knowledge.categories_missing.length} of ${knowledge.categories_missing.length + knowledge.categories_present.length} categories missing. Most-impactful to fill first: business-rules, anti-decisions.`,
    )
  }

  return hints
}

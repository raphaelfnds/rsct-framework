import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState, gitBranchMerged } from '../lib/git.js'
import { effectiveProtectedList } from '../lib/branch-protection.js'
import { findActivePlan, type ActivePlan } from '../lib/plan.js'
import { readDecisions, type DecisionEntry } from '../lib/decisions.js'
import { corpusMiss } from '../lib/corpus-health.js'
import { readKnowledgeIndex, type KnowledgeIndex } from '../lib/knowledge.js'
import {
  readFindingsBaseline,
  summarizeEvidence,
  type EvidenceMix,
} from '../lib/findings.js'
import {
  BOOTSTRAP_STALE_MS,
  bootstrapWriteFailureHint,
  readContextStale,
  readPhaseState,
  readPlanDisposition,
  readThenStampBootstrap,
  truncateForHint,
  UNREADABLE_STATE_ADVICE,
  type BootstrapRefresh,
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
  evidence_mix: EvidenceMix
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
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
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
      evidence_mix: summarizeEvidence(readFindingsBaseline(findings)),
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

  const bootstrap: BootstrapRefresh | null = resolution.rsct_installed
    ? readThenStampBootstrap(resolution.root, { clearStale: true })
    : null

  const excerptCount = input.decisions_excerpt_count
  const recent_premises = decisionsSnapshot.premises.slice(-excerptCount).reverse()
  const recent_adrs = decisionsSnapshot.adrs.slice(-excerptCount).reverse()

  const universe = getUniverse(resolution.config, resolution.root)
  const topology = detectTopology(resolution.config, resolution.root, {}, universe)
  const next_action_hints = buildHints({
    resolution,
    git,
    active_plan,
    active_phase,
    knowledge,
    decisions: decisionsSnapshot,
  })
  if (bootstrap) next_action_hints.push(...bootstrapHints(bootstrap))
  if (universe.hint) next_action_hints.push(universe.hint)
  if (topology.hint) next_action_hints.push(topology.hint)
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
  if (resolution.rsct_installed) {
    const drift = getInstallDriftNotice({
      projectRoot: resolution.root,
      projectVersion: resolution.config?.rsct_version ?? null,
      mcpVersion: MCP_VERSION,
    })
    if (drift.hint) next_action_hints.push(drift.hint)
    if (drift.severity === 'security') {
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

const BOOTSTRAP_STALE_MIN = Math.round(BOOTSTRAP_STALE_MS / 60000)

function bootstrapHints(refresh: BootstrapRefresh): string[] {
  const { marker, read, write } = refresh

  if (write === null) {
    return [
      `⚠ .rsct/phase-state.json exists but could not be parsed (${truncateForHint(read.parse_error ?? 'unknown error')}) — the §0 bootstrap marker was deliberately NOT written, and any context_stale flag the file held was NOT cleared. Stamping would have replaced the file with a fresh marker and nothing else, discarding whatever plan authorization or classify verdict it still holds. ${UNREADABLE_STATE_ADVICE}`,
    ]
  }

  const hints: string[] = []
  const recorded = write.ok

  if (marker.status === 'missing' && marker.bootstrap_at !== null) {
    hints.push(
      `⚠ The recorded bootstrap_at value ('${truncateForHint(marker.bootstrap_at, 40)}') is not a parseable timestamp${recorded ? ' — this rsct_load_context call replaced it' : ', and this call could not replace it (see below)'}.`,
    )
  } else if (marker.status === 'missing') {
    hints.push(
      recorded
        ? `ℹ No §0 bootstrap marker was on record for this project — this rsct_load_context call established the session baseline and re-read plan, decisions and knowledge.`
        : `ℹ No §0 bootstrap marker is on record for this project, and this call could not record one (see below).`,
    )
  } else if (marker.status === 'stale') {
    const min = Math.round((marker.age_ms ?? 0) / 60000)
    hints.push(
      recorded
        ? `ℹ §0 was last recorded ${min} min ago (stale window ${BOOTSTRAP_STALE_MIN} min) — this rsct_load_context call refreshed it and re-read plan, decisions and knowledge.`
        : `ℹ §0 was last recorded ${min} min ago (stale window ${BOOTSTRAP_STALE_MIN} min) and this call could not refresh it (see below).`,
    )
  }

  const writeHint = bootstrapWriteFailureHint(
    write,
    'rsct_load_context',
    marker.status === 'fresh',
  )
  if (writeHint) {
    hints.push(writeHint)
    if (readContextStale(read.state) !== null) {
      hints.push(
        `⚠ The re-bootstrap flag (context_stale) was NOT cleared, because the phase-state write did not land — rsct_check_edit_scope keeps reporting 'stale_context' and managed edits stay blocked. Re-run rsct_load_context once the write can succeed.`,
      )
    }
  }

  return hints
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

  const protected_branches = effectiveProtectedList(resolution.config ?? undefined).list
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `On the protected branch '${git.branch}' — mutating git ops need a per-action OK; suggest deriving a branch before the code phase.`,
    )
  }

  const miss = corpusMiss({
    read_error: decisions.read_error,
    has_ids: decisions.has_decision_ids,
    parsed_count: decisions.premises.length + decisions.adrs.length,
  })
  if (miss === 'unreadable') {
    hints.push(
      `${decisions.path ?? 'documentation/decisions.md'} exists but could not be read — treat premises_count/adrs_count of 0 as UNKNOWN, not as "none". Check it is a readable file (not a directory) and that permissions allow reading it.`,
    )
  } else if (miss === 'ids-unparsed') {
    hints.push(
      `${decisions.path ?? 'documentation/decisions.md'} mentions decision ids but no premise or ADR heading could be parsed — treat premises_count/adrs_count of 0 as UNKNOWN, not as "none". A heading must be '## ' or '### ' followed by '#N' or 'ADR-NNN', a separator (one of — – - :) and a title.`,
    )
  }

  if (active_phase) {
    if (active_phase.phase === 'verification' && active_phase.verification) {
      hints.push(
        `Active phase: verification (spec_ref='${active_phase.verification.spec_ref ?? '?'}', ${active_phase.verification.findings_count} finding(s)). Call rsct_phase_verification_complete with an action for EVERY finding + dev_approval before editing code — rsct_phase_status lists the open ids if you no longer have them.`,
      )
    } else if (active_phase.phase === 'review') {
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

import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState } from '../lib/git.js'
import { findActivePlan, type ActivePlan } from '../lib/plan.js'
import { readDecisions, type DecisionEntry } from '../lib/decisions.js'
import { readKnowledgeIndex, type KnowledgeIndex } from '../lib/knowledge.js'
import { readPhaseState, stampBootstrapMarker } from '../lib/phase-scope.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
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
  // point. Best-effort write; failures swallowed.
  if (resolution.rsct_installed) {
    stampBootstrapMarker(resolution.root)
  }

  const excerptCount = input.decisions_excerpt_count
  const recent_premises = decisionsSnapshot.premises.slice(-excerptCount).reverse()
  const recent_adrs = decisionsSnapshot.adrs.slice(-excerptCount).reverse()

  // T1.a: org-level universe via the single source (same getUniverse as status).
  const universe = getUniverse(resolution.config, resolution.root)
  // T2: repo topology via the single source (same detectTopology as status).
  // Reuse the already-resolved universe block (avoids a second resolution).
  const topology = detectTopology(resolution.config, resolution.root, {}, universe)
  const next_action_hints = buildHints({ resolution, git, active_plan, active_phase, knowledge })
  if (universe.hint) next_action_hints.push(universe.hint)
  if (topology.hint) next_action_hints.push(topology.hint)

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
}

function buildHints({ resolution, git, active_plan, active_phase, knowledge }: HintArgs): string[] {
  const hints: string[] = []

  if (!resolution.rsct_installed) {
    hints.push(
      'Project is not rsct-managed yet — recommend `/rsct-setup` before applying §B-§H workflow.',
    )
    return hints
  }

  const protected_branches = resolution.config?.protected_branches ?? []
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `On protected branch '${git.branch}' — §D blocks mutating git ops without a per-action OK. Suggest deriving a branch before code phase.`,
    )
  }

  if (active_phase) {
    if (active_phase.phase === 'verification' && active_phase.verification) {
      hints.push(
        `Active phase: verification (spec_ref='${active_phase.verification.spec_ref ?? '?'}', ${active_phase.verification.findings_count} finding(s)). Call rsct_phase_verification_complete with findings_actions[] + dev_approval before editing code.`,
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
        `Plan branch '${active_plan.branch}' differs from current branch '${git.branch}'. §D recommends asking dev which branch to continue in.`,
      )
    }
  } else {
    hints.push('No active plan file detected — §B requires a plan before code editing for tasks above trivial tier.')
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

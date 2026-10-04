import { z } from 'zod'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readPhaseState } from '../lib/phase-scope.js'
import { listPlans, type PlanSummary } from '../lib/plan.js'
import { evaluateMcpHealth } from '../lib/health.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
import {
  getInstallDriftNotice,
  type AffectedComponent,
  type DriftSeverity,
} from '../lib/version-drift.js'

export const auditInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
  })
  .strict()

const COVERAGE_BOUNDARY: string[] = [
  'Settings drift (.claude/settings.json ownership) is NOT checked here — it needs two git reads to assemble, and this tool spawns no processes. It already reaches you at the commit gate (rsct_request_commit).',
  'Findings are pruned when a phase closes, so a finding raised and answered in a past phase leaves no trace this report can query.',
  '.rsct/ state is per-worktree. In a linked git worktree this reports on THAT worktree only, not on the project as a whole.',
  'Rule-section bodies in CLAUDE.md are not read by THIS tool. The framework does cover that axis — every section carries a sha256-body= stamp and /rsct-setup reconciles them (since v2.7.0, #45) — rsct_audit just does not check it, so a clean report here says nothing either way about rule-body freshness.',
  'This is a point-in-time read of local files, and it never gates. ONE exception to "reads only": if .rsct.json is present but REJECTED (malformed JSON, or a value outside the enforced bounds), the shared config loader records one rsct_json.* entry in .rsct/audit.log — creating that file if absent, and regardless of audit.enabled. That write belongs to resolveProjectRoot and happens identically for rsct_status and rsct_load_context; it is not specific to this report.',
  'install_drift.message is relayed VERBATIM from the drift detector and can contain a repair instruction (e.g. "Run /rsct-setup"). That text is the detector\'s, not this report\'s recommendation — nothing here tells you to run a tool that mutates RSCT phase state.',
]

export interface AuditOpenPhase {
  phase: string
  started_at: string | null
  age_days: number | null
}

export interface AuditInstallDrift {
  severity: DriftSeverity
  affected_components: AffectedComponent[]
  message: string | null
}

export interface AuditFreeCommitEligibility {
  eligible: boolean
  reasons: string[]
  explanation: string
}

export interface AuditOutput {
  mcp_server: { name: string; version: string }
  rsct_installed: boolean
  project: { root: string }
  install_drift: AuditInstallDrift | null
  free_commit_eligibility: AuditFreeCommitEligibility | null
  open_phase: AuditOpenPhase | null
  plans: PlanSummary[]
  plans_ordered_by: 'plan_file_mtime'
  coverage_boundary: string[]
  hints: string[]
}

const DAY_MS = 86_400_000

function explainEligibility(eligible: boolean, reasons: string[]): string {
  if (eligible) {
    return 'The dialog-free free-commit lane is available for this project. Every commit still goes through rsct_request_commit.'
  }
  const faults = reasons.filter((r) => r !== 'audit_history_absent')
  if (faults.length > 0) {
    const commits = faults.includes('phase_state_corrupt')
      ? 'rsct_request_commit refuses every commit until .rsct/phase-state.json is repaired or deleted.'
      : 'Commits still work; they go through the per-action §C path.'
    return `Free commits are closed, and at least one reason is a genuine fault rather than a fresh-install condition: ${faults.join(', ')}. A corrupt config, a torn phase-state or a stale lock means a writer failed mid-write — worth looking at directly. ${commits}`
  }
  return 'Free commits are closed because this project has no audit history yet — expected on a fresh install, and permanent when audit.enabled is false. This is NOT a fault: commits go through the per-action §C path instead.'
}

export const auditTool: Tool = {
  name: 'rsct_audit',
  description:
    "On-demand report on this project's RSCT surface: install drift, free-commit-lane eligibility, how long the current phase has been open, and every plan_/spec_ file at the project root with the state of its progress file. Local files only — no git, no network — and it never opens or closes a gate. It reads; the ONE exception is that a present-but-REJECTED .rsct.json makes the shared config loader record an rsct_json.* entry in .rsct/audit.log, exactly as rsct_status and rsct_load_context already do. STATED COVERAGE BOUNDARY (also returned in the output): a clean report is NOT a clean project. Settings drift is not checked here (it reaches the dev at the commit gate), findings pruned at phase close leave no queryable trace, .rsct/ is per-worktree so the report is per-worktree, and CLAUDE.md rule-section bodies are not checked here (the framework stamps and reconciles those itself since v2.7.0). Call it when the dev asks how the project is doing — do NOT call it as a precondition for any other tool, and never treat its output as an approval or a gate.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
    },
    additionalProperties: false,
  },
}

export async function auditHandler(
  rawInput: unknown,
  deps: { now?: Date } = {},
): Promise<AuditOutput> {
  const input = auditInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const now = deps.now ?? new Date()

  const hints: string[] = []

  let install_drift: AuditInstallDrift | null = null
  if (resolution.rsct_installed) {
    const drift = getInstallDriftNotice({
      projectRoot: resolution.root,
      projectVersion: resolution.config?.rsct_version ?? null,
      mcpVersion: RSCT_MCP_VERSION,
    })
    install_drift = {
      severity: drift.severity,
      affected_components: drift.affected_components,
      message: drift.hint,
    }
  }

  let free_commit_eligibility: AuditFreeCommitEligibility | null = null
  if (resolution.rsct_installed) {
    const health = evaluateMcpHealth(resolution.root, {
      now,
      config: resolution.config,
    })
    free_commit_eligibility = {
      eligible: health.healthy,
      reasons: health.reasons,
      explanation: explainEligibility(health.healthy, health.reasons),
    }
  }

  const state = readPhaseState(resolution.root).state
  let open_phase: AuditOpenPhase | null = null
  if (state?.phase) {
    const startedAt =
      state.phase === 'verification'
        ? (state.verification?.started_at ?? null)
        : (state.started_at ?? null)
    const startedMs = startedAt !== null ? Date.parse(startedAt) : NaN
    open_phase = {
      phase: state.phase,
      started_at: startedAt,
      age_days: Number.isNaN(startedMs)
        ? null
        : Math.floor((now.getTime() - startedMs) / DAY_MS),
    }
  }

  const plans = listPlans(resolution.root, { now })

  if (!resolution.rsct_installed) {
    hints.push(
      existsSync(join(resolution.root, '.rsct.json'))
        ? 'A .rsct.json is PRESENT here but was rejected — unreadable, malformed, or carrying a value outside the enforced bounds — so RSCT is treating this project as unmanaged and neither install drift nor free-commit eligibility is reported. That rejection is also recorded in .rsct/audit.log. Worth reading before assuming it is only a typo.'
        : 'This project is not rsct-managed (no .rsct.json), so install drift and free-commit eligibility are not reported. Plans found at the root are still listed.',
    )
  }

  if (open_phase && open_phase.age_days !== null && open_phase.age_days >= 7) {
    hints.push(
      `Phase '${open_phase.phase}' has been open for ${open_phase.age_days} days. Worth a look — this is an observation, not an instruction, and closing or discarding a phase is the dev's decision.`,
    )
  }

  return {
    mcp_server: { name: 'rsct-mcp', version: RSCT_MCP_VERSION },
    rsct_installed: resolution.rsct_installed,
    project: { root: resolution.root },
    install_drift,
    free_commit_eligibility,
    open_phase,
    plans,
    plans_ordered_by: 'plan_file_mtime',
    coverage_boundary: COVERAGE_BOUNDARY,
    hints,
  }
}

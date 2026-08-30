import { z } from 'zod'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readPhaseState } from '../lib/phase-scope.js'
import { listPlans, type PlanSummary } from '../lib/plan.js'
import { evaluateMcpHealth } from '../lib/health.js'
import { RSCT_MCP_VERSION } from '../lib/version.js'
// #55 — DELIBERATE BYPASS of the centralised `evaluateInstallAdvisory`
// (`lib/install-advisory.ts:23-25`), and it must stay that way. That helper
// APPENDS an `install.drift_detected` audit entry at evaluation time when the
// severity is `security` (`install-advisory.ts:68-84`), because the entry is
// meant to record that a MUTATION WAS ATTEMPTED under a degraded enforcement
// surface. `rsct_audit` attempts no mutation. Routing it through the advisory
// path would write false attempt records into `.rsct/audit.log` — the same
// append-only log `lib/free-commit.ts:112-128` re-derives the anti-rollback
// ceiling from. Corrupting a security limit to preserve a call-graph convention
// is the wrong trade. `getInstallDriftNotice` itself is pure: `readScriptEvidence`
// (`version-drift.ts:338-383`) does readdirSync/readFileSync only.
// Do NOT "fix" this back into the advisory path.
//
// Honest scope of that guarantee, measured: this keeps the tool from writing a
// FALSE `install.drift_detected` entry. It does NOT make the handler write-free.
// `resolveProjectRoot` below reaches `emitConfigViolation` (`project-root.ts:383`,
// `:391`) → `appendAuditEntry(..., { enabled: true })` (`:420`) when `.rsct.json`
// is present but rejected, creating `.rsct/audit.log` if absent and ignoring
// `audit.enabled: false`. Verified by running the real handler: `rsct_status` and
// `rsct_load_context` do exactly the same on the same input, so the behaviour is
// the shared resolver's, not this tool's — but the description and the returned
// coverage boundary state it rather than claiming "no writes".
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
      .describe('Optional absolute path to override project root detection.'),
  })
  .strict()

/**
 * What this report cannot see. Shipped in the OUTPUT, not only in the docs:
 * "is this project's process healthy?" is a completeness claim this tool cannot
 * make, and a clean report is not a clean project.
 */
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
  /** Null when the state carries no timestamp — see the age note below. */
  started_at: string | null
  /** Whole days the phase has been open; null when `started_at` is null. */
  age_days: number | null
}

export interface AuditInstallDrift {
  severity: DriftSeverity
  affected_components: AffectedComponent[]
  /** `getInstallDriftNotice`'s prose line, or null when there is no drift. */
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

/**
 * Translate `evaluateMcpHealth`'s fail-CLOSED verdict into what it actually
 * means. That helper answers "does this project qualify for the dialog-free
 * free-commit lane?", NOT "is this project healthy" — `audit_history_absent`
 * makes a brand-new, correctly-installed project report `healthy: false`, and a
 * project with `audit.enabled: false` reports it forever, by design
 * (`lib/health.ts:38-46`). Reporting that as ill health would be a false alarm
 * on every fresh install.
 */
function explainEligibility(eligible: boolean, reasons: string[]): string {
  if (eligible) {
    return 'The dialog-free free-commit lane is available for this project. Every commit still goes through rsct_request_commit.'
  }
  // Order matters: a corrupt/torn signal is a real fault and must not be
  // described in the same breath as a fresh install, so it is answered FIRST.
  const faults = reasons.filter((r) => r !== 'audit_history_absent')
  if (faults.length > 0) {
    return `Free commits are closed, and at least one reason is a genuine fault rather than a fresh-install condition: ${faults.join(', ')}. A corrupt config, a torn phase-state or a stale lock means a writer failed mid-write — worth looking at directly. Commits still work; they go through the per-action §C path.`
  }
  if (reasons.includes('audit_history_absent')) {
    return 'Free commits are closed because this project has no audit history yet — expected on a fresh install, and permanent when audit.enabled is false. This is NOT a fault: commits go through the per-action §C path instead.'
  }
  return 'Free commits are closed; commits go through the per-action §C path instead. This withholds a convenience, it does not block any work.'
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
        description: 'Optional absolute path to override project root detection.',
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

  // Install drift. Reported ONLY in the structured field below — never pushed
  // into `hints[]`. Decision of 2026-08-21 (#53/#54/#55 shared blocker): there is
  // one advisory surface, `hints[]`, and one dedup rule per overlapping pair.
  // `rsct_status` owns the install-drift HINT; repeating it here would show the
  // dev the same line twice from two tools.
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

  // Open-phase age. The timestamp lives in two different places depending on the
  // phase: `phase-verification-start.ts:316-321` writes `phase: 'verification'`
  // but puts its `started_at` inside the VERIFICATION BLOCK, never on PhaseState,
  // while every other phase goes through `startPhaseGeneric` (`phase-machine.ts:203`),
  // which sets the top-level field. Reading only the top-level one would leave the
  // V phase — the one most likely to sit open for days — as the single phase whose
  // age cannot be reported.
  //
  // Both fields are optional in the type and the absent case is reachable (a
  // stranded `verification` label from a downgraded binary: see
  // `isStaleVerificationLabel`, `phase-machine.ts:149-151`), so a missing
  // timestamp reports null rather than a fabricated age.
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

  // `rsct_installed: false` collapses THREE different states: no .rsct.json, an
  // unreadable one, and one that is present but REJECTED as malformed or
  // out-of-bounds (`project-root.ts:370/376/386/398`). Asserting "no .rsct.json"
  // for all three fabricates a cause — and the third state is the one that
  // matters most, because the HIGH-4 bounds check exists precisely to catch a
  // config edited to disable enforcement. Distinguished with a plain existsSync.
  if (!resolution.rsct_installed) {
    hints.push(
      existsSync(join(resolution.root, '.rsct.json'))
        ? 'A .rsct.json is PRESENT here but was rejected — unreadable, malformed, or carrying a value outside the enforced bounds — so RSCT is treating this project as unmanaged and neither install drift nor free-commit eligibility is reported. That rejection is also recorded in .rsct/audit.log. Worth reading before assuming it is only a typo.'
        : 'This project is not rsct-managed (no .rsct.json), so install drift and free-commit eligibility are not reported. Plans found at the root are still listed.',
    )
  }

  // Report only. No line here may recommend a state-mutating remedy: pointing an
  // open-phase age at rsct_phase_abandon would route a report into
  // `phase-abandon.ts:188`, which replaces the whole state object with {}.
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

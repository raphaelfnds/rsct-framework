import { z } from 'zod/v3'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  coverageHints,
  walkReverseDeps,
  type DiscoveredImporter,
  type ReverseDepStats,
  type WalkCoverage,
} from '../lib/reverse-dep-walk.js'
import {
  runVerificationChecklist,
  type ChecklistStats,
  type VerificationFinding,
} from '../lib/verification-checklist.js'
import {
  phaseStatePath,
  readPhaseState,
  refuseUnreadableState,
  writePhaseState,
  type PhaseState,
  type PhaseVerificationBlock,
} from '../lib/phase-scope.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { computeRunId, describeEvidenceMix, summarizeEvidence } from '../lib/findings.js'
import { isStaleVerificationLabel, leftoverTaskHint, leftoverTaskSlug } from '../lib/phase-machine.js'
import { defaultGitExecutor, getHeadShaFull } from '../lib/git.js'
import { EMPTY_CONTRACT_GRAPH, type ContractGraph } from '../lib/contracts.js'
import { gatherContractFacts } from '../lib/contract-facts.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

export const phaseVerificationStartInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    spec_ref: z
      .string()
      .min(1, 'spec_ref required')
      .describe(
        'Free-form spec identifier — typically the plan slug (e.g., "feat-aprovacao") or a path to plan_<slug>.md. Used to correlate start/complete and as audit key.',
      ),
    spec_slug: z
      .string()
      .min(1)
      .optional()
      .describe('Task name to record in phase-state.json. Pass it when a start returns previous_task_pending: the recorded task name (continue it) or spec_ref (new task), as the developer decided.'),
    declared_paths: z
      .array(z.string())
      .default([])
      .describe('Project-relative paths the spec declares as affected. Used as seeds for reverse-dep walk.'),
    spec_claims: z
      .array(z.string().min(5))
      .optional()
      .describe('Short claim sentences extracted from the spec, each scanned via lib/premise-check against decisions + anti-decisions.'),
    spec_tier: z
      .enum(TIER_VALUES)
      .default('standard')
      .describe('Tier per rsct_classify_task (pending its arrival). trivial+small skip the V phase; standard runs; complex runs and mandates _complete before code-start.'),
    persona: z
      .string()
      .optional()
      .describe('Optional persona slug to bias the checklist lens (F3 personas). Accepted today but no-op until F3 ships; logged into audit as requested_persona.'),
    max_depth: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2)
      .describe('Reverse-dep walk depth budget. 1 = direct importers only; default 2 covers two hops.'),
    existing_project_files: z
      .array(z.string())
      .optional()
      .describe('Optional list of all project files (project-relative posix) for the redundancy basename-overlap check. When absent, redundancy check is skipped.'),
  })
  .strict()

export type PhaseVerificationStartInput = z.infer<
  typeof phaseVerificationStartInputSchema
>

export type PhaseVerificationStartStatus =
  | 'verified'
  | 'skipped_tier'
  | 'state_write_failed'
  | 'phase_already_active'
  | 'previous_task_pending'

export interface PhaseVerificationStartOutput {
  status: PhaseVerificationStartStatus
  rsct_installed: boolean
  spec_ref: string
  spec_tier: Tier
  requested_persona: string | null
  declared_paths: string[]
  discovered_importers: DiscoveredImporter[]
  findings: VerificationFinding[]
  findings_run_id: string | null
  walk_stats: ReverseDepStats
  walk_coverage: WalkCoverage
  checklist_stats: ChecklistStats
  phase_state_path: string
  phase_state_written: boolean
  existing_phase: string | null
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export const phaseVerificationStartTool: Tool = {
  name: 'rsct_phase_verification_start',
  description:
    'Start the V (Verification) phase between spec-approval and code-edit. Runs the reverse-dependency walk over declared_paths, executes the checklist (gap / breakage / redundancy / forgotten) against the project decisions + knowledge + architecture + impact docs, writes the verification block into .rsct/phase-state.json, and emits one audit event per finding. For spec_tier=trivial|small the phase is skipped (audit-only). Refuses with phase_already_active if a DIFFERENT phase is already active — close or abandon it first. The severity on each finding is a RECOMMENDATION, but answering is not optional: the dev sets an action on EVERY finding via rsct_phase_verification_complete, and leaving any unanswered rejects completion. Echo the returned findings_run_id back on that call. Note the checklist can only see what it is given — omitting spec_claims or existing_project_files shrinks the baseline it can raise. The contract check reads what the commit gate reads: every .rsct.json from the project folder to the repository top (working tree and HEAD, at their strictest) and, in each linked universe, its working tree, HEAD and fetched upstream; what changed since the last approved commit comes back in hints.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      spec_ref: {
        type: 'string',
        description: 'Free-form spec identifier (plan slug or plan_<slug>.md path).',
      },
      spec_slug: {
        type: 'string',
        description: 'Task name to record. Pass it after previous_task_pending, as the developer decided: the recorded task name (continue) or spec_ref (new task).',
      },
      declared_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative paths the spec declares as affected. Seed set for reverse-dep walk.',
      },
      spec_claims: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short claim sentences from the spec scanned for premise / anti-decision overlap.',
      },
      spec_tier: {
        type: 'string',
        enum: [...TIER_VALUES],
        default: 'standard',
        description: 'trivial+small skip the V phase; standard runs; complex runs + mandates _complete.',
      },
      persona: {
        type: 'string',
        description: 'Optional persona slug; no-op until F3 ships. Logged into audit as requested_persona.',
      },
      max_depth: {
        type: 'number',
        default: 2,
        description: 'Reverse-dep walk depth (1 = direct importers only).',
      },
      existing_project_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional project-file index for redundancy basename-overlap check.',
      },
    },
    additionalProperties: false,
  },
}

export async function phaseVerificationStartHandler(
  rawInput: unknown,
): Promise<PhaseVerificationStartOutput> {
  const input = phaseVerificationStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config

  const phaseStatePathStr = phaseStatePath(projectRoot)
  const requestedPersona = input.persona ?? null

  const walk = walkReverseDeps({
    projectRoot,
    seedPaths: input.declared_paths,
    maxDepth: input.max_depth,
  })

  const universe = gatherContractFacts({
    projectRoot,
    config: config ?? null,
    readPaths: () => walk.declared,
    executor: defaultGitExecutor,
    always: true,
    ...(config?.audit !== undefined && { auditConfig: config.audit }),
  })
  const contractGraph: ContractGraph =
    universe === null || !universe.universeLinked
      ? EMPTY_CONTRACT_GRAPH
      : { available: !universe.inactive, contracts: universe.contracts, note: universe.note }

  const checklistArgs: Parameters<typeof runVerificationChecklist>[0] = {
    projectRoot,
    declaredPaths: walk.declared,
    discoveredImporters: walk.discovered,
    specTier: input.spec_tier,
    contractGraph,
    appNames: universe?.apps ?? (config?.app?.name ? [config.app.name] : []),
    universeLinked: universe?.universeLinked === true,
  }
  if (input.spec_claims !== undefined) checklistArgs.specClaims = input.spec_claims
  if (input.existing_project_files !== undefined) {
    checklistArgs.existingProjectFiles = input.existing_project_files
  }
  const checklist = runVerificationChecklist(checklistArgs)
  const findingsRunId = computeRunId(checklist.findings)

  if (input.spec_tier === 'trivial' || input.spec_tier === 'small') {
    const skipAudit = appendAuditEntry(
      projectRoot,
      {
        event: 'verification.skip',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        requested_persona: requestedPersona,
        walk_coverage: walk.coverage,
      },
      config?.audit,
    )
    const fields = auditFields(skipAudit)
    return {
      status: 'skipped_tier',
      findings_run_id: null,
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
      walk_coverage: walk.coverage,
      checklist_stats: checklist.stats,
      phase_state_path: phaseStatePathStr,
      phase_state_written: false,
      existing_phase: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [
        ...walk.hints,
        ...checklist.hints,
        `spec_tier=${input.spec_tier} — V phase skipped per tier table; no phase-state write.`,
      ],
    }
  }

  const startedAt = new Date().toISOString()
  const existing = readPhaseState(projectRoot)
  const baseState: PhaseState = existing.state ?? {}
  const existingPhase = baseState.phase ?? null

  if (existingPhase !== null && existingPhase !== 'verification') {
    const rejectAudit = appendAuditEntry(
      projectRoot,
      {
        event: 'verification.start.rejected',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        reject_kind: 'phase_already_active',
        existing_phase: existingPhase,
      },
      config?.audit,
    )
    const fields = auditFields(rejectAudit)
    return {
      status: 'phase_already_active',
      findings_run_id: null,
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
      walk_coverage: walk.coverage,
      checklist_stats: checklist.stats,
      phase_state_path: phaseStatePathStr,
      phase_state_written: false,
      existing_phase: existingPhase,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [
        `Phase '${existingPhase}' is already active. Close it with rsct_phase_${existingPhase}_complete, or discard it with rsct_phase_abandon (records a reason in the audit log), before starting the V phase.`,
      ],
    }
  }

  const unreadable = refuseUnreadableState(projectRoot, existing)
  if (unreadable && !unreadable.ok && unreadable.reason === 'unreadable_state') {
    const unreadableAudit = appendAuditEntry(
      projectRoot,
      {
        event: 'verification.start.rejected',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        reject_kind: 'state_unreadable',
      },
      config?.audit,
    )
    const fields = auditFields(unreadableAudit)
    return {
      status: 'state_write_failed',
      findings_run_id: null,
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
      walk_coverage: walk.coverage,
      checklist_stats: checklist.stats,
      phase_state_path: phaseStatePathStr,
      phase_state_written: false,
      existing_phase: existingPhase,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [`⚠ ${unreadable.error} The V phase did not start.`],
    }
  }

  const leftover = leftoverTaskSlug(baseState, 'verification', input.spec_ref, input.spec_slug)
  if (leftover !== null) {
    const leftoverAudit = appendAuditEntry(
      projectRoot,
      {
        event: 'verification.start.rejected',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        reject_kind: 'previous_task_pending',
        existing_spec_slug: leftover,
      },
      config?.audit,
    )
    const fields = auditFields(leftoverAudit)
    return {
      status: 'previous_task_pending',
      findings_run_id: null,
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
      walk_coverage: walk.coverage,
      checklist_stats: checklist.stats,
      phase_state_path: phaseStatePathStr,
      phase_state_written: false,
      existing_phase: existingPhase,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [leftoverTaskHint('verification', leftover, input.spec_ref, baseState.started_at ?? baseState.verification?.started_at ?? null)],
    }
  }

  const staleRestart = isStaleVerificationLabel(baseState)

  const headSha = getHeadShaFull(projectRoot)

  const verificationBlock: PhaseVerificationBlock = {
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    findings_run_id: findingsRunId,
    started_at: startedAt,
    observed_at: startedAt,
  }
  if (headSha !== null) verificationBlock.head_sha = headSha
  if (requestedPersona !== null) verificationBlock.persona = requestedPersona

  const newState: PhaseState = {
    ...baseState,
    phase: 'verification',
    spec_slug: input.spec_slug ?? baseState.spec_slug ?? input.spec_ref,
    verification: verificationBlock,
  }
  const writeResult = writePhaseState(projectRoot, newState)

  if (staleRestart) {
    appendAuditEntry(
      projectRoot,
      {
        event: 'phase.stale_label_cleared',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        previous_phase: 'verification',
        previous_spec_slug: baseState.spec_slug ?? null,
        verification_spec_ref: baseState.verification?.spec_ref ?? null,
        verification_completed_at: baseState.verification?.completed_at ?? null,
        phase_state_written: writeResult.ok,
      },
      config?.audit,
    )
  }

  const startAudit = appendAuditEntry(
    projectRoot,
    {
      event: 'verification.start',
      tool: 'rsct_phase_verification_start',
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_count: walk.declared.length,
      discovered_count: walk.discovered.length,
      walk_coverage: walk.coverage,
      contract_graph: checklist.stats.contract_graph,
      contracts_scanned: checklist.stats.contracts_scanned,
      uncovered_seed_count: walk.uncovered_seeds.length,
      unresolved_js_specifiers: walk.stats.unresolved_js_specifiers,
      findings_count: checklist.findings.length,
      evidence_mix: summarizeEvidence(checklist.findings),
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )

  for (const finding of checklist.findings) {
    appendAuditEntry(
      projectRoot,
      {
        event: 'verification.finding',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        finding_id: finding.id,
        category: finding.category,
        severity: finding.severity,
        source: finding.source,
        title: finding.title,
        evidence_kind: finding.evidence.kind,
      },
      config?.audit,
    )
  }

  const fields = auditFields(startAudit)
  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(`Evidence: ${describeEvidenceMix(summarizeEvidence(checklist.findings))}.`)
    hints.push(
      `Phase state written to ${writeResult.path}. ${checklist.findings.length} finding(s) surfaced — EVERY one needs an action. Call rsct_phase_verification_complete with findings_actions[] covering all of them, findings_run_id='${findingsRunId}', and dev_approval.`,
    )
  } else if (writeResult.reason === 'locked') {
    hints.push(
      `⚠ another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago by session ${writeResult.held_by_session ?? 'unknown'}) — wait and retry. Verification ran but state was not persisted.`,
    )
  } else {
    hints.push(
      `⚠ phase-state.json write failed: ${writeResult.error}. Verification ran but state was not persisted; rsct_phase_verification_complete will not find an active block.`,
    )
  }
  hints.push(...coverageHints(walk))
  hints.push(...walk.hints)
  hints.push(...checklist.hints)
  hints.push(...(universe?.lines ?? []))
  if (fields.audit_error !== null) {
    hints.push(`⚠ audit log write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'verified' : 'state_write_failed',
    findings_run_id: writeResult.ok ? findingsRunId : null,
    rsct_installed: resolution.rsct_installed,
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    requested_persona: requestedPersona,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    walk_stats: walk.stats,
    walk_coverage: walk.coverage,
    checklist_stats: checklist.stats,
    phase_state_path: phaseStatePathStr,
    phase_state_written: writeResult.ok,
    existing_phase: null,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints,
  }
}

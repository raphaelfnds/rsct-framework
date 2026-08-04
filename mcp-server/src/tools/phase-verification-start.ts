import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  walkReverseDeps,
  type DiscoveredImporter,
  type ReverseDepStats,
} from '../lib/reverse-dep-walk.js'
import {
  runVerificationChecklist,
  type ChecklistStats,
  type VerificationFinding,
} from '../lib/verification-checklist.js'
import {
  phaseStatePath,
  readPhaseState,
  writePhaseState,
  type PhaseState,
  type PhaseVerificationBlock,
} from '../lib/phase-scope.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { isStaleVerificationLabel } from '../lib/phase-machine.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

export const phaseVerificationStartInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    spec_ref: z
      .string()
      .min(1, 'spec_ref required')
      .describe(
        'Free-form spec identifier — typically the plan slug (e.g., "feat-aprovacao") or a path to plan_<slug>.md. Used to correlate start/complete and as audit key.',
      ),
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

export interface PhaseVerificationStartOutput {
  status: PhaseVerificationStartStatus
  rsct_installed: boolean
  spec_ref: string
  spec_tier: Tier
  requested_persona: string | null
  declared_paths: string[]
  discovered_importers: DiscoveredImporter[]
  findings: VerificationFinding[]
  walk_stats: ReverseDepStats
  checklist_stats: ChecklistStats
  phase_state_path: string
  phase_state_written: boolean
  /** The phase that blocked this start, when status is phase_already_active. */
  existing_phase: string | null
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export const phaseVerificationStartTool: Tool = {
  name: 'rsct_phase_verification_start',
  description:
    'Start the V (Verification) phase between spec-approval and code-edit. Runs the reverse-dependency walk over declared_paths, executes the checklist (gap / breakage / redundancy / forgotten) against the project decisions + knowledge + architecture + impact docs, writes the verification block into .rsct/phase-state.json, and emits one audit event per finding. For spec_tier=trivial|small the phase is skipped (audit-only). Refuses with phase_already_active if a DIFFERENT phase is already active — close or abandon it first. Findings are recommendations — dev sets the action on each via rsct_phase_verification_complete.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      spec_ref: {
        type: 'string',
        description: 'Free-form spec identifier (plan slug or plan_<slug>.md path).',
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

  const checklistArgs: Parameters<typeof runVerificationChecklist>[0] = {
    projectRoot,
    declaredPaths: walk.declared,
    discoveredImporters: walk.discovered,
    specTier: input.spec_tier,
  }
  if (input.spec_claims !== undefined) checklistArgs.specClaims = input.spec_claims
  if (input.existing_project_files !== undefined) {
    checklistArgs.existingProjectFiles = input.existing_project_files
  }
  const checklist = runVerificationChecklist(checklistArgs)

  if (input.spec_tier === 'trivial' || input.spec_tier === 'small') {
    const skipAudit = appendAuditEntry(
      projectRoot,
      {
        event: 'verification.skip',
        tool: 'rsct_phase_verification_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        requested_persona: requestedPersona,
      },
      config?.audit,
    )
    const fields = auditFields(skipAudit)
    return {
      status: 'skipped_tier',
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
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

  // #27. Every other `_start` routes through `startPhaseGeneric`, which refuses
  // to overwrite a DIFFERENT active phase. This tool owns its own plumbing (the
  // checklist and reverse-dep walk diverge from the symmetric pattern) and, as a
  // side effect, used to write `phase: 'verification'` over whatever label was
  // there — no gate, no approval, no audit. An agent mid-Code could reach Test
  // without ever calling `code_complete`, and the phase history would no longer
  // describe what happened.
  //
  // Deliberately placed AFTER the `skipped_tier` return above, so that path
  // still writes no state at all — which is what makes its "audit-only" claim
  // literally true.
  //
  // Note what is NOT mirrored here: `startPhaseGeneric`'s stale-label exception
  // is unreachable in this tool. It requires `existingPhase === 'verification'`,
  // while the guard it excuses requires `existingPhase !== input.phase` — and
  // here `input.phase` IS `'verification'`, so the two conditions are mutually
  // exclusive. A literal mirror would be dead code. The live case is a stale
  // SAME-label restart, handled below.
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
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
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

  // A completed V being reopened. `startPhaseGeneric` stays silent on a same-label
  // restart, and that is right for it — restarting the phase you are already in
  // is routine. Here it is not: the block about to be rebuilt carries a
  // `completed_at`, so a finished verification record is being discarded. That is
  // the transition #15's gate exception leans on, and it deserves a forensic line.
  const staleRestart = isStaleVerificationLabel(baseState)

  const verificationBlock: PhaseVerificationBlock = {
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    started_at: startedAt,
  }
  if (requestedPersona !== null) verificationBlock.persona = requestedPersona

  const newState: PhaseState = {
    ...baseState,
    phase: 'verification',
    spec_slug: baseState.spec_slug ?? input.spec_ref,
    verification: verificationBlock,
  }
  const writeResult = writePhaseState(projectRoot, newState)

  // Emitted AFTER the write, like the generic's equivalent: a `locked` or failed
  // write must not leave the log asserting a transition that never landed.
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
      findings_count: checklist.findings.length,
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
      },
      config?.audit,
    )
  }

  const fields = auditFields(startAudit)
  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(
      `Phase state written to ${writeResult.path}. ${checklist.findings.length} finding(s) surfaced — review and call rsct_phase_verification_complete with findings_actions[] + dev_approval.`,
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
  hints.push(...walk.hints)
  hints.push(...checklist.hints)
  if (fields.audit_error !== null) {
    hints.push(`⚠ audit log write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'verified' : 'state_write_failed',
    rsct_installed: resolution.rsct_installed,
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    requested_persona: requestedPersona,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    walk_stats: walk.stats,
    checklist_stats: checklist.stats,
    phase_state_path: phaseStatePathStr,
    phase_state_written: writeResult.ok,
    existing_phase: null,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints,
  }
}

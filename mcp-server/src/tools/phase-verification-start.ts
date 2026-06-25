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
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'

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
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export const phaseVerificationStartTool: Tool = {
  name: 'rsct_phase_verification_start',
  description:
    'Start the V (Verification) phase between spec-approval and code-edit. Runs the reverse-dependency walk over declared_paths, executes the checklist (gap / breakage / redundancy / forgotten) against the project decisions + knowledge + architecture + impact docs, writes the verification block into .rsct/phase-state.json, and emits one audit event per finding. For spec_tier=trivial|small the phase is skipped (audit-only). Findings are recommendations — dev sets the action on each via rsct_phase_verification_complete.',
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

function auditFields(
  audit: AuditAppendResult,
): { audit_path: string | null; audit_error: string | null } {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
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
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints,
  }
}

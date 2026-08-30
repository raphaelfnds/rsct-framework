import { z } from 'zod'
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
  writePhaseState,
  type PhaseState,
  type PhaseVerificationBlock,
} from '../lib/phase-scope.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { computeRunId, describeEvidenceMix, summarizeEvidence } from '../lib/findings.js'
import { isStaleVerificationLabel } from '../lib/phase-machine.js'
import { getHeadShaFull } from '../lib/git.js'

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
  /**
   * #40: identifies the SET of findings above. `rsct_phase_verification_complete`
   * echoes it back so an answer set prepared before a re-run is rejected as stale.
   * `null` when nothing was persisted (a skipped tier, or a failed write) — a run id
   * for a baseline that does not exist would have the agent answer against nothing.
   */
  findings_run_id: string | null
  walk_stats: ReverseDepStats
  /**
   * #54. How much of `declared_paths` the reverse-dep walk was able to look at.
   * Travels on every return path as `walk_stats` does — unlike
   * `discovered_importers`, which is zeroed where no phase started.
   */
  walk_coverage: WalkCoverage
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
    'Start the V (Verification) phase between spec-approval and code-edit. Runs the reverse-dependency walk over declared_paths, executes the checklist (gap / breakage / redundancy / forgotten) against the project decisions + knowledge + architecture + impact docs, writes the verification block into .rsct/phase-state.json, and emits one audit event per finding. For spec_tier=trivial|small the phase is skipped (audit-only). Refuses with phase_already_active if a DIFFERENT phase is already active — close or abandon it first. The severity on each finding is a RECOMMENDATION, but answering is not optional: the dev sets an action on EVERY finding via rsct_phase_verification_complete, and leaving any unanswered rejects completion. Echo the returned findings_run_id back on that call. Note the checklist can only see what it is given — omitting spec_claims or existing_project_files shrinks the baseline it can raise.',
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
        // Recorded here too: the only artifact a trivial/small run leaves.
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

  // A completed V being reopened. `startPhaseGeneric` stays silent on a same-label
  // restart, and that is right for it — restarting the phase you are already in
  // is routine. Here it is not: the block about to be rebuilt carries a
  // `completed_at`, so a finished verification record is being discarded. That is
  // the transition #15's gate exception leans on, and it deserves a forensic line.
  const staleRestart = isStaleVerificationLabel(baseState)

  // #75 Part C. One git spawn, full sha, null outside a repo. Read here rather
  // than at `_complete` so the record says what HEAD WAS when the findings were
  // produced — a working tree is a moving target and only a commit is fixed.
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
  // Conditional, not `?? null`: `exactOptionalPropertyTypes` is on, and a stamp
  // that is absent outside a git repo is honest where a null one is noise.
  if (headSha !== null) verificationBlock.head_sha = headSha
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
      // #54. Hints are not audited, so a V that ran blind used to leave no
      // queryable trace — `discovered_count: 0` reads identically whether the
      // graph was empty, unavailable, or merely incomplete. All three of these
      // are needed to tell them apart: the seed counts do not capture a
      // resolver that dropped every edge while every seed was analyzable.
      walk_coverage: walk.coverage,
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
        // #75. The class, per finding, in the forensic record — so a past run can
        // be re-read for what it actually knew, not only for what it decided.
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
  // #54. Before the walk's and the checklist's hints, not after: this is the
  // correction to the checklist's "found no findings to surface against the
  // available corpus", and appended last it would be read after the sentence it
  // exists to qualify. Prepending an advisory is the convention here
  // (`lib/install-advisory.ts`, the three request tools). Emitted only on the
  // non-skipped paths — see `coverageHints`.
  hints.push(...coverageHints(walk))
  hints.push(...walk.hints)
  hints.push(...checklist.hints)
  if (fields.audit_error !== null) {
    hints.push(`⚠ audit log write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'verified' : 'state_write_failed',
    // null on a failed write: advertising a run id for a baseline that was never
    // stored would have the agent answer against nothing.
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

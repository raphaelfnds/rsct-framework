import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseResult,
} from '../lib/phase-machine.js'
import {
  readPhaseState,
  tierRank,
  evaluateBootstrapMarker,
  type BootstrapMarker,
} from '../lib/phase-scope.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

/**
 * CAP-28: tiers that bypass the verification gate. Trivial + small tasks
 * intentionally skip V phase per the canonical RSCT tier table
 * (see prompts/B-architect-plan.md). Standard + complex must run V or
 * provide `override_verification_skip=true` with audit trail.
 */
const TIERS_BYPASSING_V_GATE: ReadonlySet<Tier> = new Set(['trivial', 'small'])

export const phaseCodeStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
    spec_tier: z
      .enum(TIER_VALUES)
      .default('standard')
      .describe(
        'Tier per rsct_classify_task. trivial+small bypass the verification gate; standard+complex require a completed V phase OR override_verification_skip=true.',
      ),
    override_verification_skip: z
      .boolean()
      .default(false)
      .describe(
        'When true, allows code phase to start without a completed verification block for tier ∈ {standard, complex}. The override is logged to audit; use sparingly when the dev has explicitly chosen to bypass V.',
      ),
    override_classify_downgrade: z
      .boolean()
      .default(false)
      .describe(
        'CAP-30: when true, allows spec_tier lower than the highest tier ever returned by rsct_classify_task (`last_classify.tier_max` in phase-state). Override is audit-logged. Use only when the dev has explicitly chosen to downgrade.',
      ),
  })
  .strict()

export type PhaseCodeStartInput = z.infer<typeof phaseCodeStartInputSchema>

export type VerificationGateStatus =
  | 'satisfied'
  | 'bypassed_tier'
  | 'overridden'
  | 'rejected_required'
  | 'rejected_incomplete'

export interface VerificationGate {
  status: VerificationGateStatus
  spec_tier: Tier
  v_block_found: boolean
  v_spec_ref: string | null
  v_completed_at: string | null
  hint: string
}

export interface PhaseCodeStartGateRejectedOutput {
  status: 'verification_gate_rejected' | 'classify_gate_rejected'
  reject_kind:
    | 'verification_required'
    | 'verification_incomplete'
    | 'classify_downgrade'
  reason: string
  spec_ref: string
  verification_gate: VerificationGate
  classify_gate: ClassifyGate
  phase_state_path: string
  phase_state_written: false
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export type ClassifyGateStatus =
  | 'no_record'
  | 'satisfied'
  | 'overridden'
  | 'rejected_downgrade'

export interface ClassifyGate {
  status: ClassifyGateStatus
  spec_tier: Tier
  tier_max_recorded: string | null
  classified_at: string | null
  hint: string
}

export type PhaseCodeStartOutput =
  | (StartPhaseResult & {
      verification_gate: VerificationGate
      classify_gate: ClassifyGate
      bootstrap_marker: BootstrapMarker
    })
  | PhaseCodeStartGateRejectedOutput

export const phaseCodeStartTool: Tool = {
  name: 'rsct_phase_code_start',
  description:
    'Start the C (Code) phase. Writes phase="code" into .rsct/phase-state.json and emits code.start audit. `scope_globs[]` are honored by rsct_check_edit_scope to gate which files may be edited during this phase. **CAP-28: verification gate** — for spec_tier ∈ {standard, complex} this tool reads phase-state.json and rejects unless a verification block matching spec_ref has completed_at set. Pass `override_verification_skip=true` to bypass (override is audit-logged). **CAP-30: classify gate** — also rejects when `spec_tier` is lower than `last_classify.tier_max` (the highest tier ever returned by rsct_classify_task for this project). Pass `override_classify_downgrade=true` to bypass (audit-logged). **CAP-31: bootstrap visibility** — warns (hint + audit) if `bootstrap_at` is missing or older than 4 hours. For spec_tier ∈ {trivial, small} the V gate is automatically bypassed.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string' },
      spec_slug: { type: 'string' },
      scope_globs: { type: 'array', items: { type: 'string' } },
      persona: { type: 'string' },
      spec_tier: {
        type: 'string',
        enum: [...TIER_VALUES],
        default: 'standard',
        description:
          'trivial+small bypass V gate; standard+complex require completed V or override.',
      },
      override_verification_skip: {
        type: 'boolean',
        default: false,
        description:
          'When true, bypass the V gate for standard+complex (audit-logged).',
      },
      override_classify_downgrade: {
        type: 'boolean',
        default: false,
        description:
          'When true, bypass the CAP-30 classify-downgrade gate (audit-logged).',
      },
    },
    additionalProperties: false,
  },
}

function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
}

/**
 * CAP-28 hard gate. Determines if code phase may proceed based on:
 *  - tier (trivial/small bypass)
 *  - presence of a completed verification block matching spec_ref
 *  - dev's explicit override flag
 *
 * Pure function — does not write state or audit; caller wires up audit
 * events after deciding.
 */
export function evaluateVerificationGate(args: {
  projectRoot: string
  specRef: string
  specTier: Tier
  overrideVerificationSkip: boolean
}): VerificationGate {
  const { specRef, specTier, overrideVerificationSkip } = args

  if (TIERS_BYPASSING_V_GATE.has(specTier)) {
    return {
      status: 'bypassed_tier',
      spec_tier: specTier,
      v_block_found: false,
      v_spec_ref: null,
      v_completed_at: null,
      hint: `tier=${specTier} bypasses verification gate per canonical tier table.`,
    }
  }

  const stateRead = readPhaseState(args.projectRoot)
  const vBlock = stateRead.state?.verification
  const vSpecRef = vBlock?.spec_ref ?? null
  const vCompletedAt = vBlock?.completed_at ?? null
  const vMatchesSpec = vSpecRef !== null && vSpecRef === specRef

  if (vMatchesSpec && vCompletedAt !== null) {
    return {
      status: 'satisfied',
      spec_tier: specTier,
      v_block_found: true,
      v_spec_ref: vSpecRef,
      v_completed_at: vCompletedAt,
      hint: `Verification phase completed at ${vCompletedAt} for this spec_ref. Code phase may proceed.`,
    }
  }

  if (vMatchesSpec && vCompletedAt === null) {
    return {
      status: 'rejected_incomplete',
      spec_tier: specTier,
      v_block_found: true,
      v_spec_ref: vSpecRef,
      v_completed_at: null,
      hint: `Verification phase started for spec_ref='${specRef}' but not completed. Call rsct_phase_verification_complete first, OR pass override_verification_skip=true to bypass.`,
    }
  }

  if (overrideVerificationSkip) {
    return {
      status: 'overridden',
      spec_tier: specTier,
      v_block_found: vBlock !== undefined,
      v_spec_ref: vSpecRef,
      v_completed_at: vCompletedAt,
      hint: `override_verification_skip=true acknowledged. Override logged to audit (.rsct/audit.log).`,
    }
  }

  return {
    status: 'rejected_required',
    spec_tier: specTier,
    v_block_found: vBlock !== undefined,
    v_spec_ref: vSpecRef,
    v_completed_at: vCompletedAt,
    hint:
      `tier='${specTier}' requires a completed verification phase for spec_ref='${specRef}'. Run rsct_phase_verification_start + _complete, OR pass override_verification_skip=true (logged to audit) when V is intentionally skipped.`,
  }
}

/**
 * CAP-30 classify-downgrade gate. Reads `last_classify.tier_max` from
 * phase-state and rejects when `spec_tier` is strictly lower (ranks
 * defined by `tierRank` in lib/phase-scope). Pure function — caller
 * wires audit events.
 */
export function evaluateClassifyGate(args: {
  projectRoot: string
  specTier: Tier
  overrideClassifyDowngrade: boolean
}): ClassifyGate {
  const { specTier, overrideClassifyDowngrade } = args
  const stateRead = readPhaseState(args.projectRoot)
  const block = stateRead.state?.last_classify
  if (!block) {
    return {
      status: 'no_record',
      spec_tier: specTier,
      tier_max_recorded: null,
      classified_at: null,
      hint: `No classify_task verdict on record — gate inactive. Run rsct_classify_task before code_start to enable the downgrade guard.`,
    }
  }
  const requestedRank = tierRank(specTier)
  const maxRank = tierRank(block.tier_max)
  if (requestedRank >= maxRank) {
    return {
      status: 'satisfied',
      spec_tier: specTier,
      tier_max_recorded: block.tier_max,
      classified_at: block.classified_at,
      hint: `spec_tier='${specTier}' ≥ recorded tier_max='${block.tier_max}'. Classify gate satisfied.`,
    }
  }
  if (overrideClassifyDowngrade) {
    return {
      status: 'overridden',
      spec_tier: specTier,
      tier_max_recorded: block.tier_max,
      classified_at: block.classified_at,
      hint: `override_classify_downgrade=true acknowledged. Downgrade from '${block.tier_max}' to '${specTier}' logged to audit.`,
    }
  }
  return {
    status: 'rejected_downgrade',
    spec_tier: specTier,
    tier_max_recorded: block.tier_max,
    classified_at: block.classified_at,
    hint: `spec_tier='${specTier}' is lower than recorded tier_max='${block.tier_max}' (classified at ${block.classified_at}). Pass override_classify_downgrade=true (audit-logged) to bypass, OR re-classify with rsct_classify_task if the task scope genuinely changed.`,
  }
}

export async function phaseCodeStartHandler(
  rawInput: unknown,
): Promise<PhaseCodeStartOutput> {
  const input = phaseCodeStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)

  // CAP-30 classify-downgrade gate runs FIRST. A downgrade attempt is
  // higher-severity than a missing V — it tries to bypass the V gate
  // by lying about the tier. We surface it before V semantics so the
  // dev sees the most-actionable error in the response payload.
  const classifyGate = evaluateClassifyGate({
    projectRoot: resolution.root,
    specTier: input.spec_tier,
    overrideClassifyDowngrade: input.override_classify_downgrade,
  })

  if (classifyGate.status === 'rejected_downgrade') {
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: 'code.start.rejected',
        tool: 'rsct_phase_code_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: 'classify_downgrade',
        tier_max_recorded: classifyGate.tier_max_recorded,
        classified_at: classifyGate.classified_at,
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    // Build a placeholder verification_gate for the rejected envelope
    // so the output shape stays uniform across reject paths.
    const placeholderVGate: VerificationGate = {
      status: 'bypassed_tier',
      spec_tier: input.spec_tier,
      v_block_found: false,
      v_spec_ref: null,
      v_completed_at: null,
      hint: 'classify gate rejected before V evaluation',
    }
    return {
      status: 'classify_gate_rejected',
      reject_kind: 'classify_downgrade',
      reason: classifyGate.hint,
      spec_ref: input.spec_ref,
      verification_gate: placeholderVGate,
      classify_gate: classifyGate,
      phase_state_path: '',
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [classifyGate.hint],
    }
  }

  if (classifyGate.status === 'overridden') {
    appendAuditEntry(
      resolution.root,
      {
        event: 'code.start.classify_downgrade_override',
        tool: 'rsct_phase_code_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        tier_max_recorded: classifyGate.tier_max_recorded,
      },
      resolution.config?.audit,
    )
  }

  const gate = evaluateVerificationGate({
    projectRoot: resolution.root,
    specRef: input.spec_ref,
    specTier: input.spec_tier,
    overrideVerificationSkip: input.override_verification_skip,
  })

  if (gate.status === 'rejected_required' || gate.status === 'rejected_incomplete') {
    const rejectKind =
      gate.status === 'rejected_required'
        ? 'verification_required'
        : 'verification_incomplete'
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: 'code.start.rejected',
        tool: 'rsct_phase_code_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: rejectKind,
        v_block_found: gate.v_block_found,
        v_spec_ref: gate.v_spec_ref,
        v_completed_at: gate.v_completed_at,
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'verification_gate_rejected',
      reject_kind: rejectKind,
      reason: gate.hint,
      spec_ref: input.spec_ref,
      verification_gate: gate,
      classify_gate: classifyGate,
      phase_state_path: '',
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [gate.hint],
    }
  }

  if (gate.status === 'overridden') {
    appendAuditEntry(
      resolution.root,
      {
        event: 'code.start.verification_override',
        tool: 'rsct_phase_code_start',
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        v_block_found: gate.v_block_found,
        v_spec_ref: gate.v_spec_ref,
      },
      resolution.config?.audit,
    )
  }

  // CAP-31 bootstrap visibility — surfaces warning (not reject) if §0
  // was skipped or stale. Audit-logged for forensic trail.
  const bootstrap = evaluateBootstrapMarker({ projectRoot: resolution.root })
  if (bootstrap.status !== 'fresh') {
    appendAuditEntry(
      resolution.root,
      {
        event: 'code.start.bootstrap_warning',
        tool: 'rsct_phase_code_start',
        spec_ref: input.spec_ref,
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
      },
      resolution.config?.audit,
    )
  }

  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'code',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona
  const result = startPhaseGeneric(args, resolution.config)
  const extras = {
    verification_gate: gate,
    classify_gate: classifyGate,
    bootstrap_marker: bootstrap,
  }
  const baseHints = result.hints ?? []
  if (bootstrap.status !== 'fresh' && bootstrap.hint) {
    baseHints.push(bootstrap.hint)
  }
  return { ...result, ...extras, hints: baseHints }
}

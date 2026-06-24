import { type RsctConfig } from './project-root.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
} from './phase-scope.js'
import { appendAuditEntry, type AuditAppendResult } from './audit-log.js'
import {
  gateRequest,
  type GateChannel,
  type GateRejectKind,
} from './request-gate.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from './os-dialog.js'
import {
  recordConsumedApproval,
  type FabricationSignal,
} from './dev-approval.js'

/**
 * Shared helpers backing the R/S/C/T phase tool pairs. V phase
 * (rsct_phase_verification_{start,complete}) does NOT use these — its
 * checklist + reverse-dep walk + per-finding audit shape diverges from
 * the symmetric R/S/C/T pattern, so it owns its plumbing.
 *
 * Why a shared lib instead of generic phase tool?
 *   - Per-tool MCP discoverability (Claude sees rsct_phase_spec_start,
 *     not rsct_phase_transition({to_phase:"spec"})).
 *   - Per-phase audit event names (`spec.start` not `phase.start`).
 *   - INV-2.2 scope_mismatch detects per-tool action_scope prefix.
 *   - Future phase-specific logic (e.g., research sub-iterations for
 *     complex tier) has a clean extension point in the tool layer.
 */

export const RSCT_PHASES = [
  'research',
  'spec',
  'verification',
  'code',
  'test',
] as const

export type RsctPhase = (typeof RSCT_PHASES)[number]

/**
 * Canonical RSCT phase order. Used by `nextPhase` to suggest the next
 * `_start` call after a `_complete`. Verification is OPTIONAL between
 * spec and code: when `spec_complete` lands, the next recommended phase
 * is verification; when `verification_complete` lands, it's code; when
 * spec is skipped straight to code, that is the dev's call.
 */
const PHASE_ORDER: readonly RsctPhase[] = [
  'research',
  'spec',
  'verification',
  'code',
  'test',
]

export function nextPhase(current: RsctPhase): RsctPhase | null {
  const idx = PHASE_ORDER.indexOf(current)
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null
  return PHASE_ORDER[idx + 1]!
}

export function auditFields(audit: AuditAppendResult): {
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

export interface StartPhaseInput {
  projectRoot: string
  phase: RsctPhase
  specRef: string
  specSlug?: string
  scopeGlobs?: string[]
  persona?: string
}

export type StartPhaseStatus =
  | 'started'
  | 'phase_already_active'
  | 'state_write_failed'

export interface StartPhaseResult {
  status: StartPhaseStatus
  phase: RsctPhase
  spec_ref: string
  spec_slug: string | null
  started_at: string
  scope_globs: string[]
  requested_persona: string | null
  phase_state_path: string
  phase_state_written: boolean
  existing_phase: string | null
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export interface StartPhaseInternal {
  auditWriter?: typeof appendAuditEntry
  now?: Date
}

export function startPhaseGeneric(
  input: StartPhaseInput,
  config: RsctConfig | null,
  internal: StartPhaseInternal = {},
): StartPhaseResult {
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const startedAt = (internal.now ?? new Date()).toISOString()

  const existing = readPhaseState(input.projectRoot)
  const baseState: PhaseState = existing.state ?? {}
  const existingPhase = baseState.phase

  if (existingPhase && existingPhase !== input.phase) {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.start.rejected`,
        tool: `rsct_phase_${input.phase}_start`,
        spec_ref: input.specRef,
        reject_kind: 'phase_already_active',
        existing_phase: existingPhase,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'phase_already_active',
      phase: input.phase,
      spec_ref: input.specRef,
      spec_slug: baseState.spec_slug ?? null,
      started_at: startedAt,
      scope_globs: input.scopeGlobs ?? [],
      requested_persona: input.persona ?? null,
      phase_state_path: '',
      phase_state_written: false,
      existing_phase: existingPhase,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [
        `Phase '${existingPhase}' is already active. Call rsct_phase_${existingPhase}_complete first, or wipe .rsct/phase-state.json, before starting a different phase.`,
      ],
    }
  }

  const newState: PhaseState = {
    ...baseState,
    phase: input.phase,
    spec_slug: input.specSlug ?? baseState.spec_slug ?? input.specRef,
    started_at: startedAt,
  }
  if (input.scopeGlobs !== undefined) newState.scope_globs = input.scopeGlobs

  const writeResult = writePhaseState(input.projectRoot, newState)

  const audit = appendAudit(
    input.projectRoot,
    {
      event: `${input.phase}.start`,
      tool: `rsct_phase_${input.phase}_start`,
      spec_ref: input.specRef,
      spec_slug: newState.spec_slug,
      requested_persona: input.persona ?? null,
      scope_globs: input.scopeGlobs ?? [],
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )
  const fields = auditFields(audit)

  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(
      `Phase '${input.phase}' started for spec_ref='${input.specRef}'. State at ${writeResult.path}. Call rsct_phase_${input.phase}_complete with dev_approval (action_scope='${input.phase}_complete:spec_ref=${input.specRef}') when ready.`,
    )
  } else if (writeResult.reason === 'locked') {
    hints.push(
      `⚠ another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago by session ${writeResult.held_by_session ?? 'unknown'}). Wait and retry.`,
    )
  } else {
    hints.push(`⚠ phase-state.json write failed: ${writeResult.error}.`)
  }

  return {
    status: writeResult.ok ? 'started' : 'state_write_failed',
    phase: input.phase,
    spec_ref: input.specRef,
    spec_slug: newState.spec_slug ?? null,
    started_at: startedAt,
    scope_globs: input.scopeGlobs ?? [],
    requested_persona: input.persona ?? null,
    phase_state_path: writeResult.path,
    phase_state_written: writeResult.ok,
    existing_phase: null,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints,
  }
}

export interface CompletePhaseInput {
  projectRoot: string
  phase: RsctPhase
  specRef: string
  devApproval: unknown
}

export type CompletePhaseStatus =
  | 'completed'
  | 'rejected'
  | 'state_write_failed'
  | 'no_active_phase'

export type CompletePhaseRejectKind =
  | GateRejectKind
  | 'spec_ref_mismatch'
  | 'phase_mismatch'

export interface CompletePhaseResult {
  status: CompletePhaseStatus
  phase: RsctPhase
  channel: GateChannel | null
  reject_kind: CompletePhaseRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  spec_ref: string
  cleared: boolean
  next_recommended_phase: RsctPhase | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface CompletePhaseInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
}

export async function gatePhaseComplete(
  input: CompletePhaseInput,
  config: RsctConfig | null,
  internal: CompletePhaseInternal = {},
): Promise<CompletePhaseResult> {
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const existing = readPhaseState(input.projectRoot)
  if (!existing.exists || !existing.state?.phase) {
    return {
      status: 'no_active_phase',
      phase: input.phase,
      channel: null,
      reject_kind: null,
      reason:
        'no active phase in .rsct/phase-state.json — call rsct_phase_*_start first',
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `No active phase in phase-state.json. Run rsct_phase_${input.phase}_start before _complete.`,
      ],
    }
  }

  const state = existing.state

  if (state.phase !== input.phase) {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: 'phase_mismatch',
        active_phase: state.phase,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      phase: input.phase,
      channel: null,
      reject_kind: 'phase_mismatch',
      reason: `active phase is '${state.phase}', not '${input.phase}'`,
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `phase-state.json holds phase='${state.phase}', not '${input.phase}'. Call rsct_phase_${state.phase}_complete instead, or wipe the state.`,
      ],
    }
  }

  if (state.spec_slug && state.spec_slug !== input.specRef) {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: 'spec_ref_mismatch',
        existing_spec_slug: state.spec_slug,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      phase: input.phase,
      channel: null,
      reject_kind: 'spec_ref_mismatch',
      reason: `phase-state holds spec_slug='${state.spec_slug}' but input spec_ref is '${input.specRef}'`,
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `spec_ref mismatch — pass spec_ref='${state.spec_slug}' to match the active phase.`,
      ],
    }
  }

  const gate = await gateRequest({
    toolName: `rsct_phase_${input.phase}_complete`,
    approval: input.devApproval,
    dialog: {
      title: `RSCT — ${input.phase} complete`,
      message: `Complete the ${input.phase} phase for spec '${input.specRef}'?`,
    },
    projectRoot: input.projectRoot,
    ...(config?.approval_modes !== undefined && {
      approvalModes: config.approval_modes,
    }),
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      phase: input.phase,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const newState: PhaseState = { ...state }
  delete newState.phase
  delete newState.scope_globs
  delete newState.started_at

  const writeResult = writePhaseState(input.projectRoot, newState)
  const record = recordApproval(gate.approval, {
    projectRoot: input.projectRoot,
    now,
  })

  const recommended = nextPhase(input.phase)
  const completedAt = now.toISOString()

  const completeAudit = appendAudit(
    input.projectRoot,
    {
      event: `${input.phase}.complete`,
      tool: `rsct_phase_${input.phase}_complete`,
      spec_ref: input.specRef,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      next_recommended_phase: recommended,
      completed_at: completedAt,
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )
  const fields = auditFields(completeAudit)

  const hints: string[] = []
  if (writeResult.ok) {
    if (recommended) {
      hints.push(
        `${input.phase} complete for '${input.specRef}'. Next recommended phase: '${recommended}' — call rsct_phase_${recommended}_start when ready.`,
      )
    } else {
      hints.push(
        `${input.phase} complete for '${input.specRef}' — task cycle finished. spec_slug retained for traceability.`,
      )
    }
  } else if (writeResult.reason === 'locked') {
    hints.push(
      `⚠ ${input.phase} complete approved but another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago). State may be inconsistent.`,
    )
  } else {
    hints.push(
      `⚠ ${input.phase} complete approved but phase-state.json write failed: ${writeResult.error}.`,
    )
  }
  if (!record.ok) {
    hints.push(
      `⚠ I could not record this approval as used: ${record.error}. The dev_approval could be accepted again by mistake for a short time — use a fresh one next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  if (fields.audit_error !== null) {
    hints.push(`⚠ ${input.phase}.complete audit write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'completed' : 'state_write_failed',
    phase: input.phase,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    spec_ref: input.specRef,
    cleared: writeResult.ok,
    next_recommended_phase: recommended,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : (record.error ?? null),
    hints,
  }
}

import { type RsctConfig } from './project-root.js'
import { type FindingsGateRejectKind } from './findings.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
} from './phase-scope.js'
import { appendAuditEntry, auditFields } from './audit-log.js'
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
  'review',
  'test',
] as const

export type RsctPhase = (typeof RSCT_PHASES)[number]

/**
 * Canonical RSCT phase order. Used by `nextPhase` to suggest the next
 * `_start` call after a `_complete`. Verification is OPTIONAL between
 * spec and code: when `spec_complete` lands, the next recommended phase
 * is verification; when `verification_complete` lands, it's code; when
 * spec is skipped straight to code, that is the dev's call. REVIEW (code
 * review of the diff) sits between code and test: when `code_complete`
 * lands the next recommended phase is review; it is opt-in (asked once at
 * spec_complete via include_review) and the test-start gate honors that
 * decision. The recommended cycle is R→S→V→C→REVIEW→T.
 */
const PHASE_ORDER: readonly RsctPhase[] = [
  'research',
  'spec',
  'verification',
  'code',
  'review',
  'test',
]

export function nextPhase(current: RsctPhase): RsctPhase | null {
  const idx = PHASE_ORDER.indexOf(current)
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null
  return PHASE_ORDER[idx + 1]!
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
  /**
   * Extra state merged into the transition's SINGLE write (#40).
   *
   * A caller that needs to persist something alongside the phase label — REVIEW's
   * declared findings, say — must not do it in a second `writePhaseState`: the
   * advisory lock serialises writes but not read-modify-write cycles, so a
   * background `rsct_status` in another window can land between the two and drop
   * whichever it did not read. Hand-rolling the transition instead would be worse:
   * it would be a third copy of this function's guard, stale-label handling and
   * hint branches, and copying `verification_start`'s guard specifically would
   * regress #15 (see `isStaleVerificationLabel`).
   *
   * Applied AFTER the phase fields, so it sees them and can override deliberately.
   * A mutator rather than an object because callers also need to REMOVE keys, which
   * a spread cannot express under `exactOptionalPropertyTypes`.
   */
  patch?: (state: PhaseState) => void
}

/**
 * Stale-label exception (issue #15). A `verification` label whose block already
 * carries `completed_at` describes finished work: builds predating the fix could
 * strand it via `clear_phase: false`, and every documented way out (abandon,
 * wiping the state) also destroyed the V record that `rsct_phase_code_start`
 * requires — a closed loop whose only exit was editing the enforcement file by
 * hand.
 *
 * The condition is EXACTLY `phase === 'verification' && completed_at != null`
 * and must not be widened. Not `verification != null` alone (a V that started and
 * never completed is what `rejected_incomplete` exists to catch), not other phase
 * labels (no completion evidence behind them), and not a time-based heuristic
 * (staleness by clock is not staleness by completion). Anything looser turns this
 * repair into a general escape hatch from `phase_already_active` — the behavior
 * the mechanical layer exists to block.
 *
 * Exported so `rsct_phase_verification_start`, which owns its own plumbing and
 * cannot route through `startPhaseGeneric`, asks THIS function rather than
 * retyping the condition (issue #27). A retyped copy is exactly how a guard this
 * narrow gets widened by accident.
 */
export function isStaleVerificationLabel(state: PhaseState): boolean {
  return state.phase === 'verification' && state.verification?.completed_at != null
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

  const staleVerificationLabel = isStaleVerificationLabel(baseState)

  if (existingPhase && existingPhase !== input.phase && !staleVerificationLabel) {
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
        `Phase '${existingPhase}' is already active. Close it with rsct_phase_${existingPhase}_complete, or discard it with rsct_phase_abandon (records a reason in the audit log), before starting a different phase.`,
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
  internal.patch?.(newState)

  const writeResult = writePhaseState(input.projectRoot, newState)

  // Overwriting a completed label is a state transition worth its own forensic
  // record, separate from the `<phase>.start` event below. Emitted AFTER the
  // write so it reports what actually happened: a `locked` or failed write must
  // not leave the log asserting a transition that never landed. Carries the
  // PREVIOUS spec context too, so a reader can tell "cleared my own V" from
  // "stepped over another spec's V".
  if (staleVerificationLabel && existingPhase !== input.phase) {
    appendAudit(
      input.projectRoot,
      {
        event: 'phase.stale_label_cleared',
        tool: `rsct_phase_${input.phase}_start`,
        spec_ref: input.specRef,
        previous_phase: existingPhase,
        previous_spec_slug: baseState.spec_slug ?? null,
        verification_spec_ref: baseState.verification?.spec_ref ?? null,
        verification_completed_at: baseState.verification?.completed_at ?? null,
        phase_state_written: writeResult.ok,
      },
      config?.audit,
    )
  }

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
  /** #19: a REVIEW finding was marked action="block". */
  | 'block_actions_present'
  /** #40: the findings gate — see `lib/findings.ts`. */
  | FindingsGateRejectKind

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
  /**
   * #75. An extra line appended to the approval dialog's message, for a phase
   * that has something the generic transition cannot know — today, REVIEW's
   * evidence mix.
   *
   * Placed on the INTERNAL struct rather than on the public `CompletePhaseInput`,
   * following `StartPhaseInternal.patch`: the shared public type stays untouched,
   * and so does `DialogOptions`, which is `{title, message}` and would otherwise
   * need a third field — a cross-OS change to `os-dialog.ts` in release week.
   * The other four callers of `gatePhaseComplete` are unaffected.
   */
  dialogDetail?: string
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
        `phase-state.json holds phase='${state.phase}', not '${input.phase}'. Call rsct_phase_${state.phase}_complete instead, or discard that phase with rsct_phase_abandon.`,
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
      message: `Complete the ${input.phase} phase for spec '${input.specRef}'?${
        internal.dialogDetail ? `

${internal.dialogDetail}` : ''
      }`,
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
  // plan-lifecycle-v2 (Bloco 3.2): closing the TERMINAL phase of the cycle arms
  // the re-bootstrap flag, so the next task in the same session cannot reach an
  // Edit until rsct_load_context re-reads context. Robust terminal test
  // (nextPhase === null) rather than hardcoding 'test', so a trivial/small cycle
  // that ends earlier still arms it.
  if (nextPhase(input.phase) === null) {
    newState.context_stale = { since: now.toISOString(), reason: 'plan_closed' }
  }

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

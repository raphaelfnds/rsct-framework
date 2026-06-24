import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gateRequest,
  type GateChannel,
  type GateRejectKind,
} from '../lib/request-gate.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from '../lib/os-dialog.js'
import {
  recordConsumedApproval,
  type FabricationSignal,
} from '../lib/dev-approval.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
} from '../lib/phase-scope.js'

const ACTION_VALUES = [
  'accept',
  'address-now',
  'capture-as-issue',
  'defer',
  'block',
] as const

const findingActionSchema = z
  .object({
    finding_id: z.string().min(1, 'finding_id required'),
    action: z.enum(ACTION_VALUES),
    note: z.string().optional(),
  })
  .strict()

export const phaseVerificationCompleteInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    spec_ref: z
      .string()
      .min(1, 'spec_ref required')
      .describe('Must match the spec_ref recorded by the open V phase in .rsct/phase-state.json.'),
    findings_actions: z
      .array(findingActionSchema)
      .default([])
      .describe('Per-finding actions chosen by the dev. Any action="block" aborts completion.'),
    dev_approval: z
      .unknown()
      .describe('The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication).'),
    clear_phase: z
      .boolean()
      .default(true)
      .describe('When true, also clears the active phase block (phase/scope_globs/started_at). When false, only the verification sub-block is cleared.'),
  })
  .strict()

export type PhaseVerificationCompleteInput = z.infer<
  typeof phaseVerificationCompleteInputSchema
>

export type PhaseVerificationCompleteStatus =
  | 'completed'
  | 'rejected'
  | 'state_write_failed'
  | 'no_active_verification'

export type PhaseVerificationCompleteRejectKind =
  | GateRejectKind
  | 'block_actions_present'
  | 'spec_ref_mismatch'

export interface ActionsSummary {
  accept: number
  'address-now': number
  'capture-as-issue': number
  defer: number
  block: number
}

export interface PhaseVerificationCompleteOutput {
  status: PhaseVerificationCompleteStatus
  channel: GateChannel | null
  reject_kind: PhaseVerificationCompleteRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  spec_ref: string
  cleared_verification: boolean
  cleared_phase: boolean
  actions_summary: ActionsSummary
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface PhaseVerificationCompleteInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
}

export const phaseVerificationCompleteTool: Tool = {
  name: 'rsct_phase_verification_complete',
  description:
    '§C-gated V phase closure. Reads .rsct/phase-state.json (must contain an active verification block with matching spec_ref), validates dev_approval (schema/skew/anti-reuse/fabrication), pops an OS dialog when required, then writes the per-action audit entries + a verification.complete event and clears the verification block (and optionally the active phase). Suggested dev_approval.action_scope format: "verification_complete:spec_ref=<X>". Any findings_actions entry with action="block" aborts completion before the §C dialog.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      spec_ref: {
        type: 'string',
        description: 'Must match the open V phase spec_ref.',
      },
      findings_actions: {
        type: 'array',
        description: 'Per-finding actions. action="block" aborts completion.',
        items: {
          type: 'object',
          required: ['finding_id', 'action'],
          properties: {
            finding_id: { type: 'string' },
            action: {
              type: 'string',
              enum: [...ACTION_VALUES],
            },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      dev_approval: {
        type: 'object',
        description: 'The dev_approval payload (timestamp, action_scope, reason).',
      },
      clear_phase: {
        type: 'boolean',
        default: true,
        description: 'When true, clears the active phase block in addition to verification.',
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

function emptySummary(): ActionsSummary {
  return {
    accept: 0,
    'address-now': 0,
    'capture-as-issue': 0,
    defer: 0,
    block: 0,
  }
}

export async function phaseVerificationCompleteHandler(
  rawInput: unknown,
  internal: PhaseVerificationCompleteInternal = {},
): Promise<PhaseVerificationCompleteOutput> {
  const input = phaseVerificationCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const summary = emptySummary()
  for (const fa of input.findings_actions) {
    summary[fa.action]++
  }

  const existing = readPhaseState(projectRoot)
  if (!existing.exists || !existing.state?.verification) {
    return {
      status: 'no_active_verification',
      channel: null,
      reject_kind: null,
      reason:
        'no active verification block in .rsct/phase-state.json — call rsct_phase_verification_start first',
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'No verification block in phase-state.json. Run rsct_phase_verification_start before _complete.',
      ],
    }
  }

  const existingSpecRef = existing.state.verification.spec_ref
  if (existingSpecRef && existingSpecRef !== input.spec_ref) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'verification.complete.rejected',
        tool: 'rsct_phase_verification_complete',
        spec_ref: input.spec_ref,
        reject_kind: 'spec_ref_mismatch',
        existing_spec_ref: existingSpecRef,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      channel: null,
      reject_kind: 'spec_ref_mismatch',
      reason: `verification block holds spec_ref='${existingSpecRef}' but input is '${input.spec_ref}'`,
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `spec_ref mismatch — pass the same spec_ref that started this V phase ('${existingSpecRef}').`,
      ],
    }
  }

  if (summary.block > 0) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'verification.complete.rejected',
        tool: 'rsct_phase_verification_complete',
        spec_ref: input.spec_ref,
        reject_kind: 'block_actions_present',
        blocked_count: summary.block,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      channel: null,
      reject_kind: 'block_actions_present',
      reason: `${summary.block} finding(s) marked as block — cannot complete V phase`,
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'One or more findings have action=block. Address them (change action to address-now/capture-as-issue/defer/accept) before retrying.',
      ],
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_phase_verification_complete',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT §C — verification complete',
      message: `Complete V phase for spec '${input.spec_ref}'?\n\n${input.findings_actions.length} action(s): ${summary['address-now']} address-now, ${summary['capture-as-issue']} capture, ${summary.defer} defer, ${summary.accept} accept`,
    },
    projectRoot,
    ...(config?.approval_modes !== undefined && {
      approvalModes: config.approval_modes,
    }),
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'verification.complete.rejected',
        tool: 'rsct_phase_verification_complete',
        spec_ref: input.spec_ref,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  for (const fa of input.findings_actions) {
    appendAudit(
      projectRoot,
      {
        event: 'verification.action',
        tool: 'rsct_phase_verification_complete',
        spec_ref: input.spec_ref,
        finding_id: fa.finding_id,
        action: fa.action,
        ...(fa.note ? { note: fa.note } : {}),
      },
      config?.audit,
    )
  }

  const completedAt = new Date().toISOString()
  const newState: PhaseState = { ...existing.state }
  // CAP-28: don't delete the verification block — preserve it as audit
  // trail so that rsct_phase_code_start (and any other downstream gate)
  // can verify that V actually ran + was completed for this spec_ref.
  // Large arrays (`findings`, `discovered_importers`) are pruned to keep
  // state size bounded; metadata fields (spec_ref/spec_tier/started_at)
  // and the new `completed_at` stamp are retained.
  const prevV = existing.state.verification
  const completedV: NonNullable<PhaseState['verification']> = {
    completed_at: completedAt,
  }
  if (prevV?.spec_ref !== undefined) completedV.spec_ref = prevV.spec_ref
  if (prevV?.spec_tier !== undefined) completedV.spec_tier = prevV.spec_tier
  if (prevV?.started_at !== undefined) completedV.started_at = prevV.started_at
  if (prevV?.persona !== undefined) completedV.persona = prevV.persona
  // findings + discovered_importers + declared_paths intentionally dropped
  // (their content already lives in the audit log as per-finding entries).
  newState.verification = completedV
  if (input.clear_phase) {
    delete newState.phase
    delete newState.scope_globs
    delete newState.started_at
  }
  const writeResult = writePhaseState(projectRoot, newState)

  const completeAudit = appendAudit(
    projectRoot,
    {
      event: 'verification.complete',
      tool: 'rsct_phase_verification_complete',
      spec_ref: input.spec_ref,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      actions_summary: summary,
      cleared_phase: input.clear_phase,
      completed_at: completedAt,
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )

  const record = recordApproval(gate.approval, { projectRoot, now })

  const fields = auditFields(completeAudit)
  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(
      `V phase completed for spec '${input.spec_ref}'. ${input.findings_actions.length} action(s) recorded; verification block cleared${input.clear_phase ? ' and active phase reset' : ''}.`,
    )
  } else if (writeResult.reason === 'locked') {
    hints.push(
      `⚠ V phase approved but phase-state.json is locked (held ${writeResult.lock_age_ms}ms by session ${writeResult.held_by_session ?? 'unknown'}). State may be inconsistent; wait and retry, or manual cleanup may be needed.`,
    )
  } else {
    hints.push(
      `⚠ V phase approved but phase-state.json write failed: ${writeResult.error}. State may be inconsistent; manual cleanup may be needed.`,
    )
  }
  if (!record.ok) {
    hints.push(
      `⚠ I could not record this approval as used: ${record.error}. The same dev_approval could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  if (fields.audit_error !== null) {
    hints.push(`⚠ verification.complete audit write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'completed' : 'state_write_failed',
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    spec_ref: input.spec_ref,
    cleared_verification: writeResult.ok,
    cleared_phase: writeResult.ok && input.clear_phase,
    actions_summary: summary,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : (record.error ?? null),
    hints,
  }
}

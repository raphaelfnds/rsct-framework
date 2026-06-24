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

export const phaseAbandonInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    reason: z
      .string()
      .min(10, 'reason must be ≥10 chars — explain why this phase is being discarded')
      .describe(
        'Human-readable reason for abandoning the active phase. Lands in the audit log so a future reader can understand why work was discarded.',
      ),
    dev_approval: z
      .unknown()
      .describe(
        'dev_approval payload. action_scope SHOULD start with "phase_abandon:" (INV-2.2 scope_mismatch).',
      ),
  })
  .strict()

export type PhaseAbandonInput = z.infer<typeof phaseAbandonInputSchema>

export type PhaseAbandonStatus =
  | 'abandoned'
  | 'rejected'
  | 'state_write_failed'
  | 'no_active_phase'

export interface PhaseAbandonOutput {
  status: PhaseAbandonStatus
  channel: GateChannel | null
  reject_kind: GateRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  abandoned_phase: string | null
  abandoned_spec_slug: string | null
  abandoned_verification_block_present: boolean
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface PhaseAbandonInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
}

export const phaseAbandonTool: Tool = {
  name: 'rsct_phase_abandon',
  description:
    '§C-gated abandon — discards the active phase (and any verification sub-block) WITHOUT advancing the RSCT cycle. Use when a phase was started against the wrong spec_ref, the task pivoted, or the spec was rejected after research. Requires dev_approval with action_scope starting with "phase_abandon:" and a reason (min 10 chars). The reason lands in the audit log so future readers know why work was discarded. Spec_slug is also cleared. NOT for ending a phase cleanly — use rsct_phase_<phase>_complete for that.',
  inputSchema: {
    type: 'object',
    required: ['reason', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      reason: {
        type: 'string',
        minLength: 10,
        description:
          'Human-readable reason. ≥10 chars. Lands in audit log.',
      },
      dev_approval: {
        type: 'object',
        description: 'dev_approval payload (timestamp, action_scope, reason).',
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

export async function phaseAbandonHandler(
  rawInput: unknown,
  internal: PhaseAbandonInternal = {},
): Promise<PhaseAbandonOutput> {
  const input = phaseAbandonInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const existing = readPhaseState(projectRoot)
  if (!existing.exists || !existing.state?.phase) {
    return {
      status: 'no_active_phase',
      channel: null,
      reject_kind: null,
      reason: 'no active phase in .rsct/phase-state.json — nothing to abandon',
      fabrication_signals: [],
      abandoned_phase: null,
      abandoned_spec_slug: null,
      abandoned_verification_block_present: false,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'No active phase to abandon. If phase-state.json exists but has no phase field, the state is already clean.',
      ],
    }
  }

  const state = existing.state
  const phase = state.phase ?? ''
  const specSlug = state.spec_slug ?? null
  const hasVerification = state.verification !== undefined

  const gate = await gateRequest({
    toolName: 'rsct_phase_abandon',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT §C — abandon phase',
      message: `Abandon phase '${phase}'${specSlug ? ` for spec '${specSlug}'` : ''}?\n\nReason: ${input.reason}\n\nThis discards the phase without advancing the RSCT cycle.`,
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
        event: 'phase_abandon.rejected',
        tool: 'rsct_phase_abandon',
        active_phase: phase,
        spec_slug: specSlug,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        provided_reason: input.reason,
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
      abandoned_phase: null,
      abandoned_spec_slug: null,
      abandoned_verification_block_present: hasVerification,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const newState: PhaseState = {}
  const writeResult = writePhaseState(projectRoot, newState)
  const record = recordApproval(gate.approval, { projectRoot, now })

  const abandonedAudit = appendAudit(
    projectRoot,
    {
      event: 'phase_abandon.complete',
      tool: 'rsct_phase_abandon',
      abandoned_phase: phase,
      abandoned_spec_slug: specSlug,
      abandoned_verification_block_present: hasVerification,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      reason: input.reason,
      abandoned_at: now.toISOString(),
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )
  const fields = auditFields(abandonedAudit)

  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(
      `Phase '${phase}' abandoned${specSlug ? ` for spec '${specSlug}'` : ''}. State cleared. Next: call rsct_classify_task or rsct_phase_<phase>_start to restart.`,
    )
  } else if (writeResult.reason === 'locked') {
    hints.push(
      `⚠ Abandon approved but phase-state.json is locked (held ${writeResult.lock_age_ms}ms). Retry; state may be inconsistent until then.`,
    )
  } else {
    hints.push(
      `⚠ Abandon approved but phase-state.json write failed: ${writeResult.error}. Phase still appears active until the write succeeds.`,
    )
  }
  if (!record.ok) {
    hints.push(
      `⚠ I could not record this approval as used: ${record.error}. The dev_approval could be accepted again by mistake for a short time.`,
    )
  }
  if (fields.audit_error !== null) {
    hints.push(`⚠ phase_abandon.complete audit write failed: ${fields.audit_error}.`)
  }

  return {
    status: writeResult.ok ? 'abandoned' : 'state_write_failed',
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    abandoned_phase: phase,
    abandoned_spec_slug: specSlug,
    abandoned_verification_block_present: hasVerification,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : (record.error ?? null),
    hints,
  }
}

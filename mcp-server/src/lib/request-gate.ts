import {
  expectedScopeTokens,
  fabricationThresholdMs,
  validateDevApproval,
  type DevApproval,
  type FabricationSignal,
  type ValidateOptions,
} from './dev-approval.js'
import { specLabel } from './dialog-text.js'
import {
  promptYesNo,
  type DialogChannel,
  type DialogOptions,
  type DialogResult,
} from './os-dialog.js'
import type { RsctApprovalModes, RsctAuditConfig } from './project-root.js'

export type GateChannel = DialogChannel | 'trust'

export type GateRejectKind =
  | 'schema'
  | 'reused'
  | 'expired'
  | 'dialog_no'
  | 'dialog_failed'
  | 'force_dialog_no_channel'
  | 'no_channel'

export type GateResult =
  | {
      status: 'approved'
      approval: DevApproval
      channel: GateChannel
      fabrication_signals: FabricationSignal[]
    }
  | {
      status: 'rejected'
      reason: string
      reject_kind: GateRejectKind
      fabrication_signals: FabricationSignal[]
    }

export interface GateOptions {
  toolName: string
  approval: unknown
  dialog: DialogOptions
  projectRoot: string
  approvalModes?: RsctApprovalModes
  auditConfig?: RsctAuditConfig | undefined
  forceDialog?: boolean
  forceDialogReason?: string
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
}

export async function gateRequest(opts: GateOptions): Promise<GateResult> {
  const validateOpts: ValidateOptions = {
    projectRoot: opts.projectRoot,
    toolName: opts.toolName,
  }
  if (opts.approvalModes !== undefined) validateOpts.approvalModes = opts.approvalModes
  if (opts.now !== undefined) validateOpts.now = opts.now
  if (opts.auditConfig !== undefined) validateOpts.auditConfig = opts.auditConfig

  const validation = validateDevApproval(opts.approval, validateOpts)

  if (validation.status === 'rejected') {
    return {
      status: 'rejected',
      reason: validation.reason,
      reject_kind: inferRejectKind(validation.reason),
      fabrication_signals: validation.fabrication_signals,
    }
  }

  const promptFn = opts.promptFn ?? promptYesNo
  const dialog = await promptFn(withFabricationWarning(opts, validation.fabrication_signals, validation.approval.action_scope))

  if (dialog.input_fault === true) {
    return {
      status: 'rejected',
      reason: `the approval dialog could not show this request (${dialog.error ?? 'its text was refused'}); shorten what the agent wrote (reasons, notes, message) and call again — the framework lines cannot be removed, and trust_allowed_for does not apply`,
      reject_kind: 'no_channel',
      fabrication_signals: validation.fabrication_signals,
    }
  }

  if (validation.must_force_dialog || opts.forceDialog === true) {
    if (dialog.response === 'yes') {
      return {
        status: 'approved',
        approval: validation.approval,
        channel: dialog.channel,
        fabrication_signals: validation.fabrication_signals,
      }
    }
    const why = validation.must_force_dialog
      ? `the approval looked auto-generated (signals: ${validation.fabrication_signals.join(',')})`
      : (opts.forceDialogReason ?? 'this call bypasses a phase the tier requires')
    if (dialog.response === 'no') {
      return {
        status: 'rejected',
        reason: `dev declined the approval dialog (it was forced because ${why})`,
        reject_kind: 'dialog_no',
        fabrication_signals: validation.fabrication_signals,
      }
    }
    if (dialog.response !== 'no-channel') {
      return dialogFailed(dialog, validation.fabrication_signals, `; ${why} — the dialog is required`)
    }
    return {
      status: 'rejected',
      reason: `dialog channel unavailable (${dialog.error ?? 'no channel'}); ${why} — the dialog is required and trust_allowed_for is ignored`,
      reject_kind: 'force_dialog_no_channel',
      fabrication_signals: validation.fabrication_signals,
    }
  }

  if (dialog.response === 'yes') {
    return {
      status: 'approved',
      approval: validation.approval,
      channel: dialog.channel,
      fabrication_signals: validation.fabrication_signals,
    }
  }
  if (dialog.response === 'no') {
    return {
      status: 'rejected',
      reason: 'dev declined the approval dialog',
      reject_kind: 'dialog_no',
      fabrication_signals: validation.fabrication_signals,
    }
  }
  if (dialog.response !== 'no-channel') {
    return dialogFailed(dialog, validation.fabrication_signals, '')
  }

  const trustList = opts.approvalModes?.trust_allowed_for ?? []
  if (trustList.includes(opts.toolName)) {
    return {
      status: 'approved',
      approval: validation.approval,
      channel: 'trust',
      fabrication_signals: validation.fabrication_signals,
    }
  }
  return {
    status: 'rejected',
    reason: `dialog channel unavailable (${dialog.error ?? 'no channel'}) and '${opts.toolName}' is not listed in approval_modes.trust_allowed_for`,
    reject_kind: 'no_channel',
    fabrication_signals: validation.fabrication_signals,
  }
}

function signalReason(signal: FabricationSignal, opts: GateOptions): string {
  switch (signal) {
    case 'reason_too_short':
      return 'its reason is under 10 characters'
    case 'implausibly_fast':
      return `it came less than ${fabricationThresholdMs(opts.approvalModes)} ms after the previous approval was used`
    case 'approvals_store_corrupt':
      return 'the record of used approvals is unreadable'
    case 'approvals_store_absent':
      return 'the record of used approvals is missing although approvals were used before'
    case 'scope_mismatch':
      return `its action_scope does not start with ${expectedScopeTokens(opts.toolName).map((t) => `'${t}:'`).join(' or ')}`
    case 'burst_pattern':
      return '3 or more approvals were used in the last 10 seconds'
  }
}

function withFabricationWarning(opts: GateOptions, signals: FabricationSignal[], actionScope: string): DialogOptions {
  if (signals.length === 0) return opts.dialog
  const warning = `⚠ This approval looks auto-generated: ${signals.map((s) => signalReason(s, opts)).join('; ')}.`
  const scope = signals.includes('scope_mismatch') ? `\n\nAgent's action_scope: "${specLabel(actionScope)}"` : ''
  return { ...opts.dialog, message: `${warning}\n\n${opts.dialog.message}${scope}` }
}

function dialogFailed(dialog: DialogResult, signals: FabricationSignal[], tail: string): GateResult {
  return {
    status: 'rejected',
    reason: `the approval dialog program ended without a Yes or No answer (${dialog.error ?? 'no answer'})${tail}; the request is refused and trust_allowed_for does not apply`,
    reject_kind: 'dialog_failed',
    fabrication_signals: signals,
  }
}

export function inferRejectKind(reason: string): GateRejectKind {
  if (reason.includes('reused')) return 'reused'
  if (reason.includes('skew') || reason.includes('future')) return 'expired'
  return 'schema'
}

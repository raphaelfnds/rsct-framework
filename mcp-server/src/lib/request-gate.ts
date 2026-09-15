import {
  validateDevApproval,
  type DevApproval,
  type FabricationSignal,
  type ValidateOptions,
} from './dev-approval.js'
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
  const dialog = await promptFn(opts.dialog)

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

function inferRejectKind(reason: string): GateRejectKind {
  if (reason.includes('reused')) return 'reused'
  if (reason.includes('skew') || reason.includes('future')) return 'expired'
  return 'schema'
}

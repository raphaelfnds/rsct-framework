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
import type { RsctApprovalModes } from './project-root.js'

/**
 * The §C orchestrator. Every §C-gated tool delegates the "is this dev_approval
 * good enough to proceed?" decision here so the rules (INV-2, INV-2.1, INV-2.2)
 * land in one place and changes propagate everywhere.
 *
 * Flow:
 *  1. {@link validateDevApproval} (schema / skew / anti-reuse / fabrication)
 *  2. If `must_force_dialog`, the OS dialog is COMPULSORY:
 *      - yes -> approved (channel = dialog channel)
 *      - no  -> rejected (`dialog_no`)
 *      - no-channel -> rejected (`force_dialog_no_channel`).
 *        `trust_allowed_for[]` is IGNORED here on purpose: once fabrication
 *        signals fire, raising bypass cost matters more than CI ergonomics.
 *  3. Otherwise (no fabrication signals), try the OS dialog and fall back to
 *     `trust_allowed_for[]` only when no dialog channel exists.
 *
 * The approval is NOT consumed here. Callers consume via
 * {@link recordConsumedApproval} only AFTER a successful mutation, so a
 * failed git op or a downstream INV-5/INV-6 rejection doesn't burn the
 * approval — dev can add an override and retry with the same payload.
 */

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
  /** Tool name used to match against `trust_allowed_for[]` in headless mode. */
  toolName: string
  /** Raw `dev_approval` payload from the tool's input. */
  approval: unknown
  /** Title + message rendered in the OS dialog when one is shown. */
  dialog: DialogOptions
  projectRoot: string
  approvalModes?: RsctApprovalModes
  /** Injectable for unit tests (defaults to {@link promptYesNo}). */
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  /** Injectable for unit tests (defaults to current time). */
  now?: Date
}

export async function gateRequest(opts: GateOptions): Promise<GateResult> {
  const validateOpts: ValidateOptions = {
    projectRoot: opts.projectRoot,
    toolName: opts.toolName,
  }
  if (opts.approvalModes !== undefined) validateOpts.approvalModes = opts.approvalModes
  if (opts.now !== undefined) validateOpts.now = opts.now

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

  if (validation.must_force_dialog) {
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
        reason: 'dev declined the §C dialog (forced by fabrication signals)',
        reject_kind: 'dialog_no',
        fabrication_signals: validation.fabrication_signals,
      }
    }
    return {
      status: 'rejected',
      reason: `dialog channel unavailable (${dialog.error ?? 'no channel'}); fabrication signals [${validation.fabrication_signals.join(',')}] require forced dialog — trust_allowed_for is ignored`,
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
      reason: 'dev declined the §C dialog',
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

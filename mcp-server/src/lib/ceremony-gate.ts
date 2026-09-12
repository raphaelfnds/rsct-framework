import { deriveAuditCeiling, higherTier, isFreeTier } from './free-commit.js'
import { gateRequest, type GateChannel, type GateRejectKind } from './request-gate.js'
import { gateDialogFooter } from './gate-dialog.js'
import { readPhaseState } from './phase-scope.js'
import type { DialogOptions, DialogResult } from './os-dialog.js'
import type { RsctConfig } from './project-root.js'

export const CEREMONY_BYPASS_LABELS = {
  verification_skip: 'skip the verification (V) phase',
  classify_downgrade: 'run at a lower tier than the recorded classification',
  plan_tracking: 'start without plan_/progress_ tracking files',
  review_skip: 'skip the code review (REVIEW) phase',
} as const

export type CeremonyBypass = keyof typeof CEREMONY_BYPASS_LABELS

export interface ClassifyEvidence {
  present: boolean
  tierMax: string | null
}

export function readClassifyEvidence(
  projectRoot: string,
  config: RsctConfig | null,
): ClassifyEvidence {
  const ceiling = deriveAuditCeiling(projectRoot, config, '')
  const stateMax = readPhaseState(projectRoot).state?.last_classify?.tier_max
  return {
    present: ceiling.classifyEvidencePresent || stateMax !== undefined,
    tierMax: higherTier(stateMax, ceiling.auditTierMax) ?? null,
  }
}

export interface EvidenceGate {
  status: 'satisfied' | 'absent'
  spec_tier: string
  tier_max_recorded: string | null
  hint: string
}

export function evaluateEvidenceGate(args: {
  projectRoot: string
  config: RsctConfig | null
  specTier: string
  toolName: string
}): EvidenceGate {
  const { specTier, toolName } = args
  if (!isFreeTier(specTier)) {
    return {
      status: 'satisfied',
      spec_tier: specTier,
      tier_max_recorded: null,
      hint: `tier='${specTier}' does not bypass any phase — no classification evidence required.`,
    }
  }
  const evidence = readClassifyEvidence(args.projectRoot, args.config)
  if (evidence.present) {
    return {
      status: 'satisfied',
      spec_tier: specTier,
      tier_max_recorded: evidence.tierMax,
      hint: `tier='${specTier}' is backed by a recorded rsct_classify_task verdict.`,
    }
  }
  return {
    status: 'absent',
    spec_tier: specTier,
    tier_max_recorded: null,
    hint:
      `tier='${specTier}' skips the verification, review and plan-tracking gates, and no ` +
      `rsct_classify_task verdict is on record to support it. Run rsct_classify_task first — ` +
      `${toolName} will then honour whatever tier it returns. A tier declared with no ` +
      `classification is the one bypass that leaves no trace, which is why it is refused.`,
  }
}

export type CeremonyGateResult =
  | { status: 'not_required' }
  | { status: 'approved'; channel: GateChannel }
  | { status: 'rejected'; reject_kind: GateRejectKind; reason: string }

export async function gateCeremonyBypass(args: {
  projectRoot: string
  config: RsctConfig | null
  toolName: string
  specRef: string
  specTier: string
  bypasses: CeremonyBypass[]
  devApproval: unknown
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
}): Promise<CeremonyGateResult> {
  if (args.bypasses.length === 0) return { status: 'not_required' }

  const asked = args.bypasses.map((b) => `• ${CEREMONY_BYPASS_LABELS[b]}`).join('\n')
  const gate = await gateRequest({
    toolName: args.toolName,
    approval: args.devApproval,
    forceDialog: true,
    dialog: {
      title: `RSCT — bypass requested (${args.specTier})`,
      message:
        `Spec '${args.specRef}' asks to:\n\n${asked}\n\n` +
        `These are the checks that catch a task being treated as smaller than it is.` +
        gateDialogFooter(args.projectRoot),
    },
    projectRoot: args.projectRoot,
    ...(args.config?.approval_modes !== undefined && {
      approvalModes: args.config.approval_modes,
    }),
    auditConfig: args.config?.audit,
    ...(args.promptFn !== undefined && { promptFn: args.promptFn }),
    ...(args.now !== undefined && { now: args.now }),
  })

  if (gate.status === 'rejected') {
    return { status: 'rejected', reject_kind: gate.reject_kind, reason: gate.reason }
  }
  return { status: 'approved', channel: gate.channel }
}

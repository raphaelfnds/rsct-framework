import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import {
  findActivePlan,
  findPlanByBranch,
  progressHasOpenItems,
} from '../lib/plan.js'
import { planCleanupReport } from '../lib/plan-cleanup.js'
import {
  defaultGitExecutor,
  gitRebase,
  gitSquash,
  readGitState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import { effectiveProtectedList, isProtectedBranch } from '../lib/branch-protection.js'
import { recordConsumedApproval, type FabricationSignal } from '../lib/dev-approval.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import { promptYesNo, type DialogOptions, type DialogResult } from '../lib/os-dialog.js'
import { gateRequest, type GateChannel, type GateRejectKind } from '../lib/request-gate.js'
import { evaluateBootstrapMarker, type BootstrapMarker } from '../lib/phase-scope.js'
import {
  evaluatePreMergeAck,
  preMergeAckHint,
  preMergeAckSchema,
  preMergeAckJsonSchema,
  PRE_MERGE_ACK_ITEMS,
} from '../lib/pre-merge-ack.js'

export const requestRebaseInputSchema = z
  .object({
    project_root: z.string().optional().describe('Optional absolute path to override project root detection.'),
    mode: z
      .enum(['rebase', 'squash'])
      .optional()
      .describe("'rebase' = git rebase current onto ref; 'squash' = git merge --squash ref into current (default 'rebase')."),
    ref: z
      .string()
      .min(1, 'ref required')
      .describe("For mode='rebase': the upstream to rebase onto. For mode='squash': the branch to squash-merge into the current HEAD."),
    dev_approval: z
      .unknown()
      .describe('The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication).'),
    pre_merge_ack: preMergeAckSchema
      .optional()
      .describe('PH-5 pre-integration hygiene checklist (self-attested). REQUIRED — absence ⇒ rejected in chat (no OS dialog).'),
  })
  .strict()

export type RequestRebaseInput = z.infer<typeof requestRebaseInputSchema>
export type RequestRebaseStatus = 'rebased' | 'squashed' | 'rejected' | 'mutation_failed'

export type RequestRebaseRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'detached_head'
  | 'same_ref'
  | 'pre_merge_ack_missing'
  | 'pre_merge_ack_incomplete'

export interface RequestRebaseOutput {
  status: RequestRebaseStatus
  mode: 'rebase' | 'squash'
  ref: string
  current_branch: string | null
  channel: GateChannel | null
  reject_kind: RequestRebaseRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  sha_before: string | null
  sha_after: string | null
  branch_check: { protected: boolean; override_used: boolean }
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestRebaseInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
}

export const requestRebaseTool: Tool = {
  name: 'rsct_request_rebase',
  description:
    "§C-gated rebase / squash — the history-rewriting integration paths, ALWAYS per-action (never covered by a plan token or the free-commit lane). Validates dev_approval, pops the OS dialog, requires a pre_merge_ack, and runs INV-5 on the CURRENT branch (rewriting a PROTECTED branch's history requires override_protected_branch). mode='rebase' runs `git rebase <ref>`; mode='squash' runs `git merge --squash <ref>` (stages a squashed change WITHOUT committing — commit it afterward via rsct_request_commit). Conflicts surface as mutation_failed with git's stderr; nothing is force-pushed.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: { type: 'string', description: 'Optional absolute path to override project root detection.' },
      mode: { type: 'string', enum: ['rebase', 'squash'], description: "'rebase' or 'squash' (default 'rebase')." },
      ref: { type: 'string', description: 'Upstream to rebase onto, or branch to squash-merge.' },
      dev_approval: { type: 'object', description: 'dev_approval payload.' },
      pre_merge_ack: preMergeAckJsonSchema,
    },
    required: ['ref', 'dev_approval'],
    additionalProperties: false,
  },
}

function auditFields(r: AuditAppendResult): { audit_path: string | null; audit_error: string | null } {
  if (r.ok) return { audit_path: r.path, audit_error: null }
  if (r.reason === 'disabled') return { audit_path: null, audit_error: null }
  return { audit_path: r.path ?? null, audit_error: r.error ?? 'write_failed' }
}

export async function requestRebaseHandler(
  rawInput: unknown,
  internal: RequestRebaseInternal = {},
): Promise<RequestRebaseOutput> {
  const input = requestRebaseInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const promptFn = internal.promptFn ?? promptYesNo
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor
  const now = internal.now ?? new Date()
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const currentBranch = gitState.branch
  const currentLabel = currentBranch ?? '<no-branch>'
  const mode = input.mode ?? 'rebase'
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const base = (over: Partial<RequestRebaseOutput>): RequestRebaseOutput => ({
    status: 'rejected',
    mode,
    ref: input.ref,
    current_branch: currentBranch,
    channel: null,
    reject_kind: null,
    reason: null,
    fabrication_signals: [],
    sha_before: gitState.head_sha,
    sha_after: null,
    branch_check: { protected: false, override_used: false },
    audit_path: null,
    audit_error: null,
    anti_replay_persisted: null,
    anti_replay_error: null,
    hints: [],
    ...over,
  })

  // PH-5 ack gate (BEFORE the §C dialog). A rebase/squash rewrites history — an
  // integration event — so the ack is always required. HOLE A: feed the LIGHT
  // plan_complete check the boolean for the plan on the current branch.
  const currentPlan = currentBranch ? findPlanByBranch(projectRoot, currentBranch) : null
  const progressOpen = currentPlan ? progressHasOpenItems(projectRoot, currentPlan.slug) : undefined
  const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, progressOpen)
  if (!ackDecision.ok) {
    const hint = preMergeAckHint(ackDecision)
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_rebase.rejected',
        tool: 'rsct_request_rebase',
        reject_kind: ackDecision.kind,
        reason: hint,
        mode,
        ref: input.ref,
        pre_merge_ack: input.pre_merge_ack ?? null,
        pre_merge_ack_self_attested: PRE_MERGE_ACK_ITEMS,
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
      },
      config?.audit,
    )
    return base({ reject_kind: ackDecision.kind, reason: hint, ...auditFields(audit), hints: [hint] })
  }

  const gate = await gateRequest({
    toolName: 'rsct_request_rebase',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — rebase approval',
      message: `Approve ${mode} of '${currentLabel}' ${mode === 'rebase' ? 'onto' : 'from'} '${input.ref}'? (history-rewriting)`,
    },
    projectRoot,
    ...(config?.approval_modes !== undefined && { approvalModes: config.approval_modes }),
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_rebase.rejected',
        tool: 'rsct_request_rebase',
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        mode,
        ref: input.ref,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    return base({
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      ...auditFields(audit),
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    })
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch

  if (currentBranch === null) {
    const reason = 'cannot rebase/squash on a detached HEAD — checkout a branch first'
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.rejected', tool: 'rsct_request_rebase', reject_kind: 'detached_head', reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
    return base({ channel: gate.channel, reject_kind: 'detached_head', reason, fabrication_signals: gate.fabrication_signals, sha_before: null, ...auditFields(audit), hints: [reason] })
  }

  if (input.ref === currentBranch) {
    const reason = `cannot ${mode} '${currentBranch}' against itself`
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.rejected', tool: 'rsct_request_rebase', reject_kind: 'same_ref', reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
    return base({ channel: gate.channel, reject_kind: 'same_ref', reason, fabrication_signals: gate.fabrication_signals, ...auditFields(audit), hints: [reason] })
  }

  // INV-5: rewriting a PROTECTED branch's history requires an explicit override.
  const { list: protectedList } = effectiveProtectedList(config)
  const currentProtected = isProtectedBranch(currentBranch, protectedList)
  if (currentProtected && !overrideBranch) {
    const reason = `branch '${currentLabel}' is protected — ${mode} rewrites its history; pass dev_approval.override_protected_branch: { reason } to proceed`
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.rejected', tool: 'rsct_request_rebase', reject_kind: 'protected_branch', reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
    return base({ channel: gate.channel, reject_kind: 'protected_branch', reason, fabrication_signals: gate.fabrication_signals, branch_check: { protected: true, override_used: false }, ...auditFields(audit), hints: [reason] })
  }
  if (currentProtected && overrideBranch) {
    appendAudit(
      projectRoot,
      { event: 'request_rebase.override_invoked', tool: 'rsct_request_rebase', override_kind: 'protected_branch', override_reason: overrideBranch.reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
  }

  const result = mode === 'rebase' ? gitRebase(projectRoot, input.ref, gitExecutor) : gitSquash(projectRoot, input.ref, gitExecutor)
  if (!result.ok) {
    const reason = result.error ?? result.stderr ?? `git ${mode} failed`
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.mutation_failed', tool: 'rsct_request_rebase', reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
    return base({
      status: 'mutation_failed',
      channel: gate.channel,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: result.sha_before,
      branch_check: { protected: currentProtected, override_used: currentProtected },
      ...auditFields(audit),
      hints: [
        `git ${mode} failed — ${mode === 'rebase' ? 'resolve conflicts (git rebase --continue) or abort (git rebase --abort)' : 'resolve conflicts, then commit via rsct_request_commit'}. Approval NOT consumed; retry with a fresh dev_approval.`,
      ],
    })
  }

  const record = recordApproval(approval, { projectRoot, now })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_rebase.done',
      tool: 'rsct_request_rebase',
      mode,
      ref: input.ref,
      current_branch: currentBranch,
      channel: gate.channel,
      sha_before: result.sha_before,
      sha_after: result.sha_after,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )

  const hints: string[] = [
    mode === 'rebase'
      ? `Rebased '${currentLabel}' onto '${input.ref}' (${result.sha_before ?? '?'} → ${result.sha_after ?? '?'}).`
      : `Squash-staged '${input.ref}' into '${currentLabel}' — NOT committed. Commit the squashed change via rsct_request_commit.`,
  ]
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now })
  if (bootstrap.status !== 'fresh' && bootstrap.hint) hints.push(bootstrap.hint)
  if (!record.ok) {
    hints.push(`⚠ ${mode} landed but the approval could not be recorded as used: ${record.error}.`)
  }

  // Advisory cleanup (Fork 2/A) for the plan on the current branch.
  const donePlan = currentPlan ?? findActivePlan(projectRoot)
  if (donePlan) {
    const report = planCleanupReport(projectRoot, donePlan.slug, config ?? null)
    hints.push(`${report.hint} Record keep|delete with rsct_plan_dispose.`)
  }

  return base({
    status: mode === 'rebase' ? 'rebased' : 'squashed',
    channel: gate.channel,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: result.sha_before,
    sha_after: result.sha_after,
    branch_check: { protected: currentProtected, override_used: currentProtected },
    bootstrap_marker: bootstrap,
    ...auditFields(audit),
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints,
  })
}

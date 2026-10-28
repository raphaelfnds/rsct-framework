import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import {
  branchPlansHaveOpenItems,
  findActivePlan,
  findPlanByBranch,
} from '../lib/plan.js'
import { planCleanupReport } from '../lib/plan-cleanup.js'
import {
  defaultGitExecutor,
  getRangePaths,
  gitMerge,
  readGitState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
} from '../lib/branch-protection.js'
import {
  recordConsumedApproval,
  type FabricationSignal,
} from '../lib/dev-approval.js'
import {
  appendAuditEntry,
  auditFields,
} from '../lib/audit-log.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from '../lib/os-dialog.js'
import { evaluateInstallAdvisory } from '../lib/install-advisory.js'
import {
  gateRequest,
  type GateChannel,
  type GateRejectKind,
} from '../lib/request-gate.js'
import {
  evaluateBootstrapMarker,
  type BootstrapMarker,
} from '../lib/phase-scope.js'
import {
  evaluatePreMergeAck,
  preMergeAckHint,
  preMergeAckSchema,
  preMergeAckJsonSchema,
  PRE_MERGE_ACK_ITEMS,
  describeCrossCheck,
  crossCheckBlockedReason,
} from '../lib/pre-merge-ack.js'
import { gateDialogFooter, anchorHints } from '../lib/gate-dialog.js'
import { DIALOG_PATH_LIMIT, specLabel } from '../lib/dialog-text.js'

export const requestMergeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    source_branch: z
      .string()
      .min(1, 'source_branch required')
      .describe('Branch to merge INTO the current HEAD.'),
    no_ff: z
      .boolean()
      .optional()
      .describe('Pass --no-ff to git merge (default true).'),
    allow_unrelated_histories: z
      .boolean()
      .optional()
      .describe(
        'Pass --allow-unrelated-histories (default false). Setting true requires dev_approval.override_protected_branch as a proxy ack of force-like risk.',
      ),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication).',
      ),
    pre_merge_ack: preMergeAckSchema
      .optional()
      .describe(
        'PH-5 pre-integration hygiene checklist (self-attested). REQUIRED in practice: absence ⇒ rejected in ' +
          'chat (no OS dialog). Set plan_complete/adr_confirmed/issues_resolved true ONLY after confirming each ' +
          'with the dev — honest self-attestations, not machine-verified. When adr_confirmed or issues_resolved ' +
          'is true, `note` must state WHAT (e.g. "ADR-012 recorded; issue #7 closed").',
      ),
  })
  .strict()

export type RequestMergeInput = z.infer<typeof requestMergeInputSchema>

export type RequestMergeStatus = 'merged' | 'rejected' | 'mutation_failed'

export type RequestMergeRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'detached_head'
  | 'same_branch'
  | 'unrelated_histories_without_override'
  | 'pre_merge_ack_missing'
  | 'pre_merge_ack_incomplete'
  | 'hygiene_range_unreadable'

export interface RequestMergeOutput {
  status: RequestMergeStatus
  source_branch: string
  target_branch: string | null
  channel: GateChannel | null
  reject_kind: RequestMergeRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  sha_before: string | null
  sha_after: string | null
  branch_check: {
    protected: boolean
    override_used: boolean
  }
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestMergeInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
  rangeReader?: typeof getRangePaths
}

export const requestMergeTool: Tool = {
  name: 'rsct_request_merge',
  description:
    "§C-gated merge. Validates dev_approval, pops OS dialog when required, runs INV-5 on the TARGET branch (current HEAD), then executes `git merge` (default --no-ff). Extra-strict: --allow-unrelated-histories is treated as a force-like operation and requires override_protected_branch even on a non-protected target. Detached HEAD and self-merge surface as mutation_failed/same_branch. This is the LOCAL merge-commit path; GitHub PR merges (merge commit / squash / rebase, done by the developer on GitHub) are equivalent for cleanup purposes. On a successful merge whose plan is complete, the hints suggest deleting the merged working branch + plan_/progress_/spec_ files (never automated; see §D).",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      source_branch: {
        type: 'string',
        description: 'Branch to merge INTO the current HEAD.',
      },
      no_ff: {
        type: 'boolean',
        description: '--no-ff (default true).',
      },
      allow_unrelated_histories: {
        type: 'boolean',
        description:
          '--allow-unrelated-histories (default false; setting true requires override_protected_branch).',
      },
      dev_approval: {
        type: 'object',
        description: 'dev_approval payload.',
      },
      pre_merge_ack: preMergeAckJsonSchema,
    },
    required: ['source_branch', 'dev_approval'],
    additionalProperties: false,
  },
}

export async function requestMergeHandler(
  rawInput: unknown,
  internal: RequestMergeInternal = {},
): Promise<RequestMergeOutput> {
  const input = requestMergeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const targetBranch = gitState.branch
  const targetLabel = targetBranch ?? '<no-branch>'
  const no_ff = input.no_ff ?? true
  const allow_unrelated_histories = input.allow_unrelated_histories ?? false
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const advisories: string[] = []
  advisories.push(...anchorHints(projectRoot, config?.audit))
  const withAdvisories = (hints: string[]): string[] => [...advisories, ...hints]
  const installAdvisory = evaluateInstallAdvisory({
    projectRoot,
    rsctInstalled: resolution.rsct_installed,
    projectVersion: config?.rsct_version ?? null,
    auditConfig: config?.audit,
    tool: 'rsct_request_merge',
    auditWriter: appendAudit,
  })
  if (installAdvisory.hint) advisories.push(installAdvisory.hint)

  const integratingPlan = findPlanByBranch(projectRoot, input.source_branch)
  const progressOpen = branchPlansHaveOpenItems(projectRoot, [input.source_branch])
  const range = (internal.rangeReader ?? getRangePaths)(projectRoot, 'HEAD', input.source_branch)
  const crossCheck = describeCrossCheck(range)
  const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, {
    progressHasOpenItems: progressOpen,
    carriedPaths: range.status === 'ok' ? range.paths : null,
  })
  const unreadableIsInherent =
    allow_unrelated_histories && range.status === 'unavailable'
  if (unreadableIsInherent && ackDecision.ok) {
    appendAudit(
      projectRoot,
      {
        event: 'request_merge.pre_merge_ack_degraded',
        tool: 'rsct_request_merge',
        source_branch: input.source_branch,
        target_branch: targetBranch,
        path_crosscheck: crossCheck,
        reason: 'allow_unrelated_histories: the range has no merge base to read',
      },
      config?.audit,
    )
  }
  if (ackDecision.ok && range.status !== 'ok' && !unreadableIsInherent) {
    const reason = crossCheckBlockedReason(range, 'merge')
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: 'hygiene_range_unreadable',
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        path_crosscheck: crossCheck,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: null,
      reject_kind: 'hygiene_range_unreadable',
      reason,
      fabrication_signals: [],
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }
  if (!ackDecision.ok) {
    const hint = preMergeAckHint(ackDecision)
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: ackDecision.kind,
        reason: hint,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        pre_merge_ack: input.pre_merge_ack ?? null,
        pre_merge_ack_self_attested: PRE_MERGE_ACK_ITEMS,
        path_crosscheck: crossCheck,
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' &&
          ackDecision.unswept !== undefined && { files_unswept: ackDecision.unswept }),
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: null,
      reject_kind: ackDecision.kind,
      reason: hint,
      fabrication_signals: [],
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([hint]),
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_request_merge',
    approval: input.dev_approval,
    forceDialog: true,
    forceDialogReason: 'a merge needs the developer in the OS dialog; a batch token covers commit only; with no dialog channel, the developer runs it by hand in their own terminal',
    dialog: {
      title: 'RSCT — merge approval',
      message: [
        `Approve merge of '${specLabel(input.source_branch, DIALOG_PATH_LIMIT)}' into '${specLabel(targetLabel, DIALOG_PATH_LIMIT)}'${no_ff ? ' (--no-ff)' : ''}${allow_unrelated_histories ? ' (--allow-unrelated-histories)' : ''}?`,
        ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
      ].join('\n') + gateDialogFooter(projectRoot, config),
    },
    projectRoot,
    ...(config?.approval_modes !== undefined && { approvalModes: config.approval_modes }),
    auditConfig: config?.audit,
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([`Approval rejected (${gate.reject_kind}): ${gate.reason}`]),
    }
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch

  if (targetBranch === null || gitState.head_sha === null) {
    const reason = 'cannot merge onto a detached HEAD — checkout the target branch first'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: 'detached_head',
        reason,
        source_branch: input.source_branch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: null,
      channel: gate.channel,
      reject_kind: 'detached_head',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: null,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }

  if (input.source_branch === targetBranch) {
    const reason = `cannot merge '${input.source_branch}' into itself`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: 'same_branch',
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: 'same_branch',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }

  if (allow_unrelated_histories && !overrideBranch) {
    const reason =
      '--allow-unrelated-histories is force-like and requires dev_approval.override_protected_branch: { reason }'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: 'unrelated_histories_without_override',
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: 'unrelated_histories_without_override',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }

  const { list: protectedList } = effectiveProtectedList(config)
  const targetProtected = isProtectedBranch(targetBranch, protectedList)

  if (targetProtected && !overrideBranch) {
    const reason = `target branch '${targetLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to merge`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.rejected',
        tool: 'rsct_request_merge',
        reject_kind: 'protected_branch',
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: 'protected_branch',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: true, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }

  if ((targetProtected || allow_unrelated_histories) && overrideBranch) {
    appendAudit(
      projectRoot,
      {
        event: 'request_merge.override_invoked',
        tool: 'rsct_request_merge',
        override_kind: 'protected_branch',
        override_reason: overrideBranch.reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        allow_unrelated_histories,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  const merge = gitMerge(
    projectRoot,
    input.source_branch,
    { no_ff, allow_unrelated_histories },
    gitExecutor,
  )
  if (!merge.ok) {
    const reason = merge.error ?? merge.stderr ?? 'git merge failed'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_merge.mutation_failed',
        tool: 'rsct_request_merge',
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'mutation_failed',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: merge.sha_before,
      sha_after: null,
      branch_check: { protected: targetProtected, override_used: targetProtected || allow_unrelated_histories },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories(['git merge failed — approval NOT consumed. Resolve conflicts or fix the error, then retry with the same dev_approval.']),
    }
  }

  const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_merge.merged',
      tool: 'rsct_request_merge',
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      sha_before: merge.sha_before,
      sha_after: merge.sha_after,
      no_ff,
      allow_unrelated_histories,
      fabrication_signals: gate.fabrication_signals,
      path_crosscheck: crossCheck,
      ...(range.status === 'ok' && { carried_paths: range.paths.length }),
    },
    config?.audit,
  )

  const hints: string[] = [
    `Merged '${input.source_branch}' into '${targetLabel}' (${merge.sha_after ?? '<unknown sha>'}).`,
  ]
  if (unreadableIsInherent) {
    hints.push(
      '⚠ pre_merge_ack coverage check SKIPPED: unrelated histories have no merge base, so the ' +
        'paths this merge carries cannot be read from git. The merge was allowed because you ' +
        'declared allow_unrelated_histories and the dev approved the override — but files_swept ' +
        'was NOT verified against what was actually carried. Sweep the merged tree by hand.',
    )
  }
  if (!record.ok) {
    hints.push(
      `⚠ merge landed, but I could not record this approval as used: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  const afields = auditFields(audit)
  if (afields.audit_error !== null) {
    hints.push(
      `⚠ merge landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`,
    )
  }

  const bootstrap = evaluateBootstrapMarker({ projectRoot, now })
  if (bootstrap.status !== 'fresh') {
    if (bootstrap.hint) hints.push(bootstrap.hint)
    appendAudit(
      projectRoot,
      {
        event: 'request_merge.bootstrap_warning',
        tool: 'rsct_request_merge',
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        sha_after: merge.sha_after,
      },
      config?.audit,
    )
  }

  const donePlan = integratingPlan ?? findActivePlan(projectRoot)
  if (donePlan) {
    const report = planCleanupReport(projectRoot, donePlan.slug, config ?? null)
    hints.push(
      `ℹ Merged '${input.source_branch}'. ${report.hint} Suggest deleting the merged working branch to the developer, with their OK: local with git branch -d, remote with rsct_request_push and branch ":<name>". Record keep|delete with rsct_plan_dispose, or remove the loose files yourself — RSCT never auto-deletes.`,
    )
  }

  return {
    status: 'merged',
    source_branch: input.source_branch,
    target_branch: targetBranch,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: merge.sha_before,
    sha_after: merge.sha_after,
    branch_check: { protected: targetProtected, override_used: targetProtected || allow_unrelated_histories },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints: withAdvisories(hints),
  }
}


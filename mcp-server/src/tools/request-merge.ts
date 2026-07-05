import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan, isPlanComplete } from '../lib/plan.js'
import {
  defaultGitExecutor,
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
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from '../lib/os-dialog.js'
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
} from '../lib/pre-merge-ack.js'

export const requestMergeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
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
  /** CAP-33: §0 bootstrap visibility — null when not evaluated (reject paths). */
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  /** See `RequestCommitOutput.audit_error` for semantics. */
  audit_error: string | null
  /** See `RequestCommitOutput.anti_replay_persisted` for semantics. */
  anti_replay_persisted: boolean | null
  /** See `RequestCommitOutput.anti_replay_error` for semantics. */
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestMergeInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  /** Test-only seam — see `RequestCommitInternal.auditWriter`. */
  auditWriter?: typeof appendAuditEntry
  /** Test-only seam — see `RequestCommitInternal.approvalRecorder`. */
  approvalRecorder?: typeof recordConsumedApproval
}

export const requestMergeTool: Tool = {
  name: 'rsct_request_merge',
  description:
    "§C-gated merge. Validates dev_approval, pops OS dialog when required, runs INV-5 on the TARGET branch (current HEAD), then executes `git merge` (default --no-ff). Extra-strict: --allow-unrelated-histories is treated as a force-like operation and requires override_protected_branch even on a non-protected target. Detached HEAD and self-merge surface as mutation_failed/same_branch. This is the LOCAL merge-commit path; GitHub PR merges (merge commit / squash / rebase via `gh pr merge --merge|--squash|--rebase`) are equivalent for cleanup purposes. On a successful merge whose plan is complete, the hints suggest deleting the merged working branch + plan_/progress_/spec_ files (never automated; see §D).",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
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

  // PH-5: pre-integration hygiene gate. Checked BEFORE gateRequest so a missing
  // ack rejects in chat WITHOUT popping the §C OS dialog (V-P1·PH-5). A reject
  // here returns before the gate, so the dev_approval is never validated or
  // consumed. A merge is always an integration event ⇒ the ack is always required.
  const ackDecision = evaluatePreMergeAck(input.pre_merge_ack)
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
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
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
      hints: [hint],
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_request_merge',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — merge approval',
      message: `Approve merge of '${input.source_branch}' into '${targetLabel}'${no_ff ? ' (--no-ff)' : ''}${allow_unrelated_histories ? ' (--allow-unrelated-histories)' : ''}?`,
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
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch

  if (targetBranch === null) {
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
      hints: [reason],
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
      hints: [reason],
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
      hints: [reason],
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
      hints: [reason],
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
      hints: ['git merge failed — approval NOT consumed. Resolve conflicts or fix the error, then retry with the same dev_approval.'],
    }
  }

  const record = recordApproval(approval, { projectRoot, now })
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
    },
    config?.audit,
  )

  const hints: string[] = [
    `Merged '${input.source_branch}' into '${targetLabel}' (${merge.sha_after ?? '<unknown sha>'}).`,
  ]
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

  // CAP-33: bootstrap visibility on merge (mirror of request_commit/_push).
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

  // CAP-53/55: when the task's plan is marked complete, SUGGEST (advisory —
  // never auto-perform) the post-merge cleanup: (1) delete the merged working
  // branch, and (2) delete the branch-local plan_/progress_/spec_ files before
  // they reach a protected branch (they must never be tracked on main/test).
  // The same cleanup applies after a GitHub PR merge by ANY strategy (merge
  // commit / squash / rebase) — those run via `gh pr merge` / the web UI, not
  // this tool, so recall it from §D / the plan-tracking memory there. The dev
  // decides; nothing is automated.
  const activePlan = findActivePlan(projectRoot)
  if (activePlan && isPlanComplete(activePlan.status)) {
    hints.push(
      `ℹ Plan '${activePlan.slug}' is marked complete. Optional, with your OK (never automated): (1) delete the merged working branch '${input.source_branch}' (local + remote), and (2) delete plan_/progress_/spec_${activePlan.slug}.md so they never reach a protected branch. The same cleanup applies after a GitHub PR merge — merge commit, squash, or rebase.`,
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
    hints,
  }
}

/**
 * Project an `AuditAppendResult` to the `(audit_path, audit_error)` pair
 * surfaced in `RequestMergeOutput`. See `request-commit.ts` for full notes.
 */
function auditFields(r: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (r.ok) return { audit_path: r.path, audit_error: null }
  if (r.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: r.path ?? null,
    audit_error: r.error ?? 'write_failed',
  }
}

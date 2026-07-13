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
  gitPush,
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

export const requestPushInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    remote: z
      .string()
      .optional()
      .describe('Remote name (default: origin).'),
    branch: z
      .string()
      .optional()
      .describe('Branch name to push (default: current HEAD).'),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication).',
      ),
    pre_merge_ack: preMergeAckSchema
      .optional()
      .describe(
        'PH-5 pre-integration hygiene checklist (self-attested). Required when pushing to a PROTECTED branch: ' +
          'absence ⇒ rejected in chat (no OS dialog). Feature/WIP pushes to a non-protected branch do not require ' +
          'it. Set plan_complete/adr_confirmed/issues_resolved true ONLY after confirming each with the dev; when ' +
          'adr_confirmed or issues_resolved is true, `note` must state WHAT (e.g. "ADR-012 recorded; issue #7 closed").',
      ),
  })
  .strict()

export type RequestPushInput = z.infer<typeof requestPushInputSchema>

export type RequestPushStatus = 'pushed' | 'rejected' | 'mutation_failed'

export type RequestPushRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'pre_merge_ack_missing'
  | 'pre_merge_ack_incomplete'

export interface RequestPushOutput {
  status: RequestPushStatus
  branch: string | null
  remote: string
  channel: GateChannel | null
  reject_kind: RequestPushRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
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

export interface RequestPushInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  /** Test-only seam — see `RequestCommitInternal.auditWriter`. */
  auditWriter?: typeof appendAuditEntry
  /** Test-only seam — see `RequestCommitInternal.approvalRecorder`. */
  approvalRecorder?: typeof recordConsumedApproval
}

export const requestPushTool: Tool = {
  name: 'rsct_request_push',
  description:
    "§C-gated push. Validates dev_approval, pops OS dialog when required, runs INV-5 branch check, then executes `git push <remote> <branch>`. No secrets scan — the commit step already enforced INV-6. On rejection the approval is NOT consumed; dev can add an override and retry.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      remote: { type: 'string', description: 'Remote name (default: origin).' },
      branch: { type: 'string', description: 'Branch to push (default: current HEAD).' },
      dev_approval: {
        type: 'object',
        description: 'dev_approval payload.',
      },
      pre_merge_ack: preMergeAckJsonSchema,
    },
    required: ['dev_approval'],
    additionalProperties: false,
  },
}

export async function requestPushHandler(
  rawInput: unknown,
  internal: RequestPushInternal = {},
): Promise<RequestPushOutput> {
  const input = requestPushInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const remote = input.remote ?? 'origin'
  const branch = input.branch ?? gitState.branch
  const branchLabel = branch ?? '<no-branch>'
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const { list: protectedList } = effectiveProtectedList(config)
  const branchProtected = isProtectedBranch(branch, protectedList)

  // PH-5: pre-integration hygiene gate. Scoped to PROTECTED-branch pushes only
  // (MCP-P1-D) — a feature/WIP push to a non-protected branch (e.g. to trigger CI
  // on an open PR) is legitimate and must not force a dishonest attestation.
  // Checked BEFORE gateRequest so a missing ack rejects in chat WITHOUT popping
  // the §C OS dialog (V-P1·PH-5); the dev_approval is never validated/consumed here.
  if (branchProtected) {
    // plan-lifecycle-v2 (Bloco 2.2, HOLE A): feed the LIGHT plan_complete
    // cross-check the boolean for the plan on the branch being pushed.
    const pushingPlan = branch ? findPlanByBranch(projectRoot, branch) : null
    const progressOpen = pushingPlan
      ? progressHasOpenItems(projectRoot, pushingPlan.slug)
      : undefined
    const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, progressOpen)
    if (!ackDecision.ok) {
      const hint = preMergeAckHint(ackDecision)
      const audit = appendAudit(
        projectRoot,
        {
          event: 'request_push.rejected',
          tool: 'rsct_request_push',
          reject_kind: ackDecision.kind,
          reason: hint,
          branch,
          remote,
          pre_merge_ack: input.pre_merge_ack ?? null,
          pre_merge_ack_self_attested: PRE_MERGE_ACK_ITEMS,
          ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
        },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch,
        remote,
        channel: null,
        reject_kind: ackDecision.kind,
        reason: hint,
        fabrication_signals: [],
        branch_check: { protected: true, override_used: false },
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: [hint],
      }
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_request_push',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — push approval',
      message: `Approve push of '${branchLabel}' to '${remote}'?`,
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
        event: 'request_push.rejected',
        tool: 'rsct_request_push',
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        branch,
        remote,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch,
      remote,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch

  if (branchProtected && !overrideBranch) {
    const reason = `branch '${branchLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to push`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_push.rejected',
        tool: 'rsct_request_push',
        reject_kind: 'protected_branch',
        reason,
        branch,
        remote,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch,
      remote,
      channel: gate.channel,
      reject_kind: 'protected_branch',
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: true, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason],
    }
  }

  if (branchProtected && overrideBranch) {
    appendAudit(
      projectRoot,
      {
        event: 'request_push.override_invoked',
        tool: 'rsct_request_push',
        override_kind: 'protected_branch',
        override_reason: overrideBranch.reason,
        branch,
        remote,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  if (branch === null) {
    const reason = 'no branch resolved — pass `branch` explicitly or run from inside a git worktree on a named branch'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_push.mutation_failed',
        tool: 'rsct_request_push',
        reason,
        remote,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'mutation_failed',
      branch: null,
      remote,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason],
    }
  }

  const push = gitPush(projectRoot, remote, branch, gitExecutor)
  if (!push.ok) {
    const reason = push.error ?? push.stderr ?? 'git push failed'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_push.mutation_failed',
        tool: 'rsct_request_push',
        reason,
        branch,
        remote,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'mutation_failed',
      branch,
      remote,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: ['git push failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.'],
    }
  }

  const record = recordApproval(approval, { projectRoot, now })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_push.pushed',
      tool: 'rsct_request_push',
      branch,
      remote,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )

  const hints: string[] = [`Pushed '${branch}' to '${remote}'.`]
  if (!record.ok) {
    hints.push(
      `⚠ push landed, but I could not record this approval as used: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  const afields = auditFields(audit)
  if (afields.audit_error !== null) {
    hints.push(
      `⚠ push landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`,
    )
  }

  // CAP-33: bootstrap visibility on push (mirror of request_commit).
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now })
  if (bootstrap.status !== 'fresh') {
    if (bootstrap.hint) hints.push(bootstrap.hint)
    appendAudit(
      projectRoot,
      {
        event: 'request_push.bootstrap_warning',
        tool: 'rsct_request_push',
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        branch,
        remote,
      },
      config?.audit,
    )
  }

  // CAP-53: when the task's plan is marked complete, SUGGEST (advisory — never
  // auto-perform) cleaning up the branch-local plan_/progress_/spec_ files
  // before they can reach a protected branch (they must never be tracked on
  // main/test). The dev decides.
  // plan-lifecycle-v2 (Bloco 2.3, Fork 2/A — advisory-only): only a PROTECTED
  // push carries the plan_complete ack (a non-protected WIP push never attests
  // completion), so surface the artifact-cleanup advisory ONLY there. Resolve
  // the plan by branch (HOLE A), falling back to the active plan.
  if (branchProtected) {
    const donePlan = (branch ? findPlanByBranch(projectRoot, branch) : null) ?? findActivePlan(projectRoot)
    if (donePlan) {
      const report = planCleanupReport(projectRoot, donePlan.slug, config ?? null)
      hints.push(
        `ℹ Pushed to protected '${branchLabel}'. ${report.hint} Record keep|delete with rsct_plan_dispose, or remove the loose files yourself.`,
      )
    }
  }

  return {
    status: 'pushed',
    branch,
    remote,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    branch_check: { protected: branchProtected, override_used: branchProtected },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints,
  }
}

/**
 * Project an `AuditAppendResult` to the `(audit_path, audit_error)` pair
 * surfaced in `RequestPushOutput`. See `request-commit.ts` for full notes.
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

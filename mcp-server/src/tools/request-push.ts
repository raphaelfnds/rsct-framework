import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan, isPlanComplete } from '../lib/plan.js'
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
  })
  .strict()

export type RequestPushInput = z.infer<typeof requestPushInputSchema>

export type RequestPushStatus = 'pushed' | 'rejected' | 'mutation_failed'

export type RequestPushRejectKind = GateRejectKind | 'protected_branch'

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

  const gate = await gateRequest({
    toolName: 'rsct_request_push',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT §C — push approval',
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
      hints: [`§C rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch

  const { list: protectedList } = effectiveProtectedList(config)
  const branchProtected = isProtectedBranch(branch, protectedList)

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
      `⚠ push landed but anti-replay store update failed: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') may be replayable within the skew window — rotate the approval or repair .rsct/approvals-seen.json before the next §C-gated call.`,
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
  const activePlan = findActivePlan(projectRoot)
  if (activePlan && isPlanComplete(activePlan.status)) {
    hints.push(
      `ℹ Plan '${activePlan.slug}' is marked complete. Optional, with your OK (not automated): delete plan_/progress_/spec_${activePlan.slug}.md so they never land on a protected branch.`,
    )
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

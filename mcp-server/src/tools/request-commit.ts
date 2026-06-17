import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan } from '../lib/plan.js'
import {
  defaultGitExecutor,
  getStagedDiff,
  gitCommit,
  readGitState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
} from '../lib/branch-protection.js'
import {
  compileExtraPatterns,
  scanDiffForSecrets,
  type SecretFinding,
} from '../lib/secrets.js'
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

export const requestCommitInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    message: z
      .string()
      .min(1, 'commit message required')
      .describe('Commit message to pass to `git commit -m`.'),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload (timestamp, action_scope, reason). Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication). To avoid the soft `scope_mismatch` fabrication signal (logged to .rsct/audit.log, non-blocking), make `action_scope`/`reason` mirror the ACTUAL staged diff — the files and branch being committed — instead of free-text intent that the validator cannot reconcile with the diff.',

      ),
    staged_diff_override: z
      .string()
      .optional()
      .describe(
        'Programmatic override of `git diff --cached` for testing. Bypasses the real git fetch.',
      ),
  })
  .strict()

export type RequestCommitInput = z.infer<typeof requestCommitInputSchema>

export type RequestCommitStatus = 'committed' | 'rejected' | 'mutation_failed'

export type RequestCommitRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'secrets'

export interface RequestCommitOutput {
  status: RequestCommitStatus
  branch: string | null
  channel: GateChannel | null
  reject_kind: RequestCommitRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  sha_before: string | null
  sha_after: string | null
  branch_check: {
    protected: boolean
    override_used: boolean
  }
  secrets_check: {
    findings_count: number
    findings: SecretFinding[]
    override_used: boolean
  }
  /** CAP-33: §0 bootstrap visibility — null when not evaluated (reject paths). */
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  /**
   * Set when an audit-log append failed. `null` means the append succeeded
   * OR was disabled by config (`audit.enabled: false`). On `committed`
   * outcomes, a non-null value is a §C-bypass red flag — the mutation
   * landed but its audit trail is missing.
   */
  audit_error: string | null
  /**
   * On `committed`: `true` if `recordConsumedApproval` persisted
   * the (action_scope, timestamp) pair to `.rsct/approvals-seen.json`;
   * `false` if the write failed. On rejected / mutation_failed: `null`
   * (record was never attempted — approval not consumed by design).
   */
  anti_replay_persisted: boolean | null
  /**
   * Set when `recordConsumedApproval` failed post-commit. Non-null here
   * means the same dev_approval may be replayable within the skew window;
   * the caller MUST either rotate the approval or repair
   * `.rsct/approvals-seen.json` before the next §C-gated call.
   */
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestCommitInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  /**
   * Test-only seam: bypass `readGitState` so tests can run with a fixed
   * branch name without git-init'ing a temp repo. Not exposed to MCP callers.
   */
  gitStateOverride?: GitState
  /**
   * Test-only seam: replace `appendAuditEntry`. Production uses the
   * default lib helper; tests inject simulated I/O failures to verify
   * the post-mutation surface (`audit_error` + warning hint).
   */
  auditWriter?: typeof appendAuditEntry
  /**
   * Test-only seam: replace `recordConsumedApproval`. Production uses
   * the default lib helper; tests inject simulated I/O failures to verify
   * the post-mutation surface (`anti_replay_persisted` + warning hint).
   */
  approvalRecorder?: typeof recordConsumedApproval
}

export const requestCommitTool: Tool = {
  name: 'rsct_request_commit',
  description:
    "§C-gated commit. Validates dev_approval (schema/skew/anti-reuse/fabrication), pops an OS dialog when required, runs INV-5 branch and INV-6 secrets checks, then executes `git commit -m`. On rejection the approval is NOT consumed — dev can add an override and retry with the same payload. Audit log entry written on every outcome.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      message: {
        type: 'string',
        description: 'Commit message.',
      },
      dev_approval: {
        type: 'object',
        description:
          'The dev_approval payload (timestamp, action_scope, reason, optional overrides).',
      },
      staged_diff_override: {
        type: 'string',
        description:
          'For tests: substitute the staged diff with this unified-diff string.',
      },
    },
    required: ['message', 'dev_approval'],
    additionalProperties: false,
  },
}

export async function requestCommitHandler(
  rawInput: unknown,
  internal: RequestCommitInternal = {},
): Promise<RequestCommitOutput> {
  const input = requestCommitInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const branchLabel = gitState.branch ?? '<no-branch>'
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  const gate = await gateRequest({
    toolName: 'rsct_request_commit',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT §C — commit approval',
      message: `Approve commit on '${branchLabel}'?\n\nmessage: ${input.message}`,
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
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        branch: gitState.branch,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`§C rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch
  const overrideSecrets = approval.override_secrets_check

  const { list: protectedList } = effectiveProtectedList(config)
  const branchProtected = isProtectedBranch(gitState.branch, protectedList)

  if (branchProtected && !overrideBranch) {
    const reason = `branch '${branchLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to proceed`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'protected_branch',
        reason,
        branch: gitState.branch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: 'protected_branch',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: true, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
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
        event: 'request_commit.override_invoked',
        tool: 'rsct_request_commit',
        override_kind: 'protected_branch',
        override_reason: overrideBranch.reason,
        branch: gitState.branch,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  const diff =
    input.staged_diff_override !== undefined
      ? input.staged_diff_override
      : getStagedDiff(projectRoot) ?? ''
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
  const findings = scanDiffForSecrets(diff, extras)

  if (findings.length > 0 && !overrideSecrets) {
    const reason = `${findings.length} secret finding(s) in staged diff — pass dev_approval.override_secrets_check: { reason } to proceed`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'secrets',
        reason,
        branch: gitState.branch,
        channel: gate.channel,
        findings_count: findings.length,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: 'secrets',
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: { findings_count: findings.length, findings, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason],
    }
  }

  if (findings.length > 0 && overrideSecrets) {
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.override_invoked',
        tool: 'rsct_request_commit',
        override_kind: 'secrets_check',
        override_reason: overrideSecrets.reason,
        findings_count: findings.length,
        branch: gitState.branch,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  const commit = gitCommit(projectRoot, input.message, gitExecutor)
  if (!commit.ok) {
    const reason = commit.error ?? commit.stderr ?? 'git commit failed'
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.mutation_failed',
        tool: 'rsct_request_commit',
        reason,
        branch: gitState.branch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'mutation_failed',
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: commit.sha_before,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: {
        findings_count: findings.length,
        findings,
        override_used: findings.length > 0,
      },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: ['git commit failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.'],
    }
  }

  // Commit succeeded — now persist anti-replay state and write the
  // outcome audit entry. Both can fail (read-only FS, permission denied,
  // disk full); failures are surfaced as warning hints + non-null
  // `anti_replay_error` / `audit_error` so the caller can react.
  const record = recordApproval(approval, { projectRoot, now })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_commit.committed',
      tool: 'rsct_request_commit',
      branch: gitState.branch,
      channel: gate.channel,
      sha_before: commit.sha_before,
      sha_after: commit.sha_after,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )

  const hints: string[] = [
    `Committed ${commit.sha_after ?? '<unknown sha>'} on '${branchLabel}'.`,
  ]
  if (!record.ok) {
    hints.push(
      `⚠ commit landed but anti-replay store update failed: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') may be replayable within the skew window — rotate the approval or repair .rsct/approvals-seen.json before the next §C-gated call.`,
    )
  }
  const afields = auditFields(audit)
  if (afields.audit_error !== null) {
    hints.push(
      `⚠ commit landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`,
    )
  }

  // CAP-33: bootstrap visibility on mutating commit. Soft signal —
  // warns + audits when §0 was skipped or is stale; never rejects.
  // Mirror of CAP-31 path in phase_code_start; here we surface late
  // (post-commit) because §C gate already validated the mutation.
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now })
  if (bootstrap.status !== 'fresh') {
    if (bootstrap.hint) hints.push(bootstrap.hint)
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.bootstrap_warning',
        tool: 'rsct_request_commit',
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        branch: gitState.branch,
        sha_after: commit.sha_after,
      },
      config?.audit,
    )
  }

  // CAP-53: plan-tracking reminder (advisory — never blocks). If a branch-local
  // plan/spec exists, nudge the agent to keep its progress log current so the
  // audit trail does not stale across a long session.
  const activePlan = findActivePlan(projectRoot)
  if (activePlan) {
    hints.push(
      `ℹ Active plan '${activePlan.slug}' — if this commit advances it, update progress_${activePlan.slug}.md (and plan_/spec_${activePlan.slug}.md if the plan itself changed).`,
    )
  }

  return {
    status: 'committed',
    branch: gitState.branch,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: commit.sha_before,
    sha_after: commit.sha_after,
    branch_check: { protected: branchProtected, override_used: branchProtected },
    secrets_check: {
      findings_count: findings.length,
      findings,
      override_used: findings.length > 0,
    },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints,
  }
}

/**
 * Project an `AuditAppendResult` to the `(audit_path, audit_error)` pair
 * surfaced in `RequestCommitOutput`. `audit.enabled: false` is NOT
 * treated as an error — only real write failures populate `audit_error`.
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

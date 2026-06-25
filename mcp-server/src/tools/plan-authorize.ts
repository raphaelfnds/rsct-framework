import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan } from '../lib/plan.js'
import { readGitState, type GitState } from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
} from '../lib/branch-protection.js'
import {
  gateRequest,
  type GateChannel,
  type GateRejectKind,
} from '../lib/request-gate.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from '../lib/os-dialog.js'
import {
  recordConsumedApproval,
  type FabricationSignal,
} from '../lib/dev-approval.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
} from '../lib/phase-scope.js'
import {
  emitToken,
  resolveTtlMinutes,
  resolveMaxActions,
  PLAN_TOKEN_COVERS,
  PLAN_TOKEN_TTL_MIN,
  PLAN_TOKEN_TTL_MAX,
  PLAN_TOKEN_MAX_ACTIONS_MIN,
  PLAN_TOKEN_MAX_ACTIONS_MAX,
} from '../lib/plan-authorization.js'

export const planAuthorizeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload (timestamp, action_scope, reason). action_scope SHOULD start with "plan_authorize:" (INV-2.2 scope_mismatch). Validated via the full §C gate (schema/skew/anti-reuse/fabrication + OS dialog). This single approval mints a batch token covering up to max_actions commits.',
      ),
    ttl_minutes: z
      .number()
      .int()
      .min(PLAN_TOKEN_TTL_MIN)
      .max(PLAN_TOKEN_TTL_MAX)
      .optional()
      .describe(
        `Token lifetime in minutes (${PLAN_TOKEN_TTL_MIN}–${PLAN_TOKEN_TTL_MAX}). Precedence: this input > .rsct.json approval_modes.plan_token_ttl_minutes > 120.`,
      ),
    max_actions: z
      .number()
      .int()
      .min(PLAN_TOKEN_MAX_ACTIONS_MIN)
      .max(PLAN_TOKEN_MAX_ACTIONS_MAX)
      .optional()
      .describe(
        `Max commits the token covers (${PLAN_TOKEN_MAX_ACTIONS_MIN}–${PLAN_TOKEN_MAX_ACTIONS_MAX}). Precedence: this input > approval_modes.plan_token_max_actions > 20.`,
      ),
  })
  .strict()

export type PlanAuthorizeInput = z.infer<typeof planAuthorizeInputSchema>

export type PlanAuthorizeStatus = 'authorized' | 'rejected' | 'state_write_failed'

export type PlanAuthorizeRejectKind =
  | GateRejectKind
  | 'no_active_plan'
  | 'protected_branch'
  | 'no_branch'

export interface PlanAuthorizeOutput {
  status: PlanAuthorizeStatus
  channel: GateChannel | null
  reject_kind: PlanAuthorizeRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  plan_slug: string | null
  branch: string | null
  expires_at: string | null
  max_actions: number | null
  covers: string[]
  audit_path: string | null
  audit_error: string | null
  /** True if the emitting dev_approval was recorded to approvals-seen (anti-reuse). */
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface PlanAuthorizeInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
}

export const planAuthorizeTool: Tool = {
  name: 'rsct_plan_authorize',
  description:
    "T3 §C-gated plan execution mode. Mints a PLAN-SCOPED BATCH TOKEN: one dev_approval (validated by the full §C gate — schema/skew/anti-reuse/fabrication + OS dialog) authorizes up to max_actions COMMITS within the active plan + current branch + a time window, so rsct_request_commit no longer needs a fresh approval per commit. COMMIT ONLY — push/merge keep per-action §C. The token NEVER bypasses branch protection (INV-5) or the secrets scan (INV-6): the token commit path carries no overrides. Requires an active plan_/spec_ at the project root and a NON-protected branch. Auto-revokes on branch switch, plan completion/deletion, expiry, or exhaustion; revoke early with rsct_plan_revoke. The emitting dev_approval is consumed (cannot re-mint). Every token-authorized commit is still individually audited.",
  inputSchema: {
    type: 'object',
    required: ['dev_approval'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      dev_approval: {
        type: 'object',
        description:
          'dev_approval payload (timestamp, action_scope, reason). action_scope SHOULD start with "plan_authorize:".',
      },
      ttl_minutes: {
        type: 'number',
        description: `Token lifetime in minutes (${PLAN_TOKEN_TTL_MIN}–${PLAN_TOKEN_TTL_MAX}; default 120).`,
      },
      max_actions: {
        type: 'number',
        description: `Max commits the token covers (${PLAN_TOKEN_MAX_ACTIONS_MIN}–${PLAN_TOKEN_MAX_ACTIONS_MAX}; default 20).`,
      },
    },
    additionalProperties: false,
  },
}

function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
}

export async function planAuthorizeHandler(
  rawInput: unknown,
  internal: PlanAuthorizeInternal = {},
): Promise<PlanAuthorizeOutput> {
  const input = planAuthorizeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const branch = gitState.branch
  const branchLabel = branch ?? '<no-branch>'

  const gate = await gateRequest({
    toolName: 'rsct_plan_authorize',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — authorize batch plan execution',
      message: `Authorize batch commits for this plan on '${branchLabel}'?\n\nThis lets rsct_request_commit commit WITHOUT a fresh approval each time — limited to this plan and branch, until it expires, runs out, or is revoked.`,
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
        event: 'plan_authorize.rejected',
        tool: 'rsct_plan_authorize',
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        branch,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      plan_slug: null,
      branch,
      expires_at: null,
      max_actions: null,
      covers: [],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  // Pre-conditions (post-gate so the approval gates everything; approval is
  // NOT consumed on a pre-condition failure — dev can fix and retry).
  const reject = (
    reject_kind: PlanAuthorizeRejectKind,
    reason: string,
  ): PlanAuthorizeOutput => {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_authorize.rejected',
        tool: 'rsct_plan_authorize',
        reject_kind,
        reason,
        branch,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      channel: gate.channel,
      reject_kind,
      reason,
      fabrication_signals: gate.fabrication_signals,
      plan_slug: null,
      branch,
      expires_at: null,
      max_actions: null,
      covers: [],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason],
    }
  }

  if (branch === null) {
    return reject(
      'no_branch',
      'no branch resolved (detached HEAD or not in a git worktree) — a batch token must be scoped to a named branch',
    )
  }

  const { list: protectedList } = effectiveProtectedList(config)
  if (isProtectedBranch(branch, protectedList)) {
    return reject(
      'protected_branch',
      `branch '${branchLabel}' is protected — batch tokens are only granted on derived branches (create one: git checkout -b <slug>). Protected-branch commits still require a per-action dev_approval with override_protected_branch.`,
    )
  }

  const activePlan = findActivePlan(projectRoot)
  if (!activePlan) {
    return reject(
      'no_active_plan',
      'no active plan_<slug>.md / spec_<slug>.md at the project root — a batch token must be scoped to a plan. Create the plan/spec first.',
    )
  }

  const ttlMinutes = resolveTtlMinutes(
    input.ttl_minutes,
    config?.approval_modes?.plan_token_ttl_minutes,
  )
  const maxActions = resolveMaxActions(
    input.max_actions,
    config?.approval_modes?.plan_token_max_actions,
  )

  const token = emitToken({
    planSlug: activePlan.slug,
    branch,
    ttlMinutes,
    maxActions,
    approvalRef: {
      action_scope: gate.approval.action_scope,
      timestamp: gate.approval.timestamp,
    },
    now,
  })

  const existing = readPhaseState(projectRoot)
  const baseState: PhaseState = existing.state ?? {}
  const newState: PhaseState = { ...baseState, plan_authorization: token }
  const writeResult = writePhaseState(projectRoot, newState)

  if (!writeResult.ok) {
    // Persist failed → do NOT consume the approval (FV4) so the dev can retry.
    const reason =
      writeResult.reason === 'locked'
        ? `another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago by ${writeResult.held_by_session ?? 'unknown'}) — wait and retry`
        : `phase-state.json write failed: ${writeResult.error}`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_authorize.state_write_failed',
        tool: 'rsct_plan_authorize',
        reason,
        branch,
        plan_slug: activePlan.slug,
        channel: gate.channel,
      },
      config?.audit,
    )
    return {
      status: 'state_write_failed',
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      plan_slug: activePlan.slug,
      branch,
      expires_at: null,
      max_actions: maxActions,
      covers: [...PLAN_TOKEN_COVERS],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`⚠ token NOT minted — ${reason}. dev_approval NOT consumed; retry.`],
    }
  }

  // FV4: token persisted → now consume the emitting approval (anti-reuse).
  const record = recordApproval(gate.approval, { projectRoot, now })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'plan_authorize.authorized',
      tool: 'rsct_plan_authorize',
      branch,
      plan_slug: activePlan.slug,
      expires_at: token.expires_at,
      max_actions: maxActions,
      covers: token.covers,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )
  const afields = auditFields(audit)

  const hints: string[] = [
    `Batch authorization granted for '${activePlan.slug}' on '${branchLabel}': up to ${maxActions} commit(s) until ${token.expires_at}. rsct_request_commit needs NO dev_approval for those. Revoke early with rsct_plan_revoke; switching branch, finishing the plan, or expiry ends it automatically. push/merge still need a per-action approval.`,
  ]
  if (!record.ok) {
    hints.push(
      `⚠ authorization granted, but I could not record the approval as used: ${record.error}. The dev_approval that granted it could be accepted again by mistake for a short time — use a fresh one next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  if (afields.audit_error !== null) {
    hints.push(`⚠ token minted but audit log write failed: ${afields.audit_error}.`)
  }

  return {
    status: 'authorized',
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    plan_slug: activePlan.slug,
    branch,
    expires_at: token.expires_at,
    max_actions: maxActions,
    covers: [...token.covers],
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : (record.error ?? null),
    hints,
  }
}

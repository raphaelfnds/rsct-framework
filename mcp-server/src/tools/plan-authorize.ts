import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findNewestPlanFile, findPlanFileBySlug, isSafePlanSlug, readPlanFilePhases, type PlanPhase } from '../lib/plan.js'
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
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import {
  readPhaseState,
  refuseUnreadableState,
  writePhaseState,
  type PhaseState,
} from '../lib/phase-scope.js'
import {
  emitToken,
  resolveTtlMinutes,
  resolveMaxActions,
  PLAN_TOKEN_COVERS,
  PLAN_TOKEN_TTL_DEFAULT_MIN,
  PLAN_TOKEN_TTL_MIN,
  PLAN_TOKEN_TTL_MAX,
  PLAN_TOKEN_MAX_ACTIONS_MIN,
  PLAN_TOKEN_MAX_ACTIONS_MAX,
} from '../lib/plan-authorization.js'
import { PLAN_AUTHORIZED_EVENT } from '../lib/plan-token-record.js'
import { dialogList, specLabel } from '../lib/dialog-text.js'
import { gateDialogFooter, anchorHints } from '../lib/gate-dialog.js'
import { evaluateInstallAdvisory } from '../lib/install-advisory.js'

const MIN_PHASES = 2
const PHASES_SHOWN = 8

export const planAuthorizeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    dev_approval: z
      .unknown()
      .describe(
        'The dev_approval payload (timestamp, action_scope, reason). action_scope SHOULD start with "plan_authorize:" (INV-2.2 scope_mismatch). Validated via the full §C gate (schema/skew/anti-reuse/fabrication + OS dialog). This single approval mints a batch token covering up to max_actions commits.',
      ),
    plan_slug: z
      .string()
      .optional()
      .describe(
        'The plan to authorize, as the <slug> of plan_<slug>.md at the project root (letters, digits, ".", "_", "-"). Omitted: the newest plan_*.md. The plan must list at least two phases in its "## Phases" table.',
      ),
    ttl_minutes: z
      .number()
      .int()
      .min(PLAN_TOKEN_TTL_MIN)
      .max(PLAN_TOKEN_TTL_MAX)
      .optional()
      .describe(
        `Token lifetime in minutes from this approval (${PLAN_TOKEN_TTL_MIN}–${PLAN_TOKEN_TTL_MAX}; never extended). Precedence: this input > .rsct.json approval_modes.plan_token_ttl_minutes > ${PLAN_TOKEN_TTL_DEFAULT_MIN}.`,
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
  | 'invalid_plan_slug'
  | 'not_multi_phase'

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
    "T3 §C-gated plan execution mode — the ONLY way commits go through with no dialog. Mints a PLAN-SCOPED BATCH TOKEN: one dev_approval, answered by the developer in a FORCED OS dialog (trust_allowed_for is ignored; no dialog channel = refused), authorizes up to max_actions COMMITS on the current branch for a MULTI-PHASE plan — a plan_<slug>.md (named by plan_slug, else the newest) whose \"## Phases\" table lists at least two phases — for at most 8 hours from the approval, never extended. The dialog names the plan, its phases, the commit count and the expiry. COMMIT ONLY — push, merge and rebase keep their own dialog. The token NEVER bypasses branch protection (INV-5) or the secrets scan (INV-6): the token commit path carries no overrides. Requires a NON-protected branch. A token counts only while the audit log holds the plan_authorize.authorized line it was minted with. Auto-revokes on branch switch, plan completion/deletion, expiry, or exhaustion; revoke early with rsct_plan_revoke. The emitting dev_approval is consumed (cannot re-mint). Every token-authorized commit is still individually audited. An unreadable .rsct/phase-state.json is refused (status=\"state_write_failed\"): no token is minted, the approval is not consumed and the file is left untouched.",
  inputSchema: {
    type: 'object',
    required: ['dev_approval'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      dev_approval: {
        type: 'object',
        description:
          'dev_approval payload (timestamp, action_scope, reason). action_scope SHOULD start with "plan_authorize:".',
      },
      plan_slug: {
        type: 'string',
        description: 'The <slug> of plan_<slug>.md to authorize (letters, digits, ".", "_", "-"); omitted: the newest plan_*.md. It must list at least two phases in its "## Phases" table.',
      },
      ttl_minutes: {
        type: 'number',
        description: `Token lifetime in minutes from this approval (${PLAN_TOKEN_TTL_MIN}–${PLAN_TOKEN_TTL_MAX}; default ${PLAN_TOKEN_TTL_DEFAULT_MIN}; never extended).`,
      },
      max_actions: {
        type: 'number',
        description: `Max commits the token covers (${PLAN_TOKEN_MAX_ACTIONS_MIN}–${PLAN_TOKEN_MAX_ACTIONS_MAX}; default 20).`,
      },
    },
    additionalProperties: false,
  },
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

  const installAdvisory = evaluateInstallAdvisory({
    projectRoot,
    rsctInstalled: resolution.rsct_installed,
    projectVersion: config?.rsct_version ?? null,
    auditConfig: config?.audit,
    tool: 'rsct_plan_authorize',
    auditWriter: appendAudit,
  })
  const advisoryHints = installAdvisory.hint ? [installAdvisory.hint] : []

  const refuse = (
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
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      channel: null,
      reject_kind,
      reason,
      fabrication_signals: [],
      plan_slug: null,
      branch,
      expires_at: null,
      max_actions: null,
      covers: [],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [...anchorHints(projectRoot, config?.audit), ...advisoryHints, `${reason} No dialog was shown.`],
    }
  }

  if (branch === null) {
    return refuse(
      'no_branch',
      'no branch resolved (detached HEAD or not in a git worktree) — a batch token must be scoped to a named branch',
    )
  }

  const { list: protectedList } = effectiveProtectedList(config)
  if (isProtectedBranch(branch, protectedList)) {
    return refuse(
      'protected_branch',
      `branch '${branchLabel}' is protected — batch tokens are only granted on derived branches (create one: git checkout -b <slug>). Protected-branch commits still require a per-action dev_approval with override_protected_branch.`,
    )
  }

  if (input.plan_slug !== undefined && !isSafePlanSlug(input.plan_slug)) {
    return refuse(
      'invalid_plan_slug',
      `plan_slug '${specLabel(input.plan_slug, 80)}' is not a plan name: use the <slug> of plan_<slug>.md at the project root (letters, digits, ".", "_", "-", no "..")`,
    )
  }
  const plan = input.plan_slug !== undefined ? findPlanFileBySlug(projectRoot, input.plan_slug) : findNewestPlanFile(projectRoot)
  if (!plan) {
    return refuse(
      'no_active_plan',
      input.plan_slug !== undefined
        ? `no plan_${input.plan_slug}.md at the project root — a batch token is scoped to a plan file`
        : 'no plan_<slug>.md at the project root — a batch token is scoped to a plan file. Create the plan first.',
    )
  }
  const phases = readPlanFilePhases(plan.plan_path)
  if (phases.length < MIN_PHASES) {
    return refuse(
      'not_multi_phase',
      `a batch token is only for a plan with ${MIN_PHASES} or more phases: plan_${plan.slug}.md lists ${phases.length} in its "## Phases" table (a row needs a Phase and a Goal that are filled in). Each commit of this plan shows its own dialog.`,
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
  const expiresPreview = new Date(now.getTime() + ttlMinutes * 60_000).toISOString()

  const unreadableBefore = refuseUnreadableState(projectRoot, readPhaseState(projectRoot))
  if (unreadableBefore && !unreadableBefore.ok && unreadableBefore.reason === 'unreadable_state') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_authorize.state_write_failed',
        tool: 'rsct_plan_authorize',
        reason: unreadableBefore.error,
        branch,
        plan_slug: plan.slug,
        channel: null,
      },
      config?.audit,
    )
    return {
      status: 'state_write_failed',
      channel: null,
      reject_kind: null,
      reason: unreadableBefore.error,
      fabrication_signals: [],
      plan_slug: plan.slug,
      branch,
      expires_at: null,
      max_actions: maxActions,
      covers: [...PLAN_TOKEN_COVERS],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [...anchorHints(projectRoot, config?.audit), `⚠ token NOT minted — ${unreadableBefore.error} dev_approval NOT consumed. No dialog was shown.`],
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_plan_authorize',
    approval: input.dev_approval,
    forceDialog: true,
    forceDialogReason: 'a batch token is granted only by the developer, in this dialog',
    dialog: {
      title: 'RSCT — authorize batch commits',
      message: mintDialogMessage({
        maxActions,
        expiresAt: expiresPreview,
        branch: branchLabel,
        warningLine: installAdvisory.dialogLine,
        footer: gateDialogFooter(projectRoot, config),
        planSlug: plan.slug,
        phases,
      }),
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
      hints: [...anchorHints(projectRoot, config?.audit), ...advisoryHints, `Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const token = emitToken({
    planSlug: plan.slug,
    branch,
    ttlMinutes,
    maxActions,
    approvalRef: {
      action_scope: gate.approval.action_scope,
      timestamp: gate.approval.timestamp,
    },
    now,
  })

  const notMinted = (reason: string, unreadable: boolean): PlanAuthorizeOutput => {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_authorize.state_write_failed',
        tool: 'rsct_plan_authorize',
        reason,
        branch,
        plan_slug: plan.slug,
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
      plan_slug: plan.slug,
      branch,
      expires_at: null,
      max_actions: maxActions,
      covers: [...PLAN_TOKEN_COVERS],
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        ...anchorHints(projectRoot, config?.audit),
        unreadable
          ? `⚠ token NOT minted — ${reason} dev_approval NOT consumed.`
          : `⚠ token NOT minted — ${reason}. dev_approval NOT consumed; retry.`,
      ],
    }
  }

  const existing = readPhaseState(projectRoot)
  const unreadableState = refuseUnreadableState(projectRoot, existing)
  if (unreadableState && !unreadableState.ok && unreadableState.reason === 'unreadable_state') {
    return notMinted(unreadableState.error, true)
  }

  const audit = appendAudit(
    projectRoot,
    {
      event: PLAN_AUTHORIZED_EVENT,
      tool: 'rsct_plan_authorize',
      branch,
      plan_slug: plan.slug,
      phases: phases.length,
      authorized_at: token.authorized_at,
      expires_at: token.expires_at,
      max_actions: maxActions,
      covers: token.covers,
      approval_action_scope: token.approval_ref.action_scope,
      approval_timestamp: token.approval_ref.timestamp,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )
  const afields = auditFields(audit)
  if (afields.audit_error !== null) {
    return notMinted(`the audit log could not record the authorization (${afields.audit_error}) — a token counts only while that line exists`, false)
  }

  const baseState: PhaseState = existing.state ?? {}
  const writeResult = writePhaseState(projectRoot, { ...baseState, plan_authorization: token })
  if (!writeResult.ok) {
    const reason =
      writeResult.reason === 'locked'
        ? `another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago by ${writeResult.held_by_session ?? 'unknown'}) — wait and retry`
        : writeResult.reason === 'unreadable_state'
          ? writeResult.error
          : `phase-state.json write failed: ${writeResult.error}`
    return notMinted(reason, writeResult.reason === 'unreadable_state')
  }

  const record = recordApproval(gate.approval, { projectRoot, now, auditConfig: config?.audit })

  const hints: string[] = [...anchorHints(projectRoot, config?.audit), ...advisoryHints,
    `Batch authorization granted for '${plan.slug}' (${phases.length} phases) on '${branchLabel}': up to ${maxActions} commit(s) until ${token.expires_at}, never extended. rsct_request_commit needs NO dev_approval for those. Revoke early with rsct_plan_revoke; switching branch, finishing the plan, or expiry ends it automatically. push, merge and rebase still need their own dialog.`,
  ]
  if (!record.ok) {
    hints.push(
      `⚠ authorization granted, but I could not record the approval as used: ${record.error}. The dev_approval that granted it could be accepted again by mistake for a short time — use a fresh one next time, or repair .rsct/approvals-seen.json.`,
    )
  }

  return {
    status: 'authorized',
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    plan_slug: plan.slug,
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

function mintDialogMessage(args: {
  maxActions: number
  expiresAt: string
  branch: string
  warningLine: string | null
  footer: string
  planSlug: string
  phases: PlanPhase[]
}): string {
  const phases = dialogList(args.phases.map((p) => `${specLabel(p.id, 20)}: ${specLabel(p.goal, 100)}`), PHASES_SHOWN, 130)
  return [
    `Authorize up to ${args.maxActions} commits with NO dialog, until ${args.expiresAt} UTC (8 h at most, never extended), on branch '${specLabel(args.branch, 80)}'?`,
    ...(args.warningLine ? [args.warningLine] : []),
    '',
    'Commit only: merge, rebase and push keep their own dialog. Revoke early with rsct_plan_revoke.',
  ].join('\n') +
    args.footer +
    `\nPlan: '${specLabel(args.planSlug, 80)}' — ${args.phases.length} phases:\n` +
    phases
}

import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan, findPlanBySlug } from '../lib/plan.js'
import {
  defaultGitExecutor,
  getStagedDiff,
  getFileAtHead,
  getStagedPaths,
  getStagedStats,
  gitCommit,
  readGitState,
  type GitExecutor,
  type GitState,
  type StagedStats,
} from '../lib/git.js'
import {
  deriveAuditCeiling,
  evaluateFreeEligibility,
  reserveFreeBudget,
  resolveFreeBudgetLimits,
} from '../lib/free-commit.js'
import {
  checkStagedSweep,
  driftCovered,
  ledgerEntries,
  stampLedger,
  sweepEntry,
  verifyCommittedSweep,
  type StagedSweepCheck,
} from '../lib/comment-sweep/review.js'
import {
  checkStagedDeadCode,
  readDeadCodeKeeps,
  type StagedDeadCodeCheck,
} from '../lib/dead-code/review-gate.js'
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
  type DevApproval,
  type FabricationSignal,
} from '../lib/dev-approval.js'
import {
  appendAuditEntry,
  auditFields,
  resolveAuditPath,
} from '../lib/audit-log.js'
import { evaluateInstallAdvisory } from '../lib/install-advisory.js'
import {
  evaluateSettingsDrift,
  hashSettingsFile,
  readBaselineFromLog,
  readTextOrNull,
  SETTINGS_REL_PATH,
} from '../lib/settings-drift.js'
import { checkCommitMessage } from '../lib/commit-message.js'
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
  readPhaseState,
  writePhaseState,
  type BootstrapMarker,
  type FreeCommitBudget,
  type PhaseState,
  type PlanAuthorizationBlock,
} from '../lib/phase-scope.js'
import {
  readToken,
  validateToken,
  consumeTokenAction,
  rearmToken,
  type TokenInvalidReason,
} from '../lib/plan-authorization.js'
import { confirmedTopologyMode } from '../lib/topology.js'
import { resolveUniverseRoot } from '../lib/universe.js'
import {
  readContracts,
  contractsTouchingPaths,
  affectedConsumers,
} from '../lib/contracts.js'
import { gateDialogFooter, anchorHints } from '../lib/gate-dialog.js'

export const requestCommitInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    message: z
      .string()
      .min(1, 'commit message required')
      .describe('Commit message to pass to `git commit -m`.'),
    dev_approval: z
      .unknown()
      .optional()
      .describe(
        'The dev_approval payload (timestamp, action_scope, reason). OPTIONAL: when present, the per-action §C gate runs (schema/skew/anti-reuse/fabrication). When ABSENT, the commit is authorized by an active plan-scoped batch token (mint one with rsct_plan_authorize) — but the token NEVER bypasses branch protection or the secrets scan (the token path carries no overrides). To avoid the soft `scope_mismatch` fabrication signal, make `action_scope`/`reason` mirror the ACTUAL staged diff.',
      ),
  })
  .strict()

export type RequestCommitInput = z.infer<typeof requestCommitInputSchema>

export type RequestCommitStatus = 'committed' | 'committed_with_drift' | 'rejected' | 'mutation_failed'

export type RequestCommitRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'secrets'
  | 'contract_surface'
  | 'plan_token_invalid'
  | 'free_budget_reserve_failed'
  | 'message_too_long'
  | 'review_missing'
  | 'comments_present'
  | 'migration_reverted'
  | 'review_drift'
  | 'review_unreadable'
  | 'dead_code_staged'

export type CommitAuthVia = 'dev_approval' | 'plan_token' | 'free_commit'

export type CommitChannel = GateChannel | 'plan_token' | 'free_commit'

export interface ContractCheckResult {
  mode: 'mono' | 'monorepo' | 'multi-repo' | null
  touched: string[]
  consumers: string[]
  override_used: boolean
}

export interface RequestCommitOutput {
  status: RequestCommitStatus
  branch: string | null
  channel: CommitChannel | null
  authorized_via: CommitAuthVia | null
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
  contract_check?: ContractCheckResult | null
  plan_token?: {
    plan_slug: string
    actions_used: number
    max_actions: number
    expires_at: string
  } | null
  free_commit?: {
    plan_slug: string
    commits_used: number
    files_touched: number
    lines_changed: number
    locked: boolean
    locked_reason?: 'commit_cap' | 'volume_cap' | 'tier_divergence'
  } | null
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestCommitInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  stagedDiffOverride?: string
  stagedPathsOverride?: string[]
  stagedStatsOverride?: StagedStats
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
  shippedScriptsDir?: string | null
}

export const requestCommitTool: Tool = {
  name: 'rsct_request_commit',
  description:
    "§C-gated commit. REVIEW gate (every tier, every authorization path, checked before any dialog and again right before git commit): each staged code file must match a version stamped by a completed rsct_phase_review_complete and carry no comment (reject_kind review_missing / comments_present / migration_reverted); a pre-commit hook that slips in unreviewed code returns committed_with_drift and blocks further commits (review_drift) until a REVIEW covers it. Dead-code gate at the same two points (JavaScript/TypeScript): the STAGED bytes of each staged code file are scanned against the whole index — never the working tree — for a declared symbol nothing references, its own file included; one rejects (dead_code_staged) unless a completed REVIEW recorded the developer keeping it, which counts only when its audit line exists and the declaration bytes are unchanged. A hook that adds a dead symbol lands as committed_with_drift. Symbols the scan cannot settle are reported in hints, never passed silently. Commits with no code file are unaffected. Authorization is EITHER a per-action dev_approval (validated for schema/skew/anti-reuse/fabrication, with an OS dialog when required) OR — when dev_approval is omitted — an active plan-scoped batch token minted by rsct_plan_authorize (covers commit only; auto-revokes on branch switch / plan completion / expiry / exhaustion). Both paths run INV-5 branch and INV-6 secrets checks; the token path carries NO overrides, so a protected branch or any secret finding still rejects (fall back to a per-action dev_approval with the override). On rejection nothing is consumed — dev can add an override and retry with the same payload. Audit log entry written on every outcome.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      message: {
        type: 'string',
        description:
          'Commit message. Keep it to 15 non-empty lines at most (blank lines are not counted): what changed and why, not a file-by-file narration of the diff. Over that, the call is rejected with `message_too_long` before any approval is requested. A project can raise the cap with `commit_message_max_lines` in .rsct.json.',
      },
      dev_approval: {
        type: 'object',
        description:
          'OPTIONAL dev_approval payload (timestamp, action_scope, reason, optional overrides). Omit to authorize via an active plan token (rsct_plan_authorize).',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
}

function planTokenRejectReason(reason: TokenInvalidReason): string {
  switch (reason) {
    case 'absent':
      return 'no dev_approval and no active plan token — pass a dev_approval, or mint a batch token with rsct_plan_authorize'
    case 'not_covered':
      return 'the active plan token does not cover commit'
    case 'expired':
      return 'the plan token has expired — re-authorize with rsct_plan_authorize'
    case 'branch_mismatch':
      return 'the plan token was minted for a different branch (tokens auto-revoke on branch switch) — re-authorize on this branch or pass a per-action dev_approval'
    case 'plan_gone':
      return "the plan token's plan_/spec_ file no longer exists — re-authorize with rsct_plan_authorize"
    case 'plan_complete':
      return "the plan token's plan is marked complete — re-authorize if work continues"
    case 'exhausted':
      return 'the plan token reached its max_actions budget — mint a fresh token with rsct_plan_authorize'
  }
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

  const advisories: string[] = []
  advisories.push(...anchorHints(projectRoot, config?.audit))
  const withAdvisories = (hints: string[]): string[] => [...advisories, ...hints]

  const installAdvisory = evaluateInstallAdvisory({
    projectRoot,
    rsctInstalled: resolution.rsct_installed,
    projectVersion: config?.rsct_version ?? null,
    auditConfig: config?.audit,
    tool: 'rsct_request_commit',
    auditWriter: appendAudit,
  })
  if (installAdvisory.hint) advisories.unshift(installAdvisory.hint)

  if (resolution.rsct_installed) {
    const stagedForDrift = internal.stagedPathsOverride ?? getStagedPaths(projectRoot) ?? []
    const drift = evaluateSettingsDrift({
      currentHash: hashSettingsFile(projectRoot),
      baseline: readBaselineFromLog(readTextOrNull(resolveAuditPath(projectRoot, config?.audit)) ?? ''),
      staged: stagedForDrift.includes(SETTINGS_REL_PATH),
      currentText: readTextOrNull(join(projectRoot, '.claude', 'settings.json')),
      headText: getFileAtHead(projectRoot, SETTINGS_REL_PATH),
    })
    if (drift.hint) {
      advisories.push(drift.hint)
      appendAudit(
        projectRoot,
        {
          event: 'settings.drift_detected',
          tool: 'rsct_request_commit',
          added_count: drift.added_entries.length,
          excerpt: drift.added_entries[0]?.slice(0, 80) ?? null,
        },
        config?.audit,
      )
    }
  }

  const messageCheck = checkCommitMessage(input.message, config)
  if (!messageCheck.ok) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'message_too_long',
        reason: messageCheck.reason,
        branch: gitState.branch,
        message_lines: messageCheck.lines,
        message_limit: messageCheck.limit,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: null,
      authorized_via: null,
      reject_kind: 'message_too_long',
      reason: messageCheck.reason,
      fabrication_signals: [],
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([messageCheck.reason ?? 'commit message too long']),
    }
  }

  const runSweepCheck = async (): Promise<StagedSweepCheck> => {
    const sweepState = readPhaseState(projectRoot).state
    return checkStagedSweep({
      projectRoot,
      options: { sqlDialect: config?.sql_dialect, shippedScriptsDir: internal.shippedScriptsDir },
      ledger: sweepState?.review_sweep,
      drift: sweepState?.review_drift,
      unverifiedDecisions: deriveAuditCeiling(projectRoot, config ?? null, '').unverifiedDecisions,
    })
  }
  const rejectSweep = (check: Extract<StagedSweepCheck, { ok: false }>, stage: 'before_authorization' | 'before_commit'): RequestCommitOutput => {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: check.reject_kind,
        reason: check.reason,
        branch: gitState.branch,
        paths: check.paths,
        stage,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: null,
      authorized_via: null,
      reject_kind: check.reject_kind,
      reason: check.reason,
      fabrication_signals: [],
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([check.reason]),
    }
  }
  const runDeadCodeCheck = async (paths: readonly string[]): Promise<StagedDeadCodeCheck> =>
    checkStagedDeadCode({
      projectRoot,
      stagedPaths: paths,
      publicApi: config?.public_api,
      keeps: readDeadCodeKeeps(readPhaseState(projectRoot).state?.dead_code_keeps),
      keepDecisions: deriveAuditCeiling(projectRoot, config ?? null, '').deadCodeKeepDecisions,
    })
  const rejectDeadCode = (
    check: Extract<StagedDeadCodeCheck, { ok: false }>,
    stage: 'before_authorization' | 'before_commit',
  ): RequestCommitOutput => {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: check.reject_kind,
        reason: check.reason,
        branch: gitState.branch,
        paths: check.paths,
        stage,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: null,
      authorized_via: null,
      reject_kind: check.reject_kind,
      reason: check.reason,
      fabrication_signals: [],
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([check.reason, ...check.hints]),
    }
  }

  const sweepBefore = await runSweepCheck()
  if (!sweepBefore.ok) return rejectSweep(sweepBefore, 'before_authorization')
  const deadBefore = await runDeadCodeCheck(sweepBefore.checked.map((c) => c.path))
  if (!deadBefore.ok) return rejectDeadCode(deadBefore, 'before_authorization')

  let channel: CommitChannel
  let authorizedVia: CommitAuthVia
  let approval: DevApproval | null = null
  let fabricationSignals: FabricationSignal[] = []
  let tokenCtx: { token: PlanAuthorizationBlock; baseState: PhaseState } | null = null
  let freeCtx: { planSlug: string; baseState: PhaseState } | null = null

  if (input.dev_approval !== undefined) {
    const gate = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: input.dev_approval,
      dialog: {
        title: 'RSCT — commit approval',
        message: `Approve commit on '${branchLabel}'?\n\nmessage: ${input.message}` + gateDialogFooter(projectRoot, config),
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
        authorized_via: null,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals,
        sha_before: gitState.head_sha,
        sha_after: null,
        branch_check: { protected: false, override_used: false },
        secrets_check: { findings_count: 0, findings: [], override_used: false },
        plan_token: null,
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([
          `Approval rejected (${gate.reject_kind}): ${gate.reason}`,
        ]),
      }
    }

    approval = gate.approval
    channel = gate.channel
    authorizedVia = 'dev_approval'
    fabricationSignals = gate.fabrication_signals
  } else {
    const existing = readPhaseState(projectRoot)
    const activePlan = findActivePlan(projectRoot)
    const elig = evaluateFreeEligibility({
      installDriftSecurity: installAdvisory.isSecurity,
      projectRoot,
      config: config ?? null,
      now,
      state: existing.state,
      activePlanSlug: activePlan?.slug ?? null,
    })

    if (elig.eligible && elig.planSlug !== undefined) {
      channel = 'free_commit'
      authorizedVia = 'free_commit'
      freeCtx = { planSlug: elig.planSlug, baseState: existing.state ?? {} }
    } else {
      const token = readToken(existing.state)
      const tokenPlan = token ? findPlanBySlug(projectRoot, token.plan_slug) : null
      const verdict = validateToken(token, {
        now,
        branch: gitState.branch,
        tokenPlan,
        action: 'commit',
      })

      if (!verdict.valid) {
        let reason = planTokenRejectReason(verdict.reason)
        if (verdict.reason === 'absent' && elig.lockedHint) {
          reason = `free-commit budget is locked for this plan (${elig.reason}) — re-classify with rsct_classify_task, or mint a batch token with rsct_plan_authorize`
        }
        if (verdict.reason === 'absent' && elig.installDriftSecurity) {
          reason =
            'the dialog-free commit lane is suspended while RSCT enforcement is not running — ' +
            'approve this commit per-action (dev_approval), or run /rsct-setup and restart the IDE to restore it'
        }
        const audit = appendAudit(
          projectRoot,
          {
            event: 'request_commit.rejected',
            tool: 'rsct_request_commit',
            reject_kind: 'plan_token_invalid',
            token_reason: verdict.reason,
            reason,
            branch: gitState.branch,
          },
          config?.audit,
        )
        return {
          status: 'rejected',
          branch: gitState.branch,
          channel: null,
          authorized_via: null,
          reject_kind: 'plan_token_invalid',
          reason,
          fabrication_signals: [],
          sha_before: gitState.head_sha,
          sha_after: null,
          branch_check: { protected: false, override_used: false },
          secrets_check: { findings_count: 0, findings: [], override_used: false },
          plan_token: null,
          ...auditFields(audit),
          anti_replay_persisted: null,
          anti_replay_error: null,
          hints: withAdvisories([
            `Approval rejected (plan_token_invalid): ${reason}`,
          ]),
        }
      }

      channel = 'plan_token'
      authorizedVia = 'plan_token'
      tokenCtx = { token: verdict.token, baseState: existing.state ?? {} }
    }
  }

  const overrideBranch = approval?.override_protected_branch
  const overrideSecrets = approval?.override_secrets_check

  const { list: protectedList } = effectiveProtectedList(config)
  const branchProtected = isProtectedBranch(gitState.branch, protectedList)

  if (branchProtected && !overrideBranch) {
    const reason = `branch '${branchLabel}' is protected — ${
      authorizedVia === 'plan_token'
        ? 'a plan authorization never covers protected branches; commit with a per-action dev_approval that includes override_protected_branch: { reason }'
        : 'pass dev_approval.override_protected_branch: { reason } to proceed'
    }`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'protected_branch',
        reason,
        branch: gitState.branch,
        channel,
        authorized_via: authorizedVia,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel,
      authorized_via: authorizedVia,
      reject_kind: 'protected_branch',
      reason,
      fabrication_signals: fabricationSignals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: true, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
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
        channel,
      },
      config?.audit,
    )
  }

  const diff = internal.stagedDiffOverride ?? getStagedDiff(projectRoot) ?? ''
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
  const findings = scanDiffForSecrets(diff, extras)

  if (findings.length > 0 && !overrideSecrets) {
    const reason = `${findings.length} secret finding(s) in staged diff — ${
      authorizedVia === 'plan_token'
        ? 'a plan authorization never bypasses the secrets scan; commit with a per-action dev_approval that includes override_secrets_check: { reason }'
        : 'pass dev_approval.override_secrets_check: { reason } to proceed'
    }`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'secrets',
        reason,
        branch: gitState.branch,
        channel,
        authorized_via: authorizedVia,
        findings_count: findings.length,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel,
      authorized_via: authorizedVia,
      reject_kind: 'secrets',
      reason,
      fabrication_signals: fabricationSignals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: { findings_count: findings.length, findings, override_used: false },
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
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
        channel,
      },
      config?.audit,
    )
  }

  const overrideContract = approval?.override_contract_surface
  const topoMode = confirmedTopologyMode(config ?? null)
  let contractResult: ContractCheckResult = {
    mode: topoMode,
    touched: [],
    consumers: [],
    override_used: false,
  }
  let contractGateInactive = false
  if (topoMode === 'multi-repo') {
    const appName = config?.app?.name ?? null
    let universeRoot: string | null = null
    try {
      const r = resolveUniverseRoot(config ?? null, projectRoot)
      universeRoot = r.kind === 'found' ? r.path : null
    } catch {
      universeRoot = null
    }
    const graph = readContracts(universeRoot)
    contractGateInactive = !graph.available
    const stagedPaths = internal.stagedPathsOverride ?? getStagedPaths(projectRoot) ?? []
    const hits = appName ? contractsTouchingPaths(graph, appName, stagedPaths) : []
    if (hits.length > 0) {
      const ids = hits.map((h) => h.id)
      const consumers = affectedConsumers(hits)
      contractResult = { mode: 'multi-repo', touched: ids, consumers, override_used: !!overrideContract }
      if (!overrideContract) {
        const reason = `this commit changes contract surface(s) [${ids.join(', ')}] that other repos depend on [${
          consumers.join(', ') || 'none listed'
        }]. This repo OWNS (produces) those surfaces, so the gate stops the commit here to flag the cross-repo impact. ${
          authorizedVia === 'plan_token'
            ? 'A plan authorization never bypasses the contract gate; commit with a per-action dev_approval that includes override_contract_surface: { reason }.'
            : 'To proceed, pass dev_approval.override_contract_surface: { reason } (acknowledging the impact on the consumers listed above).'
        }`
        const audit = appendAudit(
          projectRoot,
          {
            event: 'request_commit.rejected',
            tool: 'rsct_request_commit',
            reject_kind: 'contract_surface',
            reason,
            branch: gitState.branch,
            channel,
            authorized_via: authorizedVia,
            contracts: ids,
            consumers,
          },
          config?.audit,
        )
        return {
          status: 'rejected',
          branch: gitState.branch,
          channel,
          authorized_via: authorizedVia,
          reject_kind: 'contract_surface',
          reason,
          fabrication_signals: fabricationSignals,
          sha_before: gitState.head_sha,
          sha_after: null,
          branch_check: { protected: branchProtected, override_used: branchProtected },
          secrets_check: {
            findings_count: findings.length,
            findings,
            override_used: findings.length > 0,
          },
          contract_check: contractResult,
          plan_token: null,
          ...auditFields(audit),
          anti_replay_persisted: null,
          anti_replay_error: null,
          hints: withAdvisories([reason]),
        }
      }
      appendAudit(
        projectRoot,
        {
          event: 'request_commit.override_invoked',
          tool: 'rsct_request_commit',
          override_kind: 'contract_surface',
          override_reason: overrideContract.reason,
          contracts: ids,
          consumers,
          branch: gitState.branch,
          channel,
        },
        config?.audit,
      )
    }
  }

  const sweepAtCommit = await runSweepCheck()
  if (!sweepAtCommit.ok) return rejectSweep(sweepAtCommit, 'before_commit')
  const deadAtCommit = await runDeadCodeCheck(sweepAtCommit.checked.map((c) => c.path))
  if (!deadAtCommit.ok) return rejectDeadCode(deadAtCommit, 'before_commit')

  let reservedToken: PlanAuthorizationBlock | null = null
  let reservedFreeBudget: FreeCommitBudget | null = null
  let freeNewlyLocked = false
  if (tokenCtx) {
    reservedToken = consumeTokenAction(tokenCtx.token)
    const reserve = writePhaseState(projectRoot, {
      ...tokenCtx.baseState,
      plan_authorization: reservedToken,
    })
    if (!reserve.ok) {
      const detail =
        reserve.reason === 'locked'
          ? `phase-state.json is being edited by another session (locked ${reserve.lock_age_ms}ms ago)`
          : reserve.error
      const reason = `could not reserve a plan-token action (${detail}) — retry, or commit with a per-action dev_approval`
      const audit = appendAudit(
        projectRoot,
        {
          event: 'request_commit.rejected',
          tool: 'rsct_request_commit',
          reject_kind: 'plan_token_invalid',
          token_reason: 'reserve_failed',
          reason,
          branch: gitState.branch,
          channel,
        },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch: gitState.branch,
        channel,
        authorized_via: authorizedVia,
        reject_kind: 'plan_token_invalid',
        reason,
        fabrication_signals: fabricationSignals,
        sha_before: gitState.head_sha,
        sha_after: null,
        branch_check: { protected: branchProtected, override_used: branchProtected },
        secrets_check: {
          findings_count: findings.length,
          findings,
          override_used: false,
        },
        plan_token: null,
        contract_check: contractResult,
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([reason]),
      }
    }
  } else if (freeCtx) {
    const rejectFreeReserve = (reason: string): RequestCommitOutput => {
      const audit = appendAudit(
        projectRoot,
        {
          event: 'request_commit.rejected',
          tool: 'rsct_request_commit',
          reject_kind: 'free_budget_reserve_failed',
          reason,
          branch: gitState.branch,
          channel,
        },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch: gitState.branch,
        channel,
        authorized_via: authorizedVia,
        reject_kind: 'free_budget_reserve_failed',
        reason,
        fabrication_signals: fabricationSignals,
        sha_before: gitState.head_sha,
        sha_after: null,
        branch_check: { protected: branchProtected, override_used: branchProtected },
        secrets_check: { findings_count: findings.length, findings, override_used: false },
        plan_token: null,
        free_commit: null,
        contract_check: contractResult,
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([reason]),
      }
    }

    const stats = internal.stagedStatsOverride ?? getStagedStats(projectRoot)
    if (stats === null) {
      return rejectFreeReserve(
        'could not measure the staged diff (git unavailable) — commit with a per-action dev_approval',
      )
    }
    const limits = resolveFreeBudgetLimits(config ?? null)
    const reserve = reserveFreeBudget({
      planSlug: freeCtx.planSlug,
      prev: freeCtx.baseState.free_commit_budget,
      stats,
      limits,
    })
    reservedFreeBudget = reserve.nextBudget
    freeNewlyLocked = reserve.newlyLocked
    fabricationSignals = [...fabricationSignals, ...reserve.signals]
    const write = writePhaseState(projectRoot, {
      ...freeCtx.baseState,
      free_commit_budget: reserve.nextBudget,
    })
    if (!write.ok) {
      const detail =
        write.reason === 'locked'
          ? `phase-state.json is being edited by another session (locked ${write.lock_age_ms}ms ago)`
          : write.error
      return rejectFreeReserve(
        `could not reserve the free-commit budget (${detail}) — retry, or commit with a per-action dev_approval`,
      )
    }
  }

  const commit = gitCommit(projectRoot, input.message, gitExecutor)
  if (!commit.ok) {
    const reason = commit.error ?? commit.stderr ?? 'git commit failed'
    let refundNote = ''
    if (tokenCtx) {
      const refund = writePhaseState(projectRoot, {
        ...tokenCtx.baseState,
        plan_authorization: tokenCtx.token,
      })
      refundNote = refund.ok
        ? ' The reserved token action was refunded.'
        : ' ⚠ the reserved token action could NOT be refunded (phase-state write failed) — one action was forfeited (fail-safe).'
    } else if (freeCtx) {
      const prevBudget = freeCtx.baseState.free_commit_budget
      const restored: PhaseState = { ...freeCtx.baseState }
      if (prevBudget) restored.free_commit_budget = prevBudget
      else delete restored.free_commit_budget
      const refund = writePhaseState(projectRoot, restored)
      refundNote = refund.ok
        ? ' The reserved free-commit budget was refunded.'
        : ' ⚠ the reserved free-commit budget could NOT be refunded (phase-state write failed) — the spend stays (fail-safe).'
    }
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.mutation_failed',
        tool: 'rsct_request_commit',
        reason,
        branch: gitState.branch,
        channel,
        authorized_via: authorizedVia,
      },
      config?.audit,
    )
    return {
      status: 'mutation_failed',
      branch: gitState.branch,
      channel,
      authorized_via: authorizedVia,
      reject_kind: null,
      reason,
      fabrication_signals: fabricationSignals,
      sha_before: commit.sha_before,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: {
        findings_count: findings.length,
        findings,
        override_used: findings.length > 0,
      },
      plan_token: null,
      free_commit: null,
      contract_check: contractResult,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([
        authorizedVia === 'plan_token' || authorizedVia === 'free_commit'
          ? `git commit failed — fix the underlying error and retry.${refundNote}`
          : 'git commit failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.',
      ]),
    }
  }

  let antiReplayPersisted: boolean
  let antiReplayError: string | null = null
  let tokenSummary: RequestCommitOutput['plan_token'] = null
  let freeSummary: RequestCommitOutput['free_commit'] = null
  const bookkeepingHints: string[] = []

  let sweepDrift: string[] = []
  if (commit.sha_after && sweepAtCommit.skipped === null) {
    const committed = await verifyCommittedSweep({
      projectRoot,
      options: { sqlDialect: config?.sql_dialect, shippedScriptsDir: internal.shippedScriptsDir },
      before: commit.sha_before,
      after: commit.sha_after,
      checked: sweepAtCommit.checked,
    })
    const deadAfterHook = committed.rewrites.length > 0 ? await runDeadCodeCheck(committed.rewrites.map((r) => r.path)) : null
    const deadRewritten = new Set(deadAfterHook && !deadAfterHook.ok ? deadAfterHook.paths : [])
    const cleanRewrites = committed.rewrites.filter((r) => !deadRewritten.has(r.path))
    const state = readPhaseState(projectRoot).state ?? {}
    const at = now.toISOString()
    const stamps = cleanRewrites.map((r) => {
      const original = ledgerEntries(state.review_sweep, r.path).find(
        (e) => e.blob === sweepAtCommit.checked.find((c) => c.path === r.path)?.blob,
      )
      appendAudit(
        projectRoot,
        { event: 'review.commit_hook_rewrite', tool: 'rsct_request_commit', path: r.path, blob: r.blob, sha_after: commit.sha_after },
        config?.audit,
      )
      return { path: r.path, entry: sweepEntry(r.blob, 'clean', original?.migrations ?? [], 'hook_rewrite', original?.spec_ref ?? 'hook_rewrite', at) }
    })
    if (cleanRewrites.length > 0) {
      bookkeepingHints.push(
        `ℹ a pre-commit hook rewrote ${cleanRewrites.map((r) => r.path).join(', ')} — the committed bytes carry no comment and no dead code, and were re-stamped.`,
      )
    }
    const next: PhaseState = { ...state }
    if (stamps.length > 0) next.review_sweep = stampLedger(state.review_sweep, stamps, null)
    if (state.review_drift) {
      const { open } = driftCovered(projectRoot, next.review_sweep ?? state.review_sweep, state.review_drift.paths)
      if (open.length === 0) delete next.review_drift
      else next.review_drift = { ...state.review_drift, paths: open }
    }
    const drift = [...new Set([...committed.drift, ...deadRewritten])]
    if (drift.length > 0) {
      sweepDrift = drift
      next.review_drift = { sha: committed.full_sha ?? commit.sha_after, paths: drift, at }
      appendAudit(
        projectRoot,
        { event: 'review.commit_drift', tool: 'rsct_request_commit', paths: drift, sha_after: committed.full_sha ?? commit.sha_after },
        config?.audit,
      )
      bookkeepingHints.push(
        `⚠ the commit landed code no REVIEW covers (${drift.join(', ')}) — most likely a pre-commit hook changed the index. Every further commit is refused until rsct_phase_review_start / _complete covers those paths.`,
      )
    }
    if (stamps.length > 0 || drift.length > 0 || state.review_drift) {
      const w = writePhaseState(projectRoot, next)
      if (!w.ok) {
        bookkeepingHints.push(`⚠ could not record the post-commit sweep result in phase-state (${w.reason}).`)
      }
    }
  }

  if (approval) {
    const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
    antiReplayPersisted = record.ok
    if (!record.ok) {
      antiReplayError = record.error
      bookkeepingHints.push(
        `⚠ commit landed, but I could not record this approval as used: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
      )
    }
  } else if (tokenCtx) {
    antiReplayPersisted = true
    tokenSummary = {
      plan_slug: reservedToken!.plan_slug,
      actions_used: reservedToken!.actions_used,
      max_actions: reservedToken!.max_actions,
      expires_at: reservedToken!.expires_at,
    }
    const rearmed = rearmToken(reservedToken!, now)
    if (rearmed !== reservedToken!) {
      const w = writePhaseState(projectRoot, {
        ...(readPhaseState(projectRoot).state ?? tokenCtx.baseState),
        plan_authorization: rearmed,
      })
      if (w.ok) {
        tokenSummary.expires_at = rearmed.expires_at
      } else {
        bookkeepingHints.push(
          '⚠ token sliding-window re-arm did not persist — the token keeps its current expiry (fail-safe).',
        )
      }
    }
  } else {
    antiReplayPersisted = true
    freeSummary = {
      plan_slug: reservedFreeBudget!.plan_slug,
      commits_used: reservedFreeBudget!.commits_used,
      files_touched: reservedFreeBudget!.files_touched_paths.length,
      lines_changed: reservedFreeBudget!.lines_changed,
      locked: reservedFreeBudget!.locked,
      ...(reservedFreeBudget!.locked_reason !== undefined && {
        locked_reason: reservedFreeBudget!.locked_reason,
      }),
    }
    const ledger = appendAudit(
      projectRoot,
      {
        event: 'free_commit.committed',
        tool: 'rsct_request_commit',
        channel: 'free_commit',
        plan_slug: reservedFreeBudget!.plan_slug,
        sha_after: commit.sha_after,
      },
      config?.audit,
    )
    if (!ledger.ok && ledger.reason !== 'disabled') {
      bookkeepingHints.push(
        `⚠ the durable free_commit.committed ledger event did not persist (${ledger.error ?? 'write failed'}) — if phase-state is later wiped, the free-commit count could under-count by one.`,
      )
    }
    if (freeNewlyLocked) {
      appendAudit(
        projectRoot,
        {
          event: 'free_commit.locked',
          tool: 'rsct_request_commit',
          plan_slug: reservedFreeBudget!.plan_slug,
          reason: reservedFreeBudget!.locked_reason ?? 'commit_cap',
        },
        config?.audit,
      )
    }
  }

  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_commit.committed',
      tool: 'rsct_request_commit',
      branch: gitState.branch,
      channel,
      authorized_via: authorizedVia,
      sha_before: commit.sha_before,
      sha_after: commit.sha_after,
      fabrication_signals: fabricationSignals,
      ...(tokenSummary !== null && {
        plan_slug: tokenSummary.plan_slug,
        plan_token_actions_used: tokenSummary.actions_used,
        plan_token_max_actions: tokenSummary.max_actions,
      }),
    },
    config?.audit,
  )

  const hints: string[] = [
    `Committed ${commit.sha_after ?? '<unknown sha>'} on '${branchLabel}'.`,
  ]
  if (contractGateInactive) {
    hints.push(
      '⚠ topology is confirmed multi-repo but no readable contracts.json was found (no universe linked or no manifest) — the contract gate did not run. Link the universe / add contracts.json to enable it.',
    )
  }
  if (tokenSummary) {
    const remaining = tokenSummary.max_actions - tokenSummary.actions_used
    hints.push(
      `Authorized by plan token '${tokenSummary.plan_slug}' (${tokenSummary.actions_used}/${tokenSummary.max_actions} used, ${remaining} left, expires ${tokenSummary.expires_at}). No dev_approval needed within scope.`,
    )
  }
  if (freeSummary) {
    const limit = resolveFreeBudgetLimits(config ?? null).maxCommits
    const remaining = Math.max(0, limit - freeSummary.commits_used)
    hints.push(
      freeSummary.locked
        ? `Free commit on '${freeSummary.plan_slug}' — budget is now LOCKED (${freeSummary.locked_reason}). Further commits need a per-action dev_approval or a batch token (rsct_plan_authorize).`
        : `Free (dialog-free) commit on '${freeSummary.plan_slug}' — ${freeSummary.commits_used}/${limit} used, ${remaining} left. No approval needed for trivial/small within budget.`,
    )
  }
  hints.push(...deadAtCommit.hints)
  hints.push(...bookkeepingHints)
  const afields = auditFields(audit)
  if (afields.audit_error !== null) {
    hints.push(
      `⚠ commit landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`,
    )
  }

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

  const activePlan = findActivePlan(projectRoot)
  if (activePlan) {
    hints.push(
      `ℹ Active plan '${activePlan.slug}' — if this commit advances it, update progress_${activePlan.slug}.md (and plan_/spec_${activePlan.slug}.md if the plan itself changed).`,
    )
  }

  return {
    status: sweepDrift.length > 0 ? 'committed_with_drift' : 'committed',
    branch: gitState.branch,
    channel,
    authorized_via: authorizedVia,
    reject_kind: null,
    reason: null,
    fabrication_signals: fabricationSignals,
    sha_before: commit.sha_before,
    sha_after: commit.sha_after,
    branch_check: { protected: branchProtected, override_used: branchProtected },
    secrets_check: {
      findings_count: findings.length,
      findings,
      override_used: findings.length > 0,
    },
    plan_token: tokenSummary,
    free_commit: freeSummary,
    contract_check: contractResult,
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: antiReplayPersisted,
    anti_replay_error: antiReplayError,
    hints: withAdvisories(hints),
  }
}


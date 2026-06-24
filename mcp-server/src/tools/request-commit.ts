import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan, findPlanBySlug } from '../lib/plan.js'
import {
  defaultGitExecutor,
  getStagedDiff,
  getStagedPaths,
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
  type DevApproval,
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
  readPhaseState,
  writePhaseState,
  type BootstrapMarker,
  type PhaseState,
  type PlanAuthorizationBlock,
} from '../lib/phase-scope.js'
import {
  readToken,
  validateToken,
  consumeTokenAction,
  type TokenInvalidReason,
} from '../lib/plan-authorization.js'
import { confirmedTopologyMode } from '../lib/topology.js'
import { resolveUniverseRoot } from '../lib/universe.js'
import {
  readContracts,
  contractsTouchingPaths,
  affectedConsumers,
} from '../lib/contracts.js'

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
      .optional()
      .describe(
        'The dev_approval payload (timestamp, action_scope, reason). OPTIONAL: when present, the per-action §C gate runs (schema/skew/anti-reuse/fabrication). When ABSENT, the commit is authorized by an active plan-scoped batch token (mint one with rsct_plan_authorize) — but the token NEVER bypasses branch protection or the secrets scan (the token path carries no overrides). To avoid the soft `scope_mismatch` fabrication signal, make `action_scope`/`reason` mirror the ACTUAL staged diff.',
      ),
  })
  .strict()

export type RequestCommitInput = z.infer<typeof requestCommitInputSchema>

export type RequestCommitStatus = 'committed' | 'rejected' | 'mutation_failed'

export type RequestCommitRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'secrets'
  | 'contract_surface'
  | 'plan_token_invalid'

/** How the commit was authorized: a per-action dev_approval or a plan token. */
export type CommitAuthVia = 'dev_approval' | 'plan_token'

/** Commit authorization channel — the gate channels plus the T3 plan-token path. */
export type CommitChannel = GateChannel | 'plan_token'

/** T2/INV-7: the contract-surface gate result (multi-repo only). */
export interface ContractCheckResult {
  /** The CONFIRMED topology mode the gate saw (null when unconfirmed). */
  mode: 'mono' | 'monorepo' | 'multi-repo' | null
  /** Contract ids whose produced surface the staged diff touched. */
  touched: string[]
  /** Affected consumer apps (sorted union across touched contracts). */
  consumers: string[]
  override_used: boolean
}

export interface RequestCommitOutput {
  status: RequestCommitStatus
  branch: string | null
  channel: CommitChannel | null
  /** T3: which authorization path was taken (null on reject before auth resolves). */
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
  /** T2/INV-7: contract-surface gate result (omitted on rejects before INV-7 runs). */
  contract_check?: ContractCheckResult | null
  /** T3: plan-token budget after this commit (null when not a token commit). */
  plan_token?: {
    plan_slug: string
    actions_used: number
    max_actions: number
    expires_at: string
  } | null
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
   * On `committed`: post-mutation bookkeeping persisted. For the dev_approval
   * path this is `recordConsumedApproval` writing the anti-reuse entry; for the
   * plan-token path it is the token's `actions_used` increment being persisted.
   * `false` if that write failed. On rejected / mutation_failed: `null`.
   */
  anti_replay_persisted: boolean | null
  /**
   * Set when the post-mutation bookkeeping write failed. Non-null means either
   * the same dev_approval may be replayable, or the token counter is stale
   * (an action was not debited). Repair before the next §C-gated call.
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
   * Test-only seam: substitute the staged diff (`git diff --cached`) so the
   * INV-6 secrets scan can be exercised without a real git repo. NOT an MCP
   * input — the dispatch calls the handler with no `internal`, so a real caller
   * can never use it to bypass the real scan (closes the pre-existing INV-6
   * fabricated-diff hole; A2).
   */
  stagedDiffOverride?: string
  /**
   * Test-only seam: substitute the staged file list (`git diff --cached
   * --name-only`) so the INV-7 contract-surface gate can be exercised without a
   * real git repo. NOT an MCP input (same posture as stagedDiffOverride).
   */
  stagedPathsOverride?: string[]
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
    "§C-gated commit. Authorization is EITHER a per-action dev_approval (validated for schema/skew/anti-reuse/fabrication, with an OS dialog when required) OR — when dev_approval is omitted — an active plan-scoped batch token minted by rsct_plan_authorize (covers commit only; auto-revokes on branch switch / plan completion / expiry / exhaustion). Both paths run INV-5 branch and INV-6 secrets checks; the token path carries NO overrides, so a protected branch or any secret finding still rejects (fall back to a per-action dev_approval with the override). On rejection nothing is consumed — dev can add an override and retry with the same payload. Audit log entry written on every outcome.",
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

  // --- Authorization: per-action dev_approval OR an active plan token (T3) ---
  let channel: CommitChannel
  let authorizedVia: CommitAuthVia
  let approval: DevApproval | null = null
  let fabricationSignals: FabricationSignal[] = []
  let tokenCtx: { token: PlanAuthorizationBlock; baseState: PhaseState } | null = null

  if (input.dev_approval !== undefined) {
    const gate = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: input.dev_approval,
      dialog: {
        title: 'RSCT — commit approval',
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
        hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
      }
    }

    approval = gate.approval
    channel = gate.channel
    authorizedVia = 'dev_approval'
    fabricationSignals = gate.fabrication_signals
  } else {
    // Token path: no dev_approval supplied — try an active plan-scoped token.
    const existing = readPhaseState(projectRoot)
    const token = readToken(existing.state)
    const tokenPlan = token ? findPlanBySlug(projectRoot, token.plan_slug) : null
    const verdict = validateToken(token, {
      now,
      branch: gitState.branch,
      tokenPlan,
      action: 'commit',
    })

    if (!verdict.valid) {
      const reason = planTokenRejectReason(verdict.reason)
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
        hints: [`Approval rejected (plan_token_invalid): ${reason}`],
      }
    }

    channel = 'plan_token'
    authorizedVia = 'plan_token'
    tokenCtx = { token: verdict.token, baseState: existing.state ?? {} }
  }

  // Overrides ONLY come from a per-action dev_approval. The token path leaves
  // both undefined (FV3) → a protected branch / any secret finding rejects.
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
        channel,
      },
      config?.audit,
    )
  }

  // INV-6: scan the staged diff for secrets. `internal.stagedDiffOverride` is a
  // TEST-ONLY seam (not an MCP input — the dispatch passes no `internal`), so a
  // real caller can never substitute a fabricated diff; production ALWAYS scans
  // the real `git diff --cached` on both the dev_approval and plan-token paths.
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
        channel,
      },
      config?.audit,
    )
  }

  // INV-7 (T2): contract-surface gate. Diverges ONLY on a CONFIRMED multi-repo
  // topology (the dev confirmed it at /rsct-setup — an unconfirmed/inferred mode
  // never gates). In multi-repo mode, a commit touching a contract surface THIS
  // app PRODUCES is blocked so the cross-repo blast radius is acknowledged, unless
  // a per-action dev_approval carries override_contract_surface. mono/monorepo, no
  // universe/manifest, or no produced surface touched → no-op (degrade-to-today).
  // The token path carries no overrides → a surface-touching commit under a token
  // is a hard block. Scans the REAL staged set (the override is a test-only seam).
  const overrideContract = approval?.override_contract_surface
  const topoMode = confirmedTopologyMode(config ?? null)
  let contractResult: ContractCheckResult = {
    mode: topoMode,
    touched: [],
    consumers: [],
    override_used: false,
  }
  // RV3: surface a multi-repo commit where the gate could NOT enforce (no universe
  // linked / no readable contracts.json) so the inactive gate isn't silent at commit.
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
          hints: [reason],
        }
      }
      // Override invoked — audit the waiver (parallel to the secrets override).
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

  // Token path (T3 / review FV): RESERVE the action by debiting the counter
  // BEFORE the commit. If the debit can't persist, REFUSE to commit — the bound
  // must be mechanically enforceable, so "can't record the spend" ⇒ "can't
  // spend". (A debit-AFTER-commit ordering would let a persistent phase-state
  // write failure authorize unbounded commits within the TTL window.) On a
  // later commit failure we best-effort refund so a failed commit doesn't waste
  // a slot.
  let reservedToken: PlanAuthorizationBlock | null = null
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
        hints: [reason],
      }
    }
  }

  const commit = gitCommit(projectRoot, input.message, gitExecutor)
  if (!commit.ok) {
    const reason = commit.error ?? commit.stderr ?? 'git commit failed'
    // Token path: the action was reserved (debited) before the commit. The
    // commit didn't land, so best-effort REFUND it — a failed commit shouldn't
    // waste a slot. If the refund write also fails, the action stays spent
    // (fail-safe: tightens the bound, never loosens it).
    let refundNote = ''
    if (tokenCtx) {
      const refund = writePhaseState(projectRoot, {
        ...tokenCtx.baseState,
        plan_authorization: tokenCtx.token,
      })
      refundNote = refund.ok
        ? ' The reserved token action was refunded.'
        : ' ⚠ the reserved token action could NOT be refunded (phase-state write failed) — one action was forfeited (fail-safe).'
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
      contract_check: contractResult,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        authorizedVia === 'plan_token'
          ? `git commit failed — fix the underlying error and retry.${refundNote}`
          : 'git commit failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.',
      ],
    }
  }

  // Commit succeeded — persist post-mutation bookkeeping (anti-reuse for the
  // approval path, or the token counter increment for the token path) and write
  // the outcome audit entry. Both can fail; failures surface as warning hints
  // + non-null `anti_replay_error` / `audit_error`.
  let antiReplayPersisted: boolean
  let antiReplayError: string | null = null
  let tokenSummary: RequestCommitOutput['plan_token'] = null
  const bookkeepingHints: string[] = []

  if (approval) {
    const record = recordApproval(approval, { projectRoot, now })
    antiReplayPersisted = record.ok
    if (!record.ok) {
      antiReplayError = record.error
      bookkeepingHints.push(
        `⚠ commit landed, but I could not record this approval as used: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
      )
    }
  } else {
    // Token path: the action was already debited (reserved) BEFORE the commit
    // (debit-first — see the reserve block above), so nothing to persist here.
    antiReplayPersisted = true
    tokenSummary = {
      plan_slug: reservedToken!.plan_slug,
      actions_used: reservedToken!.actions_used,
      max_actions: reservedToken!.max_actions,
      expires_at: reservedToken!.expires_at,
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
  // RV3: a confirmed multi-repo commit where the gate could not enforce (no
  // universe linked / no readable contracts.json) — say so at commit time, not
  // only in the read tools (the FV1 philosophy: the inactive gate is never silent).
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
  hints.push(...bookkeepingHints)
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
    contract_check: contractResult,
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: antiReplayPersisted,
    anti_replay_error: antiReplayError,
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

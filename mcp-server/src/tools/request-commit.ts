import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import { findActivePlan, findPlanFileBySlug } from '../lib/plan.js'
import {
  defaultGitExecutor,
  getFileAtHead,
  getStagedPaths,
  getTreeDiffPaths,
  gitCommit,
  readCommittedTree,
  readGitState,
  readHeadBirth,
  readStagedTreeState,
  baseTreeOf,
  sameStagedTreeState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import { deriveAuditCeiling } from '../lib/free-commit.js'
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
import { scanTreeDiff } from '../lib/staged-scan.js'
import {
  DevApprovalSchema,
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
  describeRetention,
  previewRetention,
  pruneAuditLog,
  retentionDialogLine,
} from '../lib/audit-retention.js'
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
  refuseUnreadableState,
  writePhaseState,
  type BootstrapMarker,
  type PhaseState,
  type PlanAuthorizationBlock,
} from '../lib/phase-scope.js'
import { describePending, readHomeRunAlone, readRunAlone } from '../lib/run-alone.js'
import { isTokenMintRecorded } from '../lib/plan-token-record.js'
import {
  readToken,
  validateToken,
  consumeTokenAction,
  tokenExpiryMs,
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
import { DIALOG_PATH_LIMIT, commitMessageView, dialogList, specLabel } from '../lib/dialog-text.js'

const STAGED_PATHS_UNREADABLE =
  'git could not list the files this commit carries, so the commit is refused rather than let through unchecked — retry, or the developer commits this by hand in their own terminal'

const STAGED_STATE_UNREADABLE =
  'git could not record what is staged for this commit, so it is refused rather than committed unchecked — retry, or the developer commits this by hand in their own terminal'

const DIALOG_FINDINGS_SHOWN = 10

interface CommitOverrides {
  branch?: { reason: string } | undefined
  secrets?: { reason: string } | undefined
  contract?: { reason: string } | undefined
}

interface ContractFacts {
  mode: ContractCheckResult['mode']
  ids: string[]
  consumers: string[]
  inactive: boolean
}

function readContractFacts(
  projectRoot: string,
  config: RsctConfig | null | undefined,
  readCommitPaths: () => string[] | null,
): ContractFacts | null {
  const mode = confirmedTopologyMode(config ?? null)
  if (mode !== 'multi-repo') return { mode, ids: [], consumers: [], inactive: false }
  let universeRoot: string | null = null
  try {
    const r = resolveUniverseRoot(config ?? null, projectRoot)
    universeRoot = r.kind === 'found' ? r.path : null
  } catch {
    universeRoot = null
  }
  const graph = readContracts(universeRoot)
  const stagedPaths = readCommitPaths()
  if (stagedPaths === null) return null
  const appName = config?.app?.name ?? null
  const hits = appName ? contractsTouchingPaths(graph, appName, stagedPaths) : []
  return { mode, ids: hits.map((h) => h.id), consumers: affectedConsumers(hits), inactive: !graph.available }
}

function findingRule(finding: SecretFinding): string {
  return finding.reason === 'extra-pattern' ? `extra pattern ${finding.pattern_id ?? '?'}` : finding.reason
}

function findingLabel(finding: SecretFinding): string {
  return `"${finding.file}":${finding.line_number ?? '?'} — ${findingRule(finding)}`
}

function writeSecretsReport(projectRoot: string, findings: readonly SecretFinding[]): string | null {
  const lines = ['# Secret scan findings for one commit approval', '', ...findings.map((f) => `- ${findingLabel(f)} — ${f.excerpt}`), '']
  const content = lines.join('\n')
  const rel = join('.rsct', 'reports', `commit-secrets-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.md`)
  try {
    mkdirSync(join(projectRoot, '.rsct', 'reports'), { recursive: true })
    writeFileSync(join(projectRoot, rel), content, 'utf8')
    return rel.replace(/\\/g, '/')
  } catch {
    return null
  }
}

function quoted(text: string): string {
  return `"${specLabel(text)}"`
}

function commitExceptionLines(
  projectRoot: string,
  facts: {
    branchLabel: string
    branchProtected: boolean
    findings: readonly SecretFinding[]
    contract: ContractFacts
    overrides: CommitOverrides
  },
): { facts: string[]; reasons: string[] } {
  const lines: string[] = []
  const reasons: string[] = []
  if (facts.branchProtected) {
    lines.push(`⚠ '${specLabel(facts.branchLabel, DIALOG_PATH_LIMIT)}' is a protected branch: committing here needs your exception.`)
  }
  if (facts.findings.length > 0) {
    lines.push(`⚠ The secrets scan found ${facts.findings.length} line(s) that look like a credential (file:line — rule; values are never shown):`)
    lines.push(dialogList(facts.findings.map(findingLabel), DIALOG_FINDINGS_SHOWN))
    if (facts.findings.length > DIALOG_FINDINGS_SHOWN) {
      const report = writeSecretsReport(projectRoot, facts.findings)
      lines.push(report ? `Full list: ${report}` : 'The full list is in this tool result.')
    }
  }
  if (facts.contract.ids.length > 0) {
    const consumers = facts.contract.consumers.length > 0 ? facts.contract.consumers.map(quoted).join(', ') : 'none listed'
    lines.push(`⚠ This commit changes contract surface ${facts.contract.ids.map(quoted).join(', ')}; declared consumers: ${consumers}.`)
  }
  if (facts.contract.inactive) {
    lines.push('⚠ The contract gate is inactive: no readable contracts.json for this universe, so cross-repo impact is not checked.')
  }
  if (facts.branchProtected && facts.overrides.branch) {
    reasons.push(`Agent's reason for the protected branch: ${quoted(facts.overrides.branch.reason)}`)
  }
  if (facts.findings.length > 0 && facts.overrides.secrets) {
    reasons.push(`Agent's reason for the secret findings: ${quoted(facts.overrides.secrets.reason)}`)
  }
  if (facts.contract.ids.length > 0 && facts.overrides.contract) {
    reasons.push(`Agent's reason for the contract surface: ${quoted(facts.overrides.contract.reason)}`)
  }
  return { facts: lines, reasons }
}

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
  | 'secrets_unreadable'
  | 'staged_paths_unreadable'
  | 'staged_state_unreadable'
  | 'staged_changed'
  | 'contract_surface'
  | 'plan_token_invalid'
  | 'message_too_long'
  | 'review_missing'
  | 'comments_present'
  | 'migration_reverted'
  | 'review_drift'
  | 'review_unreadable'
  | 'dead_code_staged'
  | 'run_alone_pending'

export type CommitAuthVia = 'dev_approval' | 'plan_token'

export type CommitChannel = GateChannel | 'plan_token'

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
  secretsScanTimeoutMs?: number
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
  shippedScriptsDir?: string | null
  retention?: typeof pruneAuditLog
}

function runRetention(
  prune: typeof pruneAuditLog,
  projectRoot: string,
  config: RsctConfig | undefined,
  now: Date,
): string | null {
  try {
    return describeRetention(prune(projectRoot, config?.audit, now))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `Audit log retention (ADR-025): the cut did not run (${detail}); a later commit retries it.`
  }
}

export const requestCommitTool: Tool = {
  name: 'rsct_request_commit',
  description:
    "§C-gated commit. REVIEW gate (every tier, every authorization path, checked before any dialog and again right before git commit): each staged code file must match a version stamped by a completed rsct_phase_review_complete and carry no comment (reject_kind review_missing / comments_present / migration_reverted); a pre-commit hook that slips in unreviewed code returns committed_with_drift and blocks further commits (review_drift) until a REVIEW covers it. Dead-code gate at the same two points (JavaScript/TypeScript): the STAGED bytes of each staged code file are scanned against the whole index — never the working tree — for a declared symbol nothing references, its own file included; one rejects (dead_code_staged) unless a completed REVIEW recorded the developer keeping it, which counts only when its audit line exists and the declaration bytes are unchanged. A hook that adds a dead symbol lands as committed_with_drift. Symbols the scan cannot settle are reported in hints, never passed silently. RUN ALONE: while a run_alone record exists in .rsct/phase-state.json (the developer chose run alone at rsct_phase_code_start), every commit is refused (run_alone_pending) before any dialog and before a batch token is read, until rsct_phase_review_complete approves each phase that closed on its own and the REVIEW itself. Commits with no code file pass both gates untouched, with two exceptions: an armed review_drift lock blocks them too, and an unreadable .rsct/phase-state.json rejects every commit (review_unreadable) until the file is repaired or deleted, because the REVIEW ledger and the drift record live in it. Authorization is EITHER a per-action dev_approval (validated for schema/skew/anti-reuse/fabrication) answered by the developer in a FORCED OS dialog — trust_allowed_for does not apply to commits, and with no dialog channel the commit is refused — OR — when dev_approval is omitted — an active plan-scoped batch token minted by rsct_plan_authorize (covers commit only; auto-revokes on branch switch / plan completion / expiry / exhaustion). Both paths run INV-5 branch and INV-6 secrets checks; the token path carries NO overrides, so a protected branch or any secret finding still rejects (fall back to a per-action dev_approval with the override). These checks and the contract gate run BEFORE the dialog: a check that needs an exception the request does not carry is refused before any dialog opens, and the dialog lists each exception it approves (the protected branch, each secret finding as file:line and rule, never the value, the contract surfaces and their declared consumers) before the agent's reasons and the commit message. The secrets scan reads the staged diff as git will commit it (attributes, diff drivers and repository config cannot hide content); a read that fails refuses (secrets_unreadable / staged_paths_unreadable / staged_state_unreadable). The staged tree, HEAD and branch are checked again right before git commit (staged_changed), and a commit that a git hook changed after the approval returns committed_with_drift with the changed paths, the secret findings in them and how to undo the commit; the code files among them are locked by review_drift as above. On rejection nothing is consumed — dev can add an override and retry with the same payload. Audit log entry written on every outcome. RETENTION: about once a day, a commit that LANDED also removes audit-log lines older than 10 days, from the top of the file down — a refused or unapproved call removes nothing. Kept whatever their age: the entries a gate can still use, the entries named as an override, skip, degraded check or bypass, and the newest of each repeating state record. The hints report every cut and an audit.pruned entry records it. The approval dialog forecasts the cut only when it reaches entries older than 20 days; a commit under a plan token shows no dialog and so no forecast.",
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
      return "the plan token's plan_<slug>.md file no longer exists — re-authorize with rsct_plan_authorize"
    case 'plan_complete':
      return "the plan token's plan is marked complete — re-authorize if work continues"
    case 'exhausted':
      return 'the plan token reached its max_actions budget — mint a fresh token with rsct_plan_authorize'
    case 'unrecorded':
      return 'the audit log holds no plan_authorize.authorized line for this plan token, so it was not minted by an approved rsct_plan_authorize — commit with a per-action dev_approval, or ask the developer to authorize again'
  }
}

function sameToken(a: PlanAuthorizationBlock | null, b: PlanAuthorizationBlock): boolean {
  return (
    a !== null &&
    a.plan_slug === b.plan_slug &&
    a.branch === b.branch &&
    a.authorized_at === b.authorized_at &&
    a.actions_used === b.actions_used
  )
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

  const rejectWith = (
    reject_kind: RequestCommitRejectKind,
    reason: string,
    context: {
      via: CommitAuthVia | null
      channel: CommitChannel | null
      signals: FabricationSignal[]
      auditExtra?: Record<string, unknown>
      shape?: Partial<Pick<RequestCommitOutput, 'branch_check' | 'secrets_check' | 'contract_check'>>
    },
  ): RequestCommitOutput => {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind,
        reason,
        branch: gitState.branch,
        ...(context.via !== null && { channel: context.channel, authorized_via: context.via }),
        ...context.auditExtra,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: context.channel,
      authorized_via: context.via,
      reject_kind,
      reason,
      fabrication_signals: context.signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      ...context.shape,
      plan_token: null,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }
  const earlyReject = (reject_kind: RequestCommitRejectKind, reason: string): RequestCommitOutput => {
    return rejectWith(reject_kind, reason, { via: null, channel: null, signals: [] })
  }

  if (resolution.rsct_installed) {
    const stagedForDrift = internal.stagedPathsOverride ?? getStagedPaths(projectRoot)
    if (stagedForDrift === null) return earlyReject('staged_paths_unreadable', STAGED_PATHS_UNREADABLE)
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

  const runAlone = readRunAlone(readPhaseState(projectRoot).state) ?? readHomeRunAlone(projectRoot)?.block ?? null
  if (runAlone !== null) {
    const reason =
      `a task run alone (spec '${runAlone.spec_slug}') is not approved yet${runAlone.pending.length > 0 ? ` — waiting for the developer: ${describePending(runAlone.pending)}` : ''}. Its REVIEW must be approved first: call rsct_phase_review_complete when the developer is back. No commit was made and no dialog was shown.`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_commit.rejected',
        tool: 'rsct_request_commit',
        reject_kind: 'run_alone_pending',
        reason,
        branch: gitState.branch,
        run_alone_pending: runAlone.pending.map((p) => p.phase),
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch: gitState.branch,
      channel: null,
      authorized_via: null,
      reject_kind: 'run_alone_pending',
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
      hints: withAdvisories([reason]),
    }
  }

  const runSweepCheck = async (): Promise<StagedSweepCheck> => {
    const read = readPhaseState(projectRoot)
    const refusal = refuseUnreadableState(projectRoot, read)
    if (refusal && !refusal.ok && refusal.reason === 'unreadable_state') {
      return { ok: false, reject_kind: 'review_unreadable', reason: `${refusal.error} No commit was made.`, paths: [] }
    }
    const sweepState = read.state
    const ceiling = deriveAuditCeiling(projectRoot, config ?? null)
    return checkStagedSweep({
      projectRoot,
      options: { sqlDialect: config?.sql_dialect, shippedScriptsDir: internal.shippedScriptsDir },
      ledger: sweepState?.review_sweep,
      drift: sweepState?.review_drift,
      unverifiedDecisions: ceiling.unverifiedDecisions,
      legacyBaselineDecisions: ceiling.legacyBaselineDecisions,
      headUnborn: ceiling.legacyBaselineDecisions.size > 0 && readHeadBirth(projectRoot).status === 'unborn',
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
  const runDeadCodeCheck = async (
    entries: ReadonlyArray<{ path: string; unverified: boolean }>,
  ): Promise<StagedDeadCodeCheck> => {
    const paths = entries.map((entry) => entry.path)
    const ceiling = deriveAuditCeiling(projectRoot, config ?? null)
    try {
      return await checkStagedDeadCode({
        projectRoot,
        stagedPaths: paths,
        publicApi: config?.public_api,
        keeps: readDeadCodeKeeps(readPhaseState(projectRoot).state?.dead_code_keeps),
        keepDecisions: ceiling.deadCodeKeepDecisions,
        publicApiApprovals: ceiling.publicApiApprovals,
        exempt: entries.filter((entry) => entry.unverified).map((entry) => entry.path),
      })
    } catch (error) {
      const reason = `the dead-code check failed: ${error instanceof Error ? error.message : String(error)}`
      return { ok: false, reject_kind: 'dead_code_staged', reason, hints: [reason], paths }
    }
  }
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
  const deadBefore = await runDeadCodeCheck(sweepBefore.checked)
  if (!deadBefore.ok) return rejectDeadCode(deadBefore, 'before_authorization')

  const approvedState = await readStagedTreeState(projectRoot)
  const baseTree = approvedState?.tree ? baseTreeOf(projectRoot, approvedState.head) : null
  if (approvedState === null || (approvedState.tree !== null && baseTree === null)) {
    return earlyReject('staged_state_unreadable', STAGED_STATE_UNREADABLE)
  }
  const { list: protectedList } = effectiveProtectedList(config)
  const branchProtected = isProtectedBranch(gitState.branch, protectedList)
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
  const scan =
    internal.stagedDiffOverride !== undefined
      ? { ok: true as const, findings: scanDiffForSecrets(internal.stagedDiffOverride, extras) }
      : approvedState.tree === null || baseTree === null
        ? { ok: true as const, findings: [] }
        : await scanTreeDiff(projectRoot, baseTree, approvedState.tree, extras, internal.secretsScanTimeoutMs)
  if (!scan.ok) {
    return earlyReject(
      'secrets_unreadable',
      `the secrets scan could not read what this commit carries (${scan.reason}), so it is refused rather than let through unscanned — split the commit, or the developer commits this by hand in their own terminal`,
    )
  }
  const findings = scan.findings
  const contractFacts = readContractFacts(
    projectRoot,
    config,
    () =>
      internal.stagedPathsOverride ??
      (approvedState.tree === null || baseTree === null ? [] : getTreeDiffPaths(projectRoot, baseTree, approvedState.tree)),
  )
  if (contractFacts === null) return earlyReject('staged_paths_unreadable', STAGED_PATHS_UNREADABLE)

  const uncovered = (
    overrides: CommitOverrides,
    via: CommitAuthVia | null,
    ch: CommitChannel | null,
    signals: FabricationSignal[],
  ): RequestCommitOutput | null => {
    const tokenPath = via === 'plan_token'
    const refuse = (
      reject_kind: RequestCommitRejectKind,
      reason: string,
      auditExtra: Record<string, unknown>,
      shape: Pick<RequestCommitOutput, 'branch_check' | 'secrets_check'> & Partial<Pick<RequestCommitOutput, 'contract_check'>>,
    ): RequestCommitOutput => rejectWith(reject_kind, reason, { via, channel: ch, signals, auditExtra, shape })
    if (branchProtected && !overrides.branch) {
      return refuse(
        'protected_branch',
        `branch '${branchLabel}' is protected — ${
          tokenPath
            ? 'a plan authorization never covers protected branches; commit with a per-action dev_approval that includes override_protected_branch: { reason }'
            : 'pass dev_approval.override_protected_branch: { reason } to proceed'
        }`,
        {},
        { branch_check: { protected: true, override_used: false }, secrets_check: { findings_count: 0, findings: [], override_used: false } },
      )
    }
    if (findings.length > 0 && !overrides.secrets) {
      return refuse(
        'secrets',
        `${findings.length} secret finding(s) in staged diff — ${
          tokenPath
            ? 'a plan authorization never bypasses the secrets scan; commit with a per-action dev_approval that includes override_secrets_check: { reason }'
            : 'pass dev_approval.override_secrets_check: { reason } to proceed'
        }`,
        { findings_count: findings.length },
        {
          branch_check: { protected: branchProtected, override_used: branchProtected },
          secrets_check: { findings_count: findings.length, findings, override_used: false },
        },
      )
    }
    if (contractFacts.ids.length > 0 && !overrides.contract) {
      return refuse(
        'contract_surface',
        `this commit changes contract surface(s) [${contractFacts.ids.join(', ')}] that other repos depend on [${
          contractFacts.consumers.join(', ') || 'none listed'
        }]. This repo OWNS (produces) those surfaces, so the gate stops the commit here to flag the cross-repo impact. ${
          tokenPath
            ? 'A plan authorization never bypasses the contract gate; commit with a per-action dev_approval that includes override_contract_surface: { reason }.'
            : 'To proceed, pass dev_approval.override_contract_surface: { reason } (acknowledging the impact on the consumers listed above).'
        }`,
        { contracts: contractFacts.ids, consumers: contractFacts.consumers },
        {
          branch_check: { protected: branchProtected, override_used: branchProtected },
          secrets_check: { findings_count: findings.length, findings, override_used: findings.length > 0 },
          contract_check: { mode: 'multi-repo', touched: contractFacts.ids, consumers: contractFacts.consumers, override_used: false },
        },
      )
    }
    return null
  }

  let channel: CommitChannel
  let authorizedVia: CommitAuthVia
  let approval: DevApproval | null = null
  let fabricationSignals: FabricationSignal[] = []
  let tokenCtx: { token: PlanAuthorizationBlock } | null = null

  if (input.dev_approval !== undefined) {
    const raw = DevApprovalSchema.safeParse(input.dev_approval)
    const rawOverrides: CommitOverrides = raw.success
      ? { branch: raw.data.override_protected_branch, secrets: raw.data.override_secrets_check, contract: raw.data.override_contract_surface }
      : {}
    if (raw.success) {
      const early = uncovered(rawOverrides, null, null, [])
      if (early) return early
    }
    const retentionLine = resolution.rsct_installed
      ? retentionDialogLine(previewRetention(projectRoot, config?.audit, now))
      : null
    const exceptions = commitExceptionLines(projectRoot, {
      branchLabel,
      branchProtected,
      findings,
      contract: contractFacts,
      overrides: rawOverrides,
    })
    const gate = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: input.dev_approval,
      forceDialog: true,
      forceDialogReason: 'every commit needs the developer in the OS dialog, or a batch token they approved in one (rsct_plan_authorize); with no dialog channel, the developer commits by hand in their own terminal',
      dialog: {
        title: 'RSCT — commit approval',
        message:
          [
            `Approve commit on '${specLabel(branchLabel, DIALOG_PATH_LIMIT)}'?`,
            ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
            ...(retentionLine ? [retentionLine] : []),
            ...exceptions.facts,
          ].join('\n') +
          gateDialogFooter(projectRoot, config) +
          (exceptions.reasons.length > 0 ? `\n\n${exceptions.reasons.join('\n')}` : '') +
          `\n\nCommit message:\n${commitMessageView(input.message)}`,
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
    const token = readToken(existing.state)
    const tokenPlan = token ? findPlanFileBySlug(projectRoot, token.plan_slug) : null
    const verdict = validateToken(token, {
      now,
      branch: gitState.branch,
      tokenPlan,
      action: 'commit',
      mintRecorded: token !== null && isTokenMintRecorded(projectRoot, config?.audit, token),
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
        hints: withAdvisories([
          `Approval rejected (plan_token_invalid): ${reason}`,
        ]),
      }
    }

    channel = 'plan_token'
    authorizedVia = 'plan_token'
    tokenCtx = { token: verdict.token }
  }

  const overrides: CommitOverrides = {
    branch: approval?.override_protected_branch,
    secrets: approval?.override_secrets_check,
    contract: approval?.override_contract_surface,
  }
  const late = uncovered(overrides, authorizedVia, channel, fabricationSignals)
  if (late) return late

  if (branchProtected && overrides.branch) {
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.override_invoked',
        tool: 'rsct_request_commit',
        override_kind: 'protected_branch',
        override_reason: overrides.branch.reason,
        branch: gitState.branch,
        channel,
      },
      config?.audit,
    )
  }

  if (findings.length > 0 && overrides.secrets) {
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.override_invoked',
        tool: 'rsct_request_commit',
        override_kind: 'secrets_check',
        override_reason: overrides.secrets.reason,
        findings_count: findings.length,
        branch: gitState.branch,
        channel,
      },
      config?.audit,
    )
  }

  const contractResult: ContractCheckResult =
    contractFacts.ids.length > 0
      ? { mode: 'multi-repo', touched: contractFacts.ids, consumers: contractFacts.consumers, override_used: !!overrides.contract }
      : { mode: contractFacts.mode, touched: [], consumers: [], override_used: false }
  const contractGateInactive = contractFacts.inactive
  if (contractFacts.ids.length > 0 && overrides.contract) {
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.override_invoked',
        tool: 'rsct_request_commit',
        override_kind: 'contract_surface',
        override_reason: overrides.contract.reason,
        contracts: contractFacts.ids,
        consumers: contractFacts.consumers,
        branch: gitState.branch,
        channel,
      },
      config?.audit,
    )
  }

  const sweepAtCommit = await runSweepCheck()
  if (!sweepAtCommit.ok) return rejectSweep(sweepAtCommit, 'before_commit')
  const deadAtCommit = await runDeadCodeCheck(sweepAtCommit.checked)
  if (!deadAtCommit.ok) return rejectDeadCode(deadAtCommit, 'before_commit')

  const stateNow = await readStagedTreeState(projectRoot)
  if (stateNow === null || !sameStagedTreeState(approvedState, stateNow)) {
    return rejectWith(
      stateNow === null ? 'staged_state_unreadable' : 'staged_changed',
      stateNow === null
        ? STAGED_STATE_UNREADABLE
        : 'what is staged, HEAD or the branch changed after the approval was asked for, so the developer did not see what would be committed — ask again',
      {
        via: authorizedVia,
        channel,
        signals: fabricationSignals,
        shape: {
          branch_check: { protected: branchProtected, override_used: branchProtected },
          secrets_check: { findings_count: findings.length, findings, override_used: findings.length > 0 },
          contract_check: contractResult,
        },
      },
    )
  }

  let reservedToken: PlanAuthorizationBlock | null = null
  if (tokenCtx) {
    reservedToken = consumeTokenAction(tokenCtx.token)
    const fresh = readPhaseState(projectRoot)
    const unchanged = fresh.parse_error === undefined && sameToken(readToken(fresh.state), tokenCtx.token)
    const reserve = unchanged
      ? writePhaseState(projectRoot, {
          ...fresh.state!,
          plan_authorization: reservedToken,
        })
      : null
    if (reserve === null || !reserve.ok) {
      const detail =
        reserve === null
          ? fresh.parse_error !== undefined
            ? 'phase-state.json could not be read while this commit was being checked'
            : 'the plan token changed while this commit was being checked (revoked, used or re-minted)'
          : reserve.reason === 'locked'
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
  }

  const commit = gitCommit(projectRoot, input.message, gitExecutor)
  if (!commit.ok) {
    const reason = commit.error ?? commit.stderr ?? 'git commit failed'
    let refundNote = ''
    if (tokenCtx) {
      const fresh = readPhaseState(projectRoot)
      const stillReserved = fresh.parse_error === undefined && sameToken(readToken(fresh.state), reservedToken!)
      const refund = stillReserved
        ? writePhaseState(projectRoot, {
            ...fresh.state!,
            plan_authorization: tokenCtx.token,
          })
        : null
      refundNote =
        refund === null
          ? fresh.parse_error !== undefined
            ? ' phase-state.json could not be read after the commit failed; nothing was refunded.'
            : ' The plan token changed during the commit (revoked or re-minted); nothing was refunded.'
          : refund.ok
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
      hints: withAdvisories([
        authorizedVia === 'plan_token'
          ? `git commit failed — fix the underlying error and retry.${refundNote}`
          : 'git commit failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.',
      ]),
    }
  }

  let antiReplayPersisted: boolean
  let antiReplayError: string | null = null
  let tokenSummary: RequestCommitOutput['plan_token'] = null
  const bookkeepingHints: string[] = []

  const treeDrift = async (cleanRewrites: ReadonlySet<string>): Promise<{ paths: string[]; secrets: number; unverified: boolean }> => {
    if (!commit.sha_after || approvedState.tree === null) return { paths: [], secrets: 0, unverified: false }
    const landed = readCommittedTree(projectRoot, commit.sha_after)
    if (landed === null) return { paths: [], secrets: 0, unverified: true }
    if (landed.tree === approvedState.tree && landed.parent === approvedState.head) return { paths: [], secrets: 0, unverified: false }
    const changed = getTreeDiffPaths(projectRoot, approvedState.tree, landed.tree)
    if (changed === null) return { paths: [], secrets: 0, unverified: true }
    const scanned = await scanTreeDiff(projectRoot, approvedState.tree, landed.tree, extras)
    if (!scanned.ok) return { paths: changed, secrets: 0, unverified: true }
    const withSecrets = new Set(scanned.findings.map((f) => f.file))
    const parentMoved = landed.parent !== approvedState.head
    return {
      paths: changed.filter((path) => parentMoved || withSecrets.has(path) || !cleanRewrites.has(path)),
      secrets: scanned.findings.length,
      unverified: false,
    }
  }
  const reportTreeDrift = (drift: { paths: string[]; secrets: number; unverified: boolean }): void => {
    if (drift.paths.length === 0 && !drift.unverified) return
    appendAudit(
      projectRoot,
      {
        event: 'request_commit.tree_drift',
        tool: 'rsct_request_commit',
        paths: drift.paths,
        secret_findings: drift.secrets,
        unverified: drift.unverified,
        sha_after: commit.sha_after,
      },
      config?.audit,
    )
    bookkeepingHints.push(
      drift.unverified
        ? `⚠ git committed, but RSCT could not compare the commit with what the developer approved${drift.paths.length > 0 ? ` (${drift.paths.join(', ')})` : ''} — check it before any push.`
        : `⚠ the commit is not exactly what the developer approved: ${drift.paths.join(', ')} changed after the approval${drift.secrets > 0 ? `, with ${drift.secrets} secret finding(s)` : ''} — most likely a git hook. Check them before any push; \`git reset --soft HEAD~1\` undoes this commit and keeps everything staged.`,
    )
  }

  let sweepDrift: string[] = []
  let cleanRewritePaths: ReadonlySet<string> = new Set()
  if (commit.sha_after && sweepAtCommit.skipped === null) {
    const committed = await verifyCommittedSweep({
      projectRoot,
      options: { sqlDialect: config?.sql_dialect, shippedScriptsDir: internal.shippedScriptsDir },
      before: commit.sha_before,
      after: commit.sha_after,
      checked: sweepAtCommit.checked,
    })
    const unverifiedAtCommit = new Set(sweepAtCommit.checked.filter((c) => c.unverified).map((c) => c.path))
    const deadAfterHook =
      committed.rewrites.length > 0
        ? await runDeadCodeCheck(committed.rewrites.map((r) => ({ path: r.path, unverified: unverifiedAtCommit.has(r.path) })))
        : null
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
    cleanRewritePaths = new Set(cleanRewrites.map((r) => r.path))
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
  const tree = await treeDrift(cleanRewritePaths)
  reportTreeDrift(tree)

  if (approval) {
    const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
    antiReplayPersisted = record.ok
    if (!record.ok) {
      antiReplayError = record.error
      bookkeepingHints.push(
        `⚠ commit landed, but I could not record this approval as used: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') could be accepted again by mistake for a short time — use a fresh approval next time, or repair .rsct/approvals-seen.json.`,
      )
    }
  } else {
    antiReplayPersisted = true
    const expiryMs = tokenExpiryMs(reservedToken!, now)
    tokenSummary = {
      plan_slug: reservedToken!.plan_slug,
      actions_used: reservedToken!.actions_used,
      max_actions: reservedToken!.max_actions,
      expires_at: new Date(expiryMs!).toISOString(),
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
  hints.push(...deadAtCommit.hints)
  hints.push(...bookkeepingHints)
  const retentionHint = resolution.rsct_installed
    ? runRetention(internal.retention ?? pruneAuditLog, projectRoot, config, now)
    : null
  if (retentionHint) hints.push(retentionHint)
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
    status: sweepDrift.length > 0 || tree.paths.length > 0 ? 'committed_with_drift' : 'committed',
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
    hints: withAdvisories(hints),
  }
}


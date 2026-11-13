import { z } from 'zod/v3'
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
  branchRef,
  readGitState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
} from '../lib/branch-protection.js'
import {
  DevApprovalSchema,
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
import { agentReasonLine, protectedBranchLine, secretFindingLines } from '../lib/gate-exceptions.js'
import { baselineEntry, checkGitPrograms, programsDialogLines, programsStillSame } from '../lib/git-programs.js'
import {
  ackDialogLines,
  driftRefusal,
  mergeMessage,
  readDriftLock,
  readHeadPosition,
  rescanLanded,
  resolvePinned,
  sameHeadPosition,
} from '../lib/integration-gate.js'
import { scanCommits } from '../lib/staged-scan.js'
import { compileExtraPatterns, type SecretFinding } from '../lib/secrets.js'

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
  | 'review_drift'
  | 'review_unreadable'
  | 'source_unreadable'
  | 'source_moved'
  | 'secrets'
  | 'secrets_unreadable'
  | 'target_moved'
  | 'programs_unreadable'
  | 'programs_moved'

export interface RequestMergeOutput {
  status: RequestMergeStatus
  source_branch: string
  source_sha: string | null
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
  secrets_check: {
    commits_scanned: number | null
    findings_count: number
    findings: SecretFinding[]
    override_used: boolean
    after_merge: SecretFinding[]
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
  commitScanner?: typeof scanCommits
  secretsScanTimeoutMs?: number
}

export const requestMergeTool: Tool = {
  name: 'rsct_request_merge',
  description:
    "§C-gated merge of `source_branch` into the current branch (default --no-ff). Before any dialog: pre_merge_ack is checked; HEAD must be on a branch with a commit (detached_head otherwise) and differ from the source; an armed review_drift lock refuses, as it refuses every commit; a protected target, and --allow-unrelated-histories on any target (force-like), need dev_approval.override_protected_branch; the source is pinned to its commit; and every commit the merge brings is scanned for secrets (each commit's own diff, merge commits included), so a finding needs dev_approval.override_secrets_check. The forced OS dialog then lists the pinned source commit, the protected branch and unrelated histories, each secret finding as file:line, rule and commit (never the value) and the pre_merge_ack answers, and after the framework footer the agent's reasons and ack note. A source that moved after the dialog refuses (source_moved). The merge runs on the pinned commit (with the usual merge message), and HEAD must still be on the branch and commit it was on at the dialog (target_moved otherwise). After the merge, the merge commit it wrote, if any, is scanned (the source's commits were scanned before the dialog, at the pinned commit); a finding the dialog did not show arms review_drift with its paths, so commits, merges, rebases and pushes are refused until a REVIEW covers them. This is the LOCAL merge-commit path; GitHub PR merges are equivalent for cleanup purposes. On a successful merge whose plan is complete, the hints suggest deleting the merged working branch + plan_/progress_/spec_ files (never automated).",
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
        description: 'dev_approval payload. override_protected_branch and override_secrets_check are listed in the dialog with their reasons.',
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

  let pinned: string | null = null
  let findings: SecretFinding[] = []
  let commitsScanned: number | null = null
  const secretsCheck = (overrideUsed: boolean, afterMerge: SecretFinding[] = []): RequestMergeOutput['secrets_check'] => ({
    commits_scanned: commitsScanned,
    findings_count: findings.length,
    findings,
    override_used: overrideUsed,
    after_merge: afterMerge,
  })
  const reject = (
    kind: RequestMergeRejectKind,
    reason: string,
    opts: { protected?: boolean; channel?: GateChannel | null; signals?: FabricationSignal[]; audit?: Record<string, unknown>; hints?: string[]; target?: string | null; shaBefore?: string | null } = {},
  ): RequestMergeOutput => {
    const audit = appendAudit(
      projectRoot,
      { event: 'request_merge.rejected', tool: 'rsct_request_merge', reject_kind: kind, reason, source_branch: input.source_branch, target_branch: targetBranch, ...opts.audit },
      config?.audit,
    )
    return {
      status: 'rejected',
      source_branch: input.source_branch,
      source_sha: pinned,
      target_branch: opts.target === undefined ? targetBranch : opts.target,
      channel: opts.channel ?? null,
      reject_kind: kind,
      reason,
      fabrication_signals: opts.signals ?? [],
      sha_before: opts.shaBefore === undefined ? gitState.head_sha : opts.shaBefore,
      sha_after: null,
      branch_check: { protected: opts.protected ?? false, override_used: false },
      secrets_check: secretsCheck(false),
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories(opts.hints ?? [reason]),
    }
  }

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
    return reject('hygiene_range_unreadable', crossCheckBlockedReason(range, 'merge'), { audit: { path_crosscheck: crossCheck } })
  }
  if (!ackDecision.ok) {
    return reject(ackDecision.kind, preMergeAckHint(ackDecision), {
      audit: {
        pre_merge_ack: input.pre_merge_ack ?? null,
        pre_merge_ack_self_attested: PRE_MERGE_ACK_ITEMS,
        path_crosscheck: crossCheck,
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
        ...(ackDecision.kind === 'pre_merge_ack_incomplete' &&
          ackDecision.unswept !== undefined && { files_unswept: ackDecision.unswept }),
      },
    })
  }

  if (targetBranch === null || gitState.head_sha === null) {
    return reject('detached_head', 'cannot merge onto a HEAD that is not on a branch with a commit — checkout the target branch first. No dialog was shown.', { target: null, shaBefore: null })
  }
  if (input.source_branch === targetBranch) {
    return reject('same_branch', `cannot merge '${input.source_branch}' into itself. No dialog was shown.`)
  }

  const drift = readDriftLock(projectRoot)
  if (drift.status === 'unreadable') return reject('review_unreadable', `${drift.error} Nothing was merged and no dialog was shown.`)
  if (drift.status === 'armed') {
    return reject('review_drift', driftRefusal(drift.paths, 'every merge'), { audit: { drift_paths: drift.paths } })
  }

  const { list: protectedList } = effectiveProtectedList(config)
  const targetProtected = isProtectedBranch(targetBranch, protectedList)
  const raw = DevApprovalSchema.safeParse(input.dev_approval)
  const rawOverrides = raw.success ? { branch: raw.data.override_protected_branch, secrets: raw.data.override_secrets_check } : {}
  if (raw.success && allow_unrelated_histories && !rawOverrides.branch) {
    return reject('unrelated_histories_without_override', '--allow-unrelated-histories is force-like and requires dev_approval.override_protected_branch: { reason }. No dialog was shown.')
  }
  if (raw.success && targetProtected && !rawOverrides.branch) {
    return reject('protected_branch', `target branch '${targetLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to merge. No dialog was shown.`, { protected: true })
  }

  pinned = resolvePinned(projectRoot, input.source_branch, gitExecutor)
  const headAt = readHeadPosition(projectRoot, gitExecutor)
  if (headAt.ref !== branchRef(targetBranch)) {
    return reject('target_moved', `HEAD is no longer on '${specLabel(targetLabel, DIALOG_PATH_LIMIT)}', the branch the checks read — nothing was merged and no dialog was shown; ask again.`, { protected: targetProtected })
  }
  const head = headAt.sha
  if (pinned === null || head === null) {
    return reject('source_unreadable', `git could not resolve '${specLabel(input.source_branch, DIALOG_PATH_LIMIT)}'${head === null ? ' or HEAD' : ''} to a commit, so what the merge brings cannot be shown — nothing was merged.`, { protected: targetProtected })
  }
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
  const scanner = internal.commitScanner ?? scanCommits
  const before = await scanner(projectRoot, { tips: [pinned], exclude: [head] }, extras, internal.secretsScanTimeoutMs, gitExecutor)
  if (!before.ok) {
    return reject('secrets_unreadable', `the secrets scan could not read the commits this merge brings (${before.reason}), so it is refused rather than merged unscanned — the developer merges this by hand in their own terminal`, { protected: targetProtected })
  }
  findings = before.findings
  commitsScanned = before.commits
  if (raw.success && findings.length > 0 && !rawOverrides.secrets) {
    return reject('secrets', `${findings.length} secret finding(s) in the commits this merge brings — pass dev_approval.override_secrets_check: { reason } to merge. No dialog was shown.`, {
      protected: targetProtected,
      audit: { findings_count: findings.length },
    })
  }

  const programs = checkGitPrograms(projectRoot, gitExecutor, config?.audit)
  if (!programs.ok) {
    return reject('programs_unreadable', `${programs.reason}, so the hooks and programs git would run inside this merge cannot be listed — nothing was merged and no dialog was shown.`, { protected: targetProtected })
  }

  const ack = ackDialogLines(input.pre_merge_ack)
  const facts = [
    `Approve merge of '${specLabel(input.source_branch, DIALOG_PATH_LIMIT)}' into '${specLabel(targetLabel, DIALOG_PATH_LIMIT)}'${no_ff ? ' (--no-ff)' : ''}${allow_unrelated_histories ? ' (--allow-unrelated-histories)' : ''}?`,
    ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
    `Source commit: ${pinned.slice(0, 12)}`,
    ...(targetProtected ? [protectedBranchLine(targetLabel, 'merging into it')] : []),
    ...(allow_unrelated_histories ? ['⚠ --allow-unrelated-histories joins two histories with no common commit; it needs your exception.'] : []),
    ...(findings.length === 0 ? [`Secrets scan: ${commitsScanned} commit(s) read, nothing found.`] : []),
    ...secretFindingLines(projectRoot, 'merge', findings),
    ...programsDialogLines(projectRoot, 'merge', 'merge', programs.read, programs.fresh),
    ...ack.facts,
  ]
  const reasons = [
    ...agentReasonLine(allow_unrelated_histories && !targetProtected ? 'the unrelated histories' : 'the protected branch', targetProtected || allow_unrelated_histories ? rawOverrides.branch : undefined),
    ...agentReasonLine('the secret findings', findings.length > 0 ? rawOverrides.secrets : undefined),
    ...ack.note,
  ]

  const gate = await gateRequest({
    toolName: 'rsct_request_merge',
    approval: input.dev_approval,
    forceDialog: true,
    forceDialogReason: 'a merge needs the developer in the OS dialog; a batch token covers commit only; with no dialog channel, the developer runs it by hand in their own terminal',
    dialog: {
      title: 'RSCT — merge approval',
      message: facts.join('\n') + gateDialogFooter(projectRoot, config) + (reasons.length > 0 ? `\n\n${reasons.join('\n')}` : ''),
    },
    projectRoot,
    ...(config?.approval_modes !== undefined && { approvalModes: config.approval_modes }),
    auditConfig: config?.audit,
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    return reject(gate.reject_kind, gate.reason, {
      signals: gate.fabrication_signals,
      audit: { fabrication_signals: gate.fabrication_signals },
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    })
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch
  const after = { channel: gate.channel, signals: gate.fabrication_signals, audit: { channel: gate.channel } }
  if (allow_unrelated_histories && !overrideBranch) {
    return reject('unrelated_histories_without_override', '--allow-unrelated-histories is force-like and requires dev_approval.override_protected_branch: { reason }', after)
  }
  if (targetProtected && !overrideBranch) {
    return reject('protected_branch', `target branch '${targetLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to merge`, { ...after, protected: true })
  }
  if (findings.length > 0 && !approval.override_secrets_check) {
    return reject('secrets', `${findings.length} secret finding(s) in the commits this merge brings — pass dev_approval.override_secrets_check: { reason } to merge`, { ...after, protected: targetProtected })
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
  if (findings.length > 0 && approval.override_secrets_check) {
    appendAudit(
      projectRoot,
      {
        event: 'request_merge.override_invoked',
        tool: 'rsct_request_merge',
        override_kind: 'secrets_check',
        override_reason: approval.override_secrets_check.reason,
        findings_count: findings.length,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  const moved = resolvePinned(projectRoot, input.source_branch, gitExecutor)
  if (moved !== pinned) {
    return reject('source_moved', `'${specLabel(input.source_branch, DIALOG_PATH_LIMIT)}' moved after the dialog (${pinned.slice(0, 12)} → ${moved?.slice(0, 12) ?? 'gone'}), so the merge would not be the one approved — ask again. The approval was not used.`, {
      ...after,
      protected: targetProtected,
    })
  }
  if (!sameHeadPosition(headAt, readHeadPosition(projectRoot, gitExecutor))) {
    return reject('target_moved', `HEAD moved to another branch or commit after the dialog, so the merge would not land where the developer approved — ask again. The approval was not used.`, {
      ...after,
      protected: targetProtected,
    })
  }

  const programsNow = programsStillSame(programs, projectRoot, gitExecutor)
  if (!programsNow.ok) return reject(programsNow.kind, `${programsNow.reason}. The approval was not used.`, { ...after, protected: targetProtected })
  appendAudit(projectRoot, baselineEntry(programs.read, programs.baseline), config?.audit)

  const branchCheck = { protected: targetProtected, override_used: targetProtected || allow_unrelated_histories }
  const merge = gitMerge(projectRoot, pinned, { no_ff, allow_unrelated_histories, message: mergeMessage(input.source_branch, targetBranch) }, gitExecutor)
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
      source_sha: pinned,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: merge.sha_before,
      sha_after: null,
      branch_check: branchCheck,
      secrets_check: secretsCheck(findings.length > 0),
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories(['git merge failed — approval NOT consumed. Resolve conflicts or fix the error, then retry with the same dev_approval.']),
    }
  }

  const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
  const hints: string[] = [
    `Merged '${input.source_branch}' into '${targetLabel}' (${merge.sha_after ?? '<unknown sha>'}).`,
  ]
  const landed = merge.sha_after ?? 'HEAD'
  const rescan = await rescanLanded({
    projectRoot,
    what: 'merge',
    sha: landed,
    range: { tips: [landed], exclude: [head, pinned] },
    approved: findings,
    extras,
    timeoutMs: internal.secretsScanTimeoutMs,
    executor: gitExecutor,
    scanner,
    now,
  })
  const afterMerge = rescan.findings
  if (rescan.hint !== null) hints.push(rescan.hint)
  if (rescan.audit !== null) appendAudit(projectRoot, { event: `request_merge.${rescan.audit.event}`, tool: 'rsct_request_merge', ...rescan.audit.fields }, config?.audit)

  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_merge.merged',
      tool: 'rsct_request_merge',
      source_branch: input.source_branch,
      source_sha: pinned,
      target_branch: targetBranch,
      channel: gate.channel,
      sha_before: merge.sha_before,
      sha_after: merge.sha_after,
      no_ff,
      allow_unrelated_histories,
      fabrication_signals: gate.fabrication_signals,
      path_crosscheck: crossCheck,
      commits_scanned: commitsScanned,
      secret_findings: findings.length,
      ...(range.status === 'ok' && { carried_paths: range.paths.length }),
    },
    config?.audit,
  )

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
    source_sha: pinned,
    target_branch: targetBranch,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: merge.sha_before,
    sha_after: merge.sha_after,
    branch_check: branchCheck,
    secrets_check: secretsCheck(findings.length > 0, afterMerge),
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints: withAdvisories(hints),
  }
}

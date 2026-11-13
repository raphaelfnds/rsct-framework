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
  gitRebase,
  gitSquash,
  branchRef,
  readGitState,
  type GitExecutor,
  type GitState,
} from '../lib/git.js'
import { effectiveProtectedList, isProtectedBranch } from '../lib/branch-protection.js'
import { DevApprovalSchema, recordConsumedApproval, type FabricationSignal } from '../lib/dev-approval.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { promptYesNo, type DialogOptions, type DialogResult } from '../lib/os-dialog.js'
import { gateRequest, type GateChannel, type GateRejectKind } from '../lib/request-gate.js'
import { evaluateBootstrapMarker, type BootstrapMarker } from '../lib/phase-scope.js'
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
import { evaluateInstallAdvisory } from '../lib/install-advisory.js'
import { agentReasonLine, protectedBranchLine, secretFindingLines } from '../lib/gate-exceptions.js'
import { baselineEntry, checkGitPrograms, programsDialogLines, programsStillSame } from '../lib/git-programs.js'
import { ackDialogLines, driftRefusal, readDriftLock, readHeadPosition, rescanLanded, resolvePinned, sameHeadPosition } from '../lib/integration-gate.js'
import { scanCommits } from '../lib/staged-scan.js'
import { compileExtraPatterns, type SecretFinding } from '../lib/secrets.js'

export const requestRebaseInputSchema = z
  .object({
    project_root: z.string().optional().describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    mode: z
      .enum(['rebase', 'squash'])
      .optional()
      .describe("'rebase' = git rebase current onto ref; 'squash' = git merge --squash ref into current (default 'rebase')."),
    ref: z
      .string()
      .min(1, 'ref required')
      .describe("For mode='rebase': the upstream to rebase onto. For mode='squash': the branch to squash-merge into the current HEAD."),
    dev_approval: z
      .unknown()
      .describe('The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication).'),
    pre_merge_ack: preMergeAckSchema
      .optional()
      .describe('PH-5 pre-integration hygiene checklist (self-attested). REQUIRED — absence ⇒ rejected in chat (no OS dialog).'),
  })
  .strict()

export type RequestRebaseInput = z.infer<typeof requestRebaseInputSchema>
export type RequestRebaseStatus = 'rebased' | 'squashed' | 'rejected' | 'mutation_failed'

export type RequestRebaseRejectKind =
  | GateRejectKind
  | 'protected_branch'
  | 'detached_head'
  | 'same_ref'
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

export interface RequestRebaseOutput {
  status: RequestRebaseStatus
  mode: 'rebase' | 'squash'
  ref: string
  ref_sha: string | null
  current_branch: string | null
  channel: GateChannel | null
  reject_kind: RequestRebaseRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  sha_before: string | null
  sha_after: string | null
  branch_check: { protected: boolean; override_used: boolean }
  secrets_check: {
    commits_scanned: number | null
    findings_count: number
    findings: SecretFinding[]
    override_used: boolean
    after_rebase: SecretFinding[]
  }
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestRebaseInternal {
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

export const requestRebaseTool: Tool = {
  name: 'rsct_request_rebase',
  description:
    "§C-gated rebase / squash — the history-rewriting integration paths, ALWAYS per-action (never covered by a plan token). Before any dialog: pre_merge_ack is checked; HEAD must be on a branch with a commit (detached_head otherwise) and differ from `ref`; an armed review_drift lock refuses; rewriting a PROTECTED branch needs dev_approval.override_protected_branch; `ref` is pinned to its commit; and for mode='rebase' every commit on either side since the merge base is scanned for secrets (each commit's own diff), so a finding needs dev_approval.override_secrets_check. The forced OS dialog lists the pinned commit, the protected branch, each finding as file:line, rule and commit (never the value) and the pre_merge_ack answers, and after the framework footer the agent's reasons and ack note. A `ref` that moved after the dialog refuses (source_moved), and so does a HEAD no longer on the branch and commit it was on at the dialog (target_moved). mode='rebase' runs `git rebase` on the pinned commit and then scans the rewritten commits again: a finding the dialog did not show arms review_drift with its paths. mode='squash' runs `git merge --squash <ref>` (stages a squashed change WITHOUT committing — rsct_request_commit scans it when it is committed). Conflicts surface as mutation_failed with git's stderr; content resolved by hand during `git rebase --continue` is outside RSCT, and the push gate scans it again; nothing is force-pushed. Before the dialog it also lists every file in the hooks folder git runs and every configured key that runs a program (ssh command, credential helper, filters, merge drivers, signing, remote programs, transport helpers), with its origin and URL credentials masked, marking what is new or changed since the last approved call; the list is read again right before git runs (programs_moved), and a list that cannot be read refuses (programs_unreadable).",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: { type: 'string', description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.' },
      mode: { type: 'string', enum: ['rebase', 'squash'], description: "'rebase' or 'squash' (default 'rebase')." },
      ref: { type: 'string', description: 'Upstream to rebase onto, or branch to squash-merge.' },
      dev_approval: { type: 'object', description: 'dev_approval payload; action_scope starts with rebase: or squash:. override_protected_branch and override_secrets_check are listed in the dialog with their reasons.' },
      pre_merge_ack: preMergeAckJsonSchema,
    },
    required: ['ref', 'dev_approval'],
    additionalProperties: false,
  },
}

export async function requestRebaseHandler(
  rawInput: unknown,
  internal: RequestRebaseInternal = {},
): Promise<RequestRebaseOutput> {
  const input = requestRebaseInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config: RsctConfig | undefined = resolution.config ?? undefined
  const promptFn = internal.promptFn ?? promptYesNo
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor
  const now = internal.now ?? new Date()
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot)
  const currentBranch = gitState.branch
  const currentLabel = currentBranch ?? '<no-branch>'
  const mode = input.mode ?? 'rebase'
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval

  let pinned: string | null = null
  let findings: SecretFinding[] = []
  let commitsScanned: number | null = null
  const secretsCheck = (overrideUsed: boolean, afterRebase: SecretFinding[] = []): RequestRebaseOutput['secrets_check'] => ({
    commits_scanned: commitsScanned,
    findings_count: findings.length,
    findings,
    override_used: overrideUsed,
    after_rebase: afterRebase,
  })

  const base = (over: Partial<RequestRebaseOutput>): RequestRebaseOutput => ({
    status: 'rejected',
    mode,
    ref: input.ref,
    ref_sha: pinned,
    current_branch: currentBranch,
    channel: null,
    reject_kind: null,
    reason: null,
    fabrication_signals: [],
    sha_before: gitState.head_sha,
    sha_after: null,
    branch_check: { protected: false, override_used: false },
    secrets_check: secretsCheck(false),
    audit_path: null,
    audit_error: null,
    anti_replay_persisted: null,
    anti_replay_error: null,
    ...over,
    hints: [...anchorHints(projectRoot, config?.audit), ...(over.hints ?? [])],
  })
  const reject = (
    kind: RequestRebaseRejectKind,
    reason: string,
    opts: { protected?: boolean; channel?: GateChannel | null; signals?: FabricationSignal[]; audit?: Record<string, unknown>; hints?: string[]; shaBefore?: string | null } = {},
  ): RequestRebaseOutput => {
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.rejected', tool: 'rsct_request_rebase', reject_kind: kind, reason, mode, ref: input.ref, ...opts.audit },
      config?.audit,
    )
    return base({
      reject_kind: kind,
      reason,
      channel: opts.channel ?? null,
      fabrication_signals: opts.signals ?? [],
      branch_check: { protected: opts.protected ?? false, override_used: false },
      ...(opts.shaBefore !== undefined && { sha_before: opts.shaBefore }),
      ...auditFields(audit),
      hints: opts.hints ?? [reason],
    })
  }

  const currentPlan = currentBranch ? findPlanByBranch(projectRoot, currentBranch) : null
  const progressOpen = branchPlansHaveOpenItems(projectRoot, [currentBranch, ...(mode === 'squash' ? [input.ref] : [])])
  const range =
    mode === 'rebase'
      ? (internal.rangeReader ?? getRangePaths)(projectRoot, input.ref, 'HEAD')
      : (internal.rangeReader ?? getRangePaths)(projectRoot, 'HEAD', input.ref)
  const crossCheck = describeCrossCheck(range)
  const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, {
    progressHasOpenItems: progressOpen,
    carriedPaths: range.status === 'ok' ? range.paths : null,
  })
  if (ackDecision.ok && range.status !== 'ok') {
    return reject('hygiene_range_unreadable', crossCheckBlockedReason(range, mode), { audit: { path_crosscheck: crossCheck } })
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

  const installAdvisory = evaluateInstallAdvisory({
    projectRoot,
    rsctInstalled: resolution.rsct_installed,
    projectVersion: config?.rsct_version ?? null,
    auditConfig: config?.audit,
    tool: 'rsct_request_rebase',
    auditWriter: appendAudit,
  })
  const advisoryHints = installAdvisory.hint ? [installAdvisory.hint] : []

  if (currentBranch === null || gitState.head_sha === null) {
    return reject('detached_head', 'cannot rebase/squash on a HEAD that is not on a branch with a commit — checkout a branch first. No dialog was shown.', { shaBefore: null })
  }
  if (input.ref === currentBranch) {
    return reject('same_ref', `cannot ${mode} '${currentBranch}' against itself. No dialog was shown.`)
  }

  const drift = readDriftLock(projectRoot)
  if (drift.status === 'unreadable') return reject('review_unreadable', `${drift.error} Nothing was ${mode === 'rebase' ? 'rebased' : 'squashed'} and no dialog was shown.`)
  if (drift.status === 'armed') {
    return reject('review_drift', driftRefusal(drift.paths, `every ${mode}`), { audit: { drift_paths: drift.paths } })
  }

  const { list: protectedList } = effectiveProtectedList(config)
  const currentProtected = isProtectedBranch(currentBranch, protectedList)
  const raw = DevApprovalSchema.safeParse(input.dev_approval)
  const rawOverrides = raw.success ? { branch: raw.data.override_protected_branch, secrets: raw.data.override_secrets_check } : {}
  if (raw.success && currentProtected && !rawOverrides.branch) {
    return reject('protected_branch', `branch '${currentLabel}' is protected — ${mode} rewrites its history; pass dev_approval.override_protected_branch: { reason } to proceed. No dialog was shown.`, { protected: true })
  }

  pinned = resolvePinned(projectRoot, input.ref, gitExecutor)
  const headAt = readHeadPosition(projectRoot, gitExecutor)
  if (headAt.ref !== branchRef(currentBranch)) {
    return reject('target_moved', `HEAD is no longer on '${specLabel(currentLabel, DIALOG_PATH_LIMIT)}', the branch the checks read — nothing was changed and no dialog was shown; ask again.`, { protected: currentProtected })
  }
  const head = headAt.sha
  if (pinned === null || head === null) {
    return reject('source_unreadable', `git could not resolve '${specLabel(input.ref, DIALOG_PATH_LIMIT)}'${head === null ? ' or HEAD' : ''} to a commit, so what the ${mode} brings cannot be shown — nothing was changed.`, { protected: currentProtected })
  }
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
  const scanner = internal.commitScanner ?? scanCommits
  if (mode === 'rebase') {
    const before = await scanner(projectRoot, { tips: [`${head}...${pinned}`], exclude: [] }, extras, internal.secretsScanTimeoutMs, gitExecutor)
    if (!before.ok) {
      return reject('secrets_unreadable', `the secrets scan could not read the commits this rebase rewrites and brings (${before.reason}), so it is refused rather than run unscanned — the developer rebases by hand in their own terminal`, { protected: currentProtected })
    }
    findings = before.findings
    commitsScanned = before.commits
  }
  if (raw.success && findings.length > 0 && !rawOverrides.secrets) {
    return reject('secrets', `${findings.length} secret finding(s) in the commits this rebase rewrites and brings — pass dev_approval.override_secrets_check: { reason } to proceed. No dialog was shown.`, {
      protected: currentProtected,
      audit: { findings_count: findings.length },
    })
  }

  const programs = checkGitPrograms(projectRoot, gitExecutor, config?.audit)
  if (!programs.ok) {
    return reject('programs_unreadable', `${programs.reason}, so the hooks and programs git would run inside this ${mode} cannot be listed — nothing was changed and no dialog was shown.`, { protected: currentProtected })
  }

  const ack = ackDialogLines(input.pre_merge_ack)
  const facts = [
    `Approve ${mode} of '${specLabel(currentLabel, DIALOG_PATH_LIMIT)}' ${mode === 'rebase' ? 'onto' : 'from'} '${specLabel(input.ref, DIALOG_PATH_LIMIT)}'? (history-rewriting)`,
    ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
    `${mode === 'rebase' ? 'Onto' : 'From'} commit: ${pinned.slice(0, 12)}`,
    ...(currentProtected ? [protectedBranchLine(currentLabel, 'rewriting its history')] : []),
    ...(mode === 'rebase' && findings.length === 0 ? [`Secrets scan: ${commitsScanned} commit(s) read, nothing found.`] : []),
    ...(mode === 'squash' ? ['Secrets scan: the squashed change is scanned when rsct_request_commit commits it.'] : []),
    ...secretFindingLines(projectRoot, 'rebase', findings),
    ...programsDialogLines(projectRoot, 'rebase', mode, programs.read, programs.fresh),
    ...ack.facts,
  ]
  const reasons = [
    ...agentReasonLine('the protected branch', currentProtected ? rawOverrides.branch : undefined),
    ...agentReasonLine('the secret findings', findings.length > 0 ? rawOverrides.secrets : undefined),
    ...ack.note,
  ]

  const gate = await gateRequest({
    toolName: 'rsct_request_rebase',
    approval: input.dev_approval,
    forceDialog: true,
    forceDialogReason: 'a rebase or squash needs the developer in the OS dialog; a batch token covers commit only; with no dialog channel, the developer runs it by hand in their own terminal',
    dialog: {
      title: 'RSCT — rebase approval',
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
      hints: [...advisoryHints, `Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    })
  }

  const approval = gate.approval
  const overrideBranch = approval.override_protected_branch
  const after = { channel: gate.channel, signals: gate.fabrication_signals, audit: { channel: gate.channel } }
  if (currentProtected && !overrideBranch) {
    return reject('protected_branch', `branch '${currentLabel}' is protected — ${mode} rewrites its history; pass dev_approval.override_protected_branch: { reason } to proceed`, { ...after, protected: true })
  }
  if (findings.length > 0 && !approval.override_secrets_check) {
    return reject('secrets', `${findings.length} secret finding(s) in the commits this rebase rewrites and brings — pass dev_approval.override_secrets_check: { reason } to proceed`, { ...after, protected: currentProtected })
  }
  if (currentProtected && overrideBranch) {
    appendAudit(
      projectRoot,
      { event: 'request_rebase.override_invoked', tool: 'rsct_request_rebase', override_kind: 'protected_branch', override_reason: overrideBranch.reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
  }
  if (findings.length > 0 && approval.override_secrets_check) {
    appendAudit(
      projectRoot,
      { event: 'request_rebase.override_invoked', tool: 'rsct_request_rebase', override_kind: 'secrets_check', override_reason: approval.override_secrets_check.reason, findings_count: findings.length, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
  }

  const moved = resolvePinned(projectRoot, input.ref, gitExecutor)
  if (moved !== pinned) {
    return reject('source_moved', `'${specLabel(input.ref, DIALOG_PATH_LIMIT)}' moved after the dialog (${pinned.slice(0, 12)} → ${moved?.slice(0, 12) ?? 'gone'}), so the ${mode} would not be the one approved — ask again. The approval was not used.`, {
      ...after,
      protected: currentProtected,
    })
  }
  if (!sameHeadPosition(headAt, readHeadPosition(projectRoot, gitExecutor))) {
    return reject('target_moved', `HEAD moved to another branch or commit after the dialog, so the ${mode} would not change what the developer approved — ask again. The approval was not used.`, {
      ...after,
      protected: currentProtected,
    })
  }

  const programsNow = programsStillSame(programs, projectRoot, gitExecutor)
  if (!programsNow.ok) return reject(programsNow.kind, `${programsNow.reason}. The approval was not used.`, { ...after, protected: currentProtected })
  appendAudit(projectRoot, baselineEntry(programs.read, programs.baseline), config?.audit)

  const branchCheck = { protected: currentProtected, override_used: currentProtected }
  const result = mode === 'rebase' ? gitRebase(projectRoot, pinned, gitExecutor) : gitSquash(projectRoot, pinned, gitExecutor)
  if (!result.ok) {
    const reason = result.error ?? result.stderr ?? `git ${mode} failed`
    const audit = appendAudit(
      projectRoot,
      { event: 'request_rebase.mutation_failed', tool: 'rsct_request_rebase', reason, mode, ref: input.ref, channel: gate.channel },
      config?.audit,
    )
    return base({
      status: 'mutation_failed',
      channel: gate.channel,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: result.sha_before,
      branch_check: branchCheck,
      secrets_check: secretsCheck(findings.length > 0),
      ...auditFields(audit),
      hints: [
        `git ${mode} failed — ${mode === 'rebase' ? 'resolve conflicts (git rebase --continue) or abort (git rebase --abort)' : 'resolve conflicts, then commit via rsct_request_commit'}. Approval NOT consumed; retry with a fresh dev_approval.`,
      ],
    })
  }

  const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
  const hints: string[] = [
    ...advisoryHints,
    mode === 'rebase'
      ? `Rebased '${currentLabel}' onto '${input.ref}' (${result.sha_before ?? '?'} → ${result.sha_after ?? '?'}).`
      : `Squash-staged '${input.ref}' into '${currentLabel}' — NOT committed. Commit the squashed change via rsct_request_commit.`,
  ]
  let afterRebase: SecretFinding[] = []
  if (mode === 'rebase') {
    const landed = result.sha_after ?? 'HEAD'
    const rescan = await rescanLanded({
      projectRoot,
      what: 'rebase',
      sha: landed,
      range: { tips: [landed], exclude: [pinned] },
      approved: findings,
      extras,
      timeoutMs: internal.secretsScanTimeoutMs,
      executor: gitExecutor,
      scanner,
      now,
    })
    afterRebase = rescan.findings
    if (rescan.hint !== null) hints.push(rescan.hint)
    if (rescan.audit !== null) appendAudit(projectRoot, { event: `request_rebase.${rescan.audit.event}`, tool: 'rsct_request_rebase', ...rescan.audit.fields }, config?.audit)
  }

  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_rebase.done',
      tool: 'rsct_request_rebase',
      mode,
      ref: input.ref,
      ref_sha: pinned,
      current_branch: currentBranch,
      channel: gate.channel,
      sha_before: result.sha_before,
      sha_after: result.sha_after,
      fabrication_signals: gate.fabrication_signals,
      path_crosscheck: crossCheck,
      commits_scanned: commitsScanned,
      secret_findings: findings.length,
      ...(range.status === 'ok' && { carried_paths: range.paths.length }),
    },
    config?.audit,
  )

  const bootstrap = evaluateBootstrapMarker({ projectRoot, now })
  if (bootstrap.status !== 'fresh' && bootstrap.hint) hints.push(bootstrap.hint)
  if (!record.ok) {
    hints.push(`⚠ ${mode} landed but the approval could not be recorded as used: ${record.error}.`)
  }

  const donePlan = currentPlan ?? findActivePlan(projectRoot)
  if (donePlan) {
    const report = planCleanupReport(projectRoot, donePlan.slug, config ?? null)
    hints.push(`${report.hint} Record keep|delete with rsct_plan_dispose.`)
  }

  return base({
    status: mode === 'rebase' ? 'rebased' : 'squashed',
    channel: gate.channel,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: result.sha_before,
    sha_after: result.sha_after,
    branch_check: branchCheck,
    secrets_check: secretsCheck(findings.length > 0, afterRebase),
    bootstrap_marker: bootstrap,
    ...auditFields(audit),
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints,
  })
}

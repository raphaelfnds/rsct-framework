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
  getRangePaths,
  gitPush,
  readGitState,
  type GitExecutor,
  type GitState,
  type RangePathsResult,
} from '../lib/git.js'
import {
  effectiveProtectedList,
  isProtectedBranch,
} from '../lib/branch-protection.js'
import {
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
  type PathCrossCheck,
} from '../lib/pre-merge-ack.js'
import {
  parsePushRefspec,
  pushRefspecRejectReason,
  stripRefsPrefix,
} from '../lib/push-refspec.js'

export const requestPushInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    remote: z
      .string()
      .optional()
      .describe(
        'Configured remote NAME (default: origin). A URL or filesystem path is refused — ' +
          'it would send the repository somewhere branch protection cannot see. Add it with ' +
          '`git remote add` first.',
      ),
    branch: z
      .string()
      .optional()
      .describe(
        'Branch to push (default: current HEAD). Branch protection compares the resolved push ' +
          'DESTINATION, so +main, HEAD:main, feat/x:main, refs/heads/main and heads/main are all ' +
          'recognised as main. Refused outright: a value starting with "-", a "*" glob refspec, ' +
          'and an empty destination (a bare ":" pushes every matching ref).',
      ),
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
  /** #62 B5: the branch/refspec is option-shaped, a glob, or has no destination. */
  | 'unsafe_push_target'
  /** #62 B5: the remote is not a configured remote of this repository. */
  | 'unknown_remote'

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
  /** Test-only seam — see `RequestMergeInternal.rangeReader`. */
  rangeReader?: typeof getRangePaths
}

export const requestPushTool: Tool = {
  name: 'rsct_request_push',
  description:
    "§C-gated push. Validates dev_approval, pops OS dialog when required, runs INV-5 branch check, then executes `git push <remote> <branch>`. No secrets scan — the commit step already enforced INV-6. On rejection the approval is NOT consumed; dev can add an override and retry. `remote` must be a CONFIGURED remote name (a URL or path is refused), and INV-5 compares the RESOLVED push destination, so +main / HEAD:main / refs/heads/main are all recognised as main; a leading '-', a '*' glob refspec and an empty destination reject before git runs.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      remote: {
        type: 'string',
        description:
          'Configured remote NAME (default: origin). A URL or path is refused — add it with `git remote add` first.',
      },
      branch: {
        type: 'string',
        description:
          'Branch to push (default: current HEAD). Protection compares the resolved DESTINATION, so +main / HEAD:main / refs/heads/main are all recognised as main. A leading "-", a "*" glob, and an empty destination are refused.',
      },
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

  // #25. Push is outward-facing and hard to reverse, so degraded enforcement
  // matters MORE here than at commit — and this is exactly where the warning used
  // to be silent. Evaluated before every pre-gate check so it reaches the dev on
  // rejected attempts too, and drained through `withAdvisories` on every return
  // path. Prepended: it outranks the routine hint tail.
  const advisories: string[] = []
  const withAdvisories = (hints: string[]): string[] => [...advisories, ...hints]
  const installAdvisory = evaluateInstallAdvisory({
    projectRoot,
    rsctInstalled: resolution.rsct_installed,
    projectVersion: config?.rsct_version ?? null,
    auditConfig: config?.audit,
    tool: 'rsct_request_push',
    auditWriter: appendAudit,
  })
  if (installAdvisory.hint) advisories.push(installAdvisory.hint)

  // #62 B5: the remote is an agent slot that nothing validated, and it feeds the
  // same argv. Measured: `git push <arbitrary-bare-path> main` lands the repo's
  // contents in a foreign repository, and `--` does NOT protect that slot —
  // `git push -- <path> main` is still rc=0. So the operand sentinel in `gitPush`
  // is necessary and not sufficient; this is the other half.
  //
  // STRICT by decision: only an UNREADABLE list (`ok === false`, e.g. outside a
  // repo) skips the check. An EMPTY list REJECTS. The two are different failures:
  // skipping on empty would leave a repo with no configured remotes — exactly the
  // shape an attacker-controlled path exploits — with no protection at all.
  //
  // BREAKING, deliberately: pushing straight to a URL or filesystem path stops
  // working. That capability IS the exfiltration vector, and the tool's own
  // schema has always documented this field as "Remote name (default: origin)".
  const remoteList = gitExecutor(projectRoot, ['remote'])
  if (remoteList.ok) {
    const names = remoteList.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (!names.includes(remote)) {
      const reason =
        `remote ${JSON.stringify(remote)} is not a configured remote of this repository` +
        `${names.length > 0 ? ` (configured: ${names.join(', ')})` : ' (none configured)'}` +
        '. RSCT pushes only to NAMED remotes — a URL or path here would send the ' +
        'repository somewhere branch protection cannot see. Add it with `git remote add` first.'
      const audit = appendAudit(
        projectRoot,
        {
          event: 'request_push.rejected',
          tool: 'rsct_request_push',
          reject_kind: 'unknown_remote',
          reason,
          branch,
          remote,
          configured_remotes: names,
        },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch,
        remote,
        channel: null,
        reject_kind: 'unknown_remote',
        reason,
        fabrication_signals: [],
        branch_check: { protected: false, override_used: false },
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([reason]),
      }
    }
  }

  // #62 B5: resolve what this push actually WRITES TO before asking whether it is
  // protected. `isProtectedBranch` is an exact compare, so `+main`, `HEAD:main`,
  // `refs/heads/main`, `heads/main` and `@` all missed it while landing on the
  // remote's `main` — no ack, no override. The parse is pure; the ref-store
  // resolution below adds what only git can answer.
  const refspec = parsePushRefspec(branch ?? '')
  if (branch !== null && !refspec.ok) {
    const reason = pushRefspecRejectReason(refspec.reason, branch)
    const audit = appendAudit(
      projectRoot,
      {
        event: 'request_push.rejected',
        tool: 'rsct_request_push',
        reject_kind: 'unsafe_push_target',
        refspec_reject: refspec.reason,
        reason,
        branch,
        remote,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch,
      remote,
      channel: null,
      reject_kind: 'unsafe_push_target',
      reason,
      fabrication_signals: [],
      branch_check: { protected: false, override_used: false },
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories([reason]),
    }
  }

  // Ask the ref store what the destination canonicalises to, and add that to the
  // candidate set. Guarded on `startsWith('refs/')`, NEVER on the exit code:
  // measured, `rev-parse --symbolic-full-name` returns rc=0 with EMPTY stdout for
  // `main@{0}`, rc=0 echoing `HEAD` on a detached HEAD, rc=0 echoing `--mirror`
  // unchanged, and on FAILURE it still echoes its argument to stdout.
  //
  // It answers about the LOCAL ref store while the push writes the REMOTE, so it
  // is an addition to the string candidates, never a replacement: in a
  // `clone --single-branch` with no local `main`, resolution fails while
  // `HEAD:refs/heads/main` still moves the protected branch. The prefix-stripped
  // string arm is what closes that, and it cannot fail.
  const candidates = new Set(refspec.ok ? refspec.candidates : [])
  // #62: the endpoints of the coverage cross-check, composed HERE because this is
  // the only point where the parsed refspec and the ref store's answer are both
  // in scope. A push CARRIES `<remote>/<destination>`...`<source>` — the local
  // side is what is being sent, the remote-tracking side is what is already
  // there. Both stay null when the range cannot be named, and a null range is
  // treated as degraded (see the protected block below).
  let rangeBase: string | null = null
  let rangeHead: string | null = null
  if (refspec.ok) {
    const rp = gitExecutor(projectRoot, [
      'rev-parse',
      '--symbolic-full-name',
      '--',
      refspec.destination,
    ])
    const resolved = rp.stdout.trim()
    let destBare = stripRefsPrefix(refspec.destination)
    if (resolved.startsWith('refs/')) {
      candidates.add(resolved)
      destBare = stripRefsPrefix(resolved)
      candidates.add(destBare)
    }
    // Two shapes name no readable range, and both DEGRADE rather than guess:
    //  - an empty source is a DELETE refspec (`:main`) — it carries no files at
    //    all, so there is nothing to cross-check;
    //  - a destination still spelled `HEAD` means the ref store declined to
    //    canonicalise it (a detached HEAD echoes `HEAD` back at rc=0). Composing
    //    `<remote>/HEAD` there would silently read the remote's DEFAULT-branch
    //    symref instead of the branch being pushed — wrong, not degraded, and
    //    wrong is the worse of the two because it produces confident output.
    if (refspec.source.length > 0 && destBare !== 'HEAD') {
      rangeBase = `${remote}/${destBare}`
      rangeHead = refspec.source
    }
  }
  const branchProtected = [...candidates].some((c) => isProtectedBranch(c, protectedList))
  // `null` = not applicable (this push is not to a protected branch, so the check
  // never ran). Deliberately not `'degraded'`: that label claims an attempt was
  // made, and the audit must not over-claim what was checked.
  let crossCheck: PathCrossCheck | null = null
  let degradedHint: string | null = null

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
    const range: RangePathsResult =
      rangeBase !== null && rangeHead !== null
        ? (internal.rangeReader ?? getRangePaths)(projectRoot, rangeBase, rangeHead)
        : { status: 'unavailable' }
    crossCheck = describeCrossCheck(range)
    const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, {
      progressHasOpenItems: progressOpen,
      carriedPaths: range.status === 'ok' ? range.paths : null,
    })
    // FAIL-OPEN — and push is the ONLY one of the three that does. Merge and
    // rebase fail closed because the mutation can succeed where the range read
    // cannot; push inverts that. Measured: `git push origin main` succeeds even
    // when `origin/main` was never fetched, so `origin/main...main` is rc=128 on
    // a perfectly ordinary first push of a clone made with `--single-branch`.
    // Failing closed there would block a legitimate push on a purely local
    // bookkeeping gap, and an unfetched remote-tracking ref is the NORMAL state,
    // not the adversarial one. The push's own protection is elsewhere and
    // independent of this: the remote allow-list, the refspec parse, INV-5 on the
    // resolved destination, and `override_protected_branch`.
    if (ackDecision.ok && range.status !== 'ok') {
      // Two DIFFERENT causes reach this branch and they need different advice.
      // A named range that would not read is a fetch problem; an unnameable range
      // is not, and telling the agent to `git fetch` there would be wrong advice
      // it cannot act on — a delete refspec carries no files however many refs
      // are fetched. The audit distinguishes them by `range_base: null`, which is
      // also why `crossCheck` stays a four-way label instead of growing a fifth
      // variant for merge and rebase to carry but never use.
      const named = rangeBase !== null && rangeHead !== null
      degradedHint = named
        ? `⚠ pre_merge_ack coverage check DEGRADED (${crossCheck}): the paths this push carries ` +
          `could not be read from git (${rangeBase}...${rangeHead}). The push proceeds — an ` +
          'unfetched remote-tracking ref is an ordinary state, not a fault — but files_swept was ' +
          `NOT verified against what is actually being sent. Run \`git fetch ${remote}\` and ` +
          're-check if that matters here.'
        : `⚠ pre_merge_ack coverage check DEGRADED (${crossCheck}): this push names no readable ` +
          'range — either it deletes a ref (which carries no files) or its destination could not ' +
          'be resolved to a branch. The push proceeds and files_swept was not verified. Fetching ' +
          'will not change this; name the branch explicitly if you expected a coverage check.'
      appendAudit(
        projectRoot,
        {
          event: 'request_push.pre_merge_ack_degraded',
          tool: 'rsct_request_push',
          branch,
          remote,
          path_crosscheck: crossCheck,
          range_base: rangeBase,
          range_head: rangeHead,
        },
        config?.audit,
      )
    }
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
          path_crosscheck: crossCheck,
          ...(ackDecision.kind === 'pre_merge_ack_incomplete' && { failing: ackDecision.failing }),
          ...(ackDecision.kind === 'pre_merge_ack_incomplete' &&
            ackDecision.unswept !== undefined && { files_unswept: ackDecision.unswept }),
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
        hints: withAdvisories([hint]),
      }
    }
  }

  const gate = await gateRequest({
    toolName: 'rsct_request_push',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — push approval',
      // The dialog is the one channel the agent cannot rewrite or summarize
      // away, which is why the security line belongs here and not only in
      // hints[]. One line, deliberately: this is a decision surface, and a wall
      // of text trains the dev to dismiss it unread.
      message: [
        `Approve push of '${branchLabel}' to '${remote}'?`,
        ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
      ].join('\n'),
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
      hints: withAdvisories([`Approval rejected (${gate.reject_kind}): ${gate.reason}`]),
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
      hints: withAdvisories([reason]),
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
      hints: withAdvisories([reason]),
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
      hints: withAdvisories(['git push failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.']),
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
      // #62: what the coverage check did on the push that LANDED. Omitted
      // entirely (rather than sent as a placeholder) when the push was not to a
      // protected branch — the check does not apply there, and an absent field
      // says that without claiming a result.
      ...(crossCheck !== null && { path_crosscheck: crossCheck }),
    },
    config?.audit,
  )

  const hints: string[] = [`Pushed '${branch}' to '${remote}'.`]
  if (degradedHint !== null) hints.push(degradedHint)
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
    hints: withAdvisories(hints),
  }
}


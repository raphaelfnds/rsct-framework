import { z } from 'zod'
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
  getTreePaths,
  gitPush,
  readGitState,
  resolveCommit,
  type GitExecutor,
  type GitState,
  type RangePathsResult,
} from '../lib/git.js'
import { defaultPushProbe, type PushProbe } from '../lib/push-probe.js'
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
  crossCheckBlockedReason,
  evaluatePreMergeAck,
  MAX_FILES_SWEPT,
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
import { gateDialogFooter, anchorHints } from '../lib/gate-dialog.js'
import { DIALOG_PATH_LIMIT, specLabel } from '../lib/dialog-text.js'

export const requestPushInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
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
  | 'unsafe_push_target'
  | 'unknown_remote'
  | 'hygiene_range_unreadable'

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
  bootstrap_marker?: BootstrapMarker | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface RequestPushInternal {
  gitExecutor?: GitExecutor
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  gitStateOverride?: GitState
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
  rangeReader?: typeof getRangePaths
  treeReader?: typeof getTreePaths
  pushProbe?: PushProbe
}

interface ProbeRead {
  projectRoot: string
  remote: string
  refspec: string
  destinationRef: string
  head: string
  probe: PushProbe
  treeReader: typeof getTreePaths
  rangeReader: typeof getRangePaths
}

function carriedByProbe(read: ProbeRead): { range: RangePathsResult; parsed: boolean } {
  const probed = read.probe(read.projectRoot, read.remote, read.refspec)
  if (probed.status !== 'parsed') return { range: { status: 'unavailable' }, parsed: false }
  const mine = probed.refs.filter((r) => r.to === read.destinationRef)
  if (mine.length === 0) return { range: { status: 'unavailable' }, parsed: false }
  const paths = new Set<string>()
  for (const r of mine) {
    if (r.flag === '=' || r.flag === '-') continue
    const old = r.old !== null ? resolveCommit(read.projectRoot, r.old) : null
    let carried = old !== null ? read.rangeReader(read.projectRoot, old, read.head) : read.treeReader(read.projectRoot, read.head)
    if (carried.status !== 'ok' && old !== null) carried = read.treeReader(read.projectRoot, read.head)
    if (carried.status !== 'ok') return { range: carried, parsed: true }
    for (const p of carried.paths) paths.add(p)
  }
  return { range: { status: 'ok', paths: [...paths] }, parsed: true }
}

export const requestPushTool: Tool = {
  name: 'rsct_request_push',
  description:
    "§C-gated push. Validates dev_approval, pops OS dialog when required, runs INV-5 branch check, then executes `git push <remote>` with an explicit full refspec built from the parsed request (so a remote.<name>.push mapping cannot redirect it). No secrets scan — the commit step already enforced INV-6. On rejection the approval is NOT consumed; dev can add an override and retry. `remote` must be a CONFIGURED remote name (a URL or path is refused), and INV-5 compares the RESOLVED push destination, so +main / HEAD:main / refs/heads/main are all recognised as main; a leading '-', a '*' glob refspec and an empty destination reject before git runs.",
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
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

  const advisories: string[] = []
  advisories.push(...anchorHints(projectRoot, config?.audit))
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

  const candidates = new Set(refspec.ok ? refspec.candidates : [])
  let rangeBase: string | null = null
  let rangeLabel: string | null = null
  let rangeHead: string | null = null
  let destinationRef: string | null = null
  let destinationLabel: string | null = null
  let sourceSha: string | null = null
  let explicitRefspec: string | null = null
  if (refspec.ok) {
    const rp = gitExecutor(projectRoot, [
      'rev-parse',
      '--symbolic-full-name',
      refspec.destination,
    ])
    const resolved = rp.stdout.trim()
    let destBare = stripRefsPrefix(refspec.destination)
    if (resolved.startsWith('refs/')) {
      candidates.add(resolved)
      destBare = stripRefsPrefix(resolved)
      candidates.add(destBare)
    }
    destinationLabel = destBare
    destinationRef = resolved.startsWith('refs/')
      ? resolved
      : refspec.destination.startsWith('refs/')
        ? refspec.destination
        : destBare === 'HEAD'
          ? null
          : `refs/heads/${destBare}`
    if (refspec.source.length > 0) {
      const peel = (rev: string): string => {
        const sv = gitExecutor(projectRoot, ['rev-parse', '--verify', '-q', `${rev}^{object}`])
        const out = sv.ok ? sv.stdout.trim() : ''
        return /^[0-9a-f]{40,64}$/.test(out) ? out : ''
      }
      const bare = !refspec.source.startsWith('refs/') && !/^[0-9a-f]{7,64}$/i.test(refspec.source)
      const head = bare ? peel(`refs/heads/${refspec.source}`) : ''
      sourceSha = (head || peel(refspec.source)) || null
    }
    if (destinationRef !== null) {
      const source = refspec.source.length === 0 ? '' : (sourceSha ?? refspec.source)
      explicitRefspec = `${refspec.forced ? '+' : ''}${source}:${destinationRef}`
    }
    if (refspec.source.length > 0 && destBare !== 'HEAD') {
      rangeLabel = `${remote}/${destBare}`
      rangeBase = destinationRef?.startsWith('refs/heads/')
        ? `refs/remotes/${remote}/${destinationRef.slice('refs/heads/'.length)}`
        : rangeLabel
      rangeHead = sourceSha ?? refspec.source
    }
  }
  const branchProtected = [...candidates].some((c) => isProtectedBranch(c, protectedList))
  let crossCheck: PathCrossCheck | null = null
  let degradedHint: string | null = null

  if (branchProtected) {
    const source = refspec.ok ? refspec.source : ''
    const pushedBranch = /^(?:head|@)$/i.test(source) ? gitState.branch : source
    const progressOpen = branchPlansHaveOpenItems(projectRoot, [pushedBranch])
    const rangeReader = internal.rangeReader ?? getRangePaths
    let range: RangePathsResult =
      rangeBase !== null && rangeHead !== null
        ? rangeReader(projectRoot, rangeBase, rangeHead)
        : { status: 'unavailable' }
    let probeParsed = false
    if (range.status === 'unavailable' && explicitRefspec !== null && destinationRef !== null && rangeHead !== null) {
      const carried = carriedByProbe({
        projectRoot,
        remote,
        refspec: explicitRefspec,
        destinationRef,
        head: sourceSha ?? rangeHead,
        probe: internal.pushProbe ?? defaultPushProbe,
        treeReader: internal.treeReader ?? getTreePaths,
        rangeReader,
      })
      range = carried.range
      probeParsed = carried.parsed
    }
    crossCheck = describeCrossCheck(range)
    if (range.status === 'ok' && range.paths.length > MAX_FILES_SWEPT) {
      const reason =
        `refusing to push: this push carries ${range.paths.length} files, over the ${MAX_FILES_SWEPT} the ` +
        'coverage check can attest. A first publication this large is one the developer pushes by hand in their own terminal.'
      const audit = appendAudit(
        projectRoot,
        { event: 'request_push.rejected', tool: 'rsct_request_push', reject_kind: 'hygiene_range_unreadable', reason, branch, remote, path_crosscheck: crossCheck },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch,
        remote,
        channel: null,
        reject_kind: 'hygiene_range_unreadable',
        reason,
        fabrication_signals: [],
        branch_check: { protected: true, override_used: false },
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([reason]),
      }
    }
    const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, {
      progressHasOpenItems: progressOpen,
      carriedPaths: range.status === 'ok' ? range.paths : null,
    })
    if (ackDecision.ok && range.status !== 'ok' && probeParsed) {
      const reason = crossCheckBlockedReason(range, 'push')
      const audit = appendAudit(
        projectRoot,
        {
          event: 'request_push.rejected',
          tool: 'rsct_request_push',
          reject_kind: 'hygiene_range_unreadable',
          reason,
          branch,
          remote,
          path_crosscheck: crossCheck,
        },
        config?.audit,
      )
      return {
        status: 'rejected',
        branch,
        remote,
        channel: null,
        reject_kind: 'hygiene_range_unreadable',
        reason,
        fabrication_signals: [],
        branch_check: { protected: true, override_used: false },
        ...auditFields(audit),
        anti_replay_persisted: null,
        anti_replay_error: null,
        hints: withAdvisories([reason]),
      }
    }
    if (ackDecision.ok && range.status !== 'ok') {
      const named = rangeBase !== null && rangeHead !== null
      degradedHint = named
        ? `⚠ pre_merge_ack coverage check DEGRADED (${crossCheck}): the paths this push carries ` +
          `could not be read from git (${rangeLabel}...${rangeHead}). The push proceeds — an ` +
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
          range_base: rangeLabel,
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
    forceDialog: true,
    forceDialogReason: 'a push needs the developer in the OS dialog; a batch token covers commit only; with no dialog channel, the developer runs it by hand in their own terminal',
    dialog: {
      title: 'RSCT — push approval',
      message: [
        `Approve push of '${specLabel(branchLabel, DIALOG_PATH_LIMIT)}' to '${specLabel(remote, DIALOG_PATH_LIMIT)}'?`,
        ...(refspec.ok && refspec.destination !== refspec.source
          ? [`Destination branch: '${specLabel(refspec.destination, DIALOG_PATH_LIMIT)}'`]
          : []),
        ...(sourceSha !== null ? [`Commit: ${sourceSha.slice(0, 12)}`] : []),
        ...(branchProtected && crossCheck === 'degraded'
          ? [
              '⚠ files_swept NOT checked: RSCT could not read what this push carries.' +
                (rangeHead !== null
                  ? ` If the remote has no '${specLabel(destinationLabel ?? branchLabel, DIALOG_PATH_LIMIT)}' yet, this push carries the whole branch.`
                  : ''),
            ]
          : []),
        ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
      ].join('\n') + gateDialogFooter(projectRoot, config),
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

  const push = gitPush(projectRoot, remote, explicitRefspec ?? branch, gitExecutor)
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

  const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_push.pushed',
      tool: 'rsct_request_push',
      branch,
      remote,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
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


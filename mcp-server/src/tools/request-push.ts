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
  getTreePaths,
  gitPush,
  readGitState,
  resolveCommit,
  type CommitRange,
  type GitExecutor,
  type GitState,
  type RangePathsResult,
} from '../lib/git.js'
import { defaultPushProbe, type PushProbe, type PushProbeResult } from '../lib/push-probe.js'
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
import { DIALOG_PATH_LIMIT, DIALOG_UNCUT, dialogList, specLabel } from '../lib/dialog-text.js'
import { agentReasonLine, protectedBranchLine, secretFindingLines } from '../lib/gate-exceptions.js'
import { baselineEntry, checkGitPrograms, programsDialogLines, programsStillSame } from '../lib/git-programs.js'
import { ackDialogLines, driftRefusal, readDriftLock, resolvePinned } from '../lib/integration-gate.js'
import { maskUrl, readFetchUrl, readPushOptions, readPushUrls, readSubmoduleMode, sameRepository } from '../lib/push-target.js'
import { scanCommits } from '../lib/staged-scan.js'
import { compileExtraPatterns, type SecretFinding } from '../lib/secrets.js'

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
  | 'no_branch'
  | 'review_drift'
  | 'review_unreadable'
  | 'push_url_unreadable'
  | 'push_options_unreadable'
  | 'secrets'
  | 'secrets_unreadable'
  | 'push_url_changed'
  | 'programs_unreadable'
  | 'programs_changed'
  | 'programs_moved'

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
  secrets_check: {
    commits_scanned: number | null
    findings_count: number
    findings: SecretFinding[]
    override_used: boolean
  }
  push_urls: string[]
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
  commitScanner?: typeof scanCommits
  secretsScanTimeoutMs?: number
}

interface ProbeRead {
  projectRoot: string
  destinationRef: string
  head: string
  probe: () => PushProbeResult
  treeReader: typeof getTreePaths
  rangeReader: typeof getRangePaths
}

function carriedByProbe(read: ProbeRead): { range: RangePathsResult; parsed: boolean } {
  const probed = read.probe()
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

function scanRange(args: { remote: string; tip: string; fetchUrl: string | null; pushUrls: readonly string[]; remotes: readonly string[] | null }): CommitRange {
  const own = args.remote.toLowerCase()
  const shadowed =
    args.remotes === null ||
    args.remotes.some((r) => r !== args.remote && (r.toLowerCase() === own || r.toLowerCase().startsWith(`${own}/`)))
  return !shadowed && args.fetchUrl !== null && sameRepository(args.fetchUrl, args.pushUrls)
    ? { tips: [args.tip], exclude: [], excludeRemote: args.remote }
    : { tips: [args.tip], exclude: [] }
}

function shownList(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return []
  if (items.length === 1) return [`${label}: ${specLabel(items[0]!, DIALOG_UNCUT)}`]
  return [`${label} (${items.length}):`, dialogList(items, items.length, DIALOG_UNCUT)]
}

export const requestPushTool: Tool = {
  name: 'rsct_request_push',
  description:
    "§C-gated push. Before any dialog: `remote` must be a CONFIGURED remote name (a URL or path is refused) and branch protection compares the RESOLVED push destination, so +main / HEAD:main / refs/heads/main are all recognised as main (a leading '-', a '*' glob refspec and an empty destination reject before git runs); a push with no branch resolved (HEAD not on a branch and no `branch` given) is refused; an armed review_drift lock refuses every push, as it refuses every commit; a protected destination needs pre_merge_ack and dev_approval.override_protected_branch; the push URLs are read (`git remote get-url --push --all`, git 2.7 or newer); and every commit the push carries is scanned for secrets (each commit's own diff, merge commits included; commits on the remote's tracking refs are skipped when every push URL names the same repository as the fetch URL and no other remote is named '<remote>/…', otherwise the whole history is read; what the push sends must be a commit), so a finding needs dev_approval.override_secrets_check. A scan that cannot finish refuses (secrets_unreadable). The forced OS dialog then lists every push URL (credentials masked), the destination and commit, a FORCE or DELETE in words, the protected branch, each secret finding as file:line, rule and commit (never the value), the pre_merge_ack answers and the push options sent, and after the framework footer the agent's reasons and ack note. The push URLs are read again after the dialog (push_url_changed if they moved). The push runs `git push` with an explicit full refspec, --no-follow-tags, --recurse-submodules=check when the repository config would push or check submodules (=no otherwise), and exactly the push options shown. Before the dialog it also lists every file in the hooks folder git runs and every configured key that runs a program (ssh command, credential helper, filters, merge drivers, signing, remote programs, transport helpers), with its origin and values masked, marking what is new or changed since the last approved call; the list is read again right before git runs (programs_moved), and a list that cannot be read refuses (programs_unreadable). A push to a local path lists that repository's own too, and the coverage dry run of a protected push runs only when nothing in the list is new (programs_changed). On rejection the approval is NOT consumed.",
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
        description: 'dev_approval payload. override_protected_branch and override_secrets_check are listed in the dialog with their reasons.',
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

  let pushUrls: string[] = []
  let findings: SecretFinding[] = []
  let commitsScanned: number | null = null
  const reject = (
    kind: RequestPushRejectKind,
    reason: string,
    opts: { protected?: boolean; channel?: GateChannel | null; signals?: FabricationSignal[]; audit?: Record<string, unknown>; hints?: string[] } = {},
  ): RequestPushOutput => {
    const audit = appendAudit(
      projectRoot,
      { event: 'request_push.rejected', tool: 'rsct_request_push', reject_kind: kind, reason, branch, remote, ...(pushUrls.length > 0 && { push_urls: pushUrls.map(maskUrl) }), ...opts.audit },
      config?.audit,
    )
    return {
      status: 'rejected',
      branch,
      remote,
      channel: opts.channel ?? null,
      reject_kind: kind,
      reason,
      fabrication_signals: opts.signals ?? [],
      branch_check: { protected: opts.protected ?? false, override_used: false },
      secrets_check: { commits_scanned: commitsScanned, findings_count: findings.length, findings, override_used: false },
      push_urls: pushUrls.map(maskUrl),
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories(opts.hints ?? [reason]),
    }
  }

  const remoteList = gitExecutor(projectRoot, ['remote'])
  let remoteNames: string[] | null = null
  if (remoteList.ok) {
    const names = remoteList.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    remoteNames = names
    if (!names.includes(remote)) {
      const reason =
        `remote ${JSON.stringify(remote)} is not a configured remote of this repository` +
        `${names.length > 0 ? ` (configured: ${names.join(', ')})` : ' (none configured)'}` +
        '. RSCT pushes only to NAMED remotes — a URL or path here would send the ' +
        'repository somewhere branch protection cannot see. Add it with `git remote add` first.'
      return reject('unknown_remote', reason, { audit: { configured_remotes: names } })
    }
  }

  const refspec = parsePushRefspec(branch ?? '')
  if (branch !== null && !refspec.ok) {
    return reject('unsafe_push_target', pushRefspecRejectReason(refspec.reason, branch), { audit: { refspec_reject: refspec.reason } })
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
  const deleting = refspec.ok && refspec.source.length === 0
  let probeResult: PushProbeResult | null = null
  const probe = (): PushProbeResult => {
    if (probeResult === null) {
      probeResult = explicitRefspec !== null ? (internal.pushProbe ?? defaultPushProbe)(projectRoot, remote, explicitRefspec) : { status: 'unavailable' }
    }
    return probeResult
  }
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
      const probeUrls = readPushUrls(projectRoot, remote, gitExecutor)
      const beforeProbe = probeUrls.ok ? checkGitPrograms(projectRoot, gitExecutor, config?.audit, { urls: probeUrls.value }) : null
      if (beforeProbe === null || !beforeProbe.ok || beforeProbe.fresh.length > 0) {
        return reject(
          beforeProbe !== null && beforeProbe.ok ? 'programs_changed' : 'programs_unreadable',
          "the coverage check needs a dry run of this push, because the remote-tracking ref is missing here, and that dry run would run hooks or configured programs that are new since the developer's last approved call, or that could not be listed — nothing ran. Any approved RSCT call records the current list; or the developer pushes by hand in their own terminal.",
          { protected: true, audit: { programs_new: beforeProbe?.ok === true ? beforeProbe.fresh.length : null } },
        )
      }
      const carried = carriedByProbe({
        projectRoot,
        destinationRef,
        head: sourceSha ?? rangeHead,
        probe,
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
      return reject('hygiene_range_unreadable', reason, { protected: true, audit: { path_crosscheck: crossCheck } })
    }
    const ackDecision = evaluatePreMergeAck(input.pre_merge_ack, {
      progressHasOpenItems: progressOpen,
      carriedPaths: range.status === 'ok' ? range.paths : null,
    })
    if (ackDecision.ok && range.status !== 'ok' && probeParsed) {
      return reject('hygiene_range_unreadable', crossCheckBlockedReason(range, 'push'), { protected: true, audit: { path_crosscheck: crossCheck } })
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
      return reject(ackDecision.kind, hint, {
        protected: true,
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
  }

  if (branch === null) {
    return reject('no_branch', 'no branch resolved — HEAD is not on a branch; pass `branch` explicitly or check out the branch to push. No dialog was shown.')
  }

  const drift = readDriftLock(projectRoot)
  if (drift.status === 'unreadable') {
    return reject('review_unreadable', `${drift.error} Nothing was pushed and no dialog was shown.`, { protected: branchProtected })
  }
  if (drift.status === 'armed') {
    return reject('review_drift', driftRefusal(drift.paths, 'every push'), { protected: branchProtected, audit: { drift_paths: drift.paths } })
  }

  const urls = readPushUrls(projectRoot, remote, gitExecutor)
  if (!urls.ok) return reject('push_url_unreadable', `${urls.reason}, so the dialog cannot show where this push goes — nothing was pushed.`, { protected: branchProtected })
  pushUrls = urls.value
  const programs = checkGitPrograms(projectRoot, gitExecutor, config?.audit, { urls: pushUrls })
  if (!programs.ok) {
    return reject('programs_unreadable', `${programs.reason}, so the hooks and programs git would run inside this push cannot be listed — nothing was pushed and no dialog was shown.`, { protected: branchProtected })
  }

  const raw = DevApprovalSchema.safeParse(input.dev_approval)
  const rawOverrides = raw.success ? { branch: raw.data.override_protected_branch, secrets: raw.data.override_secrets_check } : {}
  if (raw.success && branchProtected && !rawOverrides.branch) {
    return reject('protected_branch', `branch '${branchLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to push. No dialog was shown.`, { protected: true })
  }

  const options = readPushOptions(projectRoot, gitExecutor)
  if (!options.ok) return reject('push_options_unreadable', `${options.reason}, so the dialog cannot show what this push sends — nothing was pushed.`, { protected: branchProtected })
  const submodules = readSubmoduleMode(projectRoot, gitExecutor)

  let pushedCommit: string | null = null
  if (!deleting) {
    const sent = sourceSha ?? (refspec.ok ? refspec.source : branch)
    const tip = resolvePinned(projectRoot, sent, gitExecutor)
    pushedCommit = tip
    if (tip === null) {
      return reject(
        'secrets_unreadable',
        `what this push sends ('${specLabel(sent, DIALOG_PATH_LIMIT)}') is not a commit — a tree, a blob, or a tag on one — so it cannot be scanned for secrets; the developer pushes it by hand in their own terminal. No dialog was shown.`,
        { protected: branchProtected },
      )
    }
    const range = scanRange({ remote, tip, fetchUrl: readFetchUrl(projectRoot, remote, gitExecutor), pushUrls, remotes: remoteNames })
    const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled
    const scan = await (internal.commitScanner ?? scanCommits)(projectRoot, range, extras, internal.secretsScanTimeoutMs, gitExecutor)
    if (!scan.ok) {
      return reject(
        'secrets_unreadable',
        `the secrets scan could not read the commits this push carries (${scan.reason}), so it is refused rather than pushed unscanned — the developer pushes this by hand in their own terminal`,
        { protected: branchProtected },
      )
    }
    findings = scan.findings
    commitsScanned = scan.commits
  }
  if (raw.success && findings.length > 0 && !rawOverrides.secrets) {
    return reject(
      'secrets',
      `${findings.length} secret finding(s) in the commits this push carries — pass dev_approval.override_secrets_check: { reason } to push. No dialog was shown.`,
      { protected: branchProtected, audit: { findings_count: findings.length } },
    )
  }

  const ack = branchProtected ? ackDialogLines(input.pre_merge_ack) : { facts: [], note: [] }
  const shownDestination = destinationRef ?? destinationLabel ?? branchLabel
  const facts = [
    `Approve push of '${specLabel(branchLabel, DIALOG_PATH_LIMIT)}' to remote '${specLabel(remote, DIALOG_PATH_LIMIT)}'?`,
    ...(refspec.ok && (refspec.destination !== refspec.source || (destinationRef !== null && !destinationRef.startsWith('refs/heads/')))
      ? [`Destination: '${specLabel(destinationRef ?? refspec.destination, DIALOG_PATH_LIMIT)}'`]
      : []),
    ...(pushedCommit !== null ? [`Commit: ${pushedCommit.slice(0, 12)}`] : []),
    ...shownList('Push URL', pushUrls.map(maskUrl)),
    ...(refspec.ok && refspec.forced ? [`⚠ FORCE: replaces '${specLabel(shownDestination, DIALOG_PATH_LIMIT)}' on the remote even where its history differs; commits there can be lost.`] : []),
    ...(deleting ? [`⚠ DELETE: removes '${specLabel(shownDestination, DIALOG_PATH_LIMIT)}' from the remote.`] : []),
    ...(branchProtected ? [protectedBranchLine(destinationLabel ?? branchLabel, 'pushing here')] : []),
    ...(commitsScanned !== null && findings.length === 0 ? [`Secrets scan: ${commitsScanned} commit(s) read, nothing found.`] : []),
    ...secretFindingLines(projectRoot, 'push', findings),
    ...ack.facts,
    ...shownList('Push option sent', options.value),
    ...programsDialogLines(projectRoot, 'push', 'push', programs.read, programs.fresh),
    ...(submodules === 'check' ? ['Submodules: checked, never pushed.'] : []),
    ...(branchProtected && crossCheck === 'degraded'
      ? [
          '⚠ files_swept NOT checked: RSCT could not read what this push carries.' +
            (rangeHead !== null
              ? ` If the remote has no '${specLabel(destinationLabel ?? branchLabel, DIALOG_PATH_LIMIT)}' yet, this push carries the whole branch.`
              : ''),
        ]
      : []),
    ...(installAdvisory.dialogLine ? [installAdvisory.dialogLine] : []),
  ]
  const reasons = [
    ...agentReasonLine('the protected branch', branchProtected ? rawOverrides.branch : undefined),
    ...agentReasonLine('the secret findings', findings.length > 0 ? rawOverrides.secrets : undefined),
    ...ack.note,
  ]

  const gate = await gateRequest({
    toolName: 'rsct_request_push',
    approval: input.dev_approval,
    forceDialog: true,
    forceDialogReason: 'a push needs the developer in the OS dialog; a batch token covers commit only; with no dialog channel, the developer runs it by hand in their own terminal',
    dialog: {
      title: 'RSCT — push approval',
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
  const overrideSecrets = approval.override_secrets_check

  if (branchProtected && !overrideBranch) {
    return reject('protected_branch', `branch '${branchLabel}' is protected — pass dev_approval.override_protected_branch: { reason } to push`, {
      protected: true,
      channel: gate.channel,
      signals: gate.fabrication_signals,
      audit: { channel: gate.channel },
    })
  }
  if (findings.length > 0 && !overrideSecrets) {
    return reject('secrets', `${findings.length} secret finding(s) in the commits this push carries — pass dev_approval.override_secrets_check: { reason } to push`, {
      protected: branchProtected,
      channel: gate.channel,
      signals: gate.fabrication_signals,
      audit: { channel: gate.channel, findings_count: findings.length },
    })
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
  if (findings.length > 0 && overrideSecrets) {
    appendAudit(
      projectRoot,
      {
        event: 'request_push.override_invoked',
        tool: 'rsct_request_push',
        override_kind: 'secrets_check',
        override_reason: overrideSecrets.reason,
        findings_count: findings.length,
        branch,
        remote,
        channel: gate.channel,
      },
      config?.audit,
    )
  }

  const urlsNow = readPushUrls(projectRoot, remote, gitExecutor)
  if (!urlsNow.ok || urlsNow.value.join('\n') !== pushUrls.join('\n')) {
    return reject(
      'push_url_changed',
      `where '${specLabel(remote, DIALOG_PATH_LIMIT)}' pushes changed after the dialog, so the push would not go where the developer approved — ask again. The approval was not used.`,
      { protected: branchProtected, channel: gate.channel, signals: gate.fabrication_signals, audit: { channel: gate.channel, ...(urlsNow.ok && { push_urls_now: urlsNow.value.map(maskUrl) }) } },
    )
  }

  const programsNow = programsStillSame(programs, projectRoot, gitExecutor, { urls: pushUrls })
  if (!programsNow.ok) {
    return reject(programsNow.kind, `${programsNow.reason}. The approval was not used.`, { protected: branchProtected, channel: gate.channel, signals: gate.fabrication_signals, audit: { channel: gate.channel } })
  }
  appendAudit(projectRoot, baselineEntry(programs.read, programs.baseline), config?.audit)

  const secretsCheck = { commits_scanned: commitsScanned, findings_count: findings.length, findings, override_used: findings.length > 0 }
  const push = gitPush(projectRoot, remote, explicitRefspec ?? branch, gitExecutor, { submodules, pushOptions: options.value })
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
      secrets_check: secretsCheck,
      push_urls: pushUrls.map(maskUrl),
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: withAdvisories(['git push failed — approval NOT consumed. Fix the underlying error and retry with the same dev_approval.']),
    }
  }

  const record = recordApproval(approval, { projectRoot, now, auditConfig: config?.audit })
  const urlsAfter = readPushUrls(projectRoot, remote, gitExecutor)
  const urlsMoved = !urlsAfter.ok || urlsAfter.value.join('\n') !== pushUrls.join('\n')
  const audit = appendAudit(
    projectRoot,
    {
      event: 'request_push.pushed',
      tool: 'rsct_request_push',
      branch,
      remote,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      push_urls: pushUrls.map(maskUrl),
      ...(urlsMoved && { push_urls_after: urlsAfter.ok ? urlsAfter.value.map(maskUrl) : null }),
      commits_scanned: commitsScanned,
      secret_findings: findings.length,
      ...(crossCheck !== null && { path_crosscheck: crossCheck }),
    },
    config?.audit,
  )

  const hints: string[] = [`Pushed '${branch}' to '${remote}'.`]
  if (urlsMoved) {
    hints.push(`⚠ where '${remote}' pushes changed while git pushed; the push may have gone elsewhere than the dialog showed — check the remote before anything else.`)
  }
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
    const donePlan = findPlanByBranch(projectRoot, branch) ?? findActivePlan(projectRoot)
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
    secrets_check: secretsCheck,
    push_urls: pushUrls.map(maskUrl),
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints: withAdvisories(hints),
  }
}

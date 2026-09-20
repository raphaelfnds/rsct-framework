import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot, type RsctConfig } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  precheckPhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'
import {
  headStaleness,
  readPhaseState,
  refuseUnreadableState,
  stampReviewCompleted,
  writePhaseState,
  type PhaseState,
  type SweepLedgerEntry,
} from '../lib/phase-scope.js'
import { getHeadShaFull } from '../lib/git.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { promptYesNo } from '../lib/os-dialog.js'
import {
  FINDING_ACTIONS,
  checkFindingsGate,
  describeEvidenceMix,
  emptyActionsSummary,
  readFindingsBaseline,
  summarizeEvidence,
  type ActionsSummary,
  type EvidenceMix,
  type FindingsGateRejectKind,
  type StoredFinding,
} from '../lib/findings.js'
import {
  MIGRATION_DESTINATIONS,
  checkDispositions,
  computeWorkingSweep,
  driftCovered,
  knownPaths,
  normalizeRepoPath,
  stampLedger,
  sweepEntry,
  workingBlobIds,
  type Disposition,
  type ExemptReason,
  type PendingDisposition,
  type SweepFile,
} from '../lib/comment-sweep/review.js'
import { openSweepRepo } from '../lib/comment-sweep/git-reads.js'
import {
  checkDeadCode,
  type DeadCodeRejectKind,
  type PendingDeadSymbol,
} from '../lib/dead-code/review-gate.js'
import { validateDevApproval } from '../lib/dev-approval.js'
import { inferRejectKind, type GateRejectKind } from '../lib/request-gate.js'

const findingActionSchema = z
  .object({
    finding_id: z.string().min(1, 'finding_id required'),
    action: z.enum(FINDING_ACTIONS),
    note: z.string().optional(),
  })
  .strict()

const dispositionSchema = z
  .object({
    comment_id: z.string().min(1),
    action: z.enum(['migrated', 'discarded']),
    destination: z.string().optional(),
  })
  .strict()

const exemptFileSchema = z
  .object({
    path: z.string().min(1),
    reason: z.enum(['generated', 'vendored']),
  })
  .strict()

const deadCodeKeepSchema = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1),
    declaration_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'declaration_sha256 must be a sha256 hex digest'),
    note: z.string().min(1, 'a keep needs the reason the developer gave'),
  })
  .strict()

const sweepInputSchema = z.object({
  comment_dispositions: z.array(dispositionSchema).optional(),
  exempt_files: z.array(exemptFileSchema).optional(),
  dead_code_keeps: z.array(deadCodeKeepSchema).optional(),
})

export const phaseReviewCompleteInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    dev_approval: z.unknown(),
    findings_actions: z
      .array(findingActionSchema)
      .default([])
      .describe(
        'One action per finding declared at rsct_phase_review_start — EVERY declared finding needs one, or completion is rejected. Any action="block" aborts completion.',
      ),
    findings_run_id: z
      .string()
      .optional()
      .describe(
        'The findings_run_id returned by rsct_phase_review_start. Echo it back so answers prepared before a re-run are rejected as a stale set.',
      ),
    comment_dispositions: z.unknown().optional(),
    exempt_files: z.unknown().optional(),
    dead_code_keeps: z
      .unknown()
      .optional()
      .describe(
        'One entry per dead symbol the DEVELOPER decided to keep: path, name, the declaration_sha256 from pending_dead_code, and the reason they gave. A keep is bound to those exact declaration bytes — editing the declaration asks again.',
      ),
  })
  .strict()

export type PhaseReviewCompleteInput = z.infer<typeof phaseReviewCompleteInputSchema>

export type PhaseReviewSweepRejectKind =
  | 'sweep_input_invalid'
  | 'not_git_repo'
  | 'git_read_failed'
  | 'comments_remaining'
  | 'dispositions_missing'
  | 'disposition_unknown'
  | 'disposition_duplicate'
  | 'migration_missing'
  | 'unverified_declined'
  | 'unverified_undecided'
  | DeadCodeRejectKind

export type PhaseReviewCompleteRejectKind =
  | GateRejectKind
  | FindingsGateRejectKind
  | 'block_actions_present'
  | PhaseReviewSweepRejectKind

export interface CommentSweepSummary {
  files: Array<{
    path: string
    kind: SweepFile['kind']
    language: string | null
    reason: string | null
    blob: string | null
    comments: Array<{ id: string; line: number; body: string }>
  }>
  removed_count: number
  migrated: number
  discarded: number
  unverified: string[]
  allowlist_changes: Array<{ path: string; line: number; body: string }>
  stamped: string[]
  changed_during_dialog: string[]
  report_path: string | null
}

export type PhaseReviewCompleteOutput = Omit<CompletePhaseResult, 'reject_kind'> & {
  reject_kind: CompletePhaseResult['reject_kind'] | PhaseReviewSweepRejectKind
  actions_summary: ActionsSummary
  evidence_mix: EvidenceMix
  head_stale: boolean | null
  open_findings?: StoredFinding[]
  pending_dispositions?: PendingDisposition[]
  pending_dead_code?: PendingDeadSymbol[]
  comment_sweep: CommentSweepSummary | null
}

export const phaseReviewCompleteTool: Tool = {
  name: 'rsct_phase_review_complete',
  description:
    '§C-gated REVIEW phase closure — the last phase of the cycle (R→S→V→C→T→REVIEW), mandatory at every tier. Before any dialog it recomputes the files this change touched (git, against HEAD, untracked included) and sweeps them for comments: a code file that still carries a comment rejects (comments_remaining); every comment the change removed (renamed and deleted files included) needs one entry in comment_dispositions — "discarded", or "migrated" with a destination among documentation/decisions.md, documentation/knowledge/anti-decisions.md, docs/decisions.md where the comment text must appear in the lines added to that file (dispositions_missing returns pending_dispositions). Functional comments (shebang, licence header, tool directives) are kept by a closed allowlist. Files the sweep cannot verify (unsupported or unknown language, undeclared sql_dialect, parse error, git filter) and files you list in exempt_files as generated or vendored go to a forced OS dialog: Yes makes those exact file versions committable without a mechanical check, No rejects the REVIEW. When comments were removed, files are unverified or an allowlisted comment changed, the §C dialog is forced (trust_allowed_for ignored) and names a report under .rsct/reports/. Reasons a file is unverified: unsupported_language, unknown_extension, sql_dialect_missing, parse_error, binary_or_encoding, engine_unavailable, git_filter, head_unverified (its HEAD version could not be scanned), generated, vendored. On success it stamps a sweep ledger (path + git blob id; deleted files included) that rsct_request_commit requires for every staged code file; paths a previous commit left as review_drift are re-checked here even when unchanged. A behaviour fix made during this REVIEW changes the stamped bytes: re-run the tests (rsct_phase_test_start / _complete), then this REVIEW again. Pass findings_actions[] with a decision for EVERY finding declared at rsct_phase_review_start — leaving any unanswered rejects completion and returns open_findings. Any entry with action="block" aborts completion BEFORE the §C dialog. Suggested action_scope: "review_complete:spec_ref=<X>".',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'dev_approval'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: {
        type: 'string',
        description: 'Must match the spec_ref of the open REVIEW phase.',
      },
      dev_approval: { type: 'object' },
      findings_run_id: {
        type: 'string',
        description:
          'The findings_run_id returned by rsct_phase_review_start. Echo it back so an answer set prepared before a re-run is rejected as stale.',
      },
      findings_actions: {
        type: 'array',
        description:
          'One action per finding declared at rsct_phase_review_start — every declared finding needs one or completion is rejected. action="block" aborts completion.',
        items: {
          type: 'object',
          required: ['finding_id', 'action'],
          properties: {
            finding_id: { type: 'string' },
            action: { type: 'string', enum: [...FINDING_ACTIONS] },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      comment_dispositions: {
        type: 'array',
        description:
          'One entry per comment this change removed (ids from rsct_phase_review_start comment_sweep or from pending_dispositions). migrated needs destination.',
        items: {
          type: 'object',
          required: ['comment_id', 'action'],
          properties: {
            comment_id: { type: 'string' },
            action: { type: 'string', enum: ['migrated', 'discarded'] },
            destination: { type: 'string', enum: [...MIGRATION_DESTINATIONS] },
          },
          additionalProperties: false,
        },
      },
      dead_code_keeps: {
        type: 'array',
        description:
          'One entry per dead symbol the DEVELOPER decided to keep. Take path, name and declaration_sha256 verbatim from pending_dead_code, and put the reason they gave in note. The keep is bound to those declaration bytes: edit the declaration and it is asked again.',
        items: {
          type: 'object',
          required: ['path', 'name', 'declaration_sha256', 'note'],
          properties: {
            path: { type: 'string' },
            name: { type: 'string' },
            declaration_sha256: { type: 'string' },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      exempt_files: {
        type: 'array',
        description:
          'Generated or vendored code files that keep their comments, as repository-relative or project-relative paths (either slash). Each goes to the developer-only unverified dialog, bound to its exact version.',
        items: {
          type: 'object',
          required: ['path', 'reason'],
          properties: {
            path: { type: 'string' },
            reason: { type: 'string', enum: ['generated', 'vendored'] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
}

function summarize(files: SweepFile[]): CommentSweepSummary {
  return {
    files: files.map((f) => ({
      path: f.path,
      kind: f.kind,
      language: f.language,
      reason: f.reason,
      blob: f.blob,
      comments: f.comments.map((c) => ({ id: c.id, line: c.line, body: c.body })),
    })),
    removed_count: files.reduce((n, f) => n + f.removed.length, 0),
    migrated: 0,
    discarded: 0,
    unverified: files.filter((f) => f.kind === 'unverified').map((f) => f.path),
    allowlist_changes: files.flatMap((f) => f.allowlist_changes.map((c) => ({ path: f.path, line: c.line, body: c.body }))),
    stamped: [],
    changed_during_dialog: [],
    report_path: null,
  }
}

function listLines(items: string[], limit: number): string {
  const head = items.slice(0, limit).map((i) => `• ${i}`)
  if (items.length > limit) head.push(`… and ${items.length - limit} more`)
  return head.join('\n')
}

function writeReport(
  projectRoot: string,
  specRef: string,
  files: SweepFile[],
  dispositions: readonly Disposition[],
): { path: string; sha256: string } | null {
  const byId = new Map(dispositions.map((d) => [d.comment_id, d]))
  const lines: string[] = [`# REVIEW comment sweep — ${specRef}`, '']
  for (const f of files) {
    lines.push(`## ${f.path} (${f.kind}${f.reason ? `: ${f.reason}` : ''})`)
    for (const c of f.removed) {
      const d = byId.get(c.id)
      lines.push(`- HEAD line ${c.line} — ${d ? (d.action === 'migrated' ? `migrated to ${d.destination}` : 'discarded') : 'no disposition'}: ${c.body}`)
    }
    for (const c of f.allowlist_changes) lines.push(`- allowlisted, line ${c.line}: ${c.body}`)
    lines.push('')
  }
  const content = `${lines.join('\n')}\n`
  const sha256 = createHash('sha256').update(content).digest('hex')
  const rel = join('.rsct', 'reports', `review-comments-${sha256.slice(0, 16)}.md`)
  try {
    mkdirSync(join(projectRoot, '.rsct', 'reports'), { recursive: true })
    writeFileSync(join(projectRoot, rel), content, 'utf8')
    return { path: rel.replace(/\\/g, '/'), sha256 }
  } catch {
    return null
  }
}

interface RejectArgs {
  projectRoot: string
  config: RsctConfig | null
  specRef: string
  rejectKind: PhaseReviewCompleteRejectKind
  reason: string
  hints: string[]
  actions_summary: ActionsSummary
  evidence_mix: EvidenceMix
  head_stale: boolean | null
  comment_sweep: CommentSweepSummary | null
  appendAudit: typeof appendAuditEntry
  extra?: Record<string, unknown>
  open_findings?: StoredFinding[]
  pending_dispositions?: PendingDisposition[]
  pending_dead_code?: PendingDeadSymbol[]
}

function reject(args: RejectArgs): PhaseReviewCompleteOutput {
  const audit = args.appendAudit(
    args.projectRoot,
    {
      event: 'review.complete.rejected',
      tool: 'rsct_phase_review_complete',
      spec_ref: args.specRef,
      reject_kind: args.rejectKind,
      ...args.extra,
    },
    args.config?.audit,
  )
  return {
    status: 'rejected',
    phase: 'review',
    spec_ref: args.specRef,
    channel: null,
    reject_kind: args.rejectKind,
    reason: args.reason,
    fabrication_signals: [],
    cleared: false,
    next_recommended_phase: 'review',
    ...auditFields(audit),
    anti_replay_persisted: null,
    anti_replay_error: null,
    hints: args.hints,
    actions_summary: args.actions_summary,
    evidence_mix: args.evidence_mix,
    head_stale: args.head_stale,
    comment_sweep: args.comment_sweep,
    ...(args.open_findings !== undefined && { open_findings: args.open_findings }),
    ...(args.pending_dispositions !== undefined && { pending_dispositions: args.pending_dispositions }),
    ...(args.pending_dead_code !== undefined && { pending_dead_code: args.pending_dead_code }),
  }
}

export async function phaseReviewCompleteHandler(
  rawInput: unknown,
  internal: CompletePhaseInternal = {},
): Promise<PhaseReviewCompleteOutput> {
  const input = phaseReviewCompleteInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()

  const actions_summary = emptyActionsSummary()
  for (const fa of input.findings_actions) actions_summary[fa.action]++

  const stored = readPhaseState(projectRoot).state?.review_findings
  const baseline = readFindingsBaseline(stored?.findings)
  const evidence_mix = summarizeEvidence(baseline)
  const staleness = headStaleness(stored?.head_sha, getHeadShaFull(projectRoot))
  const base = { projectRoot, config, specRef: input.spec_ref, actions_summary, evidence_mix, head_stale: staleness.head_stale, appendAudit }

  const sweepInput = sweepInputSchema.safeParse({
    comment_dispositions: input.comment_dispositions,
    exempt_files: input.exempt_files,
    dead_code_keeps: input.dead_code_keeps,
  })
  if (!sweepInput.success) {
    const reason = `comment_dispositions / exempt_files / dead_code_keeps are malformed: ${sweepInput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    return reject({ ...base, rejectKind: 'sweep_input_invalid', reason, hints: [reason], comment_sweep: null })
  }
  const dispositions: Disposition[] = sweepInput.data.comment_dispositions ?? []

  const precheck = precheckPhaseComplete(
    { projectRoot, phase: 'review', specRef: input.spec_ref, devApproval: input.dev_approval },
    config,
    internal,
  )
  if (precheck) {
    return { ...precheck, actions_summary, evidence_mix, head_stale: staleness.head_stale, comment_sweep: null }
  }

  const findingsGate = checkFindingsGate({
    baseline,
    storedRunId: stored?.run_id ?? null,
    suppliedRunId: input.findings_run_id ?? null,
    actions: input.findings_actions,
    storedSpecRef: stored?.spec_ref ?? null,
    specRef: input.spec_ref,
  })
  if (!findingsGate.ok) {
    return reject({
      ...base,
      rejectKind: findingsGate.reject_kind!,
      reason: findingsGate.reason!,
      hints: [
        findingsGate.reason!,
        `findings_run_id for this review is '${stored?.run_id ?? '(none)'}'. Send one action per finding listed in open_findings, then retry.`,
      ],
      comment_sweep: null,
      extra: { open_findings_count: findingsGate.open_findings?.length ?? 0 },
      open_findings: findingsGate.open_findings ?? [],
    })
  }

  if (actions_summary.block > 0) {
    const reason = `${actions_summary.block} review finding(s) marked action="block". Resolve them, then re-run rsct_phase_review_complete.`
    return reject({
      ...base,
      rejectKind: 'block_actions_present',
      reason,
      hints: [
        `REVIEW is not complete: ${actions_summary.block} finding(s) are blocking. Fix them or downgrade the action with the dev — a blocking finding is the one thing this phase will not wave through.`,
      ],
      comment_sweep: null,
      extra: { blocked_count: actions_summary.block },
    })
  }

  const sweepRepo = openSweepRepo(projectRoot)
  const exempt = new Map<string, ExemptReason>(
    (sweepInput.data.exempt_files ?? []).map((e) => [sweepRepo ? normalizeRepoPath(sweepRepo, e.path) : e.path, e.reason]),
  )
  const driftBefore = readPhaseState(projectRoot).state?.review_drift
  const sweep = await computeWorkingSweep(projectRoot, {
    sqlDialect: config?.sql_dialect,
    exempt,
    extraPaths: driftBefore?.paths ?? [],
  })
  if (!sweep.ok) {
    const reason =
      sweep.reason === 'not_git_repo'
        ? 'the comment sweep needs a git repository — REVIEW compares the change against HEAD'
        : `the comment sweep could not read git: ${sweep.detail}`
    return reject({ ...base, rejectKind: sweep.reason, reason, hints: [reason], comment_sweep: null })
  }
  const summary = summarize(sweep.files)

  const withComments = sweep.files.filter((f) => f.kind === 'comments_present')
  if (withComments.length > 0) {
    const reason = `${withComments.length} touched code file(s) still carry comments: ${withComments.map((f) => f.path).join(', ')}`
    return reject({
      ...base,
      rejectKind: 'comments_remaining',
      reason,
      hints: [reason, 'Remove every comment (a measured fact migrates to a decisions file first), then retry.'],
      comment_sweep: summary,
      extra: { paths: withComments.map((f) => f.path) },
    })
  }

  const deadCheck = await checkDeadCode({
    projectRoot,
    touched: sweep.files.filter((f) => f.status !== 'deleted').map((f) => f.path),
    publicApi: config?.public_api,
    keeps: sweepInput.data.dead_code_keeps ?? [],
  })
  if (!deadCheck.ok) {
    return reject({
      ...base,
      rejectKind: deadCheck.reject_kind,
      reason: deadCheck.reason,
      hints: [deadCheck.reason, ...deadCheck.hints],
      comment_sweep: summary,
      extra: { dead_symbols: deadCheck.pending.length },
      pending_dead_code: deadCheck.pending,
    })
  }

  const dispositionCheck = checkDispositions(sweep.repo, sweep.files, dispositions)
  if (!dispositionCheck.ok) {
    return reject({
      ...base,
      rejectKind: dispositionCheck.reject_kind,
      reason: dispositionCheck.reason,
      hints: [dispositionCheck.reason, 'pending_dispositions lists each removed comment with its HEAD line and text.'],
      comment_sweep: summary,
      extra: { pending_count: dispositionCheck.pending.length },
      pending_dispositions: dispositionCheck.pending,
    })
  }
  summary.migrated = dispositionCheck.migrated
  summary.discarded = dispositionCheck.discarded

  const removedFiles = sweep.files.filter((f) => f.removed.length > 0)
  const unverified = sweep.files.filter((f) => f.kind === 'unverified')
  const mustForce = summary.removed_count > 0 || unverified.length > 0 || summary.allowlist_changes.length > 0
  const report = mustForce ? writeReport(projectRoot, input.spec_ref, sweep.files, dispositions) : null
  summary.report_path = report?.path ?? null
  const reportLine = report
    ? `Full list: ${report.path} (sha256 ${report.sha256.slice(0, 16)})`
    : 'Full list: report could not be written.'

  if (unverified.length > 0) {
    const validation = validateDevApproval(input.dev_approval, {
      projectRoot,
      toolName: 'rsct_phase_review_complete',
      ...(config?.approval_modes !== undefined && { approvalModes: config.approval_modes }),
      ...(internal.now !== undefined && { now: internal.now }),
      auditConfig: config?.audit,
    })
    if (validation.status === 'rejected') {
      return reject({
        ...base,
        rejectKind: inferRejectKind(validation.reason),
        reason: validation.reason,
        hints: [`Approval rejected before any dialog: ${validation.reason}`],
        comment_sweep: summary,
      })
    }
    const dialog = await promptFn({
      title: `RSCT — ${unverified.length} file(s) the comment sweep cannot verify`,
      message:
        `Spec '${input.spec_ref}'. These exact file versions would become committable WITHOUT a mechanical comment check:\n\n` +
        listLines(
          unverified.map((f) => `${f.path} — ${f.reason} (${(f.blob ?? '').slice(0, 10)})`),
          40,
        ) +
        `\n${reportLine}` +
        `\n\nYes = allow these versions. No = reject this REVIEW.`,
    })
    if (dialog.response !== 'yes') {
      const declined = dialog.response === 'no'
      if (declined) {
        for (const f of unverified) {
          appendAudit(
            projectRoot,
            { event: 'review.unverified_decision', tool: 'rsct_phase_review_complete', spec_ref: input.spec_ref, path: f.path, blob: f.blob, reason: f.reason, answer: 'no' },
            config?.audit,
          )
        }
      }
      const reason = declined
        ? 'the developer declined the unverified files — take them out of the change or make them scannable'
        : `the unverified-files dialog could not be shown (${dialog.error ?? 'no channel'}) — only the developer can allow unverified files`
      return reject({
        ...base,
        rejectKind: declined ? 'unverified_declined' : 'unverified_undecided',
        reason,
        hints: [reason],
        comment_sweep: summary,
        extra: { unverified: unverified.map((f) => f.path) },
      })
    }
  }

  const byId = new Map(dispositions.map((d) => [d.comment_id, d]))
  const removedLines = removedFiles.flatMap((f) => f.removed.map((c) => ({ c, d: byId.get(c.id) })))
  const detailParts = [`Evidence: ${describeEvidenceMix(evidence_mix)}`]
  if (mustForce) {
    detailParts.push(
      `Comments removed: ${summary.removed_count} (migrated ${summary.migrated}, discarded ${summary.discarded}).`,
      listLines(
        removedLines.map(({ c, d }) => `${c.path}:${c.line} ${d?.action === 'migrated' ? '→ migrated' : '→ discarded'}: ${c.body.slice(0, 80)}`),
        10,
      ),
    )
    if (unverified.length > 0) detailParts.push(`Unverified files allowed: ${unverified.length}.`)
    if (summary.allowlist_changes.length > 0) {
      detailParts.push(
        `Allowlisted comments added or changed: ${summary.allowlist_changes.length}.`,
        listLines(
          summary.allowlist_changes.map((c) => `${c.path}:${c.line} kept: ${c.body.slice(0, 120)}`),
          10,
        ),
      )
    }
    detailParts.push(reportLine)
  }

  const result = await gatePhaseComplete(
    { projectRoot, phase: 'review', specRef: input.spec_ref, devApproval: input.dev_approval },
    config,
    {
      ...internal,
      dialogDetail: detailParts.filter(Boolean).join('\n'),
      ...(mustForce && {
        forceDialog: true,
        forceDialogReason: 'this REVIEW removed comments, allows unverified files or changes allowlisted comments',
      }),
    },
  )

  const output: PhaseReviewCompleteOutput = {
    ...result,
    actions_summary,
    evidence_mix,
    head_stale: staleness.head_stale,
    comment_sweep: summary,
  }
  if (result.status !== 'completed') {
    output.hints.push(`Evidence: ${describeEvidenceMix(evidence_mix)}.`)
    return output
  }

  const at = now.toISOString()
  const channel = result.channel ?? 'unknown'
  const present = sweep.files.filter((f) => f.kind !== 'deleted' && f.blob !== null).map((f) => f.path)
  const currentIds = workingBlobIds(sweep.repo, present) ?? new Map<string, string>()
  const stamps: Array<{ path: string; entry: SweepLedgerEntry }> = []
  for (const f of sweep.files) {
    if (f.blob === null || f.kind === 'comments_present') continue
    if (f.kind === 'deleted') {
      stamps.push({
        path: f.path,
        entry: sweepEntry(f.blob, 'clean', dispositionCheck.migrations.get(f.path) ?? [], channel, input.spec_ref, at),
      })
      continue
    }
    if (currentIds.get(f.path) !== f.blob) {
      summary.changed_during_dialog.push(f.path)
      continue
    }
    const verdict = f.kind === 'clean' ? 'clean' : 'unverified_authorized'
    stamps.push({
      path: f.path,
      entry: sweepEntry(f.blob, verdict, dispositionCheck.migrations.get(f.path) ?? [], channel, input.spec_ref, at),
    })
  }

  let auditOk = true
  for (const s of stamps) {
    if (s.entry.verdict === 'unverified_authorized') {
      const file = unverified.find((f) => f.path === s.path)
      const w = appendAudit(
        projectRoot,
        { event: 'review.unverified_decision', tool: 'rsct_phase_review_complete', spec_ref: input.spec_ref, path: s.path, blob: s.entry.blob, reason: file?.reason ?? null, answer: 'yes' },
        config?.audit,
      )
      if (!w.ok) auditOk = false
    }
    const w = appendAudit(
      projectRoot,
      { event: 'review.sweep_stamped', tool: 'rsct_phase_review_complete', spec_ref: input.spec_ref, path: s.path, blob: s.entry.blob, verdict: s.entry.verdict, channel, migrations: s.entry.migrations.length },
      config?.audit,
    )
    if (!w.ok) auditOk = false
  }

  if (!auditOk) {
    output.hints.push('⚠ REVIEW completed, but the audit log could not record the sweep, so no file was stamped — rsct_request_commit will ask for a new REVIEW. Check .rsct/audit.log and re-run the REVIEW.')
  } else {
    const freshRead = readPhaseState(projectRoot)
    const freshRefusal = refuseUnreadableState(projectRoot, freshRead)
    const fresh = freshRead.state ?? {}
    const next: PhaseState = { ...fresh, review_sweep: stampLedger(fresh.review_sweep, stamps, knownPaths(projectRoot)) }
    if (fresh.review_drift) {
      const { open } = driftCovered(projectRoot, next.review_sweep, fresh.review_drift.paths)
      if (open.length === 0) delete next.review_drift
      else next.review_drift = { ...fresh.review_drift, paths: open }
    }
    const w = freshRefusal ?? writePhaseState(projectRoot, next)
    if (w.ok) summary.stamped = stamps.map((s) => s.path)
    else
      output.hints.push(
        `⚠ REVIEW completed, but the sweep ledger could not be written (${w.reason}${w.reason === 'unreadable_state' ? `: ${w.error}` : ''}) — rsct_request_commit will ask for a new REVIEW.`,
      )
  }
  if (summary.changed_during_dialog.length > 0) {
    output.hints.push(`⚠ ${summary.changed_during_dialog.length} file(s) changed while the dialog was open and were not stamped: ${summary.changed_during_dialog.join(', ')}.`)
  }

  const stamp = stampReviewCompleted(projectRoot, { spec_ref: input.spec_ref, completed_at: at })
  if (!stamp.ok) {
    output.hints.push(`⚠ review phase completed but I could not stamp completed_at into the review block (${stamp.reason}).`)
  }
  const s = readPhaseState(projectRoot)
  if (stamp.ok && s.state?.review_findings !== undefined) {
    const next: PhaseState = { ...s.state }
    delete next.review_findings
    const pruned = writePhaseState(projectRoot, next)
    if (!pruned.ok) {
      output.hints.push(`⚠ review completed but the declared findings could not be pruned from phase state (${pruned.reason}) — rsct_phase_status keeps listing them until they are.`)
    }
  }

  appendAudit(
    projectRoot,
    {
      event: 'review.evidence_mix',
      tool: 'rsct_phase_review_complete',
      spec_ref: input.spec_ref,
      evidence_mix,
      head_stale: staleness.head_stale,
      head_sha_at_start: staleness.head_sha_at_start,
      head_sha_now: staleness.head_sha_now,
    },
    config?.audit,
  )
  for (const fa of input.findings_actions) {
    appendAudit(
      projectRoot,
      {
        event: 'review.action',
        tool: 'rsct_phase_review_complete',
        spec_ref: input.spec_ref,
        finding_id: fa.finding_id,
        action: fa.action,
        ...(fa.note ? { note: fa.note } : {}),
      },
      config?.audit,
    )
  }

  output.hints.push(`Evidence: ${describeEvidenceMix(evidence_mix)}.`)
  if (staleness.head_stale === true) {
    output.hints.push(
      `⚠ HEAD moved since these findings were declared (${staleness.head_sha_at_start?.slice(0, 12)} → ${staleness.head_sha_now?.slice(0, 12)}). That happens when non-code changes, or code an earlier REVIEW stamped, were committed while this review was open — any finding anchored to a line number was read against the earlier tree.`,
    )
  }
  return output
}

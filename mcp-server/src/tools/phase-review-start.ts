import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  startPhaseGeneric,
  type StartPhaseInput,
  type StartPhaseInternal,
  type StartPhaseResult,
} from '../lib/phase-machine.js'
import {
  computeRunId,
  describeEvidenceMix,
  evidenceJsonSchema,
  evidenceSchema,
  readFindingsBaseline,
  summarizeEvidence,
  type EvidenceMix,
} from '../lib/findings.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import { getHeadShaFull } from '../lib/git.js'
import { computeWorkingSweep } from '../lib/comment-sweep/review.js'
import {
  readPhaseState,
  type PhaseFindingsBlock,
  type PhaseReviewBlock,
  type PhaseState,
} from '../lib/phase-scope.js'

const declaredFindingSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().optional(),
    severity: z.string().optional(),
    path: z.string().optional(),
    line: z.number().optional(),
    evidence: evidenceSchema.optional(),
  })
  .strict()

export const phaseReviewStartInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z.string().min(1),
    spec_slug: z.string().optional(),
    scope_globs: z.array(z.string()).optional(),
    persona: z.string().optional(),
    findings: z
      .array(declaredFindingSchema)
      .refine(
        (fs) => new Set(fs.map((f) => f.id)).size === fs.length,
        (fs) => ({
          message: `findings[] reuses the same id (${[
            ...new Set(fs.map((f) => f.id).filter((id, i, all) => all.indexOf(id) !== i)),
          ].join(', ')}). Each finding needs a distinct id — one action must map to exactly one finding.`,
        }),
      )
      .optional(),
  })
  .strict()

export type PhaseReviewStartInput = z.infer<typeof phaseReviewStartInputSchema>

export type DeclaredFinding = z.infer<typeof declaredFindingSchema>

export type PhaseReviewStartOutput = StartPhaseResult & {
  findings: DeclaredFinding[]
  findings_run_id: string | null
  evidence_mix: EvidenceMix
  comment_sweep: {
    files: Array<{
      path: string
      status: string
      kind: string
      language: string | null
      reason: string | null
      comments: Array<{ id: string; line: number; body: string }>
      removed: Array<{ id: string; head_line: number; body: string }>
    }>
  } | null
}

export const phaseReviewStartTool: Tool = {
  name: 'rsct_phase_review_start',
  description:
    'Start the REVIEW phase — an adversarial code review of the diff, code and tests together, as the last phase of the cycle (R→S→V→C→T→REVIEW). Mandatory at every tier: rsct_request_commit refuses code that no completed REVIEW covers. Writes phase="review" into .rsct/phase-state.json and emits review.start audit. Run it after rsct_phase_test_complete. Do the review here (hunt correctness/security/regression/cross-OS bugs in the diff, plus hygiene: dead code, scaffolding left from an approach abandoned inside this same task, and tool/parameter descriptions that no longer match the code — e.g. via the qa + senior-dev personas or /code-review). The output carries comment_sweep: every touched code file with its remaining comments and the comments the change removed (each needs a disposition at _complete); remove every comment, migrating measured facts to a decisions file first, then declare what you found via findings[] and call rsct_phase_review_complete. DECLARING A FINDING COMMITS YOU TO RESOLVING IT: every declared finding needs an action at _complete or the phase will not close. Re-running this tool REPLACES the declared set and reopens the review. NOTE: this is the review PHASE, distinct from rsct_persona_review (a stateless advisory lens). Refuses if a different phase is already active.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: {
        type: 'string',
        description:
          'The spec this review covers. Must match the one you pass to rsct_phase_review_complete.',
      },
      spec_slug: { type: 'string', description: 'Plan slug, when it differs from spec_ref.' },
      scope_globs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths this review covers, for the edit-scope guard.',
      },
      persona: { type: 'string', description: 'Optional persona lens for the review (e.g. qa, senior-dev).' },
      findings: {
        type: 'array',
        description:
          'What the review actually surfaced. Each entry needs a stable id you choose (e.g. "r-bug-1"), a category and a title; path/line anchor it. Every finding declared here must be given an action at rsct_phase_review_complete before the phase can close, so declare what you genuinely found — not a placeholder.',
        items: {
          type: 'object',
          required: ['id', 'category', 'title'],
          properties: {
            id: { type: 'string' },
            category: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' },
            severity: { type: 'string' },
            path: { type: 'string' },
            line: { type: 'number' },
            evidence: evidenceJsonSchema,
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
}

export interface PhaseReviewStartInternal extends StartPhaseInternal {}

export async function phaseReviewStartHandler(
  rawInput: unknown,
  internal: PhaseReviewStartInternal = {},
): Promise<PhaseReviewStartOutput> {
  const input = phaseReviewStartInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const args: StartPhaseInput = {
    projectRoot: resolution.root,
    phase: 'review',
    specRef: input.spec_ref,
  }
  if (input.spec_slug !== undefined) args.specSlug = input.spec_slug
  if (input.scope_globs !== undefined) args.scopeGlobs = input.scope_globs
  if (input.persona !== undefined) args.persona = input.persona

  const declared = input.findings ?? []

  const runId = declared.length > 0 ? computeRunId(declared) : null

  const previous = readPhaseState(resolution.root).state
  const hadFindings = previous?.review_findings !== undefined
  const declaredAt = (internal.now ?? new Date()).toISOString()
  const headSha = getHeadShaFull(resolution.root)

  const patch = (state: PhaseState): void => {
    if (runId === null) {
      delete state.review_findings
    } else {
      const block: PhaseFindingsBlock = {
        spec_ref: input.spec_ref,
        run_id: runId,
        findings: declared,
        declared_at: declaredAt,
        observed_at: declaredAt,
      }
      if (headSha !== null) block.head_sha = headSha
      state.review_findings = block
    }

    if (state.review?.completed_at !== undefined) {
      const reopened: PhaseReviewBlock = { ...state.review }
      delete reopened.completed_at
      state.review = reopened
    }
  }

  const result = await startPhaseGeneric(args, resolution.config, {
    ...internal,
    patch,
  })

  if (hadFindings && result.status === 'started') {
    const discarded = readFindingsBaseline(previous?.review_findings?.findings) ?? []
    const audit = (internal.auditWriter ?? appendAuditEntry)(
      resolution.root,
      {
        event: 'review.findings_replaced',
        tool: 'rsct_phase_review_start',
        spec_ref: input.spec_ref,
        previous_spec_ref: previous?.review_findings?.spec_ref ?? null,
        previous_run_id: previous?.review_findings?.run_id ?? null,
        discarded_count: discarded.length,
        discarded_ids: discarded.map((f) => f.id),
        declared_count: declared.length,
      },
      resolution.config?.audit,
    )
    const fields = auditFields(audit)
    if (fields.audit_error) result.audit_error = fields.audit_error
    result.hints.push(
      `A previous review had declared ${discarded.length} finding(s); this run replaced them${
        runId === null ? ' with nothing' : ''
      }. Any findings_actions prepared from that run are now stale — answer the findings returned here.`,
    )
  }

  const persisted = result.status === 'started' && result.phase_state_written
  const evidence_mix = summarizeEvidence(persisted ? declared : null)
  if (persisted && declared.length > 0) {
    result.hints.push(`Evidence: ${describeEvidenceMix(evidence_mix)}.`)
  }
  const sweep = await computeWorkingSweep(resolution.root, { sqlDialect: resolution.config?.sql_dialect })
  const comment_sweep = sweep.ok
    ? {
        files: sweep.files.map((f) => ({
          path: f.path,
          status: f.status,
          kind: f.kind,
          language: f.language,
          reason: f.reason,
          comments: f.comments.map((c) => ({ id: c.id, line: c.line, body: c.body })),
          removed: f.removed.map((c) => ({ id: c.id, head_line: c.line, body: c.body })),
        })),
      }
    : null
  if (!sweep.ok) {
    result.hints.push(`Comment sweep unavailable (${sweep.detail}) — rsct_phase_review_complete will reject until it can read git.`)
  } else {
    const remaining = comment_sweep!.files.filter((f) => f.kind === 'comments_present').length
    const removed = comment_sweep!.files.reduce((n, f) => n + f.removed.length, 0)
    result.hints.push(`Comment sweep: ${comment_sweep!.files.length} touched code file(s), ${remaining} still with comments, ${removed} comment(s) removed so far (each needs a disposition at _complete).`)
  }
  return {
    ...result,
    findings: persisted ? declared : [],
    findings_run_id: persisted ? runId : null,
    evidence_mix,
    comment_sweep,
  }
}

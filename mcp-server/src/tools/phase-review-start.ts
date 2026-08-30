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
import { getHeadSha } from '../lib/git.js'
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
    // #75. REVIEW findings are 100% agent-declared — this tool generates none —
    // so unlike the V phase, this is where the class comes from. Optional at the
    // door: see `evidenceSchema` for why requiring it would buy ritual rather
    // than evidence. Claiming `measured` without a command is still rejected here.
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
      // Distinct ids, enforced at the door. Coverage counts distinct ids, so a
      // repeated one would let a single action close several findings and leave the
      // audit log recording one decision for all of them. Caught here rather than at
      // `_complete` so the bad set is never stored in the first place.
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

/**
 * What the agent declared, echoed back verbatim. Typed from the schema rather than
 * as `StoredFinding[]`: the declaration is RICHER (detail, severity, path, line,
 * and now evidence), and narrowing the echo to the storage shape both understated
 * what the tool returns and collided with `exactOptionalPropertyTypes` once the
 * optional `evidence` arrived.
 */
export type DeclaredFinding = z.infer<typeof declaredFindingSchema>

export type PhaseReviewStartOutput = StartPhaseResult & {
  /** Echoed back so the caller can answer them — see `findings_run_id`. */
  findings: DeclaredFinding[]
  /**
   * Identifies the SET of findings this run declared. `rsct_phase_review_complete`
   * must echo it: re-running this tool replaces the findings, and without run
   * identity an answer set prepared from the earlier run would be re-applied to
   * whatever now happens to share an id.
   */
  findings_run_id: string | null
  /** #75. The class mix of what was just declared, so it is visible before actions are chosen. */
  evidence_mix: EvidenceMix
}

export const phaseReviewStartTool: Tool = {
  name: 'rsct_phase_review_start',
  description:
    'Start the REVIEW phase — an adversarial code review of the diff, between Code and Test (cycle: R→S→V→C→REVIEW→T). Writes phase="review" into .rsct/phase-state.json and emits review.start audit. Run it after rsct_phase_code_complete when the review decision (recorded at rsct_phase_spec_complete via include_review) was YES. Do the review here (hunt correctness/security/regression/cross-OS bugs in the diff, plus hygiene: dead code, scaffolding left from an approach abandoned inside this same task, and comments or tool/parameter descriptions that no longer match the code — e.g. via the qa + senior-dev personas or /code-review), then declare what you found via findings[] and call rsct_phase_review_complete. DECLARING A FINDING COMMITS YOU TO RESOLVING IT: every declared finding needs an action at _complete or the phase will not close. Re-running this tool REPLACES the declared set and reopens the review. NOTE: this is the review PHASE, distinct from rsct_persona_review (a stateless advisory lens). Refuses if a different phase is already active.',
  inputSchema: {
    type: 'object',
    required: ['spec_ref'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: {
        type: 'string',
        description:
          'The spec this review covers. Must match the spec_ref the REVIEW decision was recorded under at rsct_phase_spec_complete, and the one you pass to rsct_phase_review_complete.',
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

  // Everything below rides the transition's SINGLE write via `patch`. A second
  // writePhaseState would race the advisory lock against any background
  // rsct_status, and whichever call read first would drop the other's fields.
  const previous = readPhaseState(resolution.root).state
  const hadFindings = previous?.review_findings !== undefined
  const declaredAt = (internal.now ?? new Date()).toISOString()
  const headSha = getHeadSha(resolution.root)

  const patch = (state: PhaseState): void => {
    if (runId === null) {
      // Restarting with no declared findings clears the stale set rather than
      // leaving a previous run's findings attached to a review that no longer
      // claims them.
      delete state.review_findings
    } else {
      const block: PhaseFindingsBlock = {
        spec_ref: input.spec_ref,
        run_id: runId,
        findings: declared,
        declared_at: declaredAt,
        observed_at: declaredAt,
      }
      // #75 Part C. See phase-verification-start for why this is conditional.
      if (headSha !== null) block.head_sha = headSha
      state.review_findings = block
    }

    // Opening the review REOPENS it, whether or not anything was declared: a
    // completed_at left from a previous pass would otherwise make
    // evaluateReviewGate report `passed` over a review that is currently open.
    // Note this NEVER writes `decision` — stampReviewDecision defaults it to 'no',
    // and the gate reads 'no' as bypassed_declined, so routing through that writer
    // would let STARTING the review disarm the review gate.
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

  // Discarding a previously declared set needs its own forensic line. The generic
  // `review.start` event records nothing about findings, so without this the audit
  // log cannot tell "a review that found nothing" from "a review that erased five
  // findings" — and erasing them is the one move that makes the gate fail open.
  // A hint alone would only inform the actor doing the discarding.
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

  // Only advertise a baseline that actually landed. On `phase_already_active` or a
  // failed/locked write nothing was stored, and returning a run id for it would have
  // the agent prepare answers against a baseline that does not exist — which
  // `_complete` then fails open on, closing the review with no coverage at all.
  const persisted = result.status === 'started' && result.phase_state_written
  // #75. Counted from what was actually PERSISTED, not from the input: advertising
  // a mix for a baseline that was never stored would describe a set the dev cannot
  // act on. `null` (not `[]`) where nothing landed, so the mix reads `unmeasurable`
  // rather than an innocent-looking row of zeros.
  const evidence_mix = summarizeEvidence(persisted ? declared : null)
  if (persisted && declared.length > 0) {
    result.hints.push(`Evidence: ${describeEvidenceMix(evidence_mix)}.`)
  }
  return {
    ...result,
    findings: persisted ? declared : [],
    findings_run_id: persisted ? runId : null,
    evidence_mix,
  }
}

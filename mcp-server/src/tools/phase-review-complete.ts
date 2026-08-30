import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gatePhaseComplete,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from '../lib/phase-machine.js'
import {
  headStaleness,
  readPhaseState,
  stampReviewDecision,
  writePhaseState,
  type PhaseState,
} from '../lib/phase-scope.js'
import { getHeadSha } from '../lib/git.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
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

/**
 * #19. REVIEW was defined by its POSITION in the cycle — between Code and Test —
 * but never given anywhere to put what it found. `rsct_phase_review_complete`
 * took only `spec_ref` + `dev_approval`, so a review that found dead code, an
 * abandoned scaffold or a comment describing behaviour the code no longer has had
 * nowhere to record it. The phase rested entirely on the agent remembering the
 * tool description, which is exactly the behavioural slack the mechanical layer
 * exists to close.
 *
 * This gives it the V phase's shape: per-finding actions, `block` aborts, one
 * audit entry per finding.
 *
 * It does NOT give it a mechanical checklist. That half needs a diff reader this
 * codebase does not have — `getStagedDiff` passes `-U0`, so "comments adjacent to
 * changed lines" has no adjacent line to read — and a dead-code pass resting on
 * the JS/TS-only import walker would yield nothing forever in, say, a Java
 * project while charging its runtime at every REVIEW. Tracked separately.
 */
const findingActionSchema = z
  .object({
    finding_id: z.string().min(1, 'finding_id required'),
    action: z.enum(FINDING_ACTIONS),
    note: z.string().optional(),
  })
  .strict()

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
  })
  .strict()

export type PhaseReviewCompleteInput = z.infer<typeof phaseReviewCompleteInputSchema>

export type PhaseReviewCompleteRejectKind = FindingsGateRejectKind | 'block_actions_present'

export type PhaseReviewCompleteOutput = CompletePhaseResult & {
  actions_summary: ActionsSummary
  /** #75. How the declared findings are known, counted from the stored baseline. */
  evidence_mix: EvidenceMix
  /**
   * #75 Part C. `true` when HEAD moved since the findings were declared. Reported,
   * NEVER a rejection: committing the fixes a review found is the normal reason
   * for HEAD to move, and refusing to close the phase for it would punish the
   * correct behaviour.
   */
  head_stale: boolean | null
  /** #40: on a findings-gate rejection, every finding still awaiting an action. */
  open_findings?: StoredFinding[]
}

export const phaseReviewCompleteTool: Tool = {
  name: 'rsct_phase_review_complete',
  description:
    '§C-gated REVIEW phase closure. Reads .rsct/phase-state.json (must hold phase="review" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. On success it also stamps completed_at into the review decision block so rsct_phase_test_start sees the review actually ran. Pass findings_actions[] with a decision for EVERY finding declared at rsct_phase_review_start — leaving any unanswered rejects completion, and the rejection returns open_findings so you can answer them without re-running _start (rsct_phase_status also lists them). Unknown ids, duplicates and a stale findings_run_id reject the same way. Dead code, leftover scaffolding from an abandoned approach inside this same task, and comments or tool/parameter descriptions that no longer match the code are the hygiene items worth recording, alongside correctness and security findings. Any entry with action="block" aborts completion BEFORE the §C dialog. Suggested action_scope: "review_complete:spec_ref=<X>". Next recommended phase: test.',
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
    },
    additionalProperties: false,
  },
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

  const actions_summary = emptyActionsSummary()
  for (const fa of input.findings_actions) actions_summary[fa.action]++

  // #40: the same gate the V phase runs, from the same module — the finding
  // vocabulary was hand-written in four places before #10 and this is that hazard
  // one level up. Placed before the `block` check so an unknown id carrying
  // action:'block' is reported as the unknown id, not as an instruction to change
  // the action on a finding that does not exist.
  const stored = readPhaseState(projectRoot).state?.review_findings
  const baseline = readFindingsBaseline(stored?.findings)
  // #75. From the stored baseline, not from findings_actions — an action is a
  // decision, never the evidence under it. `null` reads as unmeasurable.
  const evidence_mix = summarizeEvidence(baseline)
  const staleness = headStaleness(stored?.head_sha, getHeadSha(projectRoot))
  const findingsGate = checkFindingsGate({
    baseline,
    storedRunId: stored?.run_id ?? null,
    suppliedRunId: input.findings_run_id ?? null,
    actions: input.findings_actions,
    // The phase/spec_slug checks live inside gatePhaseComplete, which also pops the
    // §C dialog — and this gate has to run BEFORE that, so a rejected completion
    // never spends an approval. Comparing the stored spec_ref here is what keeps the
    // ordering safe: without it, spec-B could be completed by answering spec-A's
    // findings, which would then prune spec-A's set as well.
    storedSpecRef: stored?.spec_ref ?? null,
    specRef: input.spec_ref,
  })
  if (!findingsGate.ok) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'review.complete.rejected',
        tool: 'rsct_phase_review_complete',
        spec_ref: input.spec_ref,
        reject_kind: findingsGate.reject_kind!,
        open_findings_count: findingsGate.open_findings?.length ?? 0,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      phase: 'review',
      spec_ref: input.spec_ref,
      channel: null,
      reject_kind: findingsGate.reject_kind!,
      reason: findingsGate.reason!,
      fabrication_signals: [],
      cleared: false,
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      actions_summary,
      evidence_mix,
      head_stale: staleness.head_stale,
      next_recommended_phase: 'review',
      open_findings: findingsGate.open_findings ?? [],
      hints: [
        findingsGate.reason!,
        `findings_run_id for this review is '${stored?.run_id ?? '(none)'}'. Send one action per finding listed in open_findings, then retry.`,
      ],
    }
  }

  // `block` aborts BEFORE the §C gate, mirroring the V phase: the dialog is a
  // decision surface, and asking the dev to approve a completion that is already
  // refused wastes an approval and trains them to click through.
  if (actions_summary.block > 0) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'review.complete.rejected',
        tool: 'rsct_phase_review_complete',
        spec_ref: input.spec_ref,
        reject_kind: 'block_actions_present',
        blocked_count: actions_summary.block,
      },
      config?.audit,
    )
    return {
      status: 'rejected',
      phase: 'review',
      spec_ref: input.spec_ref,
      channel: null,
      reject_kind: 'block_actions_present',
      reason: `${actions_summary.block} review finding(s) marked action="block". Resolve them, then re-run rsct_phase_review_complete.`,
      fabrication_signals: [],
      cleared: false,
      next_recommended_phase: 'review',
      ...auditFields(audit),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `REVIEW is not complete: ${actions_summary.block} finding(s) are blocking. Fix them or downgrade the action with the dev — a blocking finding is the one thing this phase will not wave through.`,
      ],
      actions_summary,
      evidence_mix,
      head_stale: staleness.head_stale,
    }
  }

  const result = await gatePhaseComplete(
    {
      projectRoot,
      phase: 'review',
      specRef: input.spec_ref,
      devApproval: input.dev_approval,
    },
    resolution.config,
    // `dialogDetail` AFTER the spread, deliberately: every test here injects
    // `internal` for `promptFn`, and setting it first would let the injected
    // object shadow the production value — the dialog assertion would then pass
    // against a string this path never produced. That is the issue's own "a test
    // built to confirm rather than to discriminate", one level down.
    { ...internal, dialogDetail: `Evidence: ${describeEvidenceMix(evidence_mix)}` },
  )

  // Stamp completed_at ONLY when the complete genuinely succeeded; a
  // rejected/failed complete must not mark the review as done. Additive
  // upsert (preserves the decision/decided_at recorded at spec_complete).
  if (result.status === 'completed') {
    const completedAt = (internal.now ?? new Date()).toISOString()
    const stamp = stampReviewDecision(projectRoot, {
      spec_ref: input.spec_ref,
      completed_at: completedAt,
    })
    if (!stamp.ok) {
      result.hints.push(
        `⚠ review phase completed but I could not stamp completed_at into the review block (${stamp.reason}). rsct_phase_test_start will report the review as incomplete. This completion already cleared the phase label, so re-running rsct_phase_review_complete returns no_active_phase — re-open with rsct_phase_review_start (same findings) and complete again, or inspect .rsct/phase-state.json.`,
      )
    }

    // #40: prune the declared findings — a completed review has none pending, and
    // `evaluateReviewGate` now reads that as an invariant rather than as a size
    // optimisation. Done AFTER the audit entries below would be wrong: if the log
    // write fails, the decisions would exist in neither place. Done here, a failed
    // prune leaves the findings and the gate reports the review as incomplete,
    // which is the safe direction.
    // Guarded on the stamp: if completed_at did NOT land, pruning would delete the
    // findings while leaving the review looking incomplete — the answers would exist
    // only in the audit log, with nothing left to re-answer. Keeping them is the
    // recoverable direction.
    const s = readPhaseState(projectRoot)
    if (stamp.ok && s.state?.review_findings !== undefined) {
      const next: PhaseState = { ...s.state }
      delete next.review_findings
      const pruned = writePhaseState(projectRoot, next)
      if (!pruned.ok) {
        result.hints.push(
          `⚠ review completed but the declared findings could not be pruned from phase state (${pruned.reason}) — rsct_phase_test_start will report the review as incomplete until they are. Re-open with rsct_phase_review_start (same findings) and complete again; re-running rsct_phase_review_complete alone returns no_active_phase, because this completion already cleared the phase label.`,
        )
      }
    }

    // #75. The mix as its own forensic line. `gatePhaseComplete` owns the generic
    // `review.complete` event and extending it would reach four other phases that
    // have no findings at all, so this rides beside it instead.
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

    // One audit entry per finding, AFTER the gate: a rejected complete must not
    // leave the log asserting decisions that were never approved. Deliberately NOT
    // gated on a declared baseline — see the matching note in
    // phase-verification-complete.ts.
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
  }

  // The leg that survives a headless run, where the dialog never renders.
  result.hints.push(`Evidence: ${describeEvidenceMix(evidence_mix)}.`)
  if (staleness.head_stale === true) {
    result.hints.push(
      `⚠ HEAD moved since these findings were declared (${staleness.head_sha_at_start?.slice(0, 12)} → ${staleness.head_sha_now?.slice(0, 12)}). That is expected if you committed the fixes this review found — but any finding anchored to a line number was read against the earlier tree.`,
    )
  }
  return { ...result, actions_summary, evidence_mix, head_stale: staleness.head_stale }
}

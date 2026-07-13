/**
 * PH-5 — pre-integration hygiene acknowledgement (`pre_merge_ack`).
 *
 * A §C-adjacent *forcing function* for `rsct_request_merge` (always) and
 * `rsct_request_push` (only when pushing to a protected branch): before the
 * mutation, the agent must assemble a small hygiene checklist. Absence ⇒ the
 * tool rejects IN CHAT (no OS dialog — the ack is checked BEFORE `gateRequest`).
 *
 * HONESTY (deliberate, see spec_ph-5 §2): all three items are **agent
 * self-attestations**, not machine-verified facts. The V sweep established that
 * `plan_complete` ("this task/phase is done") is NOT the same question as
 * `isPlanComplete(planStatus)` ("the umbrella plan file's Status field reads as
 * a completion word") — cross-checking them produces a systematic false positive
 * on every non-final merge of a multi-phase plan, so there is NO mechanical
 * cross-check here. The real teeth are: (1) you cannot integrate WITHOUT
 * assembling the checklist (presence), and (2) if you declare any item `false`,
 * you said "not ready" and we honor it (reject-on-false). When `adr_confirmed`
 * or `issues_resolved` is attested true, a non-empty `note` is required so the
 * self-attestation leaves an auditable written claim (e.g. "ADR-012 recorded;
 * issue #7 closed").
 */

import { z } from 'zod'

/** Zod shape of `pre_merge_ack` — EVERY field optional at the schema layer so a
 * missing/partial ack yields a clean `rejected` envelope instead of a ZodError
 * throw (V-C). `.strict()` still rejects unknown nested keys. Shared verbatim by
 * `request-merge` and `request-push` (with `.optional()` applied at the call
 * site) to keep the two tools' schemas from drifting (lesson V-P1·PH-1). */
export const preMergeAckSchema = z
  .object({
    plan_complete: z.boolean().optional(),
    adr_confirmed: z.boolean().optional(),
    issues_resolved: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict()

/** Parsed `pre_merge_ack` payload — every field optional at the schema layer;
 * enforcement lives entirely in {@link evaluatePreMergeAck}. */
export type PreMergeAck = z.infer<typeof preMergeAckSchema>

/** JSON-Schema mirror of {@link preMergeAckSchema} for a tool's `inputSchema`
 * (kept in parity with the Zod shape — no key is `required`, matching the
 * all-optional Zod object; `additionalProperties:false` mirrors `.strict()`). */
export const preMergeAckJsonSchema = {
  type: 'object' as const,
  properties: {
    plan_complete: { type: 'boolean' as const },
    adr_confirmed: { type: 'boolean' as const },
    issues_resolved: { type: 'boolean' as const },
    note: { type: 'string' as const },
  },
  additionalProperties: false as const,
  description:
    'Pre-integration hygiene checklist (self-attested). Required for a merge, and ' +
    'for a push to a protected branch. Set plan_complete/adr_confirmed/issues_resolved ' +
    'true only after confirming each with the dev; when adr_confirmed or issues_resolved ' +
    'is true, `note` must state what (e.g. "ADR-012 recorded; issue #7 closed").',
}

export type PreMergeAckDecision =
  | { ok: true }
  | { ok: false; kind: 'pre_merge_ack_missing' }
  | { ok: false; kind: 'pre_merge_ack_incomplete'; failing: string[] }

/** The three self-attested checklist items, in stable order (also the audit
 * label `pre_merge_ack_self_attested`). */
export const PRE_MERGE_ACK_ITEMS = [
  'plan_complete',
  'adr_confirmed',
  'issues_resolved',
] as const

/**
 * Evaluate a `pre_merge_ack` payload. Pure — no fs, no clock; each caller wraps
 * the decision in ITS OWN reject envelope (merge and push have different output
 * shapes, so this never builds one).
 *
 * - `undefined` ⇒ `pre_merge_ack_missing`.
 * - any of the three booleans not exactly `true` (missing OR false) ⇒
 *   `pre_merge_ack_incomplete`, with the offending names in `failing`.
 * - `adr_confirmed` or `issues_resolved` true but `note` empty/blank ⇒
 *   `pre_merge_ack_incomplete` (the note requirement joins `failing`).
 * - otherwise ⇒ `{ ok: true }`.
 */
export function evaluatePreMergeAck(
  ack: PreMergeAck | undefined,
  /**
   * plan-lifecycle-v2 (Bloco 2.2, D2 — LIGHT mechanical check): whether the
   * plan's `progress_<slug>.md` still has open `- [ ]` items. The caller
   * computes it (keeping this function PURE); when it is `true` AND the agent
   * attests `plan_complete`, that mechanical contradiction rejects the ack.
   * `undefined` ⇒ pre-v2 behavior (no cross-check).
   */
  progressHasOpenItems?: boolean,
): PreMergeAckDecision {
  if (ack === undefined) return { ok: false, kind: 'pre_merge_ack_missing' }

  const failing: string[] = []
  if (ack.plan_complete !== true) failing.push('plan_complete')
  else if (progressHasOpenItems === true) {
    failing.push('plan_complete (progress_<slug>.md still has open `- [ ]` items)')
  }
  if (ack.adr_confirmed !== true) failing.push('adr_confirmed')
  if (ack.issues_resolved !== true) failing.push('issues_resolved')

  const attestedPositive = ack.adr_confirmed === true || ack.issues_resolved === true
  const noteBlank = typeof ack.note !== 'string' || ack.note.trim() === ''
  if (attestedPositive && noteBlank) {
    failing.push('note (required when adr_confirmed or issues_resolved is true)')
  }

  return failing.length > 0
    ? { ok: false, kind: 'pre_merge_ack_incomplete', failing }
    : { ok: true }
}

/** Human-readable hint listing what the agent must supply. Shared by both tools. */
export function preMergeAckHint(decision: {
  kind: 'pre_merge_ack_missing' | 'pre_merge_ack_incomplete'
  failing?: string[]
}): string {
  if (decision.kind === 'pre_merge_ack_missing') {
    return (
      'Pre-integration hygiene checklist (pre_merge_ack) is required before this ' +
      'integration. Supply pre_merge_ack: { plan_complete, adr_confirmed, ' +
      'issues_resolved } — set each true ONLY after confirming it with the dev ' +
      '(they are self-attestations, not machine-checked). When adr_confirmed or ' +
      'issues_resolved is true, add a non-empty `note` stating WHAT (e.g. ' +
      '"ADR-012 recorded; issue #7 closed"). No OS dialog was shown — nothing ran.'
    )
  }
  return (
    'Pre-integration hygiene checklist (pre_merge_ack) is incomplete — you ' +
    `declared/omitted: ${(decision.failing ?? []).join(', ')}. Resolve each item ` +
    '(finish the work, record pending ADRs via §H, close associated issues) and ' +
    're-attest. Items you mark false mean "not ready" and are honored as a stop.'
  )
}

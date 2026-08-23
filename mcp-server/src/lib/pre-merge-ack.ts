/**
 * PH-5 — pre-integration hygiene acknowledgement (`pre_merge_ack`).
 *
 * A §C-adjacent *forcing function* for `rsct_request_merge` (always) and
 * `rsct_request_push` (only when pushing to a protected branch): before the
 * mutation, the agent must assemble a small hygiene checklist. Absence ⇒ the
 * tool rejects IN CHAT (no OS dialog — the ack is checked BEFORE `gateRequest`).
 *
 * HONESTY (deliberate, see spec_ph-5 §2): the four items are **agent
 * self-attestations**, not machine-verified facts. The V sweep established that
 * `plan_complete` ("this task/phase is done") is NOT the same question as
 * `isPlanComplete(planStatus)` ("the umbrella plan file's Status field reads as
 * a completion word") — cross-checking them produces a systematic false positive
 * on every non-final merge of a multi-phase plan, so there is NO mechanical
 * cross-check on THAT item. The real teeth are: (1) you cannot integrate WITHOUT
 * assembling the checklist (presence), and (2) if you declare any item `false`,
 * you said "not ready" and we honor it (reject-on-false). When `adr_confirmed`,
 * `issues_resolved` or `hygiene_swept` is attested true, a non-empty `note` is
 * required so the self-attestation leaves an auditable written claim (e.g.
 * "ADR-012 recorded; issue #7 closed").
 *
 * #62 adds `hygiene_swept` — the cleanup sweep (dead code, comments that no
 * longer match the code) — plus `files_swept[]`, which is EVIDENCE rather than
 * an attestation and is therefore deliberately absent from
 * {@link PRE_MERGE_ACK_ITEMS}. The caller reads the paths the integration
 * actually carries out of git and passes them as
 * {@link PreMergeAckContext.carriedPaths}; a carried path missing from
 * `files_swept` rejects REGARDLESS of the four booleans.
 *
 * Be precise about what that buys, because the wording is load-bearing: it
 * verifies **coverage** — that the paths the integration carries were *claimed*
 * as swept. It does not verify that a sweep happened, or that one found
 * anything. An agent can obtain `files_swept` by running the same `git diff
 * --name-only` the tool runs; this is an auditable coverage ledger against
 * omission and stale sweeps, not a rubber-stamp-resistant forcing function.
 */

import { z } from 'zod'
import type { RangePathsResult } from './git.js'

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
    hygiene_swept: z.boolean().optional(),
    files_swept: z.array(z.string()).optional(),
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
    hygiene_swept: { type: 'boolean' as const },
    files_swept: { type: 'array' as const, items: { type: 'string' as const } },
    note: { type: 'string' as const },
  },
  additionalProperties: false as const,
  description:
    'Pre-integration hygiene checklist (self-attested). Required for a merge and a ' +
    'rebase/squash, and for a push to a protected branch. Set plan_complete/' +
    'adr_confirmed/issues_resolved/hygiene_swept true only after confirming each with ' +
    'the dev; when adr_confirmed, issues_resolved or hygiene_swept is true, `note` must ' +
    'state what (e.g. "ADR-012 recorded; issue #7 closed; swept 4 files"). ' +
    'files_swept lists every path this integration carries that you swept for dead code ' +
    'and stale comments — obtain it from `git diff --name-only <base>...<head>`. A ' +
    'carried path missing from it rejects regardless of the booleans. This checks ' +
    'COVERAGE (the carried paths were claimed as swept), never that a sweep happened.',
}

export type PreMergeAckDecision =
  | { ok: true }
  | { ok: false; kind: 'pre_merge_ack_missing' }
  | {
      ok: false
      kind: 'pre_merge_ack_incomplete'
      failing: string[]
      /**
       * #62: the carried paths absent from `files_swept`, in FULL. `failing`
       * caps its human-readable entry at {@link MAX_UNSWEPT_LISTED} names so a
       * 400-file merge does not produce a wall of chat text; this field is
       * uncapped so the audit entry names the whole gap. Absent when the
       * cross-check did not run or found nothing.
       */
      unswept?: string[]
    }

/** The four self-attested checklist items, in stable order (also the audit label
 * `pre_merge_ack_self_attested`).
 *
 * `files_swept` is deliberately NOT here. This constant is emitted verbatim as
 * that audit label at all three call sites, and it must keep meaning "the
 * booleans the agent attested" — an evidence array in it would make the label
 * claim something it is not. */
export const PRE_MERGE_ACK_ITEMS = [
  'plan_complete',
  'adr_confirmed',
  'issues_resolved',
  'hygiene_swept',
] as const

/** How many unswept paths the human-readable `failing` entry names before it
 * summarises the rest. The full list rides on `decision.unswept`. */
export const MAX_UNSWEPT_LISTED = 10

/** Upper bound on `files_swept` entries. `files_swept` is the first unbounded
 * agent-supplied array on a §C-gated tool, and all three call sites echo the
 * whole ack into `.rsct/audit.log`, which is `JSON.stringify` + `appendFileSync`
 * with no cap of its own. Enforced HERE rather than as a Zod `.max()` so an
 * over-long list yields a clean `rejected` envelope instead of a ZodError throw
 * — the same reason every field is optional at the schema layer. Precedent:
 * `request-commit` rejects `message_too_long` before the §C dialog. */
export const MAX_FILES_SWEPT = 2000

/**
 * Normalize a path for the coverage comparison, applied to BOTH sides.
 *
 * - `NFC`, because macOS returns NFD from a filesystem listing while git stores
 *   NFC; without this an accented path compares unequal on macOS and equal on
 *   Linux and Windows — the silent cross-OS divergence CLAUDE.md exists to stop.
 * - backslash to forward slash, so a Windows agent may echo either form.
 * - a leading `./` and a trailing `/` stripped, as pure noise.
 *
 * Case is NOT folded. A case-insensitive compare would pass on Windows/macOS and
 * fail on Linux for the identical input, which is worse than being strict on all
 * three: the reject names the paths, so the agent can copy them back verbatim.
 */
function normalizeSweptPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/').normalize('NFC')
  while (s.startsWith('./')) s = s.slice(2)
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** Caller-supplied facts the evaluator cross-checks the attestation against.
 * An options object rather than positional flags: this is the second such fact
 * and the shape scales, matching the `evaluate*(input, opts)` form already used
 * by `edit-guard`, `free-commit`, `install-advisory`, `phase-scope` and
 * `settings-drift`. */
export interface PreMergeAckContext {
  /**
   * plan-lifecycle-v2 (Bloco 2.2, D2 — LIGHT mechanical check): whether the
   * plan's `progress_<slug>.md` still has open `- [ ]` items. The caller
   * computes it (keeping this function PURE); when it is `true` AND the agent
   * attests `plan_complete`, that mechanical contradiction rejects the ack.
   * `undefined` ⇒ pre-v2 behavior (no cross-check).
   *
   * `| undefined` is explicit because this project sets
   * `exactOptionalPropertyTypes`, and every caller computes the value
   * conditionally — without it each of the three call sites would need a
   * conditional spread to pass a value it legitimately may not have.
   */
  progressHasOpenItems?: boolean | undefined
  /**
   * #62: the paths this integration CARRIES, from a real git read
   * (`lib/git.getRangePaths`). `undefined` or `null` ⇒ the read was unavailable
   * and the coverage cross-check is skipped — the CALLER decides what a degraded
   * read means for its own operation and states it in its audit entry, because
   * that posture differs per tool. `[]` ⇒ the range is genuinely empty and there
   * is nothing to cover.
   */
  carriedPaths?: string[] | null | undefined
}

/**
 * Evaluate a `pre_merge_ack` payload. Pure — no fs, no clock; each caller wraps
 * the decision in ITS OWN reject envelope (merge and push have different output
 * shapes, so this never builds one).
 *
 * - `undefined` ⇒ `pre_merge_ack_missing`.
 * - any of the four booleans not exactly `true` (missing OR false) ⇒
 *   `pre_merge_ack_incomplete`, with the offending names in `failing`.
 * - `adr_confirmed`, `issues_resolved` or `hygiene_swept` true but `note`
 *   empty/blank ⇒ `pre_merge_ack_incomplete` (the note requirement joins
 *   `failing`).
 * - a carried path absent from `files_swept` ⇒ `pre_merge_ack_incomplete`,
 *   INDEPENDENTLY of the booleans, with the full gap on `unswept`.
 * - otherwise ⇒ `{ ok: true }`.
 */
export function evaluatePreMergeAck(
  ack: PreMergeAck | undefined,
  context: PreMergeAckContext = {},
): PreMergeAckDecision {
  if (ack === undefined) return { ok: false, kind: 'pre_merge_ack_missing' }
  const { progressHasOpenItems, carriedPaths } = context

  const failing: string[] = []
  if (ack.plan_complete !== true) failing.push('plan_complete')
  else if (progressHasOpenItems === true) {
    failing.push('plan_complete (progress_<slug>.md still has open `- [ ]` items)')
  }
  if (ack.adr_confirmed !== true) failing.push('adr_confirmed')
  if (ack.issues_resolved !== true) failing.push('issues_resolved')
  if (ack.hygiene_swept !== true) failing.push('hygiene_swept')

  // Mirrors PH-5 rather than escalating past it: a note is owed for an item
  // attested TRUE, and `plan_complete` stays exempt exactly as before. Note that
  // this changes no verdict on its own — a passing ack already requires
  // `adr_confirmed`, so the disjunction is already true there. It is message
  // composition, not a tightening, and should not be credited as one.
  const attestedPositive =
    ack.adr_confirmed === true || ack.issues_resolved === true || ack.hygiene_swept === true
  const noteBlank = typeof ack.note !== 'string' || ack.note.trim() === ''
  if (attestedPositive && noteBlank) {
    failing.push(
      'note (required when adr_confirmed, issues_resolved or hygiene_swept is true)',
    )
  }

  const sweptDeclared = ack.files_swept ?? []
  if (sweptDeclared.length > MAX_FILES_SWEPT) {
    failing.push(
      `files_swept (${sweptDeclared.length} entries exceeds the ${MAX_FILES_SWEPT} cap)`,
    )
  }

  // The coverage cross-check. Runs INDEPENDENTLY of the four booleans — a path
  // the integration carries that was never claimed rejects even on an otherwise
  // perfect ack. Skipped when the range is unreadable (null/undefined) or
  // genuinely empty; the caller labels those cases in its own audit entry.
  let unswept: string[] | undefined
  if (Array.isArray(carriedPaths) && carriedPaths.length > 0) {
    const swept = new Set(sweptDeclared.map(normalizeSweptPath))
    const missing = carriedPaths
      .map(normalizeSweptPath)
      .filter((p) => p.length > 0 && !swept.has(p))
    if (missing.length > 0) {
      unswept = missing
      const shown = missing.slice(0, MAX_UNSWEPT_LISTED).join(', ')
      const rest = missing.length - Math.min(missing.length, MAX_UNSWEPT_LISTED)
      failing.push(
        `files_swept (${missing.length} path(s) this integration carries were not ` +
          `attested: ${shown}${rest > 0 ? `, and ${rest} more` : ''})`,
      )
    }
  }

  if (failing.length === 0) return { ok: true }
  return {
    ok: false,
    kind: 'pre_merge_ack_incomplete',
    failing,
    ...(unswept !== undefined && { unswept }),
  }
}

/**
 * What the coverage cross-check actually did, for the audit entry. Four states,
 * not two: `empty_range` must not be filed as `enforced` (nothing was checked,
 * and D7 forbids over-claiming), and `rejected_revision` must not be filed as
 * `degraded` (a crafted input and an unfetched remote branch are different
 * events and a forensic reader has to tell them apart).
 */
export type PathCrossCheck = 'enforced' | 'empty_range' | 'degraded' | 'rejected_revision'

/** Label a {@link RangePathsResult} for the audit. Pure. */
export function describeCrossCheck(range: RangePathsResult): PathCrossCheck {
  if (range.status === 'unsafe_revision') return 'rejected_revision'
  if (range.status === 'unavailable') return 'degraded'
  return range.paths.length > 0 ? 'enforced' : 'empty_range'
}

/**
 * Reject prose for an operation that fails CLOSED on an unreadable range —
 * merge and rebase, where the mutation can still succeed while the range read
 * cannot (measured: an unrelated-histories merge, and a rebase onto an orphan
 * ref). Push is the exception and fails open; see its call site.
 */
export function crossCheckBlockedReason(range: RangePathsResult, op: string): string {
  if (range.status === 'unsafe_revision') {
    return (
      `refusing to ${op}: ${JSON.stringify(range.revision)} is not a safe revision — a value ` +
      "starting with '-' is read by git as an OPTION, not a name. No OS dialog was shown."
    )
  }
  return (
    `refusing to ${op}: the paths this integration carries could not be read from git, so the ` +
    'pre_merge_ack coverage check cannot run. This fails CLOSED because the mutation can ' +
    'succeed where the read cannot — an unrelated-histories merge, or a rebase onto an ' +
    'unrelated ref, would otherwise skip the check entirely. Fetch the refs involved (or fix ' +
    'the ref name) and retry. No OS dialog was shown — nothing ran.'
  )
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
      'issues_resolved, hygiene_swept, files_swept } — set each boolean true ONLY ' +
      'after confirming it with the dev (they are self-attestations, not ' +
      'machine-checked). When adr_confirmed, issues_resolved or hygiene_swept is ' +
      'true, add a non-empty `note` stating WHAT (e.g. "ADR-012 recorded; issue #7 ' +
      'closed; swept 4 files"). files_swept must list every path this integration ' +
      'carries that you swept for dead code and stale comments — get it from ' +
      '`git diff --name-only <base>...<head>`. No OS dialog was shown — nothing ran.'
    )
  }
  return (
    'Pre-integration hygiene checklist (pre_merge_ack) is incomplete — you ' +
    `declared/omitted: ${(decision.failing ?? []).join(', ')}. Resolve each item ` +
    '(finish the work, record pending ADRs via §H, close associated issues, sweep ' +
    'the carried files for dead code and stale comments) and re-attest. Booleans ' +
    'you mark false mean "not ready" and are honored as a stop. Paths are compared ' +
    'case-sensitively after normalizing separators and Unicode form, so copy them ' +
    'back exactly as listed.'
  )
}

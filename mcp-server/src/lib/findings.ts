import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The shared finding vocabulary (#19), plus the shared findings gate (#40).
 *
 * The same five values were hand-written in FOUR places — `FindingSeverity` in
 * `lib/verification-checklist.ts`, `ACTION_VALUES` in
 * `tools/phase-verification-complete.ts`, and that tool's `ActionsSummary`
 * interface and `emptySummary()` initializer. Adding the REVIEW phase would have
 * made it six. Four copies of a list whose members carry an abort rule is one
 * edit away from a phase that silently stops honouring `block`.
 *
 * **Two names, one value list — deliberately.** `FindingSeverity` is what the
 * machine SUGGESTS when it produces a finding; `FindingAction` is what the dev
 * DECIDES about it, and `block` on the decision side aborts phase completion.
 * Collapsing them into one name would invite reading a machine-emitted
 * `severity: 'block'` as a decision, at which point a checklist finding could
 * make a phase uncompletable on its own. The checklist deliberately never emits
 * `accept` either — that value only makes sense as a dev decision.
 */

/** The five values, ordered high → low. Single source for both aliases below. */
export const FINDING_ACTIONS = [
  'block',
  'address-now',
  'capture-as-issue',
  'defer',
  'accept',
] as const

/**
 * What the DEV decided about a finding.
 *
 *  - `block`            — completion cannot proceed; fix it first
 *  - `address-now`      — handle before moving on
 *  - `capture-as-issue` — track separately so it does not block this task
 *  - `defer`            — record only; revisit later
 *  - `accept`           — acknowledged, no action needed
 */
export type FindingAction = (typeof FINDING_ACTIONS)[number]

/**
 * What the MACHINE suggested when it produced the finding. Same values, but a
 * recommendation rather than a decision — nothing acts on it directly.
 */
export type FindingSeverity = FindingAction

/** Per-action counts, keyed by the action itself so a new value cannot be missed. */
export type ActionsSummary = Record<FindingAction, number>

/**
 * A zero-filled summary, DERIVED from the value list rather than hand-written.
 * The previous hand-written initializer was the fourth copy, and the one most
 * likely to silently omit a newly added action.
 */
export function emptyActionsSummary(): ActionsSummary {
  return Object.fromEntries(FINDING_ACTIONS.map((a) => [a, 0])) as ActionsSummary
}

/**
 * Sequential id generator: `<prefix>-<category>-<n>`, where `n` counts across ALL
 * categories, not per category (`v-gap-1`, `v-breakage-2`, `v-gap-3`).
 *
 * Prefixed so V and REVIEW findings can never collide in a shared audit trail —
 * `v-gap-1` and `r-dead-code-1` are distinguishable at a glance, which matters
 * because `findings_actions[]` references these ids by hand.
 *
 * Content-derived ids were considered for #40 and rejected: the finding type has no
 * `path` (only `affected_paths[]`), all three `gap` findings carry the SAME
 * `affected_paths` with a title derived from the matched entry rather than the claim
 * — so two claims hitting one anti-decision would collide into a single id — and
 * `breakage` titles embed live importer counts, so they change whenever the graph
 * does. Run identity is carried by `computeRunId` below instead, which binds to the
 * set rather than to the item.
 */
export function makeIdGenerator(prefix: string): (category: string) => string {
  let counter = 0
  return (category) => `${prefix}-${category}-${++counter}`
}

/**
 * #75. HOW a finding is known — the discriminator the record never carried.
 *
 * The framework already forced the agent to DECLARE findings and to ANSWER every
 * one of them, and never asked how any of them was known: a measured fact and an
 * untested guess were stored, counted and gated identically. So the phase gate
 * could prove a finding was answered and could never prove it was true.
 *
 * Three classes, mechanically checkable, no calibration and no score.
 *
 * **What this module can and cannot check, stated plainly because the tool
 * descriptions repeat it.** It can check that a claimed class carries its fields
 * — `measured` without a `command` is rejected at the door. It CANNOT check
 * whether `also_explained_by` is honest. A minimum length, a denylist of null
 * answers ("nothing", "n/a", "nada"), a distinctness test against `title` — each
 * is an arms race, each is bilingual, and each rewards a longer lie over a short
 * truth. Pretending otherwise would be the same failure the class exists to
 * price.
 *
 * So the weight sits elsewhere, on two things that ARE mechanical:
 *
 *  1. **Irreversible degradation.** Absent, malformed or unrecognised becomes
 *     `hypothesis`. Never fact. No text defeats it — see {@link coerceEvidence}.
 *  2. **A visible mix at approval time.** "12 findings — 1 measured, 0 reported,
 *     11 hypothesis (9 unrecorded)" reaches the dev BEFORE the OK, so the cost of
 *     a cheap claim lands on the answerer, immediately, instead of on the reader,
 *     later. That asymmetry is the generator this whole issue is about.
 */
export const EVIDENCE_KINDS = ['measured', 'reported', 'hypothesis'] as const
export type FindingEvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** Where a `reported` claim was checked. A working tree moves; only a commit is fixed. */
export const VERIFIED_AGAINST = ['commit', 'working_tree', 'unverified'] as const
export type VerifiedAgainst = (typeof VERIFIED_AGAINST)[number]

export type FindingEvidence =
  | {
      kind: 'measured'
      /** The command actually run. Not a description of one. */
      command: string
      output_excerpt: string
      /**
       * What ELSE would produce that same output.
       *
       * The load-bearing field, and deliberately the one nothing here validates.
       * The most expensive failure in the record behind #75 survived a command
       * being present: a probe threw `spawnSync npx ENOENT` with both streams
       * empty — vitest never spawned — and the throw was reported as a
       * reproduction. The test ran. It simply did not discriminate.
       */
      also_explained_by: string
    }
  | {
      kind: 'reported'
      /** Where it came from: a doc path, an issue number, another session. */
      source: string
      verified_against: VerifiedAgainst
      /**
       * The immutable id, when `verified_against` is `commit`. Full sha, not an
       * abbreviation — `git rev-parse --short` output is length-variable
       * (`core.abbrev`, object count) and so is not stable across machines.
       *
       * `| undefined` is explicit: under `exactOptionalPropertyTypes` a
       * zod-inferred optional carries it, and an explicitly-undefined sha means
       * the same thing as an absent one.
       */
      commit_sha?: string | undefined
    }
  | {
      kind: 'hypothesis'
      how_to_falsify: string
      /** Set ONLY by {@link coerceEvidence}, and only when it did the degrading. */
      degraded?: true
      /** Why it degraded: `absent`, `malformed`, or `unknown_kind:<k>`. */
      degraded_from?: string
    }

/**
 * The declaration-side schema, for the agent-declared REVIEW findings.
 *
 * Kept beside the type so the two cannot drift, and shaped as a DISCRIMINATED
 * union so a `measured` claim missing its `command` is a hard rejection at
 * `rsct_phase_review_start` — the bad set never reaches storage, exactly like the
 * duplicate-id refine that already guards that door.
 *
 * The field itself is OPTIONAL, deliberately. Requiring it would force a resumed
 * session to re-derive evidence it may no longer have, and would break #40's
 * recovery path for any finding stored before this shipped. More importantly, a
 * required field is what produces ritual compliance: the point is not to make
 * everyone type something, it is to make a set of cheap claims visible. So you
 * are never forced to CLAIM a class — you are forced to be consistent once you
 * do, and the absence is counted as `unrecorded` and shown to the dev.
 */
export const evidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('measured'),
      command: z.string().min(1, 'measured evidence needs the command that was run'),
      output_excerpt: z.string().min(1, 'measured evidence needs an excerpt of the output'),
      also_explained_by: z
        .string()
        .min(1, 'measured evidence needs what ELSE would produce that same output'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reported'),
      source: z.string().min(1, 'reported evidence needs a source'),
      verified_against: z.enum(VERIFIED_AGAINST),
      commit_sha: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('hypothesis'),
      how_to_falsify: z.string().min(1, 'a hypothesis needs a way to falsify it'),
    })
    .strict(),
])

/** The JSON-Schema mirror for the MCP tool `inputSchema` (hand-kept, like its siblings). */
export const evidenceJsonSchema = {
  type: 'object' as const,
  // Flat, not `oneOf`: no schema in this catalog uses a JSON-Schema combinator,
  // and introducing one in release week trades a real client-compatibility risk
  // for a presentational gain. The cost is that the property list alone cannot
  // express "these three groups are mutually exclusive" — so the description says
  // it outright, and `phase-schema-parity` pins that the rejection is real rather
  // than merely claimed here.
  required: ['kind'] as string[],
  description:
    'How this finding is known. OPTIONAL — omitting it is allowed and is not a rejection: the finding counts as an UNRECORDED hypothesis, and the dev sees that in the evidence mix before approving. Send ONLY the fields belonging to your chosen kind: measured -> command + output_excerpt + also_explained_by; reported -> source + verified_against (+ commit_sha); hypothesis -> how_to_falsify. Mixing fields across kinds is REJECTED, and so is a kind whose own fields are missing (e.g. measured with no command). NOTE: nothing here can check whether also_explained_by is honest — only that you wrote one.',
  properties: {
    kind: { type: 'string' as const, enum: [...EVIDENCE_KINDS] },
    command: { type: 'string' as const, description: 'measured: the command actually run.' },
    output_excerpt: { type: 'string' as const, description: 'measured: an excerpt of its output.' },
    also_explained_by: {
      type: 'string' as const,
      description:
        'measured: what ELSE would produce that same output. The load-bearing field — a test that ran but did not discriminate is the most expensive failure this class exists to catch.',
    },
    source: { type: 'string' as const, description: 'reported: doc path, issue, or session.' },
    verified_against: { type: 'string' as const, enum: [...VERIFIED_AGAINST] },
    commit_sha: { type: 'string' as const, description: 'reported: the full sha, when checked against a commit.' },
    how_to_falsify: { type: 'string' as const, description: 'hypothesis: how someone would prove it wrong.' },
  },
}

const ABSENT_FALSIFIER =
  '<not recorded — no evidence class was supplied, so this finding is treated as a hypothesis>'

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Read whatever is on disk (or came off the wire) as an evidence class, degrading
 * anything that is not a well-formed member to `hypothesis`. Never throws.
 *
 * **Idempotent, and that is a correctness requirement rather than a nicety.**
 * Every class the checklist assigns is written into phase state and read back
 * through {@link readFindingsBaseline} on the very next tool call. If this
 * function re-stamped `degraded` on a well-formed stored hypothesis, then after
 * ONE round-trip every honestly-declared hypothesis would count as `unrecorded`,
 * and the headline the dev reads would flip from "22 hypotheses, labelled" to
 * "22 unrecorded, nobody said anything". The mix would lie in the exact direction
 * this design exists to make trustworthy. So a well-formed member passes through
 * unchanged, `degraded` is preserved when already present, and it is SET only
 * where this function itself performed the degradation.
 */
export function coerceEvidence(raw: unknown): FindingEvidence {
  if (raw === undefined || raw === null) return degrade('absent')
  if (typeof raw !== 'object') return degrade('malformed')
  const rec = raw as Record<string, unknown>

  if (rec.kind === 'measured') {
    if (nonEmpty(rec.command) && nonEmpty(rec.output_excerpt) && nonEmpty(rec.also_explained_by)) {
      return {
        kind: 'measured',
        command: rec.command,
        output_excerpt: rec.output_excerpt,
        also_explained_by: rec.also_explained_by,
      }
    }
    // A `measured` claim missing its fields is NOT a weaker measurement — it is
    // not a measurement. Degrade rather than repair.
    return degrade('malformed')
  }

  if (rec.kind === 'reported') {
    if (
      nonEmpty(rec.source) &&
      VERIFIED_AGAINST.includes(rec.verified_against as VerifiedAgainst)
    ) {
      const out: FindingEvidence = {
        kind: 'reported',
        source: rec.source,
        verified_against: rec.verified_against as VerifiedAgainst,
      }
      if (nonEmpty(rec.commit_sha)) out.commit_sha = rec.commit_sha
      return out
    }
    return degrade('malformed')
  }

  if (rec.kind === 'hypothesis') {
    if (nonEmpty(rec.how_to_falsify)) {
      const out: FindingEvidence = { kind: 'hypothesis', how_to_falsify: rec.how_to_falsify }
      // Preserved, never re-stamped — see the idempotence note above.
      if (rec.degraded === true) out.degraded = true
      if (nonEmpty(rec.degraded_from)) out.degraded_from = rec.degraded_from
      return out
    }
    return degrade('malformed')
  }

  return degrade(nonEmpty(rec.kind) ? `unknown_kind:${rec.kind}` : 'malformed')
}

function degrade(from: string): FindingEvidence {
  return {
    kind: 'hypothesis',
    how_to_falsify: ABSENT_FALSIFIER,
    degraded: true,
    degraded_from: from,
  }
}

/**
 * The evidence mix of a finding set.
 *
 * `unrecorded` is a SUBSET of `hypothesis`, not a fourth class: the three kind
 * counts sum to `total`. It is split out because "I considered it and it is a
 * guess" and "I did not say" are different facts about the answerer, and folding
 * the second into the first hides the one the ritual-compliance analysis says
 * will dominate.
 */
export interface EvidenceMix {
  /**
   * `false` when there is no baseline to measure — foreign or hand-edited state,
   * where {@link readFindingsBaseline} returns `null`. A row of zeros from `null`
   * ("unmeasurable") and from `[]` ("the phase ran and found nothing") would
   * render identically, which is a state read as if it were an observation — the
   * very mechanism this issue was opened over.
   */
  measurable: boolean
  measured: number
  reported: number
  hypothesis: number
  /** Degraded rather than declared. A subset of `hypothesis`. */
  unrecorded: number
  total: number
}

export function summarizeEvidence(
  // `| undefined` is explicit because `exactOptionalPropertyTypes` is on and a
  // zod-inferred optional carries it. The body already treats absent and
  // explicitly-undefined the same way, so accepting both is honest rather than a
  // loosening — narrowing it would only force callers to strip a field this
  // function is built to count as unrecorded.
  findings: readonly { evidence?: FindingEvidence | undefined }[] | null,
): EvidenceMix {
  const mix: EvidenceMix = {
    measurable: findings !== null,
    measured: 0,
    reported: 0,
    hypothesis: 0,
    unrecorded: 0,
    total: 0,
  }
  if (findings === null) return mix
  for (const f of findings) {
    const e = f.evidence ?? coerceEvidence(undefined)
    mix.total++
    if (e.kind === 'measured') mix.measured++
    else if (e.kind === 'reported') mix.reported++
    else {
      mix.hypothesis++
      if (e.degraded === true) mix.unrecorded++
    }
  }
  return mix
}

/** One line for the OS dialog, the hints and the audit. */
export function describeEvidenceMix(mix: EvidenceMix): string {
  if (!mix.measurable) return 'no findings baseline recorded — evidence mix unavailable'
  if (mix.total === 0) return 'no findings — nothing to weigh'
  const unrecorded = mix.unrecorded > 0 ? ` (${mix.unrecorded} unrecorded)` : ''
  return `${mix.total} finding(s) — ${mix.measured} measured, ${mix.reported} reported, ${mix.hypothesis} hypothesis${unrecorded}`
}

/**
 * A finding as it survives a round-trip through phase state, which types it as
 * `unknown[]`. Only these fields are read back — `id` to validate against,
 * `category`/`title` so a rejection can tell the agent WHAT is still open, and
 * `evidence` (#75) so the mix can be counted and so #40's `open_findings`
 * recovery path hands back what was declared rather than a stripped copy.
 */
export interface StoredFinding {
  id: string
  category?: string
  title?: string
  evidence?: FindingEvidence
}

/**
 * Extract the usable baseline from whatever is on disk, or `null` for "no baseline".
 *
 * `null` means every check downstream is SKIPPED. That covers a legitimately empty
 * corpus, an already-pruned block, and foreign or hand-edited state — and it is
 * deliberately generous: `findings: null` or an array of id-less objects must not
 * make a phase uncompletable, and must not throw out of a tool that has no try/catch
 * around its state reads.
 */
export function readFindingsBaseline(raw: unknown): StoredFinding[] | null {
  if (!Array.isArray(raw)) return null
  const out: StoredFinding[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id === '') continue
    const f: StoredFinding = { id: rec.id }
    if (typeof rec.category === 'string') f.category = rec.category
    if (typeof rec.title === 'string') f.title = rec.title
    // #75. The ONE line that carries the evidence class to every consumer: both
    // `phase_status` blocks, both `_complete` gates, and #40's `open_findings`
    // rejection payload all read the baseline through here. Never drops a finding
    // — a legacy entry with no `evidence` degrades to a hypothesis and still gates.
    f.evidence = coerceEvidence(rec.evidence)
    out.push(f)
  }
  return out.length > 0 ? out : null
}

/**
 * A short, order-independent fingerprint of the id SET a phase raised.
 *
 * This is what makes a stale answer set detectable. Ids are sequential, so re-running
 * `_start` over changed inputs renumbers them: an answer prepared from the previous
 * run can still name ids that exist, while pointing at different findings. Comparing
 * run identity catches that as a set mismatch — the unit that actually changed —
 * instead of silently re-applying answers item by item.
 */
export function computeRunId(findings: readonly { id: string }[]): string {
  const ids = findings.map((f) => f.id).sort()
  return createHash('sha256').update(ids.join('\0')).digest('hex').slice(0, 12)
}

export type FindingsGateRejectKind =
  | 'stale_finding_run'
  | 'unknown_finding_ids'
  | 'unanswered_findings'
  | 'duplicate_finding_ids'
  /** The stored baseline belongs to a different spec_ref than the one being completed. */
  | 'findings_spec_mismatch'
  /** The stored baseline itself contains repeated ids, so coverage cannot be counted. */
  | 'ambiguous_baseline'

export interface FindingsGateResult {
  ok: boolean
  reject_kind?: FindingsGateRejectKind
  reason?: string
  /** Every finding still open, so a rejected caller can recover without re-running `_start`. */
  open_findings?: StoredFinding[]
}

function describe(f: StoredFinding): string {
  return f.title ? `${f.id} (${f.title})` : f.id
}

/**
 * The shared gate for both phases: run identity, id validity, coverage, duplicates.
 *
 * Held in ONE place because V and REVIEW must not drift — the finding vocabulary was
 * hand-written in four places before #10 and this is the same hazard one level up.
 * Returns a rejection rather than throwing; the caller decides how to surface it.
 *
 * Every rejection carries `open_findings`, and that is load-bearing rather than a
 * nicety: nothing else in the framework can tell an agent what the stored ids are
 * (`phase_status` and `load_context` both reduce them to a count), so without it the
 * only route back is re-running `_start` — which rewrites the very baseline the
 * caller is being measured against.
 */
export function checkFindingsGate(input: {
  baseline: StoredFinding[] | null
  storedRunId: string | null
  suppliedRunId: string | null
  actions: readonly { finding_id: string }[]
  /** `spec_ref` the stored baseline was declared under, when the block records one. */
  storedSpecRef?: string | null
  /** `spec_ref` of the phase being completed. */
  specRef?: string | null
}): FindingsGateResult {
  const { baseline, storedRunId, suppliedRunId, actions, storedSpecRef, specRef } = input
  if (baseline === null) return { ok: true } // fail-open: nothing to measure against

  // A baseline belonging to another spec must neither be demanded nor answerable.
  // Without this, completing spec-B by answering spec-A's findings SUCCEEDS — and
  // then prunes spec-A's findings, so the work it was tracking is lost too. A
  // re-plan leaves exactly this state behind, since the review decision block is
  // rebuilt for the new spec_ref while the findings block is not.
  if (storedSpecRef != null && specRef != null && storedSpecRef !== specRef) {
    return {
      ok: false,
      reject_kind: 'findings_spec_mismatch',
      reason: `The stored findings were declared for spec_ref '${storedSpecRef}', not '${specRef}'. They belong to a different task — re-run the phase start for this spec_ref rather than answering another one.`,
      open_findings: baseline,
    }
  }

  // Repeated ids in the BASELINE (not in the answers) make coverage unanswerable:
  // one action would resolve every finding sharing that id, and the audit log would
  // record a single decision for several distinct problems. V cannot produce this —
  // its ids come from a counter — but a declared REVIEW baseline can.
  const baselineDuplicates = baseline
    .map((f) => f.id)
    .filter((id, i, all) => all.indexOf(id) !== i)
  if (baselineDuplicates.length > 0) {
    return {
      ok: false,
      reject_kind: 'ambiguous_baseline',
      reason: `The stored findings reuse the same id more than once (${[...new Set(baselineDuplicates)].join(', ')}), so one action would silently close several findings. Re-declare them with a distinct id each.`,
      open_findings: baseline,
    }
  }

  // Run identity, but ONLY when the caller supplied one. Omitting it is not itself a
  // problem: the run id is a hash of the id set, so a stale answer set either names
  // ids that no longer exist (caught below as unknown) or fails to cover the current
  // ones (caught as unanswered). If it does neither, the sets are identical and the
  // run id would have matched anyway. Rejecting on absence would only replace the
  // useful message ("these 3 findings have no action") with a bookkeeping one.
  //
  // Checked BEFORE the per-id errors: when the set itself moved, per-id complaints
  // send the caller chasing ids that are no longer the question.
  if (storedRunId !== null && suppliedRunId !== null && suppliedRunId !== storedRunId) {
    return {
      ok: false,
      reject_kind: 'stale_finding_run',
      reason: `findings_run_id '${suppliedRunId}' is stale — the phase was re-run and now holds ${baseline.length} finding(s) under '${storedRunId}'. Re-read the findings listed here; earlier answers describe a set that no longer exists.`,
      open_findings: baseline,
    }
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const a of actions) {
    if (seen.has(a.finding_id)) duplicates.add(a.finding_id)
    seen.add(a.finding_id)
  }
  if (duplicates.size > 0) {
    return {
      ok: false,
      reject_kind: 'duplicate_finding_ids',
      reason: `The same finding is answered more than once: ${[...duplicates].join(', ')}. Two actions for one finding is not a decision — send exactly one action per finding.`,
      open_findings: baseline,
    }
  }

  const validIds = new Set(baseline.map((f) => f.id))
  const unknown = [...seen].filter((id) => !validIds.has(id))
  if (unknown.length > 0) {
    return {
      ok: false,
      reject_kind: 'unknown_finding_ids',
      reason: `No such finding: ${unknown.join(', ')}. Valid ids for this phase: ${baseline.map((f) => f.id).join(', ')}.`,
      open_findings: baseline,
    }
  }

  const unanswered = baseline.filter((f) => !seen.has(f.id))
  if (unanswered.length > 0) {
    return {
      ok: false,
      reject_kind: 'unanswered_findings',
      reason: `${unanswered.length} of ${baseline.length} finding(s) have no action: ${unanswered.map(describe).join('; ')}. Every finding needs a decision before this phase can complete.`,
      open_findings: unanswered,
    }
  }

  return { ok: true }
}

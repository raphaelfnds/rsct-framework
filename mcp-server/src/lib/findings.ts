import { createHash } from 'node:crypto'

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
 * A finding as it survives a round-trip through phase state, which types it as
 * `unknown[]`. Only these three fields are read back — `id` to validate against,
 * `category`/`title` so a rejection can tell the agent WHAT is still open.
 */
export interface StoredFinding {
  id: string
  category?: string
  title?: string
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

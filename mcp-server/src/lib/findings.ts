/**
 * The shared finding vocabulary (#19).
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
 * Sequential per-category id generator: `<prefix>-<category>-<n>`.
 *
 * Prefixed so V and REVIEW findings can never collide in a shared audit trail —
 * `v-gap-1` and `r-dead-code-1` are distinguishable at a glance, which matters
 * because `findings_actions[]` references these ids by hand.
 */
export function makeIdGenerator(prefix: string): (category: string) => string {
  let counter = 0
  return (category) => `${prefix}-${category}-${++counter}`
}

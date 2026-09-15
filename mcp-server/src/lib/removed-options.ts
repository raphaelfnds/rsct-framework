export const REVIEW_OPTION_REMOVED_REASON =
  'REVIEW is mandatory at every tier; this option was removed in 2.11.0 — run the tests, then rsct_phase_review_start / _complete'

export interface RemovedOptionsRejection {
  status: 'rejected'
  reject_kind: 'review_option_removed'
  reason: string
  removed_options: string[]
  hints: string[]
}

export function detectRemovedOptions(
  rawInput: unknown,
  removed: readonly string[],
): RemovedOptionsRejection | null {
  if (!rawInput || typeof rawInput !== 'object') return null
  const present = removed.filter((key) => Object.prototype.hasOwnProperty.call(rawInput, key))
  if (present.length === 0) return null
  return {
    status: 'rejected',
    reject_kind: 'review_option_removed',
    reason: `${present.join(', ')}: ${REVIEW_OPTION_REMOVED_REASON}`,
    removed_options: present,
    hints: [`Drop ${present.join(', ')} from the call and retry.`],
  }
}

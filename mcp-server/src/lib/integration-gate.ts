import { readPhaseState, refuseUnreadableState } from './phase-scope.js'
import { quoted } from './gate-exceptions.js'
import type { PreMergeAck } from './pre-merge-ack.js'

export type DriftLock = { status: 'clear' } | { status: 'armed'; paths: string[] } | { status: 'unreadable'; error: string }

export function readDriftLock(projectRoot: string): DriftLock {
  const read = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, read)
  if (refusal && !refusal.ok && refusal.reason === 'unreadable_state') return { status: 'unreadable', error: refusal.error }
  const paths = read.state?.review_drift?.paths ?? []
  return paths.length > 0 ? { status: 'armed', paths: [...paths] } : { status: 'clear' }
}

const ANSWER = (value: boolean | undefined): string => (value === true ? 'yes' : value === false ? 'no' : 'not given')

export function ackDialogLines(ack: PreMergeAck | undefined): { facts: string[]; note: string[] } {
  if (ack === undefined) return { facts: [], note: [] }
  const swept = ack.files_swept === undefined ? 'not given' : `${ack.files_swept.length} path(s)`
  return {
    facts: [
      `pre_merge_ack: plan_complete ${ANSWER(ack.plan_complete)} · adr_confirmed ${ANSWER(ack.adr_confirmed)} · issues_resolved ${ANSWER(ack.issues_resolved)} · hygiene_swept ${ANSWER(ack.hygiene_swept)} · files_swept ${swept}`,
    ],
    note: ack.note !== undefined && ack.note.trim().length > 0 ? [`Agent's pre_merge_ack note: ${quoted(ack.note)}`] : [],
  }
}

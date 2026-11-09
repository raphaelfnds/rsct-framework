import { readPhaseState, refuseUnreadableState, writePhaseState, type WritePhaseStateResult } from './phase-scope.js'
import { findingIdentity, findingLabel, quoted } from './gate-exceptions.js'
import type { GitExecutor } from './git.js'
import type { PreMergeAck } from './pre-merge-ack.js'
import type { SecretFinding } from './secrets.js'

export type DriftLock = { status: 'clear' } | { status: 'armed'; paths: string[] } | { status: 'unreadable'; error: string }

export function readDriftLock(projectRoot: string): DriftLock {
  const read = readPhaseState(projectRoot)
  const refusal = refuseUnreadableState(projectRoot, read)
  if (refusal && !refusal.ok && refusal.reason === 'unreadable_state') return { status: 'unreadable', error: refusal.error }
  const paths = read.state?.review_drift?.paths ?? []
  return paths.length > 0 ? { status: 'armed', paths: [...paths] } : { status: 'clear' }
}

export function armDriftForFindings(
  projectRoot: string,
  sha: string,
  findings: readonly SecretFinding[],
  now: Date,
  codePaths: readonly string[] = [],
): WritePhaseStateResult {
  const state = readPhaseState(projectRoot).state ?? {}
  const existing = state.review_drift
  const paths = [...new Set([...(existing?.paths ?? []), ...codePaths, ...findings.map((f) => f.file)])]
  const secrets = [...new Set([...(existing?.secrets ?? []), ...findings.map(findingLabel)])]
  return writePhaseState(projectRoot, { ...state, review_drift: { sha, paths, at: now.toISOString(), ...(secrets.length > 0 && { secrets }) } })
}

export function unapprovedFindings(found: readonly SecretFinding[], approved: readonly SecretFinding[]): SecretFinding[] {
  const seen = new Set(approved.map(findingIdentity))
  return found.filter((f) => !seen.has(findingIdentity(f)))
}

const COMMIT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

export function resolvePinned(projectRoot: string, rev: string, executor: GitExecutor): string | null {
  if (rev.startsWith('-')) return null
  const r = executor(projectRoot, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  const sha = r.ok ? r.stdout.trim() : ''
  return COMMIT_ID.test(sha) ? sha : null
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

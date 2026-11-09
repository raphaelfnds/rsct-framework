import { readPhaseState, refuseUnreadableState, writePhaseState, type WritePhaseStateResult } from './phase-scope.js'
import { findingIdentity, findingLabel, quoted } from './gate-exceptions.js'
import type { CommitRange, GitExecutor } from './git.js'
import type { PreMergeAck } from './pre-merge-ack.js'
import type { ExtraPattern, SecretFinding } from './secrets.js'
import type { CommitScanResult } from './staged-scan.js'

type DriftLock = { status: 'clear' } | { status: 'armed'; paths: string[] } | { status: 'unreadable'; error: string }

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

type CommitScanner = (
  projectRoot: string,
  range: CommitRange,
  extraPatterns: ReadonlyArray<ExtraPattern>,
  timeoutMs: number | undefined,
  executor: GitExecutor,
) => Promise<CommitScanResult>

interface LandedRescan {
  findings: SecretFinding[]
  hint: string | null
  audit: { event: 'after_scan_unverified' | 'after_scan_drift'; fields: Record<string, unknown> } | null
}

export async function rescanLanded(args: {
  projectRoot: string
  what: string
  sha: string
  range: CommitRange
  approved: readonly SecretFinding[]
  extras: ReadonlyArray<ExtraPattern>
  timeoutMs: number | undefined
  executor: GitExecutor
  scanner: CommitScanner
  now: Date
}): Promise<LandedRescan> {
  const scan = await args.scanner(args.projectRoot, args.range, args.extras, args.timeoutMs, args.executor)
  if (!scan.ok) {
    return {
      findings: [],
      hint: `⚠ the ${args.what} landed, but RSCT could not scan what it wrote (${scan.reason}) — check it before any push; the push gate scans it again.`,
      audit: { event: 'after_scan_unverified', fields: { reason: scan.reason, sha_after: args.sha } },
    }
  }
  const findings = unapprovedFindings(scan.findings, args.approved)
  if (findings.length === 0) return { findings, hint: null, audit: null }
  const paths = [...new Set(findings.map((f) => f.file))]
  const armed = armDriftForFindings(args.projectRoot, args.sha, findings, args.now)
  return {
    findings,
    hint: `⚠ the ${args.what} wrote ${findings.length} secret finding(s) the dialog did not show (${paths.join(', ')}). ${
      armed.ok
        ? 'Commits, merges, rebases and pushes are refused until rsct_phase_review_start / _complete covers those paths.'
        : `RSCT could not arm the review_drift lock (${armed.reason}); do not push until they are checked.`
    }`,
    audit: { event: 'after_scan_drift', fields: { findings_count: findings.length, paths, sha_after: args.sha, lock_armed: armed.ok } },
  }
}

export function unapprovedFindings(found: readonly SecretFinding[], approved: readonly SecretFinding[]): SecretFinding[] {
  const seen = new Set(approved.map(findingIdentity))
  return found.filter((f) => !seen.has(findingIdentity(f)))
}

interface HeadPosition {
  ref: string | null
  sha: string | null
}

export function readHeadPosition(projectRoot: string, executor: GitExecutor): HeadPosition {
  const ref = executor(projectRoot, ['symbolic-ref', '-q', 'HEAD'])
  return { ref: ref.ok ? ref.stdout.trim() : null, sha: resolvePinned(projectRoot, 'HEAD', executor) }
}

export function sameHeadPosition(a: HeadPosition, b: HeadPosition): boolean {
  return a.ref === b.ref && a.sha === b.sha
}

export function mergeMessage(source: string, target: string): string {
  return `Merge branch '${source}'${target === 'main' || target === 'master' ? '' : ` into ${target}`}`
}

export function driftRefusal(paths: readonly string[], action: string): string {
  return `a commit, merge or rebase landed content no dialog showed the developer (${paths.join(', ')}); ${action} is refused until rsct_phase_review_start / _complete covers those paths. No dialog was shown.`
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUDIT_PRUNED_EVENT,
  AUDIT_RETENTION_DAYS,
  NEWEST_ONLY_EVENTS,
  PINNED_EVENTS,
  PINNED_NAME_PARTS,
  clearRetentionMemo,
  describeRetention,
  planCut,
  previewRetention,
  pruneAuditLog,
  retentionClassOf,
  retentionDialogLine,
  type RetentionOutcome,
  type RetentionSeams,
} from '../../src/lib/audit-retention.js'
import { decideAuditPath } from '../../src/lib/audit-log.js'
import { deriveAuditCeiling } from '../../src/lib/free-commit.js'
import { readBaselineFromLog } from '../../src/lib/settings-drift.js'
import { validateDevApproval } from '../../src/lib/dev-approval.js'
import { evaluateMcpHealth } from '../../src/lib/health.js'
import { auditHandler } from '../../src/tools/audit.js'
import { tutorStepHandler } from '../../src/tools/tutor-step.js'
import { anchorFor, clearAnchorCache } from '../../src/lib/repo-anchor.js'

const NOW = new Date('2026-10-10T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-retention-'))
  mkdirSync(join(root, '.rsct'), { recursive: true })
  clearRetentionMemo()
  clearAnchorCache()
  if (decideAuditPath(root, undefined).path !== logPath()) {
    throw new Error('the temp folder sits inside a git repository: these cases would cut that repository log')
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const logPath = (): string => join(root, '.rsct', 'audit.log')
const reports = (): string => join(root, '.rsct', 'reports')
const lockPath = (): string => join(reports(), 'audit-prune.lock')
const oldPath = (): string => join(reports(), 'audit-prune-old.log')
const tempPath = (): string => join(reports(), 'audit-prune-new.log')
const stampAt = (ageMs: number): string => new Date(NOW.getTime() - ageMs).toISOString()

function entry(event: string, ageDays: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ event, ...extra, ts: stampAt(ageDays * DAY_MS) })
}

function entryAt(event: string, ageMs: number): string {
  return JSON.stringify({ event, ts: stampAt(ageMs) })
}

function writeLog(lines: string[]): void {
  writeFileSync(logPath(), lines.map((line) => `${line}\n`).join(''), 'utf8')
}

function logLines(): string[] {
  return readFileSync(logPath(), 'utf8').split('\n').filter((line) => line.length > 0)
}

function parsedLog(): Array<Record<string, unknown>> {
  return logLines().map((line) => JSON.parse(line) as Record<string, unknown>)
}

function eventsIn(): string[] {
  return parsedLog().map((line) => String(line.event))
}

function cut(seams: RetentionSeams = {}, now: Date = NOW): RetentionOutcome {
  const [outcome] = pruneAuditLog(root, undefined, now, seams)
  if (outcome === undefined) throw new Error('no outcome')
  return outcome
}

function plantLock(cutId: string, ageMs: number): void {
  mkdirSync(reports(), { recursive: true })
  writeFileSync(lockPath(), JSON.stringify({ log: logPath(), cut: cutId }), 'utf8')
  const at = new Date(Date.now() - ageMs)
  utimesSync(lockPath(), at, at)
}

function markerFor(cutId: string, sourceBytes: number, ageDays: number): string {
  return JSON.stringify({
    event: AUDIT_PRUNED_EVENT,
    dropped: 1,
    kept: 0,
    cutoff: stampAt((ageDays + AUDIT_RETENTION_DAYS) * DAY_MS),
    source_bytes: sourceBytes,
    dropped_total: 1,
    first_cut_at: stampAt(ageDays * DAY_MS),
    cut: cutId,
    ts: stampAt(ageDays * DAY_MS),
  })
}

const OLD_ROUTINE = entry('request_commit.committed', 30)
const RECENT = entry('code.start', 1)
const STALE_MS = 5 * 60 * 1000

const EXPECTED_PINNED = [
  'classify.verdict',
  'review.unverified_decision',
  'review.dead_code_kept',
  'review.public_api_approved',
  'review.commit_drift',
  'approval.consumed',
  'plan_authorize.authorized',
  'plan_revoke.revoked',
  'tutor.step',
  'free_commit.committed',
  'free_commit.locked',
  'sanitize.stripped',
  'audit_log.migrated',
]

const EXPECTED_NEWEST_ONLY = [
  'settings.baseline',
  'rsct_json.malformed',
  'rsct_json.bounds_violation',
  'install.drift_detected',
  'sanitize.malformed',
  'sanitize.migration_skipped',
  'settings.drift_detected',
  'audit.pruned',
]

describe('lib/audit-retention — which entries a cut keeps (#93)', () => {
  it('pins exactly these events and name parts, and keeps only the newest of exactly these', () => {
    expect([...PINNED_EVENTS].sort()).toEqual([...EXPECTED_PINNED].sort())
    expect([...NEWEST_ONLY_EVENTS].sort()).toEqual([...EXPECTED_NEWEST_ONLY].sort())
    expect([...PINNED_NAME_PARTS]).toEqual(['override', 'skip', 'degraded', 'bypass'])
    expect(AUDIT_RETENTION_DAYS).toBe(10)
  })

  it('drops routine history older than ten days, from the top, and keeps what is recent', () => {
    writeLog([OLD_ROUTINE, entry('verification.finding', 12), entry('request_push.pushed', 9), RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2 })
    expect(eventsIn()).toEqual(['request_push.pushed', 'code.start', AUDIT_PRUNED_EVENT])
  })

  it.each([
    ...EXPECTED_PINNED,
    'request_commit.override_invoked',
    'request_push.override_invoked',
    'request_merge.override_invoked',
    'request_rebase.override_invoked',
    'code.start.classify_downgrade_override',
    'code.start.plan_tracking_override',
    'code.start.verification_override',
    'verification.skip',
    'request_push.pre_merge_ack_degraded',
    'request_merge.pre_merge_ack_degraded',
    'test.start.review_skipped_declined',
    'future.gate_bypass',
  ])('keeps an old %s entry whatever its age', (event) => {
    writeLog([entry(event, 400), OLD_ROUTINE, RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1, kept: 1 })
    expect(eventsIn()).toEqual([event, 'code.start', AUDIT_PRUNED_EVENT])
  })

  it.each(EXPECTED_NEWEST_ONLY.filter((event) => event !== AUDIT_PRUNED_EVENT))(
    'keeps only the last of the old %s entries',
    (event) => {
      writeLog([
        entry(event, 90, { hash: 'h', n: 1 }),
        entry(event, 60, { hash: 'h', n: 2 }),
        entry(event, 30, { hash: 'h', n: 3 }),
        RECENT,
      ])
      expect(cut()).toMatchObject({ status: 'pruned', dropped: 2, kept: 1 })
      expect(parsedLog().filter((line) => line.event === event).map((line) => line.n)).toEqual([3])
    },
  )

  it('keeps the newest of each repeating state record, one event never standing in for another', () => {
    writeLog([
      entry('settings.baseline', 90, { hash: 'accepted' }),
      entry('rsct_json.malformed', 80, { n: 1 }),
      entry('install.drift_detected', 70),
      entry('rsct_json.malformed', 60, { n: 2 }),
      OLD_ROUTINE,
      RECENT,
    ])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2, kept: 3 })
    expect(eventsIn()).toEqual([
      'settings.baseline',
      'install.drift_detected',
      'rsct_json.malformed',
      'code.start',
      AUDIT_PRUNED_EVENT,
    ])
    expect(readBaselineFromLog(readFileSync(logPath(), 'utf8'))?.hash).toBe('accepted')
  })

  it('a repeating state record is newest-only even when its name looks like a bypass', () => {
    expect(retentionClassOf('sanitize.migration_skipped')).toBe('newest_only')
    expect(retentionClassOf('verification.skip')).toBe('pinned')
    expect(retentionClassOf('classify.verdict')).toBe('pinned')
    expect(retentionClassOf('request_commit.rejected')).toBe('dated')
    expect(retentionClassOf('request_commit.bootstrap_warning')).toBe('dated')
  })

  it('keeps the last baseline the settings reader accepts, not a later one it would ignore', () => {
    writeLog([
      entry('settings.baseline', 60, { hash: 'accepted' }),
      entry('settings.baseline', 50),
      entry('settings.baseline', 40, { hash: '' }),
      RECENT,
    ])
    const before = readBaselineFromLog(readFileSync(logPath(), 'utf8'))
    expect(before?.hash).toBe('accepted')
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2 })
    expect(readBaselineFromLog(readFileSync(logPath(), 'utf8'))).toEqual(before)
  })

  it('stops at the first entry inside the window and leaves everything below it alone', () => {
    const backdated = entry('request_commit.committed', 200)
    const firstRecent = entry('spec.start', 2)
    writeLog([OLD_ROUTINE, firstRecent, backdated, RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
    expect(logLines().slice(0, 3)).toEqual([firstRecent, backdated, RECENT])
  })

  it('treats an entry stamped in the future as inside the window', () => {
    const future = entry('spec.start', -30)
    writeLog([OLD_ROUTINE, future, entry('request_commit.committed', 100), RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
    expect(logLines()[0]).toBe(future)
  })

  it('keeps what it cannot date and carries on past it', () => {
    const opaque = [
      'null',
      '[1,2]',
      '42',
      'not json at all',
      '{"event":"request_commit.committed"}',
      '{"event":"request_commit.committed","ts":"Sat Oct 10 2026"}',
      '{"event":"request_commit.committed","ts":"2026-01-01 00:00:00"}',
      '{"event":"request_commit.committed","ts":1759000000000}',
      '{"event":7,"ts":"2026-01-01T00:00:00.000Z"}',
      '{"event":"request_commit.committed","ts":"2026-13-01T00:00:00.000Z"}',
      '{"event":"request_commit.committed","ts":"2026-01-01T00:00:00.123456Z"}',
    ]
    writeLog([...opaque, OLD_ROUTINE, RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1, kept: opaque.length })
    expect(logLines().slice(0, opaque.length)).toEqual(opaque)
    expect(logLines()).toHaveLength(opaque.length + 2)
  })

  it('dates a stamp without milliseconds and a first line behind a byte-order mark', () => {
    const withMark = `${String.fromCharCode(0xfeff)}${JSON.stringify({ event: 'spec.start', ts: '2026-01-01T00:00:00.000Z' })}`
    const noMillis = JSON.stringify({ event: 'spec.complete', ts: '2026-01-02T00:00:00Z' })
    writeLog([withMark, noMillis, RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2, kept: 0 })
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
  })

  it('never rewrites a kept line: CRLF, accents and a 100 KB entry survive byte for byte', () => {
    const accented = entry('review.dead_code_kept', 90, { note: 'não remover — função pública' })
    const big = entry('tutor.step', 80, { result: 'ç'.repeat(50_000) })
    writeFileSync(logPath(), `${accented}\r\n${OLD_ROUTINE}\n${big}\n${RECENT}\r\n`, 'utf8')
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
    const raw = readFileSync(logPath())
    const marker = `${JSON.stringify(parsedLog().at(-1))}\n`
    expect(raw.equals(Buffer.from(`${accented}\r\n${big}\n${RECENT}\r\n${marker}`, 'utf8'))).toBe(true)
  })

  it('carries an unterminated last line over whole, once', () => {
    const partial = '{"event":"code.start","unterminated":true'
    writeFileSync(logPath(), `${OLD_ROUTINE}\n${RECENT}\n${partial}`, 'utf8')
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
    const lines = readFileSync(logPath(), 'utf8').split('\n')
    expect(lines.filter((line) => line === partial)).toHaveLength(1)
    expect(lines.filter((line) => line.includes('unterminated'))).toHaveLength(1)
  })

  it('keeps the surviving entries in file order, whatever their stamps say', () => {
    writeLog([
      entry('classify.verdict', 20, { tier: 'small' }),
      OLD_ROUTINE,
      entry('classify.verdict', 40, { tier: 'complex' }),
      RECENT,
    ])
    expect(cut().status).toBe('pruned')
    expect(parsedLog().slice(0, 2).map((line) => line.tier)).toEqual(['small', 'complex'])
  })

  it('cuts at ten days, to the millisecond', () => {
    writeLog([OLD_ROUTINE, entryAt('spec.start', 10 * DAY_MS + 1), entryAt('code.start', 10 * DAY_MS)])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2 })
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
  })

  it('waits until something droppable is more than eleven days old, and writes nothing before that', () => {
    writeLog([entry('classify.verdict', 300, { tier: 'small' }), entryAt('spec.start', 11 * DAY_MS), RECENT])
    const before = readFileSync(logPath())
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(cut()).toMatchObject({ status: 'idle', reason: 'not_due' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)

    writeLog([entry('classify.verdict', 300, { tier: 'small' }), entryAt('spec.start', 11 * DAY_MS + 1), RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it('forecasts a cut only once it reaches an entry more than twenty days old', () => {
    writeLog([entryAt('spec.start', 20 * DAY_MS), entryAt('spec.complete', 19 * DAY_MS), RECENT])
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(existsSync(reports())).toBe(false)

    writeLog([entryAt('spec.start', 20 * DAY_MS + 1), entryAt('spec.complete', 19 * DAY_MS), RECENT])
    const before = readFileSync(logPath())
    expect(previewRetention(root, undefined, NOW)).toBe(2)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2 })
  })

  it('does not come due because of an old entry it keeps', () => {
    writeLog([entry('settings.baseline', 300, { hash: 'h' }), entry('approval.consumed', 200), RECENT])
    expect(cut()).toMatchObject({ status: 'idle', reason: 'not_due' })
  })

  it('re-reads the log once it holds the lock, and cuts nothing if nothing is due any more', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const outcome = cut({
      link: (existing, created) => {
        linkSync(existing, created)
        writeLog([RECENT])
      },
    })
    expect(outcome).toMatchObject({ status: 'idle', reason: 'not_due' })
    expect(logLines()).toEqual([RECENT])
    expect(existsSync(reports())).toBe(false)
  })

  it('plans nothing for a log with no complete line', () => {
    expect(planCut(Buffer.from('{"event":"x"', 'utf8'), NOW.getTime())).toMatchObject({ due: false, dropped: 0, tailStart: 0 })
    expect(planCut(Buffer.alloc(0), NOW.getTime())).toMatchObject({ due: false, dropped: 0, tailStart: 0 })
  })
})

describe('lib/audit-retention — every reader gets the same answer after a cut (#93)', () => {
  it('ceiling, baseline, approval results and health are unchanged, and the tutor counts every old step', async () => {
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }), 'utf8')
    writeLog([
      entry('classify.verdict', 300, { tier: 'complex' }),
      entry('classify.verdict', 200, { tier: 'small' }),
      entry('review.unverified_decision', 150, { answer: 'yes', path: 'src/a.ts', blob: 'b1' }),
      entry('review.dead_code_kept', 140, { path: 'src/a.ts', name: 'kept', declaration_sha256: 'd1' }),
      entry('review.public_api_approved', 130, {
        public_api_sha256: 'p1',
        path: 'src/a.ts',
        name: 'api',
        declaration_sha256: 'd2',
      }),
      entry('tutor.step', 120, { spec_ref: 'spec-a' }),
      entry('tutor.step', 110, { spec_ref: 'spec-a' }),
      entry('settings.baseline', 100, { hash: 'old' }),
      entry('settings.baseline', 90, { hash: 'current' }),
      entry('approval.consumed', 85, { action_scope: 'commit', approval_timestamp: stampAt(85 * DAY_MS) }),
      entry('approval.consumed', 80, { action_scope: 'commit', approval_timestamp: stampAt(80 * DAY_MS) }),
      entry('request_commit.committed', 70),
      entry('verification.finding', 60),
      RECENT,
    ])
    const read = (): unknown => {
      const ceiling = deriveAuditCeiling(root, null)
      const approval = validateDevApproval(
        { timestamp: NOW.toISOString(), action_scope: 'commit', reason: 'a reason that is long enough' },
        { projectRoot: root, now: NOW },
      )
      return {
        present: ceiling.classifyEvidencePresent,
        tierMax: ceiling.auditTierMax,
        unverified: [...ceiling.unverifiedDecisions],
        keeps: [...ceiling.deadCodeKeepDecisions],
        publicApi: [...ceiling.publicApiApprovals],
        baseline: readBaselineFromLog(readFileSync(logPath(), 'utf8')),
        approvalStatus: approval.status,
        approvalSignals: approval.fabrication_signals,
        health: evaluateMcpHealth(root, { now: NOW, config: null }).reasons,
      }
    }
    const before = read()
    expect(before).toMatchObject({
      present: true,
      tierMax: 'complex',
      baseline: { hash: 'current' },
      approvalStatus: 'valid',
      approvalSignals: ['approvals_store_absent'],
    })
    const sets = before as { unverified: unknown[]; keeps: unknown[]; publicApi: unknown[] }
    expect([sets.unverified.length, sets.keeps.length, sets.publicApi.length]).toEqual([1, 1, 1])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 3 })
    expect(read()).toEqual(before)
    expect(eventsIn().filter((event) => event === 'approval.consumed')).toHaveLength(2)

    const step = await tutorStepHandler({
      project_root: root,
      spec_ref: 'spec-a',
      step_kind: 'propose',
      step_description: 'the third step of this tutor session',
    })
    expect(step.step_number).toBe(3)
  })
})

describe('lib/audit-retention — the record and the words a cut leaves (#93)', () => {
  it('appends an audit.pruned entry with the counts, a cut id and the offset it copied up to', () => {
    writeLog([OLD_ROUTINE, entry('request_commit.committed', 20), entry('classify.verdict', 15, { tier: 'small' }), RECENT])
    const sourceBytes = statSync(logPath()).size
    const outcome = cut()
    expect(outcome).toMatchObject({ status: 'pruned', dropped: 2, kept: 1, cutoff: stampAt(10 * DAY_MS), bytes_before: sourceBytes })
    const marker = parsedLog().at(-1)
    expect(marker).toEqual({
      event: AUDIT_PRUNED_EVENT,
      dropped: 2,
      kept: 1,
      cutoff: stampAt(10 * DAY_MS),
      source_bytes: sourceBytes,
      dropped_total: 2,
      first_cut_at: NOW.toISOString(),
      cut: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ts: NOW.toISOString(),
    })
    expect(outcome.status === 'pruned' && outcome.bytes_after).toBe(statSync(logPath()).size)
  })

  it('keeps a running total across cuts, finding the last marker wherever it sits', () => {
    writeLog([OLD_ROUTINE, entry('request_commit.committed', 20), RECENT])
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 2 })
    appendFileSync(logPath(), `${entry('spec.start', 0)}\n${entry('spec.complete', 0)}\n`, 'utf8')
    const second = new Date(NOW.getTime() + 20 * DAY_MS)
    expect(cut({}, second)).toMatchObject({ status: 'pruned', dropped: 3 })
    appendFileSync(logPath(), `${entry('spec.start', -20)}\n`, 'utf8')
    const third = new Date(NOW.getTime() + 40 * DAY_MS)
    expect(cut({}, third)).toMatchObject({ status: 'pruned', dropped: 2 })
    const markers = parsedLog().filter((line) => line.event === AUDIT_PRUNED_EVENT)
    expect(markers.map((line) => line.dropped_total)).toEqual([5, 7])
    expect(markers.map((line) => line.first_cut_at)).toEqual([NOW.toISOString(), NOW.toISOString()])
  })

  it('says in the audit report that the log is not the whole history', async () => {
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }), 'utf8')
    const report = await auditHandler({ project_root: root }, {})
    expect(report.coverage_boundary.join(' ')).toContain(
      `.rsct/audit.log is not the whole history: about once a day a commit that landed through rsct_request_commit removes the entries older than ${AUDIT_RETENTION_DAYS} days.`,
    )
  })

  it('says in the dialog how many lines are due, in the singular and in the plural', () => {
    expect(retentionDialogLine(0)).toBeNull()
    expect(retentionDialogLine(1)).toBe('Audit log: 1 line older than 10 days is due for removal with this commit.')
    expect(retentionDialogLine(3)).toBe('Audit log: 3 lines older than 10 days are due for removal with this commit.')
  })

  it('reports a cut, adding the lines of every log it cut, and stays silent when nothing happened', () => {
    const pruned = (dropped: number): RetentionOutcome => ({
      status: 'pruned',
      path: 'p',
      dropped,
      kept: 1,
      cutoff: 'c',
      bytes_before: 10,
      bytes_after: 5,
    })
    expect(describeRetention([pruned(1)])).toMatch(/^Audit log retention \(ADR-025\): 1 line older than 10 days was removed from the audit log\./)
    expect(describeRetention([pruned(2), pruned(3)])).toMatch(/: 5 lines older than 10 days were removed/)
    expect(describeRetention([pruned(2)])).toBe(
      'Audit log retention (ADR-025): 2 lines older than 10 days were removed from the audit log. Kept whatever their age: the entries a gate can still use, the entries named as an override, skip, degraded check or bypass, and the newest of each repeating state record. An audit.pruned entry records the cut.',
    )
    expect(describeRetention([])).toBeNull()
    expect(describeRetention([{ status: 'idle', path: 'p', reason: 'absent' }])).toBeNull()
    expect(describeRetention([{ status: 'idle', path: 'p', reason: 'not_due' }])).toBeNull()
    expect(describeRetention([{ status: 'idle', path: 'p', reason: 'volume_refused' }])).toBeNull()
    expect(describeRetention([{ status: 'skipped', path: 'p', reason: 'busy', detail: null }])).toBeNull()
  })

  it('reports every state in which the log is not being cut', () => {
    const skip = (
      reason:
        | 'unsupported'
        | 'not_atomic'
        | 'too_large'
        | 'not_regular'
        | 'failed'
        | 'working_path'
        | 'stream_path'
        | 'anchor_unavailable',
      detail: string | null,
    ): RetentionOutcome => ({ status: 'skipped', path: 'p', reason, detail })
    const told = (outcomes: RetentionOutcome[]): string | null => describeRetention(outcomes)
    const prefix = 'Audit log retention (ADR-025): '
    expect(told([skip('unsupported', 'ENOTSUP')])).toBe(
      `${prefix}the audit log is not cut on this volume — it cannot hard-link (ENOTSUP) — and keeps growing.`,
    )
    expect(told([skip('not_atomic', '9p')])).toBe(
      `${prefix}the audit log is not cut on this volume — replacing a file is not atomic on a 9p share, such as a Windows disk seen from WSL — and keeps growing.`,
    )
    expect(told([skip('stream_path', null)])).toBe(
      `${prefix}audit.path names a stream inside a file, so no audit log is cut.`,
    )
    expect(told([skip('too_large', null)])).toBe(
      `${prefix}the audit log is larger than 512 MB and is not cut; what to do with it is the developer's decision, not the agent's.`,
    )
    expect(told([skip('not_regular', null)])).toBe(`${prefix}the audit log path is not a regular file and is not cut.`)
    expect(told([skip('working_path', null)])).toBe(
      `${prefix}audit.path names one of the cut's own working files, so no audit log is cut.`,
    )
    expect(told([skip('anchor_unavailable', null)])).toBe(
      `${prefix}git could not report the repository, so the audit log is not cut in this session.`,
    )
    expect(told([skip('failed', 'EPERM: rename')])).toBe(
      `${prefix}the cut did not complete (EPERM: rename); a later commit finishes or retries it.`,
    )
    expect(told([{ status: 'recovered', path: 'p' }])).toBe(
      `${prefix}an audit-log cut that an earlier call left interrupted was finished or undone; a later commit cuts.`,
    )
  })

  it('puts the cut first, then each other state once', () => {
    const told = describeRetention([
      { status: 'skipped', path: 'a', reason: 'working_path', detail: null },
      { status: 'skipped', path: 'b', reason: 'working_path', detail: null },
      { status: 'skipped', path: 'c', reason: 'unsupported', detail: 'EXDEV' },
      { status: 'pruned', path: 'd', dropped: 2, kept: 0, cutoff: 'c', bytes_before: 2, bytes_after: 1 },
    ])
    expect(told).toBe(
      "Audit log retention (ADR-025): 2 lines older than 10 days were removed from the audit log. Kept whatever their age: the entries a gate can still use, the entries named as an override, skip, degraded check or bypass, and the newest of each repeating state record. An audit.pruned entry records the cut. Also: audit.path names one of the cut's own working files, so no audit log is cut. Also: the audit log is not cut on this volume — it cannot hard-link (EXDEV) — and keeps growing.",
    )
  })
})

describe('lib/audit-retention — replacing the file without losing an entry (#93)', () => {
  const late = entry('request_push.pushed', 0)

  it('carries over an entry appended between the copy and the swap', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const outcome = cut({
      onStep: (step, paths) => {
        if (step === 'ready') appendFileSync(paths.log, `${late}\n`, 'utf8')
      },
    })
    expect(outcome.status).toBe('pruned')
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(logLines()).toHaveLength(3)
  })

  it('rescues an entry that reaches the old file after the swap', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const outcome = cut({
      onStep: (step, paths) => {
        if (step === 'swapped') appendFileSync(paths.old, `${late}\n`, 'utf8')
      },
    })
    expect(outcome.status).toBe('pruned')
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
  })

  it('looks at the old file again after waiting, for as long as it keeps growing', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const second = entry('spec.start', 0)
    let old = ''
    const waits: number[] = []
    const outcome = cut({
      onStep: (_step, paths) => {
        old = paths.old
      },
      wait: (ms) => {
        if (waits.length === 0) appendFileSync(old, `${late}\n`, 'utf8')
        if (waits.length === 1) appendFileSync(old, `${second}\n`, 'utf8')
        waits.push(ms)
      },
    })
    expect(outcome.status).toBe('pruned')
    expect(waits).toEqual([20, 20, 20])
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(logLines().filter((line) => line === second)).toHaveLength(1)
    expect(readFileSync(logPath(), 'utf8')).not.toContain('\n\n')
  })

  it('stops looking at the old file after five looks, however long it keeps growing', () => {
    writeLog([OLD_ROUTINE, RECENT])
    let old = ''
    const waits: number[] = []
    const outcome = cut({
      onStep: (_step, paths) => {
        old = paths.old
      },
      wait: (ms) => {
        waits.push(ms)
        appendFileSync(old, `${entry('spec.start', 0, { n: waits.length })}\n`, 'utf8')
      },
    })
    expect(outcome.status).toBe('pruned')
    expect(waits).toEqual([20, 20, 20, 20])
    expect(parsedLog().filter((line) => line.event === 'spec.start').map((line) => line.n)).toEqual([1, 2, 3, 4])
    expect(existsSync(reports())).toBe(false)
  })

  it('copies what arrives while it works, and gives up as busy when the log never settles', () => {
    writeLog([OLD_ROUTINE, RECENT])
    let rounds = 0
    let sizeAtLastRound = 0
    const settled = cut({
      onStep: (step, paths) => {
        if (step !== 'catch_up') return
        if (rounds++ < 3) appendFileSync(paths.log, `${entry('spec.start', 0, { n: rounds })}\n`, 'utf8')
        sizeAtLastRound = statSync(paths.log).size
      },
    })
    expect(settled.status).toBe('pruned')
    expect(parsedLog().filter((line) => line.event === 'spec.start').map((line) => line.n)).toEqual([1, 2, 3])
    expect(eventsIn().at(-1)).toBe(AUDIT_PRUNED_EVENT)
    expect(parsedLog().at(-1)?.source_bytes).toBe(sizeAtLastRound)
    expect(settled.status === 'pruned' && settled.bytes_after).toBe(statSync(logPath()).size)

    writeLog([OLD_ROUTINE, RECENT])
    let appended = 0
    const busy = cut({
      onStep: (step, paths) => {
        if (step === 'catch_up') appendFileSync(paths.log, `${entry('spec.start', 0, { n: ++appended })}\n`, 'utf8')
      },
    })
    expect(busy).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(appended).toBe(6)
    expect(logLines()).toHaveLength(2 + appended)
    expect(logLines()[0]).toBe(OLD_ROUTINE)
    expect(existsSync(reports())).toBe(false)
  })

  it('works inside .rsct/reports and leaves that folder as it found it', () => {
    mkdirSync(reports(), { recursive: true })
    writeFileSync(join(reports(), 'review-comments-abc.md'), 'a report\n', 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    let during: string[] = []
    cut({
      onStep: (step) => {
        if (step === 'ready') during = readdirSync(reports()).sort()
      },
    })
    expect(during).toEqual(['audit-prune-new.log', 'audit-prune-old.log', 'audit-prune.lock', 'review-comments-abc.md'])
    expect(readdirSync(reports())).toEqual(['review-comments-abc.md'])
    expect(readdirSync(join(root, '.rsct')).sort()).toEqual(['audit.log', 'reports'])
  })

  it('removes the folder it created', () => {
    writeLog([OLD_ROUTINE, RECENT])
    expect(cut().status).toBe('pruned')
    expect(readdirSync(join(root, '.rsct'))).toEqual(['audit.log'])
  })

  it('touches nothing while another cut holds the lock, and previews nothing', () => {
    writeLog([OLD_ROUTINE, RECENT])
    plantLock('another-cut', 0)
    linkSync(logPath(), oldPath())
    const before = readFileSync(logPath())
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(readdirSync(reports()).sort()).toEqual(['audit-prune-old.log', 'audit-prune.lock'])
  })

  it('undoes an interrupted cut that never swapped, and cuts on the call after that', () => {
    writeLog([OLD_ROUTINE, markerFor('interrupted', 0, 2), RECENT])
    plantLock('interrupted', STALE_MS)
    writeFileSync(tempPath(), 'half written', 'utf8')
    linkSync(logPath(), oldPath())
    const before = readFileSync(logPath())

    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it('finishes an interrupted cut that had swapped: what reached the old file is appended', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const crashed = cut({
      onStep: (step, paths) => {
        if (step !== 'swapped') return
        appendFileSync(paths.old, `${late}\n`, 'utf8')
        throw new Error('killed after the swap')
      },
    })
    expect(crashed).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'killed after the swap' })
    expect(logLines()).not.toContain(late)
    expect(readdirSync(reports()).sort()).toEqual(['audit-prune-old.log', 'audit-prune.lock'])
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'busy' })

    const stale = new Date(Date.now() - STALE_MS)
    utimesSync(lockPath(), stale, stale)
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT, 'request_push.pushed'])
    expect(existsSync(reports())).toBe(false)
  })

  it('rescues nothing when the newest marker belongs to another cut', () => {
    writeLog([markerFor('an-earlier-cut', 0, 2), RECENT])
    plantLock('interrupted', STALE_MS)
    writeFileSync(oldPath(), `${late}\n`, 'utf8')
    const before = readFileSync(logPath())
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it.each([
    ['missing', undefined],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '0'],
  ])('rescues nothing when the marker of the interrupted cut has a %s offset', (_label, sourceBytes) => {
    const marker = JSON.parse(markerFor('interrupted', 0, 2)) as Record<string, unknown>
    if (sourceBytes === undefined) delete marker.source_bytes
    else marker.source_bytes = sourceBytes
    writeLog([JSON.stringify(marker), RECENT])
    plantLock('interrupted', STALE_MS)
    writeFileSync(oldPath(), `${late}\n`, 'utf8')
    const before = readFileSync(logPath())
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it('rescues from the offset the marker of the interrupted cut recorded', () => {
    const copied = `${OLD_ROUTINE}\n`
    writeLog([markerFor('interrupted', Buffer.byteLength(copied, 'utf8'), 2), RECENT])
    plantLock('interrupted', STALE_MS)
    writeFileSync(oldPath(), `${copied}${late}\n`, 'utf8')
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(logLines()).not.toContain(OLD_ROUTINE)
    expect(existsSync(reports())).toBe(false)
  })

  it('finishes an interrupted cut of the second log into that log, not into the first', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    const moved = join(root, 'logs', 'audit.log')
    writeFileSync(moved, `${RECENT}\n`, 'utf8')
    writeLog([markerFor('interrupted', 0, 2), RECENT])
    plantLock('interrupted', STALE_MS)
    writeFileSync(oldPath(), `${late}\n`, 'utf8')
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['recovered'])
    expect(readFileSync(moved, 'utf8')).toBe(`${RECENT}\n`)
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
  })

  it('does not rescue twice when the old file could not be removed after the rescue', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const crashed = cut({
      onStep: (step, paths) => {
        if (step === 'swapped') appendFileSync(paths.old, `${late}\n`, 'utf8')
        if (step === 'rescued') throw new Error('the old file would not go')
      },
    })
    expect(crashed).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'the old file would not go' })
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(existsSync(oldPath())).toBe(true)
    if (existsSync(lockPath())) {
      const stale = new Date(Date.now() - STALE_MS)
      utimesSync(lockPath(), stale, stale)
    }
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(existsSync(reports())).toBe(false)
  })

  it('takes a working folder that vanished under it for another cut finishing, not for a failure', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const outcome = cut({
      onStep: (step) => {
        if (step === 'lock') rmSync(reports(), { recursive: true, force: true })
      },
    })
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it('yields to a lock another cut took first, and leaves that lock as it is', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const rival = JSON.stringify({ log: logPath(), cut: 'someone-else' })
    const outcome = cut({
      onStep: (step) => {
        if (step === 'lock') writeFileSync(lockPath(), rival, 'utf8')
      },
    })
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(readFileSync(lockPath(), 'utf8')).toBe(rival)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(readdirSync(reports())).toEqual(['audit-prune.lock'])
  })

  it('takes a lock for dead after a minute, not before', () => {
    writeLog([OLD_ROUTINE, RECENT])
    plantLock('interrupted', 50 * 1000)
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'busy' })
    plantLock('interrupted', 70 * 1000)
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(existsSync(reports())).toBe(false)
  })

  it('renews its lock before the swap, so a long cut is not taken for a dead one', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const inner: RetentionOutcome[] = []
    let lockAgeAtSwap = Number.POSITIVE_INFINITY
    const outcome = cut({
      onStep: (step) => {
        if (step === 'ready') {
          const stale = new Date(Date.now() - STALE_MS)
          utimesSync(lockPath(), stale, stale)
        }
        if (step === 'swapped') inner.push(cut())
      },
      rename: (from, to) => {
        lockAgeAtSwap = Date.now() - statSync(lockPath()).mtimeMs
        renameSync(from, to)
      },
    })
    expect(lockAgeAtSwap).toBeLessThan(60 * 1000)
    expect(inner).toMatchObject([{ status: 'skipped', reason: 'busy' }])
    expect(outcome).toMatchObject({ status: 'pruned', dropped: 1 })
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
    expect(existsSync(reports())).toBe(false)
  })

  it('writes what it rescues only into a log this project uses', () => {
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    const stranger = join(root, 'elsewhere', 'notes.log')
    writeFileSync(stranger, `${markerFor('interrupted', 0, 2)}\n`, 'utf8')
    const strangerBefore = readFileSync(stranger)
    writeLog([markerFor('interrupted', 0, 2), RECENT])
    const logBefore = readFileSync(logPath())
    mkdirSync(reports(), { recursive: true })
    writeFileSync(lockPath(), JSON.stringify({ log: stranger, cut: 'interrupted' }), 'utf8')
    const stale = new Date(Date.now() - STALE_MS)
    utimesSync(lockPath(), stale, stale)
    writeFileSync(oldPath(), `${late}\n`, 'utf8')
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(stranger).equals(strangerBefore)).toBe(true)
    expect(readFileSync(logPath()).equals(logBefore)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it('treats a lock stamped far in the future as stale, but one stamped a moment ahead as live', () => {
    writeLog([OLD_ROUTINE, RECENT])
    plantLock('created-this-millisecond', -500)
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(existsSync(lockPath())).toBe(true)

    plantLock('from-the-future', -24 * 60 * 60 * 1000)
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(existsSync(reports())).toBe(false)
  })

  it.each(['audit-prune-new.log', 'audit-prune-old.log'])('clears a working file left with no lock (%s)', (name) => {
    writeLog([OLD_ROUTINE, RECENT])
    mkdirSync(reports(), { recursive: true })
    writeFileSync(join(reports(), name), 'orphan', 'utf8')
    const before = readFileSync(logPath())
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  const PLAN9 = 0x01021997
  const NOT_ATOMIC_NOTE =
    'Audit log retention (ADR-025): the audit log is not cut on this volume — replacing a file is not atomic on a 9p share, such as a Windows disk seen from WSL — and keeps growing.'

  it.runIf(process.platform === 'linux')('does not cut a log on a 9p share, and says why once', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const seams = { volumeType: (): number => PLAN9 }
    const first = pruneAuditLog(root, undefined, NOW, seams)
    expect(first).toMatchObject([{ status: 'skipped', reason: 'not_atomic', detail: '9p' }])
    expect(describeRetention(first)).toBe(NOT_ATOMIC_NOTE)
    expect(pruneAuditLog(root, undefined, NOW, seams)).toMatchObject([{ status: 'idle', reason: 'volume_refused' }])
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it.runIf(process.platform === 'linux')('forecasts nothing for a log on a 9p share, and the commit that follows says why', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const seams = { volumeType: (): number => PLAN9 }
    expect(previewRetention(root, undefined, NOW, seams)).toBe(0)
    expect(existsSync(reports())).toBe(false)
    expect(describeRetention(pruneAuditLog(root, undefined, NOW, seams))).toBe(NOT_ATOMIC_NOTE)
  })

  it.runIf(process.platform === 'linux')('cuts on any other kind of volume, and when the kind cannot be told', () => {
    writeLog([OLD_ROUTINE, RECENT])
    expect(cut({ volumeType: () => 0xef53 })).toMatchObject({ status: 'pruned', dropped: 1 })
    clearRetentionMemo()
    writeLog([OLD_ROUTINE, RECENT])
    const blind = cut({
      volumeType: () => {
        throw new Error('no statfs here')
      },
    })
    expect(blind).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it.runIf(process.platform !== 'linux')('does not ask what kind of volume the log is on outside Linux', () => {
    writeLog([OLD_ROUTINE, RECENT])
    let asked = 0
    const outcome = cut({
      volumeType: () => {
        asked++
        return PLAN9
      },
    })
    expect(outcome).toMatchObject({ status: 'pruned', dropped: 1 })
    expect(asked).toBe(0)
  })

  it('leaves the log alone where hard links are not available, and stops trying', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    let attempts = 0
    const link = (): void => {
      attempts++
      throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
    }
    expect(cut({ link })).toMatchObject({ status: 'skipped', reason: 'unsupported', detail: 'ENOTSUP' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
    expect(cut({ link })).toMatchObject({ status: 'idle', reason: 'volume_refused' })
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(attempts).toBe(1)
  })

  const failingLink = (code: string, counter: { attempts: number }) => (): void => {
    counter.attempts++
    throw Object.assign(new Error(`link refused: ${code}`), { code })
  }

  it.each(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])('takes %s from the link for a volume without hard links', (code) => {
    writeLog([OLD_ROUTINE, RECENT])
    const counter = { attempts: 0 }
    expect(cut({ link: failingLink(code, counter) })).toMatchObject({ status: 'skipped', reason: 'unsupported', detail: code })
    expect(cut({ link: failingLink(code, counter) })).toMatchObject({ status: 'idle', reason: 'volume_refused' })
    expect(counter.attempts).toBe(1)
    expect(existsSync(reports())).toBe(false)
  })

  it('takes EPERM from the link for a volume without hard links everywhere but on Windows', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const counter = { attempts: 0 }
    const first = cut({ link: failingLink('EPERM', counter) })
    const second = cut({ link: failingLink('EPERM', counter) })
    if (process.platform === 'win32') {
      expect(first).toMatchObject({ status: 'skipped', reason: 'failed' })
      expect(second).toMatchObject({ status: 'skipped', reason: 'failed' })
      expect(counter.attempts).toBe(2)
    } else {
      expect(first).toMatchObject({ status: 'skipped', reason: 'unsupported', detail: 'EPERM' })
      expect(second).toMatchObject({ status: 'idle', reason: 'volume_refused' })
      expect(counter.attempts).toBe(1)
    }
    expect(existsSync(reports())).toBe(false)
  })

  it('forecasts nothing on a volume without hard links, and the commit that follows says why once', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const counter = { attempts: 0 }
    const link = failingLink('ENOTSUP', counter)
    expect(previewRetention(root, undefined, NOW, { link })).toBe(0)
    expect(existsSync(reports())).toBe(false)
    expect(previewRetention(root, undefined, NOW, { link })).toBe(0)
    expect(counter.attempts).toBe(1)
    expect(describeRetention(pruneAuditLog(root, undefined, NOW, { link }))).toMatch(/cannot hard-link \(ENOTSUP\)/)
    expect(describeRetention(pruneAuditLog(root, undefined, NOW, { link }))).toBeNull()
    expect(counter.attempts).toBe(1)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
  })

  it('tries the link once to forecast, then cuts without asking again', () => {
    writeLog([OLD_ROUTINE, RECENT])
    let attempts = 0
    const link = (existing: string, created: string): void => {
      attempts++
      linkSync(existing, created)
    }
    expect(previewRetention(root, undefined, NOW, { link })).toBe(1)
    expect(previewRetention(root, undefined, NOW, { link })).toBe(1)
    expect(attempts).toBe(1)
    expect(existsSync(reports())).toBe(false)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
    expect(cut({ link })).toMatchObject({ status: 'pruned', dropped: 1 })
    expect(attempts).toBe(2)
  })

  it('forecasts nothing while another cut holds the lock, on a volume it already knows', () => {
    writeLog([OLD_ROUTINE, RECENT])
    expect(previewRetention(root, undefined, NOW)).toBe(1)
    plantLock('another-cut', 0)
    expect(previewRetention(root, undefined, NOW)).toBe(0)
  })

  it('forecasts nothing, and leaves nothing behind, when trying the link fails for another reason', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const counter = { attempts: 0 }
    expect(previewRetention(root, undefined, NOW, { link: failingLink('EACCES', counter) })).toBe(0)
    expect(counter.attempts).toBe(1)
    expect(existsSync(reports())).toBe(false)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it('does not clear a lock that changed hands while it tried the link', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const rival = JSON.stringify({ log: logPath(), cut: 'someone-else' })
    const due = previewRetention(root, undefined, NOW, {
      link: (existing, created) => {
        linkSync(existing, created)
        writeFileSync(lockPath(), rival, 'utf8')
      },
    })
    expect(due).toBe(1)
    expect(readFileSync(lockPath(), 'utf8')).toBe(rival)
    expect(existsSync(oldPath())).toBe(true)
  })

  it('does not take any other link failure for a volume without hard links', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    let attempts = 0
    const link = (): void => {
      attempts++
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    expect(cut({ link })).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'permission denied' })
    expect(cut({ link })).toMatchObject({ status: 'skipped', reason: 'failed' })
    expect(attempts).toBe(2)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it('leaves the log as it was when the swap itself fails', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const rename = (): void => {
      throw Object.assign(new Error('target is open'), { code: 'EPERM' })
    }
    expect(cut({ rename })).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'target is open' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
    expect(cut()).toMatchObject({ status: 'pruned', dropped: 1 })
  })

  it('neither swaps nor removes anything when its lock was taken over while it worked', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    let renames = 0
    const outcome = cut({
      onStep: (step) => {
        if (step === 'ready') plantLock('someone-else', STALE_MS)
      },
      rename: () => {
        renames++
      },
    })
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(renames).toBe(0)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(readdirSync(reports()).sort()).toEqual(['audit-prune-new.log', 'audit-prune-old.log', 'audit-prune.lock'])
    expect(Date.now() - statSync(lockPath()).mtimeMs).toBeGreaterThan(STALE_MS - 60 * 1000)
  })

  it('does not swap when its lock was cleared while it worked, and the next call tidies up', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    let renames = 0
    const outcome = cut({
      onStep: (step) => {
        if (step === 'ready') rmSync(lockPath())
      },
      rename: () => {
        renames++
      },
    })
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(renames).toBe(0)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(cut()).toMatchObject({ status: 'recovered' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(existsSync(reports())).toBe(false)
  })

  it('removes nothing when its lock was taken over during a swap that failed', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    const outcome = cut({
      rename: () => {
        writeFileSync(lockPath(), JSON.stringify({ log: logPath(), cut: 'someone-else' }), 'utf8')
        throw Object.assign(new Error('target is open'), { code: 'EPERM' })
      },
    })
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'failed' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(readdirSync(reports()).sort()).toEqual(['audit-prune-new.log', 'audit-prune-old.log', 'audit-prune.lock'])
  })

  it('fails without touching the log when it cannot create its working folder', () => {
    writeLog([OLD_ROUTINE, RECENT])
    writeFileSync(reports(), 'a file where the folder should be', 'utf8')
    const before = readFileSync(logPath())
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'failed' })
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(readFileSync(reports(), 'utf8')).toBe('a file where the folder should be')
  })

  it('skips a missing log, a path that is not a regular file, and a log over the size limit', () => {
    expect(cut()).toMatchObject({ status: 'idle', reason: 'absent' })
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    expect(cut({ maxBytes: before.length - 1 })).toMatchObject({ status: 'skipped', reason: 'too_large' })
    expect(previewRetention(root, undefined, NOW, { maxBytes: before.length - 1 })).toBe(0)
    expect(readFileSync(logPath()).equals(before)).toBe(true)
    expect(cut({ maxBytes: before.length })).toMatchObject({ status: 'pruned' })
    rmSync(logPath())
    mkdirSync(logPath(), { recursive: true })
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'not_regular' })
  })

  it.skipIf(process.platform === 'win32').each([0o600, 0o666])('keeps the mode of the log (%o)', (mode) => {
    writeLog([OLD_ROUTINE, RECENT])
    chmodSync(logPath(), mode)
    expect(cut().status).toBe('pruned')
    expect(statSync(logPath()).mode & 0o777).toBe(mode)
  })

  it('cuts the default log too when the project moved its log', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(join(root, 'logs', 'audit.log'), `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([entry('rsct_json.malformed', 90), entry('rsct_json.malformed', 30), RECENT])
    expect(previewRetention(root, { path: 'logs/audit.log' }, NOW)).toBe(2)
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['pruned', 'pruned'])
    expect(outcomes.map((outcome) => outcome.path)).toEqual([join(root, 'logs', 'audit.log'), logPath()])
    expect(readdirSync(join(root, 'logs'))).toEqual(['audit.log'])
  })

  it('a call that repairs never cuts, even with two logs', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(join(root, 'logs', 'audit.log'), `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    plantLock('interrupted', STALE_MS)
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['recovered'])
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
  })

  const WORKING_NAMES = ['audit-prune.lock', 'audit-prune-new.log', 'audit-prune-old.log']
  const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin'

  it.each([
    ...WORKING_NAMES,
    ...(CASE_BLIND ? WORKING_NAMES.map((name) => name.toUpperCase()) : []),
  ])('refuses to cut any log when audit.path names a working file (%s)', (name) => {
    mkdirSync(reports(), { recursive: true })
    const configured = join(reports(), name)
    writeFileSync(configured, `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    const config = { path: `.rsct/reports/${name}` }
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => [outcome.status, 'reason' in outcome ? outcome.reason : null])).toEqual([
      ['skipped', 'working_path'],
      ['skipped', 'working_path'],
    ])
    expect(previewRetention(root, config, NOW)).toBe(0)
    expect(readFileSync(configured, 'utf8')).toBe(`${OLD_ROUTINE}\n${RECENT}\n`)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
    expect(readdirSync(reports())).toHaveLength(1)
  })

  it.each([
    ...WORKING_NAMES,
    ...(CASE_BLIND ? WORKING_NAMES.map((name) => name.toUpperCase()) : []),
  ])('refuses at once a log path that names a working file, before any file is there (%s)', (name) => {
    writeLog([OLD_ROUTINE, RECENT])
    const config = { path: `.rsct/reports/${name}` }
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual([
      'working_path',
      'working_path',
    ])
    expect(previewRetention(root, config, NOW)).toBe(0)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
    expect(existsSync(reports())).toBe(false)
  })

  it.each(WORKING_NAMES)('refuses a working file it reaches through another folder name (%s)', (name) => {
    mkdirSync(reports(), { recursive: true })
    symlinkSync(reports(), join(root, 'alias'), 'junction')
    const held = join(reports(), name)
    writeFileSync(held, `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    const config = { path: `alias/${name}` }
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual([
      'working_path',
      'working_path',
    ])
    expect(describeRetention(outcomes)).toMatch(/names one of the cut's own working files/)
    expect(previewRetention(root, config, NOW)).toBe(0)
    expect(readFileSync(held, 'utf8')).toBe(`${OLD_ROUTINE}\n${RECENT}\n`)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
    expect(readdirSync(reports())).toEqual([name])
  })

  it.runIf(process.platform === 'win32')('refuses a working file it reaches through another folder name and another case', () => {
    mkdirSync(reports(), { recursive: true })
    symlinkSync(reports(), join(root, 'alias'), 'junction')
    writeFileSync(oldPath(), `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    const outcomes = pruneAuditLog(root, { path: 'alias/AUDIT-PRUNE-OLD.LOG' }, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : null))).toEqual(['working_path', 'working_path'])
    expect(readFileSync(oldPath(), 'utf8')).toBe(`${OLD_ROUTINE}\n${RECENT}\n`)
  })

  it.runIf(process.platform === 'win32')('cuts nothing when audit.path names a stream inside the log itself', () => {
    const stream = `${logPath()}:x`
    const kept = entry('request_commit.override_invoked', 1)
    writeLog([OLD_ROUTINE, RECENT])
    writeFileSync(stream, `${kept}\n`, 'utf8')
    const config = { path: '.rsct/audit.log:x' }
    expect(previewRetention(root, config, NOW)).toBe(0)
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['stream_path'])
    expect(readFileSync(stream, 'utf8')).toBe(`${kept}\n`)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
    expect(describeRetention(outcomes)).toBe(
      'Audit log retention (ADR-025): audit.path names a stream inside a file, so no audit log is cut.',
    )
  })

  it.runIf(process.platform === 'win32')('cuts nothing when audit.path names a working file as a stream', () => {
    mkdirSync(reports(), { recursive: true })
    writeFileSync(oldPath(), `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    writeLog([OLD_ROUTINE, RECENT])
    const outcomes = pruneAuditLog(root, { path: '.rsct/reports/audit-prune-old.log::$DATA' }, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['stream_path'])
    expect(readFileSync(oldPath(), 'utf8')).toBe(`${OLD_ROUTINE}\n${RECENT}\n`)
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
  })

  it.runIf(process.platform !== 'win32')('takes a colon in a file name for part of the name where it is one', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    const named = join(root, 'logs', 'audit:x.log')
    writeFileSync(named, `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    const outcomes = pruneAuditLog(root, { path: 'logs/audit:x.log' }, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['pruned', 'absent'])
  })

  it('counts one log, not two, when audit.path names the default log', () => {
    writeLog([OLD_ROUTINE, RECENT])
    expect(pruneAuditLog(root, { path: '.rsct/audit.log' }, NOW)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('cuts the default log itself when audit.path is a symbolic link to it', () => {
    writeLog([OLD_ROUTINE, RECENT])
    mkdirSync(join(root, 'logs'), { recursive: true })
    symlinkSync(logPath(), join(root, 'logs', 'audit.log'))
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => [outcome.status, outcome.path])).toEqual([['pruned', logPath()]])
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
    expect(readFileSync(join(root, 'logs', 'audit.log'), 'utf8')).toBe(readFileSync(logPath(), 'utf8'))
  })

  it.runIf(process.platform === 'win32').each(['?', '.'])(
    'does not take the device prefix of a project root for a stream (%s)',
    (mark) => {
      writeLog([OLD_ROUTINE, RECENT])
      const prefix = `${String.raw`\\`}${mark}${'\\'}`
      clearAnchorCache()
      const outcomes = pruneAuditLog(`${prefix}${root}`, undefined, NOW)
      expect(outcomes.map((outcome) => [outcome.status, outcome.path.startsWith(prefix)])).toEqual([['pruned', true]])
      expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
      expect(existsSync(reports())).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')('cuts the moved log when the default path is only a symbolic link to it', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    const moved = join(root, 'logs', 'audit.log')
    writeFileSync(moved, `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    symlinkSync(moved, logPath())
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => [outcome.status, outcome.path])).toEqual([['pruned', moved]])
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
  })

  it('still forecasts and cuts the default log when audit.path holds a NUL and is ignored', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const config = { path: `logs/a${String.fromCharCode(0)}.log` }
    expect(previewRetention(root, config, NOW)).toBe(1)
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['pruned'])
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
  })

  it('finishes an interrupted cut whose lock names the log by the spelling audit.path gives it', () => {
    const late = entry('request_push.pushed', 0)
    writeLog([markerFor('interrupted', 0, 2), RECENT])
    symlinkSync(join(root, '.rsct'), join(root, 'alias'), 'junction')
    const config = { path: 'alias/audit.log' }
    mkdirSync(reports(), { recursive: true })
    writeFileSync(lockPath(), JSON.stringify({ log: join(root, 'alias', 'audit.log'), cut: 'interrupted' }), 'utf8')
    const stale = new Date(Date.now() - STALE_MS)
    utimesSync(lockPath(), stale, stale)
    writeFileSync(oldPath(), `${late}\n`, 'utf8')
    expect(pruneAuditLog(root, config, NOW).map((outcome) => outcome.status)).toEqual(['recovered'])
    expect(logLines().filter((line) => line === late)).toHaveLength(1)
    expect(existsSync(reports())).toBe(false)
  })

  it('cuts once a default log that audit.path reaches through another folder name', () => {
    writeLog([OLD_ROUTINE, RECENT])
    symlinkSync(join(root, '.rsct'), join(root, 'alias'), 'junction')
    const config = { path: 'alias/audit.log' }
    expect(previewRetention(root, config, NOW)).toBe(1)
    const outcomes = pruneAuditLog(root, config, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['pruned'])
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
    expect(existsSync(reports())).toBe(false)
  })

  it('cuts both names of a log that has two, each as its own file', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeLog([OLD_ROUTINE, RECENT])
    linkSync(logPath(), join(root, 'logs', 'audit.log'))
    const outcomes = pruneAuditLog(root, { path: 'logs/audit.log' }, NOW)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['pruned', 'pruned'])
    expect(eventsIn()).toEqual(['code.start', AUDIT_PRUNED_EVENT])
  })

  it.runIf(CASE_BLIND)('counts one log when audit.path differs from the default only by case', () => {
    writeLog([OLD_ROUTINE, RECENT])
    rmSync(logPath())
    expect(pruneAuditLog(root, { path: '.RSCT/AUDIT.LOG' }, NOW)).toHaveLength(1)
  })

  it.runIf(process.platform === 'linux')('takes a path that differs only by case for another log where case matters', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const outcomes = pruneAuditLog(root, { path: '.RSCT/AUDIT.LOG' }, NOW)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['idle', 'pruned'])
  })

  it('does not take a cut in progress, whose old file is the log under a second name, for a misplaced log', () => {
    writeLog([OLD_ROUTINE, RECENT])
    mkdirSync(reports(), { recursive: true })
    linkSync(logPath(), oldPath())
    const outcomes = pruneAuditLog(root, undefined, NOW)
    expect(outcomes.map((outcome) => ('reason' in outcome ? outcome.reason : outcome.status))).toEqual(['recovered'])
    expect(logLines()).toEqual([OLD_ROUTINE, RECENT])
  })

  it.skipIf(process.platform === 'win32')('does not cut through a symbolic link', () => {
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    const target = join(root, 'elsewhere', 'real.log')
    writeFileSync(target, `${OLD_ROUTINE}\n${RECENT}\n`, 'utf8')
    symlinkSync(target, logPath())
    expect(cut()).toMatchObject({ status: 'skipped', reason: 'not_regular' })
    expect(previewRetention(root, undefined, NOW)).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe(`${OLD_ROUTINE}\n${RECENT}\n`)
  })

  it('does not cut when git could not say where the repository is', () => {
    writeLog([OLD_ROUTINE, RECENT])
    const before = readFileSync(logPath())
    clearAnchorCache()
    anchorFor(root, { worktreeInfo: () => ({ in_git_repo: true, is_worktree: false }) as never, gitRead: () => null })
    try {
      expect(cut()).toMatchObject({ status: 'skipped', reason: 'anchor_unavailable' })
      expect(previewRetention(root, undefined, NOW)).toBe(0)
      expect(readFileSync(logPath()).equals(before)).toBe(true)
    } finally {
      clearAnchorCache()
    }
  })
})

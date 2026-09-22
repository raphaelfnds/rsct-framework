import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SweepLedger, SweepLedgerEntry, SweepVerdict } from '../phase-scope.js'
import { decisionKey, deletionBlob } from './decision-key.js'
import {
  hasGitFilter,
  openSweepRepo,
  readBlob,
  readCommitBlobId,
  readCommitPaths,
  readHeadContent,
  looksLikeLinkTarget,
  readKnownPaths,
  readStagedBlobId,
  readStagedEntries,
  readTouchedPaths,
  readWorkingBlobIds,
  type SweepRepo,
  type TouchedStatus,
} from './git-reads.js'
import {
  collapseWhitespace,
  scanFile,
  type ConfiguredSqlDialect,
  type ScanResult,
  type SweepComment,
  type UnverifiedReason,
} from './index.js'
import { isShippedScriptCopy } from '../version-drift.js'

export type ExemptReason = 'generated' | 'vendored'

export interface SweepFile {
  path: string
  status: TouchedStatus
  blob: string | null
  kind: 'clean' | 'comments_present' | 'unverified' | 'deleted'
  language: string | null
  reason: UnverifiedReason | ExemptReason | 'head_unverified' | null
  comments: SweepComment[]
  allowlist_changes: SweepComment[]
  removed: Array<SweepComment & { path: string }>
}

type WorkingSweep =
  | { ok: true; repo: SweepRepo; files: SweepFile[] }
  | { ok: false; reason: 'not_git_repo' | 'git_read_failed'; detail: string }

export interface SweepOptions {
  sqlDialect?: ConfiguredSqlDialect | undefined
  exempt?: ReadonlyMap<string, ExemptReason> | undefined
  extraPaths?: readonly string[] | undefined
  shippedScriptsDir?: string | null | undefined
}

function isShippedScript(repo: SweepRepo, path: string, bytes: Uint8Array, scan: ScanResult, options: SweepOptions): boolean {
  if (scan.kind === 'unverified' && scan.reason === 'git_filter') return false
  if (repo.prefix.length > 0 && !path.startsWith(repo.prefix)) return false
  return isShippedScriptCopy(path.slice(repo.prefix.length), bytes, options.shippedScriptsDir)
}

export const MIGRATION_DESTINATIONS = [
  'documentation/decisions.md',
  'documentation/knowledge/anti-decisions.md',
  'docs/decisions.md',
] as const

const MIGRATION_MIN_BODY = 20
const LEDGER_ENTRIES_PER_PATH = 20

export interface Disposition {
  comment_id: string
  action: 'migrated' | 'discarded'
  destination?: string | undefined
}

export interface PendingDisposition {
  comment_id: string
  path: string
  head_line: number
  body: string
}

type DispositionCheck =
  | { ok: true; migrations: Map<string, Array<{ destination: string; body: string }>>; migrated: number; discarded: number }
  | {
      ok: false
      reject_kind: 'dispositions_missing' | 'disposition_unknown' | 'disposition_duplicate' | 'migration_missing'
      reason: string
      pending: PendingDisposition[]
    }

async function scanWithFilter(
  repo: SweepRepo,
  path: string,
  bytes: Uint8Array,
  options: SweepOptions,
): Promise<ScanResult> {
  const result = await scanFile(path, bytes, { sqlDialect: options.sqlDialect })
  if (result.kind === 'not_code') return result
  const filtered = hasGitFilter(repo, path)
  if (filtered === null || filtered) return { kind: 'unverified', language: result.language, reason: 'git_filter' }
  return result
}

async function scanBlobBytes(path: string, bytes: Uint8Array, options: SweepOptions): Promise<ScanResult> {
  return scanFile(path, bytes, { sqlDialect: options.sqlDialect })
}

function readWorkingBytes(repo: SweepRepo, path: string): Uint8Array | null {
  const full = join(repo.toplevel, path)
  try {
    if (!lstatSync(full).isFile()) return null
    return new Uint8Array(readFileSync(full))
  } catch {
    return null
  }
}

export function normalizeRepoPath(repo: SweepRepo, path: string): string {
  const forward = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (repo.prefix.length === 0 || forward.startsWith(repo.prefix)) return forward
  return lstatExists(repo, forward) ? forward : `${repo.prefix}${forward}`
}

function lstatExists(repo: SweepRepo, path: string): boolean {
  try {
    lstatSync(join(repo.toplevel, path))
    return true
  } catch {
    return false
  }
}

export async function computeWorkingSweep(projectRoot: string, options: SweepOptions): Promise<WorkingSweep> {
  const repo = openSweepRepo(projectRoot)
  if (!repo) return { ok: false, reason: 'not_git_repo', detail: 'project_root is not inside a git work tree' }
  const touched = readTouchedPaths(repo)
  if (!touched) return { ok: false, reason: 'git_read_failed', detail: 'could not list the touched paths' }
  const byPath = new Map(touched.map((t) => [t.path, t]))
  const known = readKnownPaths(repo)
  for (const extra of options.extraPaths ?? []) {
    if (!byPath.has(extra) && known?.has(extra)) {
      byPath.set(extra, { path: extra, status: 'modified', symlink: false })
    }
  }

  const present = [...byPath.values()].filter((t) => t.status !== 'deleted').map((t) => t.path)
  const blobs = readWorkingBlobIds(repo, present.filter((p) => readWorkingBytes(repo, p) !== null))
  if (!blobs) return { ok: false, reason: 'git_read_failed', detail: 'could not hash the touched files' }

  const files: SweepFile[] = []
  for (const { path, status, symlink } of [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const head = readHeadContent(repo, path)
    const headScan = head ? await scanBlobBytes(path, head, options) : null
    const headComments = headScan?.kind === 'scanned' ? headScan.comments : []

    if (status === 'deleted') {
      if (headScan === null || headScan.kind === 'not_code') continue
      const headBlob = repo.headCommit ? readCommitBlobId(repo, repo.headCommit, path) : null
      files.push({
        path,
        status,
        blob: headBlob ? deletionBlob(headBlob) : null,
        kind: 'deleted',
        language: headScan.language,
        reason: null,
        comments: [],
        allowlist_changes: [],
        removed: headComments.map((c) => ({ ...c, path })),
      })
      continue
    }

    const bytes = readWorkingBytes(repo, path)
    if (bytes === null) continue
    if (symlink && looksLikeLinkTarget(Buffer.from(bytes))) continue
    const blob = blobs.get(path)
    if (!blob) return { ok: false, reason: 'git_read_failed', detail: `could not hash ${path}` }
    const scan = await scanWithFilter(repo, path, bytes, options)
    if (scan.kind === 'not_code') continue
    if (isShippedScript(repo, path, bytes, scan, options)) continue

    const base = { path, status, blob, comments: [], allowlist_changes: [], removed: [] }
    const exempt = options.exempt?.get(path)
    if (exempt) {
      files.push({ ...base, kind: 'unverified', language: scan.language, reason: exempt })
      continue
    }
    if (scan.kind === 'unverified') {
      files.push({ ...base, kind: 'unverified', language: scan.language, reason: scan.reason })
      continue
    }
    if (headScan?.kind === 'unverified') {
      files.push({ ...base, kind: 'unverified', language: scan.language, reason: 'head_unverified' })
      continue
    }
    const nowIds = new Set([...scan.comments, ...scan.allowlisted].map((c) => c.id))
    const headAllowIds = new Set(headScan?.kind === 'scanned' ? headScan.allowlisted.map((c) => c.id) : [])
    files.push({
      ...base,
      kind: scan.comments.length > 0 ? 'comments_present' : 'clean',
      language: scan.language,
      reason: null,
      comments: scan.comments,
      allowlist_changes: scan.allowlisted.filter((c) => !headAllowIds.has(c.id)),
      removed: headComments.filter((c) => !nowIds.has(c.id)).map((c) => ({ ...c, path })),
    })
  }
  return { ok: true, repo, files }
}

export function workingBlobIds(repo: SweepRepo, paths: readonly string[]): Map<string, string> | null {
  return readWorkingBlobIds(repo, paths)
}

function addedText(headText: string | null, currentText: string): string {
  const remaining = new Map<string, number>()
  for (const line of (headText ?? '').replace(/\r/g, '').split('\n')) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  const added: string[] = []
  for (const line of currentText.replace(/\r/g, '').split('\n')) {
    const n = remaining.get(line) ?? 0
    if (n > 0) remaining.set(line, n - 1)
    else added.push(line)
  }
  return collapseWhitespace(added.join('\n'))
}

function destinationTexts(repo: SweepRepo, destination: string): { head: string | null; current: string | null } {
  const repoPath = `${repo.prefix}${destination}`
  const head = readHeadContent(repo, repoPath)
  const bytes = readWorkingBytes(repo, repoPath)
  return {
    head: head ? head.toString('utf8') : null,
    current: bytes ? Buffer.from(bytes).toString('utf8') : null,
  }
}

export function checkDispositions(repo: SweepRepo, files: SweepFile[], dispositions: readonly Disposition[]): DispositionCheck {
  const removed = new Map<string, SweepComment & { path: string }>()
  for (const f of files) for (const c of f.removed) removed.set(c.id, c)
  const pendingOf = (ids: Iterable<string>): PendingDisposition[] =>
    [...ids].map((id) => {
      const c = removed.get(id)!
      return { comment_id: id, path: c.path, head_line: c.line, body: c.body }
    })

  const seen = new Set<string>()
  for (const d of dispositions) {
    if (!removed.has(d.comment_id)) {
      return {
        ok: false,
        reject_kind: 'disposition_unknown',
        reason: `comment_dispositions names '${d.comment_id}', which is not a comment this change removed`,
        pending: pendingOf(removed.keys()),
      }
    }
    if (seen.has(d.comment_id)) {
      return {
        ok: false,
        reject_kind: 'disposition_duplicate',
        reason: `comment_dispositions names '${d.comment_id}' more than once`,
        pending: pendingOf(removed.keys()),
      }
    }
    seen.add(d.comment_id)
  }
  const missing = [...removed.keys()].filter((id) => !seen.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      reject_kind: 'dispositions_missing',
      reason: `${missing.length} removed comment(s) have no disposition — classify each as migrated or discarded`,
      pending: pendingOf(missing),
    }
  }

  const texts = new Map<string, string>()
  const migrations = new Map<string, Array<{ destination: string; body: string }>>()
  let migrated = 0
  let discarded = 0
  for (const d of dispositions) {
    const comment = removed.get(d.comment_id)!
    if (d.action === 'discarded') {
      discarded++
      continue
    }
    const destination = d.destination ?? ''
    const known = (MIGRATION_DESTINATIONS as readonly string[]).includes(destination)
    if (!known || comment.body.length < MIGRATION_MIN_BODY) {
      return {
        ok: false,
        reject_kind: 'migration_missing',
        reason: !known
          ? `'${d.comment_id}' is migrated to '${destination}', which is not one of ${MIGRATION_DESTINATIONS.join(', ')}`
          : `'${d.comment_id}' is too short to verify as migrated (${comment.body.length} < ${MIGRATION_MIN_BODY} chars) — discard it or migrate a longer statement of the fact`,
        pending: pendingOf([d.comment_id]),
      }
    }
    let added = texts.get(destination)
    if (added === undefined) {
      const { head, current } = destinationTexts(repo, destination)
      added = current === null ? '' : addedText(head, current)
      texts.set(destination, added)
    }
    if (!added.includes(comment.body)) {
      return {
        ok: false,
        reject_kind: 'migration_missing',
        reason: `'${d.comment_id}' is marked migrated, but its text is not among the lines added to ${destination}`,
        pending: pendingOf([d.comment_id]),
      }
    }
    migrated++
    const list = migrations.get(comment.path) ?? []
    list.push({ destination, body: comment.body })
    migrations.set(comment.path, list)
  }
  return { ok: true, migrations, migrated, discarded }
}

function isLedgerEntry(value: unknown): value is SweepLedgerEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e.blob === 'string' &&
    (e.verdict === 'clean' || e.verdict === 'unverified_authorized') &&
    Array.isArray(e.migrations) &&
    typeof e.channel === 'string' &&
    typeof e.spec_ref === 'string' &&
    typeof e.at === 'string'
  )
}

async function migrationsHold(
  repo: SweepRepo,
  entry: SweepLedgerEntry,
  cache: Map<string, string>,
): Promise<boolean> {
  for (const m of entry.migrations) {
    if (typeof m.body !== 'string') return false
    let content = cache.get(m.destination)
    if (content === undefined) {
      const repoPath = `${repo.prefix}${m.destination}`
      const stagedDest = readStagedBlobId(repo, repoPath)
      const destBytes = stagedDest ? readBlob(repo, stagedDest) : readHeadContent(repo, repoPath)
      content = destBytes ? collapseWhitespace(destBytes.toString('utf8')) : ''
      cache.set(m.destination, content)
    }
    if (!content.includes(m.body)) return false
  }
  return true
}

export function ledgerEntries(ledger: unknown, path: string): SweepLedgerEntry[] {
  if (!ledger || typeof ledger !== 'object') return []
  const list = (ledger as Record<string, unknown>)[path]
  return Array.isArray(list) ? list.filter(isLedgerEntry) : []
}

export function stampLedger(
  ledger: unknown,
  stamps: ReadonlyArray<{ path: string; entry: SweepLedgerEntry }>,
  known: ReadonlySet<string> | null,
): SweepLedger {
  const next: SweepLedger = {}
  const stamped = new Set(stamps.map((s) => s.path))
  if (ledger && typeof ledger === 'object') {
    for (const path of Object.keys(ledger as Record<string, unknown>)) {
      if (known && !known.has(path) && !stamped.has(path)) continue
      const entries = ledgerEntries(ledger, path)
      if (entries.length > 0) next[path] = entries
    }
  }
  for (const { path, entry } of stamps) {
    const kept = (next[path] ?? []).filter((e) => e.blob !== entry.blob)
    next[path] = [entry, ...kept].slice(0, LEDGER_ENTRIES_PER_PATH)
  }
  return next
}

export function sweepEntry(
  blob: string,
  verdict: SweepVerdict,
  migrations: Array<{ destination: string; body: string }>,
  channel: string,
  specRef: string,
  at: string,
): SweepLedgerEntry {
  return { blob, verdict, migrations: migrations.map((m) => ({ ...m })), channel, spec_ref: specRef, at }
}

export type StagedSweepCheck =
  | { ok: true; skipped: 'not_git_repo' | null; checked: Array<{ path: string; blob: string; unverified: boolean }> }
  | {
      ok: false
      reject_kind: 'review_missing' | 'comments_present' | 'migration_reverted' | 'review_drift' | 'review_unreadable'
      reason: string
      paths: string[]
    }

export async function checkStagedSweep(args: {
  projectRoot: string
  options: SweepOptions
  ledger: unknown
  drift: { paths: string[] } | undefined
  unverifiedDecisions: ReadonlySet<string>
}): Promise<StagedSweepCheck> {
  const repo = openSweepRepo(args.projectRoot)
  if (!repo) return { ok: true, skipped: 'not_git_repo', checked: [] }
  const staged = readStagedEntries(repo)
  if (staged === null) {
    return { ok: false, reject_kind: 'review_unreadable', reason: 'could not read the staged paths from git', paths: [] }
  }

  const checked: Array<{ path: string; blob: string; unverified: boolean }> = []
  const missing: string[] = []
  const withComments: string[] = []
  const reverted: string[] = []
  const destinationCache = new Map<string, string>()

  for (const { path, status, headBlob, symlink } of staged) {
    if (status === 'deleted') {
      if (!headBlob) continue
      const headBytes = readBlob(repo, headBlob)
      if (!headBytes) {
        return { ok: false, reject_kind: 'review_unreadable', reason: `could not read the HEAD content of ${path}`, paths: [path] }
      }
      const headScan = await scanBlobBytes(path, headBytes, args.options)
      if (headScan.kind !== 'scanned' || headScan.comments.length === 0) continue
      const deletionEntry = ledgerEntries(args.ledger, path).find((e) => e.blob === deletionBlob(headBlob))
      if (!deletionEntry) {
        missing.push(path)
        continue
      }
      if (!(await migrationsHold(repo, deletionEntry, destinationCache))) reverted.push(path)
      continue
    }
    const blob = readStagedBlobId(repo, path)
    const bytes = blob ? readBlob(repo, blob) : null
    if (!blob || !bytes) {
      return { ok: false, reject_kind: 'review_unreadable', reason: `could not read the staged content of ${path}`, paths: [path] }
    }
    if (symlink && looksLikeLinkTarget(bytes)) continue
    const scan = await scanWithFilter(repo, path, bytes, args.options)
    if (scan.kind === 'not_code') continue
    if (isShippedScript(repo, path, bytes, scan, args.options)) {
      checked.push({ path, blob, unverified: true })
      continue
    }
    const entry = ledgerEntries(args.ledger, path).find((e) => e.blob === blob)
    const authorized =
      entry?.verdict === 'unverified_authorized' && args.unverifiedDecisions.has(decisionKey(path, blob))
    if (scan.kind === 'scanned' && scan.comments.length > 0 && !authorized) {
      withComments.push(path)
      continue
    }
    if (!entry || (scan.kind === 'unverified' && !authorized)) {
      missing.push(path)
      continue
    }
    if (!(await migrationsHold(repo, entry, destinationCache))) {
      reverted.push(path)
      continue
    }
    checked.push({ path, blob, unverified: authorized })
  }

  const driftPaths = args.drift?.paths ?? []
  if (driftPaths.length > 0) {
    const stagedPaths = new Map(staged.map((e) => [e.path, e]))
    const carried = new Set(checked.map((c) => c.path))
    const openDrift = driftCovered(args.projectRoot, args.ledger, driftPaths).open.filter((path) => {
      const entry = stagedPaths.get(path)
      if (!entry) return true
      if (entry.status === 'deleted') {
        return !(entry.headBlob && ledgerEntries(args.ledger, path).some((e) => e.blob === deletionBlob(entry.headBlob!)))
      }
      return !carried.has(path)
    })
    if (openDrift.length > 0) {
      return {
        ok: false,
        reject_kind: 'review_drift',
        reason: `a previous commit landed code that no review covers (${openDrift.join(', ')}) — run rsct_phase_review_start / _complete over those paths, or stage the reviewed fix for them in this commit`,
        paths: openDrift,
      }
    }
  }

  if (withComments.length > 0) {
    return {
      ok: false,
      reject_kind: 'comments_present',
      reason: `staged code still carries comments: ${withComments.join(', ')} — remove them in a REVIEW (rsct_phase_review_start / _complete)`,
      paths: withComments,
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reject_kind: 'review_missing',
      reason: `no completed REVIEW covers the staged version of: ${missing.join(', ')} — run rsct_phase_review_start / _complete over the final code, then stage it unchanged`,
      paths: missing,
    }
  }
  if (reverted.length > 0) {
    return {
      ok: false,
      reject_kind: 'migration_reverted',
      reason: `a fact migrated out of ${reverted.join(', ')} is no longer in its destination file — restore it before committing`,
      paths: reverted,
    }
  }
  return { ok: true, skipped: null, checked }
}

type CommittedSweep = { drift: string[]; rewrites: Array<{ path: string; blob: string }>; full_sha: string | null }

export async function verifyCommittedSweep(args: {
  projectRoot: string
  options: SweepOptions
  before: string | null
  after: string
  checked: ReadonlyArray<{ path: string; blob: string }>
}): Promise<CommittedSweep> {
  const repo = openSweepRepo(args.projectRoot)
  if (!repo) return { drift: [], rewrites: [], full_sha: null }
  const fullSha = repo.headCommit
  const expected = new Map(args.checked.map((c) => [c.path, c.blob]))
  const paths = readCommitPaths(repo, args.before, args.after)
  if (paths === null) return { drift: [...expected.keys()], rewrites: [], full_sha: fullSha }
  const drift: string[] = []
  const rewrites: Array<{ path: string; blob: string }> = []
  for (const { path, symlink } of paths) {
    const blob = readCommitBlobId(repo, args.after, path)
    if (!blob) {
      drift.push(path)
      continue
    }
    if (expected.get(path) === blob) continue
    const bytes = readBlob(repo, blob)
    if (!bytes) {
      drift.push(path)
      continue
    }
    if (symlink && looksLikeLinkTarget(bytes)) continue
    const scan = await scanWithFilter(repo, path, bytes, args.options)
    if (scan.kind === 'not_code') continue
    if (scan.kind === 'scanned' && scan.comments.length === 0 && expected.has(path)) {
      rewrites.push({ path, blob })
      continue
    }
    drift.push(path)
  }
  return { drift, rewrites, full_sha: fullSha }
}

export function knownPaths(projectRoot: string): ReadonlySet<string> | null {
  const repo = openSweepRepo(projectRoot)
  return repo ? readKnownPaths(repo) : null
}

export function driftCovered(
  projectRoot: string,
  ledger: unknown,
  paths: readonly string[],
): { covered: string[]; open: string[] } {
  const repo = openSweepRepo(projectRoot)
  if (!repo) return { covered: [], open: [...paths] }
  const covered: string[] = []
  const open: string[] = []
  for (const path of paths) {
    const headBlob = repo.headCommit ? readCommitBlobId(repo, repo.headCommit, path) : null
    if (headBlob === null) {
      covered.push(path)
      continue
    }
    if (ledgerEntries(ledger, path).some((e) => e.blob === headBlob)) {
      covered.push(path)
      continue
    }
    open.push(path)
  }
  return { covered, open }
}

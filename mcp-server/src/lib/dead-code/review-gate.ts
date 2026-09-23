import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyPath } from '../comment-sweep/language.js'
import {
  openSweepRepo,
  readBlobTexts,
  readIndexEntries,
  readIndexFingerprint,
  readKnownPaths,
  readSkipWorktreePaths,
  readUntrackedPaths,
  readWorktreeChangedPaths,
  type SweepRepo,
} from '../comment-sweep/git-reads.js'
import { deadCodeKeepKey, publicApiApprovalKey } from '../free-commit.js'
import type { DeadCodeKeepRecord } from '../phase-scope.js'
import {
  configFilesFrom,
  corpusFrom,
  findDeadSymbols,
  isBuildOutput,
  languageOf,
  normalizeLineEndings,
  packageRootsOf,
  parseSizeLimitText,
  workingTreeReader,
  type DeadSymbol,
  type SourceRead,
  type SourceReader,
} from './references.js'

export interface DeadCodeKeep {
  path: string
  name: string
  declaration_sha256: string
  note: string
}

export interface PendingDeadSymbol {
  path: string
  name: string
  kind: string
  exported: boolean
  declaration_sha256: string
  declaration: string
  keep_stale: boolean
}

export type DeadCodeRejectKind = 'dead_code_remaining' | 'dead_code_keep_stale' | 'dead_code_unreadable'

export type DeadCodeCheck =
  | {
      ok: true
      kept: PendingDeadSymbol[]
      public_exempted: PendingDeadSymbol[]
      unknown: number
      hints: string[]
    }
  | {
      ok: false
      reject_kind: DeadCodeRejectKind
      reason: string
      hints: string[]
      pending: PendingDeadSymbol[]
    }

export type StagedDeadCodeCheck =
  | { ok: true; kept: number; unknown: number; hints: string[] }
  | { ok: false; reject_kind: 'dead_code_staged'; reason: string; hints: string[]; paths: string[] }

export const UNCOVERED_LANGUAGE_HINT_PREFIX = 'Dead-code scan: not checked'
export const OTHER_LANGUAGE_EVIDENCE_HINT_PREFIX = 'Dead-code scan: references from other languages are not read'
export const UNSTAGED_MENTION_HINT_PREFIX = 'Files not staged yet mention the refused symbol(s)'

const DECLARATION_PREVIEW = 400
const NO_REFERENCES_TO_CODE: ReadonlySet<string> = new Set(['css', 'sql', 'scss', 'sass', 'less'])

let analysisHook: (() => void) | null = null

export function setDeadCodeAnalysisHookForTests(hook: (() => void) | null): void {
  analysisHook = hook
}

export function publicApiDigest(globs: readonly string[] | undefined): string | null {
  if (!globs || globs.length === 0) return null
  return createHash('sha256').update(JSON.stringify([...new Set(globs)].sort()), 'utf8').digest('hex')
}

function unstagedMentions(projectRoot: string, stagedPaths: readonly string[], names: readonly string[]): string[] {
  const repo = openSweepRepo(projectRoot)
  if (!repo || names.length === 0) return []
  const staged = new Set(stagedPaths)
  const pending = [...new Set([...(readWorktreeChangedPaths(repo) ?? []), ...(readUntrackedPaths(repo) ?? [])])]
  const patterns = [...new Set(names)].map((name) => ({ name, re: new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`) }))
  const mentions: string[] = []
  for (const path of pending) {
    if (staged.has(path) || corpusFrom([path]).length === 0) continue
    let text: string
    try {
      text = readFileSync(join(repo.toplevel, path), 'utf8')
    } catch {
      continue
    }
    const hits = patterns.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name)
    if (hits.length > 0) mentions.push(`${path} (${hits.join(', ')})`)
  }
  return mentions
}

export function declarationSha256(source: string, symbol: DeadSymbol): string {
  const text = source.slice(symbol.start, symbol.end).replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function keyOf(path: string, name: string): string {
  return `${path}\u0000${name}`
}

export function mergeDeadCodeKeeps(
  existing: readonly DeadCodeKeepRecord[] | undefined,
  granted: readonly DeadCodeKeep[],
  specRef: string,
  at: string,
  known: ReadonlySet<string> | null,
): DeadCodeKeepRecord[] {
  const byKey = new Map<string, DeadCodeKeepRecord>()
  for (const record of existing ?? []) {
    if (known && !known.has(record.path)) continue
    byKey.set(deadCodeKeepKey(record.path, record.name, record.declaration_sha256), record)
  }
  for (const keep of granted) {
    byKey.set(deadCodeKeepKey(keep.path, keep.name, keep.declaration_sha256), {
      path: keep.path,
      name: keep.name,
      declaration_sha256: keep.declaration_sha256,
      note: keep.note,
      spec_ref: specRef,
      at,
    })
  }
  return [...byKey.values()]
}

export function readDeadCodeKeeps(value: unknown): DeadCodeKeep[] {
  if (!Array.isArray(value)) return []
  const keeps: DeadCodeKeep[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.path === 'string' &&
      typeof record.name === 'string' &&
      typeof record.declaration_sha256 === 'string' &&
      typeof record.note === 'string'
    ) {
      keeps.push({
        path: record.path,
        name: record.name,
        declaration_sha256: record.declaration_sha256,
        note: record.note,
      })
    }
  }
  return keeps
}

export function auditBoundKeeps(keeps: readonly DeadCodeKeep[], decisions: ReadonlySet<string>): DeadCodeKeep[] {
  return keeps.filter((keep) => decisions.has(deadCodeKeepKey(keep.path, keep.name, keep.declaration_sha256)))
}

export function keepPrunePaths(projectRoot: string): Set<string> | null {
  const repo = openSweepRepo(projectRoot)
  if (!repo) return null
  const known = readKnownPaths(repo)
  const untracked = readUntrackedPaths(repo)
  if (!known || !untracked) return null
  for (const path of untracked) known.add(path)
  return known
}

function languageBucket(path: string): { code: boolean; language: string | null } {
  const classified = classifyPath(path, null)
  if (classified.bucket === 'supported' || classified.bucket === 'unsupported') return { code: true, language: classified.language }
  return { code: false, language: null }
}

function notCheckedHints(paths: readonly string[], roots: readonly string[], exempt: ReadonlySet<string>): string[] {
  const hints: string[] = []
  const exempted = paths.filter((path) => exempt.has(path))
  if (exempted.length > 0) {
    hints.push(
      `${UNCOVERED_LANGUAGE_HINT_PREFIX} in ${exempted.join(', ')}: the developer allowed these versions without a ` +
        `mechanical check (vendored, generated or unscannable), so dead code in them is uncovered, not cleared.`,
    )
  }
  const rest = paths.filter((path) => !exempt.has(path))
  const output = rest.filter((path) => languageOf(path) !== null && isBuildOutput(path, roots))
  if (output.length > 0) {
    hints.push(
      `${UNCOVERED_LANGUAGE_HINT_PREFIX} in ${output.join(', ')}: build output (dist/, build/ or coverage/ at a package ` +
        `root) and vendored code are outside the dead-code scan, so dead code in them is uncovered, not cleared.`,
    )
  }
  const uncovered = rest.filter((path) => languageOf(path) === null && languageBucket(path).code)
  if (uncovered.length > 0) {
    hints.push(
      `${UNCOVERED_LANGUAGE_HINT_PREFIX} in ${uncovered.join(', ')}: this release reads JavaScript and ` +
        `TypeScript only, so dead code in those files is uncovered, not cleared.`,
    )
  }
  return hints
}

function otherLanguageHint(known: readonly string[], corpus: ReadonlySet<string>, roots: readonly string[]): string[] {
  const suffixes = new Map<string, number>()
  for (const path of known) {
    if (corpus.has(path) || isBuildOutput(path, roots)) continue
    const bucket = languageBucket(path)
    if (!bucket.code || bucket.language === null || NO_REFERENCES_TO_CODE.has(bucket.language)) continue
    const dot = path.lastIndexOf('.')
    const suffix = dot > path.lastIndexOf('/') ? path.slice(dot) : path.slice(path.lastIndexOf('/') + 1)
    suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1)
  }
  if (suffixes.size === 0) return []
  const total = [...suffixes.values()].reduce((sum, n) => sum + n, 0)
  return [
    `${OTHER_LANGUAGE_EVIDENCE_HINT_PREFIX} (${total} file(s): ${[...suffixes.keys()].sort().join(', ')}): an export ` +
      `used only from them, through a bridge this scan cannot see, reads as dead. Keep it through the developer if so.`,
  ]
}

interface Analysis {
  ok: true
  pending: PendingDeadSymbol[]
  stale: PendingDeadSymbol[]
  kept: PendingDeadSymbol[]
  publicExempted: PendingDeadSymbol[]
  unknown: number
  hints: string[]
}

type AnalysisResult = Analysis | { ok: false; reason: string; hints?: string[]; paths?: string[] }

function memoised(reader: SourceReader): { read: SourceReader; text: (rel: string) => string } {
  const cache = new Map<string, SourceRead>()
  const read: SourceReader = (rel) => {
    const cached = cache.get(rel)
    if (cached) return cached
    const fresh = reader(rel)
    cache.set(rel, fresh)
    return fresh
  }
  const text = (rel: string): string => {
    const source = read(rel)
    return source.kind === 'text' ? source.text : ''
  }
  return { read, text }
}

function indexReader(repo: SweepRepo, paths: readonly string[], blobs: ReadonlyMap<string, string>): SourceReader | null {
  const oids = paths.map((path) => blobs.get(path)).filter((oid): oid is string => oid !== undefined)
  const read = readBlobTexts(repo, oids)
  if (!read) return null
  return (rel) => {
    const oid = blobs.get(rel)
    if (oid === undefined) return { kind: 'absent' }
    if (!read.texts.has(oid) && !read.failed.has(oid)) {
      const late = readBlobTexts(repo, [oid])
      if (!late) return { kind: 'error' }
      for (const [id, text] of late.texts) read.texts.set(id, text)
      for (const id of late.failed) read.failed.add(id)
    }
    if (read.failed.has(oid)) return { kind: 'error' }
    const text = read.texts.get(oid)
    return text === undefined ? { kind: 'absent' } : { kind: 'text', text: normalizeLineEndings(text) }
  }
}

function worktreeReader(repo: SweepRepo, paths: readonly string[]): SourceReader | null {
  const disk = workingTreeReader(repo.toplevel)
  const sparse = readSkipWorktreePaths(repo)
  if (!sparse) return null
  if (sparse.size === 0) return disk
  const index = readIndexEntries(repo)
  if (!index) return null
  const fromIndex = indexReader(repo, paths.filter((path) => sparse.has(path)), index.blobs)
  if (!fromIndex) return null
  return (rel) => {
    const source = disk(rel)
    return source.kind === 'absent' && sparse.has(rel) ? fromIndex(rel) : source
  }
}

interface AnalyseArgs {
  projectRoot: string
  paths: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
  exempt: ReadonlySet<string>
  source: 'working_tree' | 'index'
}

async function analyse(args: AnalyseArgs): Promise<AnalysisResult> {
  const empty: Analysis = { ok: true, pending: [], stale: [], kept: [], publicExempted: [], unknown: 0, hints: [] }
  const repo = openSweepRepo(args.projectRoot)
  const candidates = args.paths.filter((path) => languageOf(path) !== null && !args.exempt.has(path))
  if (!repo) {
    const hints = notCheckedHints(args.paths, [''], args.exempt)
    return candidates.length === 0 ? { ...empty, hints } : { ...empty, hints: [...hints, 'Dead-code scan skipped: not inside a git repository.'] }
  }

  const index = args.source === 'index' ? readIndexEntries(repo) : null
  if (args.source === 'index' && !index) return { ok: false, reason: 'could not list the staged files for the dead-code scan' }
  let known: string[]
  if (index) {
    known = [...index.paths]
  } else {
    const tracked = readKnownPaths(repo)
    const untracked = readUntrackedPaths(repo)
    if (!tracked || !untracked) return { ok: false, reason: 'could not list the repository files for the dead-code scan' }
    known = [...new Set([...tracked, ...untracked])]
  }
  const roots = packageRootsOf(known)
  const hints = notCheckedHints(args.paths, roots, args.exempt)
  const targets = candidates.filter((path) => !isBuildOutput(path, roots))
  if (targets.length === 0) return { ...empty, hints }

  const corpus = corpusFrom(known)
  for (const target of targets) {
    if (!corpus.includes(target)) corpus.push(target)
  }
  const configs = configFilesFrom(known)

  const base = index ? indexReader(repo, [...corpus, ...configs], index.blobs) : worktreeReader(repo, [...corpus, ...configs])
  if (!base) return { ok: false, reason: 'could not read the contents for the dead-code scan' }
  const bytes = memoised(base)

  const result = await findDeadSymbols({
    projectRoot: repo.toplevel,
    corpus,
    targets,
    configs,
    ...(args.publicApi !== undefined && { publicApi: args.publicApi }),
    publicApiPrefix: repo.prefix,
    read: bytes.read,
  })
  if (result.oversized.length > 0) {
    return {
      ok: false,
      reason: `too large for the dead-code scan to parse (over ${parseSizeLimitText()}): ${result.oversized.join(', ')}`,
      hints: ['List each one in exempt_files of rsct_phase_review_complete with its reason — the developer confirms it in the dialog — or take it out of the change.'],
      paths: result.oversized,
    }
  }

  const describe = (symbol: DeadSymbol, keepStale: boolean): PendingDeadSymbol => {
    const text = bytes.text(symbol.path)
    return {
      path: symbol.path,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      declaration_sha256: declarationSha256(text, symbol),
      declaration: text.slice(symbol.start, symbol.end).slice(0, DECLARATION_PREVIEW),
      keep_stale: keepStale,
    }
  }

  const keepByKey = new Map(args.keeps.map((keep) => [keyOf(keep.path, keep.name), keep]))
  const analysis: Analysis = { ...empty, hints: [...hints, ...result.hints], unknown: result.unknown.length }
  for (const symbol of result.dead) {
    const current = describe(symbol, false)
    const keep = keepByKey.get(keyOf(symbol.path, symbol.name))
    if (!keep) analysis.pending.push(current)
    else if (keep.declaration_sha256 !== current.declaration_sha256) analysis.stale.push({ ...current, keep_stale: true })
    else analysis.kept.push(current)
  }
  if (result.dead.some((symbol) => symbol.exported)) analysis.hints.push(...otherLanguageHint(known, new Set(corpus), roots))
  analysis.publicExempted = result.publicExempted.map((symbol) => describe(symbol, false))
  return analysis
}

let stagedMemo: { key: string; result: Analysis } | null = null

function stagedKey(args: AnalyseArgs): string | null {
  if (args.source !== 'index') return null
  const repo = openSweepRepo(args.projectRoot)
  const fingerprint = repo ? readIndexFingerprint(repo) : null
  if (!repo || !fingerprint) return null
  const inputs = JSON.stringify([repo.toplevel, repo.prefix, args.paths, args.publicApi ?? null, args.keeps, [...args.exempt].sort()])
  return createHash('sha256').update(fingerprint).update(inputs).digest('hex')
}

async function guardedAnalyse(args: AnalyseArgs): Promise<AnalysisResult> {
  try {
    const key = stagedKey(args)
    if (key !== null && stagedMemo?.key === key) return stagedMemo.result
    analysisHook?.()
    const result = await analyse(args)
    if (key !== null && result.ok) stagedMemo = { key, result }
    return result
  } catch (error) {
    return { ok: false, reason: `the dead-code scan failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function checkDeadCode(args: {
  projectRoot: string
  touched: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
  exempt?: readonly string[]
}): Promise<DeadCodeCheck> {
  const analysis = await guardedAnalyse({
    projectRoot: args.projectRoot,
    paths: args.touched,
    publicApi: args.publicApi,
    keeps: args.keeps,
    exempt: new Set(args.exempt ?? []),
    source: 'working_tree',
  })
  if (!analysis.ok) {
    return { ok: false, reject_kind: 'dead_code_unreadable', reason: analysis.reason, hints: [analysis.reason, ...(analysis.hints ?? [])], pending: [] }
  }
  const blocking = [...analysis.stale, ...analysis.pending]
  if (blocking.length === 0) {
    return {
      ok: true,
      kept: analysis.kept,
      public_exempted: analysis.publicExempted,
      unknown: analysis.unknown,
      hints: analysis.hints,
    }
  }
  const names = blocking.map((p) => `${p.path}:${p.name}`).join(', ')
  const parts: string[] = []
  if (analysis.pending.length > 0) parts.push(`${analysis.pending.length} referenced nowhere`)
  if (analysis.stale.length > 0) parts.push(`${analysis.stale.length} kept about different declaration bytes`)
  return {
    ok: false,
    reject_kind: analysis.stale.length > 0 ? 'dead_code_keep_stale' : 'dead_code_remaining',
    reason: `dead code in the touched files (${parts.join('; ')}): ${names}`,
    hints: [
      'Remove each one, or put it to the developer and pass it back in dead_code_keeps with the declaration_sha256 from pending_dead_code and the reason they gave.',
      ...analysis.hints,
    ],
    pending: blocking,
  }
}

export async function checkStagedDeadCode(args: {
  projectRoot: string
  stagedPaths: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
  keepDecisions: ReadonlySet<string>
  publicApiApprovals?: ReadonlySet<string>
  exempt?: readonly string[]
}): Promise<StagedDeadCodeCheck> {
  const analysis = await guardedAnalyse({
    projectRoot: args.projectRoot,
    paths: args.stagedPaths,
    publicApi: args.publicApi,
    keeps: auditBoundKeeps(args.keeps, args.keepDecisions),
    exempt: new Set(args.exempt ?? []),
    source: 'index',
  })
  if (!analysis.ok) {
    return {
      ok: false,
      reject_kind: 'dead_code_staged',
      reason: analysis.reason,
      hints: [analysis.reason, ...(analysis.hints ?? [])],
      paths: analysis.paths ?? [...args.stagedPaths],
    }
  }
  const digest = publicApiDigest(args.publicApi)
  const approvals = args.publicApiApprovals ?? new Set<string>()
  const unapproved = analysis.publicExempted.filter(
    (p) => digest === null || !approvals.has(publicApiApprovalKey(digest, p.path, p.name, p.declaration_sha256)),
  )
  const blocking = [...analysis.stale, ...analysis.pending]
  if (blocking.length === 0 && unapproved.length === 0) {
    return { ok: true, kept: analysis.kept.length, unknown: analysis.unknown, hints: analysis.hints }
  }
  if (blocking.length === 0) {
    const exempted = unapproved.map((p) => `${p.path}:${p.name}`)
    return {
      ok: false,
      reject_kind: 'dead_code_staged',
      reason: `${exempted.length} staged export(s) nothing here uses are exempt through "public_api" without the developer's recorded approval: ${exempted.join(', ')}`,
      hints: [
        'Run rsct_phase_review_start / _complete over these paths: the REVIEW puts every "public_api" exemption to the developer and records their answer in the audit log.',
        ...analysis.hints,
      ],
      paths: [...new Set(unapproved.map((p) => p.path))],
    }
  }
  const named = blocking.map((p) => `${p.path}:${p.name}`)
  const mentions = unstagedMentions(args.projectRoot, args.stagedPaths, blocking.map((p) => p.name))
  return {
    ok: false,
    reject_kind: 'dead_code_staged',
    reason:
      analysis.stale.length > 0
        ? `${named.length} staged symbol(s) are dead, ${analysis.stale.length} of them kept about different declaration bytes: ${named.join(', ')}`
        : `${named.length} staged symbol(s) are referenced nowhere in what is staged: ${named.join(', ')}`,
    hints: [
      'If a caller exists but is not staged, stage it in this same commit. Otherwise a completed REVIEW either removes them or records the developer keeping them, through the developer-only dialog: run rsct_phase_review_start / _complete over these paths.',
      ...(mentions.length > 0
        ? [`${UNSTAGED_MENTION_HINT_PREFIX}: ${mentions.slice(0, 10).join(', ')}${mentions.length > 10 ? ` and ${mentions.length - 10} more` : ''}.`]
        : []),
      ...analysis.hints,
    ],
    paths: [...new Set(blocking.map((p) => p.path))],
  }
}

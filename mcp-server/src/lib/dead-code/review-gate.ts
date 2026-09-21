import { createHash } from 'node:crypto'

import { classifyPath } from '../comment-sweep/language.js'
import {
  openSweepRepo,
  readBlobTexts,
  readIndexEntries,
  readKnownPaths,
} from '../comment-sweep/git-reads.js'
import { deadCodeKeepKey } from '../free-commit.js'
import type { DeadCodeKeepRecord } from '../phase-scope.js'
import {
  corpusFrom,
  findDeadSymbols,
  isAnalysable,
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

const DECLARATION_PREVIEW = 400

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

function isCode(path: string): boolean {
  const bucket = classifyPath(path, null).bucket
  return bucket === 'supported' || bucket === 'unsupported'
}

function uncoveredHint(paths: readonly string[]): string[] {
  const uncovered = paths.filter((path) => !isAnalysable(path) && isCode(path))
  if (uncovered.length === 0) return []
  return [
    `${UNCOVERED_LANGUAGE_HINT_PREFIX} in ${uncovered.join(', ')}: this release reads JavaScript and ` +
      `TypeScript only, so dead code in those files is uncovered, not cleared.`,
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

type AnalysisResult = Analysis | { ok: false; reason: string }

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

async function analyse(args: {
  projectRoot: string
  paths: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
  source: 'working_tree' | 'index'
}): Promise<AnalysisResult> {
  const empty: Analysis = { ok: true, pending: [], stale: [], kept: [], publicExempted: [], unknown: 0, hints: [] }
  const targets = args.paths.filter(isAnalysable)
  const hints = uncoveredHint(args.paths)
  if (targets.length === 0) return { ...empty, hints }

  const repo = openSweepRepo(args.projectRoot)
  if (!repo) return { ...empty, hints: [...hints, 'Dead-code scan skipped: not inside a git repository.'] }

  const index = args.source === 'index' ? readIndexEntries(repo) : null
  const known = index ? index.paths : args.source === 'index' ? null : readKnownPaths(repo)
  if (!known) return { ok: false, reason: 'could not list the repository files for the dead-code scan' }
  const corpus = corpusFrom(known)
  for (const target of targets) {
    if (!corpus.includes(target)) corpus.push(target)
  }

  let reader: SourceReader
  if (index) {
    const oids = corpus.map((path) => index.blobs.get(path)).filter((oid): oid is string => oid !== undefined)
    const texts = readBlobTexts(repo, oids)
    if (!texts) return { ok: false, reason: 'could not read the staged contents for the dead-code scan' }
    reader = (rel) => {
      const oid = index.blobs.get(rel)
      const text = oid === undefined ? undefined : texts.get(oid)
      return text === undefined ? { kind: 'absent' } : { kind: 'text', text }
    }
  } else {
    reader = workingTreeReader(repo.toplevel)
  }
  const bytes = memoised(reader)

  const result = await findDeadSymbols({
    projectRoot: repo.toplevel,
    corpus,
    targets,
    ...(args.publicApi !== undefined && { publicApi: args.publicApi }),
    read: bytes.read,
  })

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
  analysis.publicExempted = result.publicExempted.map((symbol) => describe(symbol, false))
  return analysis
}

export async function checkDeadCode(args: {
  projectRoot: string
  touched: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
}): Promise<DeadCodeCheck> {
  const analysis = await analyse({
    projectRoot: args.projectRoot,
    paths: args.touched,
    publicApi: args.publicApi,
    keeps: args.keeps,
    source: 'working_tree',
  })
  if (!analysis.ok) {
    return { ok: false, reject_kind: 'dead_code_unreadable', reason: analysis.reason, hints: [analysis.reason], pending: [] }
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
}): Promise<StagedDeadCodeCheck> {
  const analysis = await analyse({
    projectRoot: args.projectRoot,
    paths: args.stagedPaths,
    publicApi: args.publicApi,
    keeps: auditBoundKeeps(args.keeps, args.keepDecisions),
    source: 'index',
  })
  if (!analysis.ok) {
    return { ok: false, reject_kind: 'dead_code_staged', reason: analysis.reason, hints: [analysis.reason], paths: [] }
  }
  const blocking = [...analysis.stale, ...analysis.pending]
  if (blocking.length === 0) {
    return { ok: true, kept: analysis.kept.length, unknown: analysis.unknown, hints: analysis.hints }
  }
  const named = blocking.map((p) => `${p.path}:${p.name}`)
  return {
    ok: false,
    reject_kind: 'dead_code_staged',
    reason:
      analysis.stale.length > 0
        ? `${named.length} staged symbol(s) are dead, ${analysis.stale.length} of them kept about different declaration bytes: ${named.join(', ')}`
        : `${named.length} staged symbol(s) are referenced nowhere: ${named.join(', ')}`,
    hints: [
      'A completed REVIEW either removes them or records the developer keeping them, through the developer-only dialog. Run rsct_phase_review_start / _complete over these paths.',
      ...analysis.hints,
    ],
    paths: [...new Set(blocking.map((p) => p.path))],
  }
}

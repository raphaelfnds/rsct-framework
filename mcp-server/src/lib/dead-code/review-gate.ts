import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { knownPaths } from '../comment-sweep/review.js'
import type { DeadCodeKeepRecord } from '../phase-scope.js'
import { corpusFrom, findDeadSymbols, isAnalysable, type DeadSymbol } from './references.js'

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
}

export type DeadCodeRejectKind = 'dead_code_remaining' | 'dead_code_keep_stale'

export type DeadCodeCheck =
  | { ok: true; kept: number; unknown: number; hints: string[] }
  | {
      ok: false
      reject_kind: DeadCodeRejectKind
      reason: string
      hints: string[]
      pending: PendingDeadSymbol[]
    }

export function declarationSha256(source: string, symbol: DeadSymbol): string {
  const text = source.slice(symbol.start, symbol.end).replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function keyOf(path: string, name: string): string {
  return `${path}\u0000${name}`
}

export type StagedDeadCodeCheck =
  | { ok: true; unknown: number; kept: number }
  | { ok: false; reject_kind: 'dead_code_staged'; reason: string; hints: string[]; paths: string[] }

export function mergeDeadCodeKeeps(
  existing: readonly DeadCodeKeepRecord[] | undefined,
  granted: readonly DeadCodeKeep[],
  specRef: string,
  at: string,
): DeadCodeKeepRecord[] {
  const byKey = new Map<string, DeadCodeKeepRecord>()
  for (const record of existing ?? []) {
    byKey.set(`${keyOf(record.path, record.name)}\u0000${record.declaration_sha256}`, record)
  }
  for (const keep of granted) {
    byKey.set(`${keyOf(keep.path, keep.name)}\u0000${keep.declaration_sha256}`, {
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

export async function checkStagedDeadCode(args: {
  projectRoot: string
  stagedPaths: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
}): Promise<StagedDeadCodeCheck> {
  const check = await checkDeadCode({
    projectRoot: args.projectRoot,
    touched: args.stagedPaths,
    ...(args.publicApi !== undefined && { publicApi: args.publicApi }),
    keeps: args.keeps,
  })
  if (check.ok) return { ok: true, unknown: check.unknown, kept: check.kept }
  const named = check.pending.map((p) => `${p.path}:${p.name}`)
  const staleKeep = check.reject_kind === 'dead_code_keep_stale'
  return {
    ok: false,
    reject_kind: 'dead_code_staged',
    reason: staleKeep
      ? `${named.length} staged symbol(s) carry a keep decided about different declaration bytes: ${named.join(', ')}`
      : `${named.length} staged symbol(s) are referenced nowhere: ${named.join(', ')}`,
    hints: [
      staleKeep
        ? 'The declaration changed after the developer kept it. Run the REVIEW again so they decide about the bytes being committed.'
        : 'A completed REVIEW either removes them or records the developer keeping them. Run rsct_phase_review_start / _complete over these paths.',
    ],
    paths: [...new Set(check.pending.map((p) => p.path))],
  }
}

export async function checkDeadCode(args: {
  projectRoot: string
  touched: readonly string[]
  publicApi?: readonly string[] | undefined
  keeps: readonly DeadCodeKeep[]
}): Promise<DeadCodeCheck> {
  const targets = args.touched.filter(isAnalysable)
  if (targets.length === 0) return { ok: true, kept: 0, unknown: 0, hints: [] }

  const known = knownPaths(args.projectRoot)
  const corpus = corpusFrom(known ?? targets)
  for (const target of targets) {
    if (!corpus.includes(target)) corpus.push(target)
  }

  const result = await findDeadSymbols({
    projectRoot: args.projectRoot,
    corpus,
    targets,
    ...(args.publicApi !== undefined && { publicApi: args.publicApi }),
  })

  const sources = new Map<string, string>()
  const sourceOf = (path: string): string => {
    const cached = sources.get(path)
    if (cached !== undefined) return cached
    let text: string
    try {
      text = readFileSync(join(args.projectRoot, path), 'utf8')
    } catch {
      text = ''
    }
    sources.set(path, text)
    return text
  }

  const keepByKey = new Map(args.keeps.map((keep) => [keyOf(keep.path, keep.name), keep]))
  const pending: PendingDeadSymbol[] = []
  const stale: PendingDeadSymbol[] = []
  let kept = 0

  for (const symbol of result.dead) {
    const source = sourceOf(symbol.path)
    const sha = declarationSha256(source, symbol)
    const entry: PendingDeadSymbol = {
      path: symbol.path,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      declaration_sha256: sha,
      declaration: source.slice(symbol.start, symbol.end).slice(0, 400),
    }
    const keep = keepByKey.get(keyOf(symbol.path, symbol.name))
    if (!keep) {
      pending.push(entry)
      continue
    }
    if (keep.declaration_sha256 !== sha) {
      stale.push(entry)
      continue
    }
    kept += 1
  }

  if (stale.length > 0) {
    return {
      ok: false,
      reject_kind: 'dead_code_keep_stale',
      reason: `${stale.length} dead-code keep(s) were decided about different bytes — the declaration changed since the developer kept it`,
      hints: [
        'A keep is bound to the declaration text it was granted for. Re-confirm with the developer using the declaration_sha256 in pending_dead_code.',
      ],
      pending: stale,
    }
  }

  if (pending.length > 0) {
    const names = pending.map((p) => `${p.path}:${p.name}`).join(', ')
    return {
      ok: false,
      reject_kind: 'dead_code_remaining',
      reason: `${pending.length} symbol(s) in the touched files are referenced nowhere: ${names}`,
      hints: [
        'Remove them, or put each one to the developer and pass it back in dead_code_keeps with its declaration_sha256 and the reason to keep it.',
        ...result.hints,
      ],
      pending,
    }
  }

  return { ok: true, kept, unknown: result.unknown.length, hints: result.hints }
}

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'

import { matchesAnyGlob, toPosix } from '../phase-scope.js'
import { DEFAULT_EXCLUDE_GLOBS, extractImports, resolveImport } from '../reverse-dep-walk.js'
import {
  DEFAULT_IMPORT,
  NAMESPACE_IMPORT,
  scanSymbols,
  type DeclarationKind,
  type TreeLanguage,
  type TreeSymbolScan,
  type TreeSymbols,
} from '../comment-sweep/tree-engine.js'

const LANGUAGE_BY_SUFFIX: ReadonlyMap<string, TreeLanguage> = new Map([
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
])

export function languageOf(path: string): TreeLanguage | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return LANGUAGE_BY_SUFFIX.get(path.slice(dot).toLowerCase()) ?? null
}

export function isAnalysable(path: string): boolean {
  if (languageOf(path) === null) return false
  return !matchesAnyGlob(path, DEFAULT_EXCLUDE_GLOBS).matched
}

export function corpusFrom(knownPaths: Iterable<string>): string[] {
  const corpus: string[] = []
  for (const path of knownPaths) {
    if (isAnalysable(path)) corpus.push(path)
  }
  return corpus
}

export interface DeadCodeInput {
  projectRoot: string
  corpus: readonly string[]
  targets: readonly string[]
  publicApi?: readonly string[]
  includeTypes?: boolean
}

export interface SymbolRef {
  path: string
  name: string
}

export interface DeadSymbol extends SymbolRef {
  kind: DeclarationKind
  exported: boolean
  defaultExport: boolean
  start: number
  end: number
}

export interface DeadCodeResult {
  dead: DeadSymbol[]
  unknown: DeadSymbol[]
  unreadable: string[]
  filesScanned: number
  iterations: number
  hints: string[]
}

export const PUBLIC_API_HINT_PREFIX = 'Dead-code scan: no "public_api" is declared'
export const UNREADABLE_HINT_PREFIX = 'Dead-code scan: withheld a verdict'
export const ENTRYPOINT_HINT_PREFIX = 'Dead-code scan: no file imports'

const KEY_SEPARATOR = '\u0000'

function keyOf(path: string, name: string): string {
  return `${path}${KEY_SEPARATOR}${name}`
}

interface FileFacts {
  symbols: TreeSymbols
  importsByTarget: Map<string, { names: Array<{ imported: string; local: string }>; star: boolean }>
}

interface Corpus {
  facts: Map<string, FileFacts>
  unreadable: Set<string>
  taintedTargets: Set<string>
}

function relPosix(projectRoot: string, abs: string): string {
  return toPosix(relative(projectRoot, abs))
}

const scanCache = new Map<string, TreeSymbolScan>()
const SCAN_CACHE_MAX = 4000

export function clearSymbolScanCache(): void {
  scanCache.clear()
}

export function symbolScanCacheSize(): number {
  return scanCache.size
}

async function scanCached(language: TreeLanguage, source: string): Promise<TreeSymbolScan> {
  const key = `${language}\u0000${createHash('sha256').update(source, 'utf8').digest('hex')}`
  const cached = scanCache.get(key)
  if (cached) return cached
  const scan = await scanSymbols(language, source)
  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.clear()
  scanCache.set(key, scan)
  return scan
}

function resolveEdge(
  projectRoot: string,
  fromRel: string,
  specifier: string,
  entries: Map<string, Set<string>>,
): string | null {
  const fromAbs = resolvePath(projectRoot, fromRel)
  const target = resolveImport(projectRoot, fromAbs, specifier, entries)
  if (!target) return null
  const rel = relPosix(projectRoot, target)
  return rel.startsWith('../') ? null : rel
}

async function readCorpus(input: DeadCodeInput): Promise<Corpus> {
  const facts = new Map<string, FileFacts>()
  const unreadable = new Set<string>()
  const taintedTargets = new Set<string>()
  const entries = new Map<string, Set<string>>()

  for (const rel of input.corpus) {
    const language = languageOf(rel)
    let source: string
    try {
      source = readFileSync(join(input.projectRoot, rel), 'utf8')
    } catch {
      unreadable.add(rel)
      continue
    }
    if (!language) {
      unreadable.add(rel)
      continue
    }
    const scan = await scanCached(language, source)
    if (!scan.ok) {
      unreadable.add(rel)
      for (const specifier of extractImports(source)) {
        const target = resolveEdge(input.projectRoot, rel, specifier, entries)
        if (target) taintedTargets.add(target)
      }
      continue
    }
    const importsByTarget = new Map<string, { names: Array<{ imported: string; local: string }>; star: boolean }>()
    for (const edge of scan.symbols.imports) {
      const target = resolveEdge(input.projectRoot, rel, edge.specifier, entries)
      if (!target) continue
      const existing = importsByTarget.get(target) ?? { names: [], star: false }
      existing.names.push(...edge.names)
      if (edge.starReexport) existing.star = true
      importsByTarget.set(target, existing)
    }
    facts.set(rel, { symbols: scan.symbols, importsByTarget })
  }

  return { facts, unreadable, taintedTargets }
}

function starSources(corpus: Corpus): Map<string, Set<string>> {
  const reexportedBy = new Map<string, Set<string>>()
  for (const [rel, facts] of corpus.facts) {
    for (const [target, edge] of facts.importsByTarget) {
      if (!edge.star) continue
      const set = reexportedBy.get(target) ?? new Set<string>()
      set.add(rel)
      reexportedBy.set(target, set)
    }
  }
  return reexportedBy
}

function pathsReachingSymbol(
  declaringPath: string,
  reexportedBy: Map<string, Set<string>>,
): Set<string> {
  const reached = new Set<string>([declaringPath])
  const queue = [declaringPath]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) continue
    for (const via of reexportedBy.get(current) ?? []) {
      if (reached.has(via)) continue
      reached.add(via)
      queue.push(via)
    }
  }
  return reached
}

interface Citation {
  file: string
  owner: string | null
}

function citationsFor(
  symbol: DeadSymbol,
  corpus: Corpus,
  reexportedBy: Map<string, Set<string>>,
): Citation[] {
  const citations: Citation[] = []
  const declaring = corpus.facts.get(symbol.path)
  if (declaring) {
    for (const reference of declaring.symbols.references) {
      if (reference.name === symbol.name) citations.push({ file: symbol.path, owner: reference.owner })
    }
  }
  if (!symbol.exported) return citations

  const reachable = pathsReachingSymbol(symbol.path, reexportedBy)
  for (const [rel, facts] of corpus.facts) {
    for (const target of reachable) {
      const edge = facts.importsByTarget.get(target)
      if (!edge) continue
      for (const name of edge.names) {
        if (name.imported === NAMESPACE_IMPORT) {
          for (const use of facts.symbols.memberUses) {
            if (use.object === name.local && use.member === symbol.name) {
              citations.push({ file: rel, owner: use.owner })
            }
          }
          continue
        }
        if (name.imported === DEFAULT_IMPORT) {
          if (!symbol.defaultExport) continue
          for (const reference of facts.symbols.references) {
            if (reference.name === name.local) citations.push({ file: rel, owner: reference.owner })
          }
          continue
        }
        if (name.imported !== symbol.name) continue
        for (const reference of facts.symbols.references) {
          if (reference.name === name.local) citations.push({ file: rel, owner: reference.owner })
        }
      }
    }
  }
  return citations
}

export async function findDeadSymbols(input: DeadCodeInput): Promise<DeadCodeResult> {
  const corpus = await readCorpus(input)
  const reexportedBy = starSources(corpus)
  const publicApi = input.publicApi ?? []
  const isPublicPath = (path: string): boolean =>
    publicApi.length > 0 && matchesAnyGlob(path, publicApi).matched

  const importedAnywhere = new Set<string>()
  for (const facts of corpus.facts.values()) {
    for (const target of facts.importsByTarget.keys()) importedAnywhere.add(target)
  }

  const includeTypes = input.includeTypes === true
  const candidates: DeadSymbol[] = []
  const unattributableExports: DeadSymbol[] = []
  for (const rel of input.targets) {
    const facts = corpus.facts.get(rel)
    if (!facts) continue
    const isEntrypoint = !importedAnywhere.has(rel)
    for (const declaration of facts.symbols.declarations) {
      if (!includeTypes && declaration.kind === 'type') continue
      if (isEntrypoint && declaration.exported) {
        unattributableExports.push({
          path: rel,
          name: declaration.name,
          kind: declaration.kind,
          exported: true,
          defaultExport: declaration.defaultExport,
          start: declaration.start,
          end: declaration.end,
        })
        continue
      }
      candidates.push({
        path: rel,
        name: declaration.name,
        kind: declaration.kind,
        exported: declaration.exported,
        defaultExport: declaration.defaultExport,
        start: declaration.start,
        end: declaration.end,
      })
    }
  }

  const citations = new Map<string, Citation[]>()
  for (const candidate of candidates) {
    citations.set(keyOf(candidate.path, candidate.name), citationsFor(candidate, corpus, reexportedBy))
  }

  const dead = new Set<string>()
  let iterations = 0
  for (;;) {
    iterations += 1
    let changed = false
    for (const candidate of candidates) {
      const key = keyOf(candidate.path, candidate.name)
      if (dead.has(key)) continue
      if (candidate.exported && isPublicPath(candidate.path)) continue
      const live = (citations.get(key) ?? []).some(
        (citation) => citation.owner === null || !dead.has(keyOf(citation.file, citation.owner)),
      )
      if (!live) {
        dead.add(key)
        changed = true
      }
    }
    if (!changed) break
  }

  const deadSymbols: DeadSymbol[] = []
  const unknownSymbols: DeadSymbol[] = []
  for (const candidate of candidates) {
    if (!dead.has(keyOf(candidate.path, candidate.name))) continue
    const reachable = pathsReachingSymbol(candidate.path, reexportedBy)
    const tainted = [...reachable].some((path) => corpus.taintedTargets.has(path))
    if (tainted) unknownSymbols.push(candidate)
    else deadSymbols.push(candidate)
  }
  unknownSymbols.push(...unattributableExports)

  const hints: string[] = []
  if (publicApi.length === 0 && deadSymbols.some((symbol) => symbol.exported)) {
    hints.push(
      `${PUBLIC_API_HINT_PREFIX} in .rsct.json, so every export is judged by references inside this ` +
        `repository alone. If consumers live outside it (a published library), declare the public ` +
        `paths there or those exports will read as dead.`,
    )
  }
  if (unknownSymbols.length > unattributableExports.length) {
    hints.push(
      `${UNREADABLE_HINT_PREFIX} on ${unknownSymbols.length - unattributableExports.length} symbol(s): ` +
        `a file the parser could not read may hold the only reference. ` +
        `Unreadable files: ${[...corpus.unreadable].join(', ')}`,
    )
  }
  if (unattributableExports.length > 0) {
    const paths = [...new Set(unattributableExports.map((symbol) => symbol.path))]
    hints.push(
      `${ENTRYPOINT_HINT_PREFIX} ${paths.join(', ')}, so its exports cannot be told apart from an ` +
        `entrypoint's. ${unattributableExports.length} export(s) left as unknown rather than reported dead. ` +
        `Declare the file in "public_api" if it is an entrypoint or a published surface.`,
    )
  }

  return {
    dead: deadSymbols,
    unknown: unknownSymbols,
    unreadable: [...corpus.unreadable],
    filesScanned: corpus.facts.size,
    iterations,
    hints,
  }
}

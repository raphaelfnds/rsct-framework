import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, normalize, relative, resolve as resolvePath } from 'node:path'

import { matchesAnyGlob, toPosix } from '../phase-scope.js'
import {
  DEFAULT_EXCLUDE_GLOBS,
  extractImports,
  resolveImport,
  type ResolveProbe,
} from '../reverse-dep-walk.js'
import {
  NAMESPACE_IMPORT,
  scanSymbols,
  type DeclarationKind,
  type TreeEdgeKind,
  type TreeImportName,
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

const FOREIGN_IMPORTER_SUFFIXES: ReadonlySet<string> = new Set(['.vue', '.svelte', '.astro', '.html', '.htm', '.mdx'])

function suffixOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : ''
}

export function languageOf(path: string): TreeLanguage | null {
  return LANGUAGE_BY_SUFFIX.get(suffixOf(path)) ?? null
}

function isExcluded(path: string): boolean {
  return matchesAnyGlob(path, DEFAULT_EXCLUDE_GLOBS).matched
}

export function isAnalysable(path: string): boolean {
  return languageOf(path) !== null && !isExcluded(path)
}

function isForeignImporter(path: string): boolean {
  return FOREIGN_IMPORTER_SUFFIXES.has(suffixOf(path)) && !isExcluded(path)
}

export function corpusFrom(knownPaths: Iterable<string>): string[] {
  const corpus: string[] = []
  for (const path of knownPaths) {
    if (isAnalysable(path) || isForeignImporter(path)) corpus.push(path)
  }
  return corpus
}

export type SourceRead = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'error' }
export type SourceReader = (rel: string) => SourceRead

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])

export function workingTreeReader(root: string): SourceReader {
  return (rel) => {
    try {
      return { kind: 'text', text: readFileSync(join(root, rel), 'utf8') }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      return ABSENT_CODES.has(code) ? { kind: 'absent' } : { kind: 'error' }
    }
  }
}

export interface DeadCodeInput {
  projectRoot: string
  corpus: readonly string[]
  targets: readonly string[]
  publicApi?: readonly string[]
  includeTypes?: boolean
  read?: SourceReader
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
  publicExempted: DeadSymbol[]
  unreadable: string[]
  filesScanned: number
  iterations: number
  hints: string[]
}

export const PUBLIC_API_HINT_PREFIX = 'Dead-code scan: no "public_api" is declared'
export const PUBLIC_EXEMPTED_HINT_PREFIX = 'Dead-code scan: "public_api" exempted'
export const UNREADABLE_HINT_PREFIX = 'Dead-code scan: withheld a verdict'
export const ENTRYPOINT_HINT_PREFIX = 'Dead-code scan: no file imports'
export const DYNAMIC_HINT_PREFIX = 'Dead-code scan: dynamically imported'
export const DEPENDENT_HINT_PREFIX = 'Dead-code scan: used only by symbols left unknown'

const KEY_SEPARATOR = '\u0000'

function keyOf(path: string, name: string): string {
  return `${path}${KEY_SEPARATOR}${name}`
}

const SCAN_CACHE_MAX = 4000
let scanCacheLimit = SCAN_CACHE_MAX
const scanCache = new Map<string, TreeSymbolScan>()

export function clearSymbolScanCache(): void {
  scanCache.clear()
}

export function symbolScanCacheSize(): number {
  return scanCache.size
}

export function limitSymbolScanCacheForTests(limit: number | null): void {
  scanCacheLimit = limit ?? SCAN_CACHE_MAX
}

async function scanCached(language: TreeLanguage, source: string): Promise<TreeSymbolScan> {
  const key = `${language}${KEY_SEPARATOR}${createHash('sha256').update(source, 'utf8').digest('hex')}`
  const cached = scanCache.get(key)
  if (cached) {
    scanCache.delete(key)
    scanCache.set(key, cached)
    return cached
  }
  const scan = await scanSymbols(language, source)
  while (scanCache.size >= scanCacheLimit) {
    const oldest = scanCache.keys().next().value
    if (oldest === undefined) break
    scanCache.delete(oldest)
  }
  scanCache.set(key, scan)
  return scan
}

function relPosix(projectRoot: string, abs: string): string {
  return toPosix(relative(projectRoot, abs))
}

function corpusProbe(projectRoot: string, corpus: readonly string[]): ResolveProbe {
  const files = new Set<string>()
  const directories = new Set<string>()
  for (const path of corpus) {
    files.add(resolvePath(projectRoot, path))
    let slash = path.lastIndexOf('/')
    while (slash > 0) {
      directories.add(resolvePath(projectRoot, path.slice(0, slash)))
      slash = path.lastIndexOf('/', slash - 1)
    }
  }
  return {
    exists: (abs) => files.has(normalize(abs)) || directories.has(normalize(abs)),
    isFile: (abs) => files.has(normalize(abs)),
    isDirectory: (abs) => directories.has(normalize(abs)),
    hasExactPath: (abs) => files.has(normalize(abs)),
  }
}

interface Edge {
  target: string
  kind: TreeEdgeKind
  names: TreeImportName[]
  star: boolean
  namespaceReexport: string | null
}

interface FileFacts {
  symbols: TreeSymbols
  edges: Edge[]
}

interface Corpus {
  facts: Map<string, FileFacts>
  unreadable: Set<string>
  taintedTargets: Set<string>
  dynamicTargets: Set<string>
  importedFiles: Set<string>
  blind: boolean
}

async function readCorpus(input: DeadCodeInput): Promise<Corpus> {
  const read = input.read ?? workingTreeReader(input.projectRoot)
  const probe = corpusProbe(input.projectRoot, input.corpus)
  const entries = new Map<string, Set<string>>()
  const resolveFrom = (fromRel: string, specifier: string): string | null => {
    const target = resolveImport(input.projectRoot, resolvePath(input.projectRoot, fromRel), specifier, entries, probe)
    return target ? relPosix(input.projectRoot, target) : null
  }

  const corpus: Corpus = {
    facts: new Map(),
    unreadable: new Set(),
    taintedTargets: new Set(),
    dynamicTargets: new Set(),
    importedFiles: new Set(),
    blind: false,
  }
  const taintImportsOf = (rel: string, text: string): void => {
    for (const specifier of extractImports(text)) {
      const target = resolveFrom(rel, specifier)
      if (target) {
        corpus.taintedTargets.add(target)
        corpus.importedFiles.add(target)
      }
    }
  }

  for (const rel of input.corpus) {
    const source = read(rel)
    if (source.kind === 'absent') continue
    if (source.kind === 'error') {
      corpus.unreadable.add(rel)
      corpus.blind = true
      continue
    }
    const language = languageOf(rel)
    const scan = language ? await scanCached(language, source.text) : null
    if (!scan || !scan.ok) {
      corpus.unreadable.add(rel)
      taintImportsOf(rel, source.text)
      continue
    }
    const edges: Edge[] = []
    for (const edge of scan.symbols.imports) {
      const target = resolveFrom(rel, edge.specifier)
      if (!target) continue
      corpus.importedFiles.add(target)
      if (edge.kind === 'dynamic') corpus.dynamicTargets.add(target)
      edges.push({
        target,
        kind: edge.kind,
        names: edge.names,
        star: edge.starReexport,
        namespaceReexport: edge.namespaceReexport,
      })
    }
    corpus.facts.set(rel, { symbols: scan.symbols, edges })
  }
  return corpus
}

interface Alias {
  file: string
  name: string
  member: string | null
}

interface Reexport {
  file: string
  edge: Edge
}

function reexportsByTarget(corpus: Corpus): Map<string, Reexport[]> {
  const byTarget = new Map<string, Reexport[]>()
  for (const [file, facts] of corpus.facts) {
    for (const edge of facts.edges) {
      if (edge.kind !== 'reexport') continue
      const list = byTarget.get(edge.target) ?? []
      list.push({ file, edge })
      byTarget.set(edge.target, list)
    }
  }
  return byTarget
}

function importersByTarget(corpus: Corpus): Map<string, Array<{ file: string; facts: FileFacts; edge: Edge }>> {
  const byTarget = new Map<string, Array<{ file: string; facts: FileFacts; edge: Edge }>>()
  for (const [file, facts] of corpus.facts) {
    for (const edge of facts.edges) {
      if (edge.kind !== 'import') continue
      const list = byTarget.get(edge.target) ?? []
      list.push({ file, facts, edge })
      byTarget.set(edge.target, list)
    }
  }
  return byTarget
}

function aliasesOf(
  path: string,
  exposures: readonly string[],
  reexports: Map<string, Reexport[]>,
): { aliases: Alias[]; nested: boolean } {
  const aliases: Alias[] = []
  const seen = new Set<string>()
  let nested = false
  const queue: Alias[] = []
  const add = (alias: Alias): void => {
    const key = `${alias.file}${KEY_SEPARATOR}${alias.name}${KEY_SEPARATOR}${alias.member ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    aliases.push(alias)
    queue.push(alias)
  }
  for (const name of exposures) add({ file: path, name, member: null })
  while (queue.length > 0) {
    const alias = queue.shift()
    if (!alias) continue
    for (const { file, edge } of reexports.get(alias.file) ?? []) {
      if (edge.star && alias.name !== 'default') add({ file, name: alias.name, member: alias.member })
      if (edge.namespaceReexport !== null) {
        if (alias.member === null) add({ file, name: edge.namespaceReexport, member: alias.name })
        else nested = true
      }
      for (const name of edge.names) {
        if (name.imported === alias.name) add({ file, name: name.local, member: alias.member })
        else if (name.imported === NAMESPACE_IMPORT) {
          if (alias.member === null) add({ file, name: name.local, member: alias.name })
          else nested = true
        }
      }
    }
  }
  return { aliases, nested }
}

interface Citation {
  file: string
  owner: string | null
}

function citationsThrough(
  alias: Alias,
  importers: Map<string, Array<{ file: string; facts: FileFacts; edge: Edge }>>,
): { citations: Citation[]; nested: boolean } {
  const citations: Citation[] = []
  let nested = false
  for (const { file, facts, edge } of importers.get(alias.file) ?? []) {
    for (const name of edge.names) {
      if (name.imported === NAMESPACE_IMPORT) {
        if (alias.member !== null) {
          nested = true
          continue
        }
        for (const use of facts.symbols.memberUses) {
          if (use.object === name.local && use.member === alias.name) citations.push({ file, owner: use.owner })
        }
        continue
      }
      if (name.imported !== alias.name) continue
      if (alias.member === null) {
        for (const reference of facts.symbols.references) {
          if (reference.name === name.local) citations.push({ file, owner: reference.owner })
        }
      } else {
        for (const use of facts.symbols.memberUses) {
          if (use.object === name.local && use.member === alias.member) citations.push({ file, owner: use.owner })
        }
      }
    }
  }
  return { citations, nested }
}

interface Candidate {
  symbol: DeadSymbol
  key: string
  citations: Citation[]
  aliasFiles: string[]
  uncertain: 'entrypoint' | 'tainted' | 'dynamic' | 'nested' | null
  isPublic: boolean
}

function candidatesOf(input: DeadCodeInput, corpus: Corpus): Candidate[] {
  const includeTypes = input.includeTypes === true
  const reexports = reexportsByTarget(corpus)
  const importers = importersByTarget(corpus)
  const publicApi = input.publicApi ?? []
  const candidates: Candidate[] = []

  for (const path of input.targets) {
    const facts = corpus.facts.get(path)
    if (!facts) continue
    const byName = new Map<string, { symbol: DeadSymbol; exposures: Set<string> }>()
    for (const declaration of facts.symbols.declarations) {
      if (!includeTypes && declaration.kind === 'type') continue
      const existing = byName.get(declaration.name)
      if (existing) {
        existing.symbol.start = Math.min(existing.symbol.start, declaration.start)
        existing.symbol.end = Math.max(existing.symbol.end, declaration.end)
        existing.symbol.exported = existing.symbol.exported || declaration.exported
        existing.symbol.defaultExport = existing.symbol.defaultExport || declaration.defaultExport
        for (const exposure of declaration.exposures) existing.exposures.add(exposure)
        continue
      }
      byName.set(declaration.name, {
        symbol: {
          path,
          name: declaration.name,
          kind: declaration.kind,
          exported: declaration.exported,
          defaultExport: declaration.defaultExport,
          start: declaration.start,
          end: declaration.end,
        },
        exposures: new Set(declaration.exposures),
      })
    }

    for (const { symbol, exposures } of byName.values()) {
      const citations: Citation[] = []
      for (const reference of facts.symbols.references) {
        if (reference.name === symbol.name) citations.push({ file: path, owner: reference.owner })
      }
      const { aliases, nested: nestedAlias } = aliasesOf(path, [...exposures], reexports)
      let nested = nestedAlias
      for (const alias of aliases) {
        const through = citationsThrough(alias, importers)
        citations.push(...through.citations)
        if (through.nested) nested = true
      }
      const aliasFiles = [...new Set(aliases.map((alias) => alias.file))]
      const isPublic = publicApi.length > 0 && aliasFiles.some((file) => matchesAnyGlob(file, publicApi).matched)
      let uncertain: Candidate['uncertain'] = null
      if (aliasFiles.some((file) => !corpus.importedFiles.has(file))) uncertain = 'entrypoint'
      else if (aliasFiles.some((file) => corpus.taintedTargets.has(file))) uncertain = 'tainted'
      else if (aliasFiles.some((file) => corpus.dynamicTargets.has(file))) uncertain = 'dynamic'
      else if (nested) uncertain = 'nested'
      candidates.push({ symbol, key: keyOf(symbol.path, symbol.name), citations, aliasFiles, uncertain, isPublic })
    }
  }
  return candidates
}

function reach(candidates: readonly Candidate[], roots: ReadonlySet<string>, blocked: ReadonlySet<string>): { reached: Set<string>; waves: number } {
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  const cites = new Map<string, string[]>()
  for (const candidate of candidates) {
    for (const citation of candidate.citations) {
      if (citation.owner === null) continue
      const ownerKey = keyOf(citation.file, citation.owner)
      if (!byKey.has(ownerKey) || ownerKey === candidate.key) continue
      const list = cites.get(ownerKey) ?? []
      list.push(candidate.key)
      cites.set(ownerKey, list)
    }
  }
  const reached = new Set<string>()
  let frontier = [...roots].filter((key) => !blocked.has(key))
  for (const key of frontier) reached.add(key)
  let waves = 0
  while (frontier.length > 0) {
    waves += 1
    const next: string[] = []
    for (const key of frontier) {
      for (const cited of cites.get(key) ?? []) {
        if (reached.has(cited) || blocked.has(cited)) continue
        reached.add(cited)
        next.push(cited)
      }
    }
    frontier = next
  }
  return { reached, waves }
}

function isCertainRoot(candidate: Candidate, candidateKeys: ReadonlySet<string>): boolean {
  return candidate.citations.some((citation) => {
    if (citation.owner === null) return true
    const ownerKey = keyOf(citation.file, citation.owner)
    return ownerKey !== candidate.key && !candidateKeys.has(ownerKey)
  })
}

export async function findDeadSymbols(input: DeadCodeInput): Promise<DeadCodeResult> {
  const corpus = await readCorpus(input)
  const candidates = candidatesOf(input, corpus)
  const candidateKeys = new Set(candidates.map((candidate) => candidate.key))

  const certain = new Set(candidates.filter((c) => isCertainRoot(c, candidateKeys)).map((c) => c.key))
  const withoutPublic = reach(candidates, certain, new Set())
  const publicRoots = new Set([...certain, ...candidates.filter((c) => c.isPublic).map((c) => c.key)])
  const live = reach(candidates, publicRoots, new Set())
  const uncertainRoots = new Set(candidates.filter((c) => c.uncertain !== null).map((c) => c.key))
  const maybe = reach(candidates, uncertainRoots, live.reached)

  const dead: DeadSymbol[] = []
  const unknown: DeadSymbol[] = []
  const publicExempted: DeadSymbol[] = []
  for (const candidate of candidates) {
    if (candidate.isPublic && !withoutPublic.reached.has(candidate.key)) publicExempted.push(candidate.symbol)
    if (live.reached.has(candidate.key)) continue
    if (maybe.reached.has(candidate.key) || corpus.blind) unknown.push(candidate.symbol)
    else dead.push(candidate.symbol)
  }

  return {
    dead,
    unknown,
    publicExempted,
    unreadable: [...corpus.unreadable],
    filesScanned: corpus.facts.size,
    iterations: Math.max(live.waves, maybe.waves),
    hints: hintsFor(input, corpus, candidates, dead, unknown, publicExempted),
  }
}

function hintsFor(
  input: DeadCodeInput,
  corpus: Corpus,
  candidates: readonly Candidate[],
  dead: readonly DeadSymbol[],
  unknown: readonly DeadSymbol[],
  publicExempted: readonly DeadSymbol[],
): string[] {
  const hints: string[] = []
  const unknownKeys = new Set(unknown.map((symbol) => keyOf(symbol.path, symbol.name)))
  const unknownBy = (reason: Candidate['uncertain']): Candidate[] =>
    candidates.filter((c) => c.uncertain === reason && unknownKeys.has(c.key))

  if ((input.publicApi ?? []).length === 0 && dead.some((symbol) => symbol.exported)) {
    hints.push(
      `${PUBLIC_API_HINT_PREFIX} in .rsct.json, so every export is judged by references inside this ` +
        `repository alone. If consumers live outside it (a published library), declare the public ` +
        `paths there or those exports will read as dead.`,
    )
  }
  if (publicExempted.length > 0) {
    hints.push(
      `${PUBLIC_EXEMPTED_HINT_PREFIX} ${publicExempted.length} export(s) nothing in this repository ` +
        `uses: ${publicExempted.map((symbol) => `${symbol.path}:${symbol.name}`).join(', ')}.`,
    )
  }
  const tainted = unknownBy('tainted').length + unknownBy('nested').length
  if (corpus.blind || tainted > 0) {
    hints.push(
      `${UNREADABLE_HINT_PREFIX} on ${corpus.blind ? unknown.length : tainted} symbol(s): a file ` +
        `the scan could not read may hold the only reference. Unreadable files: ` +
        `${[...corpus.unreadable].join(', ')}`,
    )
  }
  const entry = unknownBy('entrypoint')
  if (entry.length > 0) {
    const files = [...new Set(entry.flatMap((c) => c.aliasFiles.filter((file) => !corpus.importedFiles.has(file))))]
    hints.push(
      `${ENTRYPOINT_HINT_PREFIX} ${files.join(', ')}, so what it exports cannot be told apart from an ` +
        `entrypoint's. ${entry.length} export(s) left as unknown rather than reported dead. ` +
        `Declare the file in "public_api" if it is an entrypoint or a published surface.`,
    )
  }
  const dynamic = unknownBy('dynamic')
  if (dynamic.length > 0) {
    const files = [...new Set(dynamic.flatMap((c) => c.aliasFiles.filter((file) => corpus.dynamicTargets.has(file))))]
    hints.push(
      `${DYNAMIC_HINT_PREFIX} ${files.join(', ')}: import() or require() does not say which export ` +
        `it uses, so ${dynamic.length} export(s) are left as unknown rather than reported dead.`,
    )
  }
  const dependent = corpus.blind ? [] : unknownBy(null)
  if (dependent.length > 0) {
    hints.push(
      `${DEPENDENT_HINT_PREFIX}: ${dependent.map((c) => `${c.symbol.path}:${c.symbol.name}`).join(', ')}. ` +
        `They live or die with the symbols above.`,
    )
  }
  return hints
}

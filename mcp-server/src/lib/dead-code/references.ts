import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { matchesAnyGlob } from '../phase-scope.js'
import { extractImports } from '../reverse-dep-walk.js'
import {
  NAMESPACE_IMPORT,
  ownerKeyOf,
  scanSymbols,
  type DeclarationKind,
  type TreeEdgeKind,
  type TreeImportEdge,
  type TreeImportName,
  type TreeLanguage,
  type TreeSymbolScan,
  type TreeSymbols,
} from '../comment-sweep/tree-engine.js'
import { createModuleResolver, type ModuleResolver } from './module-resolution.js'

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

const MODULE_SUFFIXES: ReadonlySet<string> = new Set(['.mjs', '.cjs', '.mts', '.cts'])
const FOREIGN_IMPORTER_SUFFIXES: ReadonlySet<string> = new Set(['.vue', '.svelte', '.astro', '.html', '.htm', '.mdx'])
const BUILD_OUTPUT_DIRS: readonly string[] = ['dist', 'build', 'coverage']
const VENDORED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', '.git'])
const CONFIG_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json)$/
const COMPUTED_IMPORT = /\b(?:import|require)\s*\(\s*[^'"\s)]|import\.meta\.glob|require\.context/
const CODE_FENCE = /^\s*(`{3,}|~{3,})/
const MDX_ESM_LINE = /^(?:import|export)\b/
const HINT_LIST_LIMIT = 10

function withoutCodeFences(text: string): string {
  const kept: string[] = []
  let open: string | null = null
  for (const line of text.split('\n')) {
    const fence = CODE_FENCE.exec(line)?.[1] ?? null
    if (open !== null) {
      if (fence !== null && fence[0] === open[0] && fence.length >= open.length) open = null
      continue
    }
    if (fence !== null) {
      open = fence
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

function suffixOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : ''
}

export function languageOf(path: string): TreeLanguage | null {
  return LANGUAGE_BY_SUFFIX.get(suffixOf(path)) ?? null
}

function isVendored(path: string): boolean {
  return path.split('/').some((segment) => VENDORED_SEGMENTS.has(segment))
}

export function packageRootsOf(known: Iterable<string>): string[] {
  const roots = new Set<string>([''])
  for (const path of known) {
    if (isVendored(path)) continue
    if (path === 'package.json' || path.endsWith('/package.json')) roots.add(path.slice(0, path.length - 'package.json'.length))
  }
  return [...roots]
}

export function isBuildOutput(path: string, packageRoots: readonly string[]): boolean {
  if (isVendored(path)) return true
  return packageRoots.some((root) => BUILD_OUTPUT_DIRS.some((dir) => path.startsWith(`${root}${dir}/`)))
}

export function corpusFrom(known: Iterable<string>): string[] {
  const paths = [...known]
  const roots = packageRootsOf(paths)
  return paths.filter(
    (path) => (languageOf(path) !== null || FOREIGN_IMPORTER_SUFFIXES.has(suffixOf(path))) && !isBuildOutput(path, roots),
  )
}

export function configFilesFrom(known: Iterable<string>): string[] {
  return [...known].filter((path) => CONFIG_FILE.test(path) && !isVendored(path))
}

export type SourceRead = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'error' }
export type SourceReader = (rel: string) => SourceRead

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function workingTreeReader(root: string): SourceReader {
  return (rel) => {
    try {
      return { kind: 'text', text: normalizeLineEndings(readFileSync(join(root, rel), 'utf8')) }
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
  configs?: readonly string[]
  publicApi?: readonly string[]
  publicApiRoot?: string
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
  start: number
  end: number
}

export interface DeadCodeResult {
  dead: DeadSymbol[]
  unknown: DeadSymbol[]
  publicExempted: DeadSymbol[]
  unreadable: string[]
  filesScanned: number
  hints: string[]
}

export const PUBLIC_API_HINT_PREFIX = 'Dead-code scan: no "public_api" is declared'
export const PUBLIC_EXEMPTED_HINT_PREFIX = 'Dead-code scan: "public_api" exempted'
export const UNREADABLE_HINT_PREFIX = 'Dead-code scan: withheld a verdict'
export const ENTRYPOINT_HINT_PREFIX = 'Dead-code scan: no resolved import reaches'
export const DYNAMIC_HINT_PREFIX = 'Dead-code scan: dynamically imported'
export const DEPENDENT_HINT_PREFIX = 'Dead-code scan: used only by symbols left unknown'
export const NESTED_HINT_PREFIX = 'Dead-code scan: reached through a namespace inside a namespace'
export const ESCAPED_HINT_PREFIX = 'Dead-code scan: a namespace import is used as a value'
export const UNRESOLVED_HINT_PREFIX = 'Dead-code scan: could not resolve'
export const UNBOUND_HINT_PREFIX = 'Dead-code scan: an import with no fixed target'
export const SCRIPT_HINT_PREFIX = 'Dead-code scan: classic script'
export const EVAL_HINT_PREFIX = 'Dead-code scan: direct eval'
export const UNPARSEABLE_TARGET_HINT_PREFIX = 'Dead-code scan: could not parse'

const KEY_SEPARATOR = '\u0000'

function keyOf(path: string, owner: string): string {
  return `${path}${KEY_SEPARATOR}${owner}`
}

const SCAN_CACHE_MAX = 4000
let scanCacheLimit = SCAN_CACHE_MAX
let scanMisses = 0
const scanCache = new Map<string, TreeSymbolScan>()

export function clearSymbolScanCache(): void {
  scanCache.clear()
}

export function symbolScanCacheSize(): number {
  return scanCache.size
}

export function symbolScanMisses(): number {
  return scanMisses
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
  scanMisses += 1
  const scan = await scanSymbols(language, source)
  while (scanCache.size >= scanCacheLimit) {
    const oldest = scanCache.keys().next().value
    if (oldest === undefined) break
    scanCache.delete(oldest)
  }
  scanCache.set(key, scan)
  return scan
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
  module: boolean
}

interface Unresolved {
  from: string
  specifier: string
  within: string | null
  names: ReadonlySet<string> | 'all'
}

interface Corpus {
  facts: Map<string, FileFacts>
  unreadable: Set<string>
  unparsed: Set<string>
  taintedTargets: Set<string>
  dynamicTargets: Set<string>
  importedFiles: Set<string>
  unresolved: Unresolved[]
  unboundFiles: Set<string>
  blind: boolean
}

function isUsed(symbols: TreeSymbols, local: string): boolean {
  return symbols.references.some((r) => r.name === local) || symbols.memberUses.some((u) => u.object === local)
}

function escapes(symbols: TreeSymbols, local: string): boolean {
  return symbols.references.some((r) => r.name === local)
}

function unresolvedNames(edge: TreeImportEdge, symbols: TreeSymbols): ReadonlySet<string> | 'all' {
  if (edge.kind === 'dynamic') return 'all'
  if (edge.kind === 'reexport') {
    if (edge.starReexport || edge.namespaceReexport !== null) return 'all'
    if (edge.names.some((name) => name.imported === NAMESPACE_IMPORT)) return 'all'
    return new Set(edge.names.map((name) => name.imported))
  }
  const names = new Set<string>()
  for (const name of edge.names) {
    if (name.imported === NAMESPACE_IMPORT) {
      if (escapes(symbols, name.local)) return 'all'
      for (const use of symbols.memberUses) if (use.object === name.local) names.add(use.member)
    } else if (isUsed(symbols, name.local)) {
      names.add(name.imported)
    }
  }
  return names
}

async function readCorpus(input: DeadCodeInput): Promise<Corpus> {
  const read = input.read ?? workingTreeReader(input.projectRoot)
  const resolver: ModuleResolver = createModuleResolver({
    projectRoot: input.projectRoot,
    corpus: input.corpus,
    configs: input.configs ?? [],
    readText: (rel) => {
      const source = read(rel)
      return source.kind === 'text' ? source.text : null
    },
  })

  const corpus: Corpus = {
    facts: new Map(),
    unreadable: new Set(),
    unparsed: new Set(),
    taintedTargets: new Set(),
    dynamicTargets: new Set(),
    importedFiles: new Set(),
    unresolved: [],
    unboundFiles: new Set(),
    blind: false,
  }

  const readByPattern = (rel: string, source: string): void => {
    const mdx = suffixOf(rel) === '.mdx'
    const text = mdx ? withoutCodeFences(source) : source
    const code = mdx ? text.split('\n').filter((line) => MDX_ESM_LINE.test(line)).join('\n') : text
    for (const specifier of extractImports(text)) {
      const resolution = resolver.resolve(rel, specifier)
      if (resolution.kind === 'files') {
        for (const target of resolution.files) {
          corpus.taintedTargets.add(target)
          corpus.importedFiles.add(target)
        }
      } else if (resolution.kind === 'unknown') {
        corpus.unresolved.push({ from: rel, specifier, within: resolution.within, names: 'all' })
      }
    }
    if (COMPUTED_IMPORT.test(code)) corpus.unboundFiles.add(rel)
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
      if (language) corpus.unparsed.add(rel)
      readByPattern(rel, source.text)
      continue
    }
    const symbols = scan.symbols
    const edges: Edge[] = []
    for (const edge of symbols.imports) {
      const resolution = resolver.resolve(rel, edge.specifier)
      if (resolution.kind === 'unknown') {
        const names = unresolvedNames(edge, symbols)
        if (names === 'all' || names.size > 0) corpus.unresolved.push({ from: rel, specifier: edge.specifier, within: resolution.within, names })
        continue
      }
      if (resolution.kind !== 'files') continue
      const kind: TreeEdgeKind = resolution.query ? 'dynamic' : edge.kind
      for (const target of resolution.files) {
        corpus.importedFiles.add(target)
        if (kind === 'dynamic') corpus.dynamicTargets.add(target)
        edges.push({ target, kind, names: edge.names, star: edge.starReexport, namespaceReexport: edge.namespaceReexport })
      }
    }
    for (const prefix of symbols.dynamicPrefixes) {
      const files = resolver.prefixFiles(rel, prefix)
      if (files === null) {
        corpus.unboundFiles.add(rel)
        continue
      }
      for (const target of files) {
        corpus.dynamicTargets.add(target)
        corpus.importedFiles.add(target)
      }
    }
    if (symbols.unboundDynamic) corpus.unboundFiles.add(rel)
    const factories = symbols.hasJsx ? resolver.jsxFactories(rel) : []
    const withFactories: TreeSymbols =
      factories.length > 0 ? { ...symbols, references: [...symbols.references, ...factories.map((name) => ({ name, owner: null }))] } : symbols
    corpus.facts.set(rel, { symbols: withFactories, edges, module: symbols.module || MODULE_SUFFIXES.has(suffixOf(rel)) })
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

interface Importer {
  file: string
  facts: FileFacts
  edge: Edge
}

function edgesByTarget<T>(corpus: Corpus, kind: TreeEdgeKind, make: (file: string, facts: FileFacts, edge: Edge) => T): Map<string, T[]> {
  const byTarget = new Map<string, T[]>()
  for (const [file, facts] of corpus.facts) {
    for (const edge of facts.edges) {
      if (edge.kind !== kind) continue
      const list = byTarget.get(edge.target) ?? []
      list.push(make(file, facts, edge))
      byTarget.set(edge.target, list)
    }
  }
  return byTarget
}

function aliasesOf(path: string, exposures: readonly string[], reexports: Map<string, Reexport[]>): { aliases: Alias[]; nested: boolean } {
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

interface Through {
  citations: Citation[]
  nested: boolean
  escapedIn: string[]
}

function citeUses(citations: Citation[], file: string, symbols: TreeSymbols, local: string): void {
  for (const reference of symbols.references) if (reference.name === local) citations.push({ file, owner: reference.owner })
  for (const use of symbols.memberUses) if (use.object === local) citations.push({ file, owner: use.owner })
}

function citeMember(citations: Citation[], file: string, symbols: TreeSymbols, local: string, member: string): void {
  for (const use of symbols.memberUses) if (use.object === local && use.member === member) citations.push({ file, owner: use.owner })
}

function citationsThrough(alias: Alias, importers: Map<string, Importer[]>): Through {
  const through: Through = { citations: [], nested: false, escapedIn: [] }
  for (const { file, facts, edge } of importers.get(alias.file) ?? []) {
    for (const name of edge.names) {
      if (name.imported === NAMESPACE_IMPORT) {
        if (alias.member !== null) {
          through.nested = true
          continue
        }
        if (escapes(facts.symbols, name.local)) through.escapedIn.push(file)
        citeMember(through.citations, file, facts.symbols, name.local, alias.name)
        continue
      }
      if (name.imported !== alias.name) continue
      if (alias.member === null) {
        citeUses(through.citations, file, facts.symbols, name.local)
        continue
      }
      if (escapes(facts.symbols, name.local)) through.escapedIn.push(file)
      citeMember(through.citations, file, facts.symbols, name.local, alias.member)
    }
  }
  return through
}

type Uncertainty = 'script' | 'eval' | 'entrypoint' | 'tainted' | 'dynamic' | 'unresolved' | 'escaped' | 'nested' | 'unbound'

interface Candidate {
  symbol: DeadSymbol
  key: string
  citations: Citation[]
  aliasFiles: string[]
  uncertain: Uncertainty | null
  because: string[]
  isPublic: boolean
  effect: boolean
}

function publicMatcher(input: DeadCodeInput): (file: string) => boolean {
  const globs = input.publicApi ?? []
  if (globs.length === 0) return () => false
  const root = input.publicApiRoot
  return (file) =>
    matchesAnyGlob(file, globs).matched || (root !== undefined && matchesAnyGlob(join(input.projectRoot, file), globs, root).matched)
}

function unresolvedMatches(corpus: Corpus, aliases: readonly Alias[]): string[] {
  const hits: string[] = []
  for (const use of corpus.unresolved) {
    const reaches = aliases.some(
      (alias) => (use.within === null || alias.file.startsWith(use.within)) && (use.names === 'all' || use.names.has(alias.name)),
    )
    if (reaches) hits.push(`${use.specifier} (${use.from})`)
  }
  return hits
}

function uncertaintyOf(
  path: string,
  facts: FileFacts,
  exported: boolean,
  corpus: Corpus,
  aliases: readonly Alias[],
  escapedIn: readonly string[],
  nested: boolean,
): { uncertain: Uncertainty | null; because: string[] } {
  const aliasFiles = [...new Set(aliases.map((alias) => alias.file))]
  const reasons: Array<[Uncertainty, readonly string[]]> = []
  if (!facts.module) reasons.push(['script', [path]])
  if (facts.symbols.directEval) reasons.push(['eval', [path]])
  if (exported) {
    const notImported = aliasFiles.filter((file) => !corpus.importedFiles.has(file))
    if (notImported.length > 0) reasons.push(['entrypoint', notImported])
    const tainted = aliasFiles.filter((file) => corpus.taintedTargets.has(file))
    if (tainted.length > 0) reasons.push(['tainted', tainted])
    const dynamic = aliasFiles.filter((file) => corpus.dynamicTargets.has(file))
    if (dynamic.length > 0) reasons.push(['dynamic', dynamic])
    const unresolved = unresolvedMatches(corpus, aliases)
    if (unresolved.length > 0) reasons.push(['unresolved', unresolved])
    if (escapedIn.length > 0) reasons.push(['escaped', escapedIn])
    if (nested) reasons.push(['nested', aliasFiles])
    if (corpus.unboundFiles.size > 0) reasons.push(['unbound', [...corpus.unboundFiles]])
  }
  const first = reasons[0]
  return first ? { uncertain: first[0], because: [...new Set(first[1])] } : { uncertain: null, because: [] }
}

function candidatesOf(input: DeadCodeInput, corpus: Corpus): Candidate[] {
  const includeTypes = input.includeTypes === true
  const reexports = edgesByTarget(corpus, 'reexport', (file, _facts, edge): Reexport => ({ file, edge }))
  const importers = edgesByTarget(corpus, 'import', (file, facts, edge): Importer => ({ file, facts, edge }))
  const isPublicPath = publicMatcher(input)
  const candidates: Candidate[] = []

  for (const path of input.targets) {
    const facts = corpus.facts.get(path)
    if (!facts) continue
    const byOwner = new Map<string, { symbol: DeadSymbol; exposures: Set<string>; effect: boolean }>()
    for (const declaration of facts.symbols.declarations) {
      if (!includeTypes && declaration.kind === 'type') continue
      const owner = ownerKeyOf(declaration.kind, declaration.name)
      const existing = byOwner.get(owner)
      if (existing) {
        existing.symbol.start = Math.min(existing.symbol.start, declaration.start)
        existing.symbol.end = Math.max(existing.symbol.end, declaration.end)
        existing.symbol.exported = existing.symbol.exported || declaration.exported
        existing.effect = existing.effect || declaration.effect
        for (const exposure of declaration.exposures) existing.exposures.add(exposure)
        continue
      }
      byOwner.set(owner, {
        symbol: {
          path,
          name: declaration.name,
          kind: declaration.kind,
          exported: declaration.exported,
          start: declaration.start,
          end: declaration.end,
        },
        exposures: new Set(declaration.exposures),
        effect: declaration.effect,
      })
    }

    for (const [owner, { symbol, exposures, effect }] of byOwner) {
      const citations: Citation[] = []
      citeUses(citations, path, facts.symbols, symbol.name)
      const { aliases, nested: nestedAlias } = aliasesOf(path, [...exposures], reexports)
      let nested = nestedAlias
      const escapedIn: string[] = []
      for (const alias of aliases) {
        const through = citationsThrough(alias, importers)
        citations.push(...through.citations)
        if (through.nested) nested = true
        escapedIn.push(...through.escapedIn)
      }
      const aliasFiles = [...new Set(aliases.map((alias) => alias.file))]
      const { uncertain, because } = uncertaintyOf(path, facts, exposures.size > 0, corpus, aliases, escapedIn, nested)
      candidates.push({
        symbol,
        key: keyOf(path, owner),
        citations,
        aliasFiles,
        uncertain,
        because,
        isPublic: aliasFiles.some(isPublicPath),
        effect,
      })
    }
  }
  return candidates
}

function reach(candidates: readonly Candidate[], roots: ReadonlySet<string>, blocked: ReadonlySet<string>): Set<string> {
  const known = new Set(candidates.map((candidate) => candidate.key))
  const cites = new Map<string, string[]>()
  for (const candidate of candidates) {
    for (const citation of candidate.citations) {
      if (citation.owner === null) continue
      const ownerKey = keyOf(citation.file, citation.owner)
      if (!known.has(ownerKey) || ownerKey === candidate.key) continue
      const list = cites.get(ownerKey) ?? []
      list.push(candidate.key)
      cites.set(ownerKey, list)
    }
  }
  const reached = new Set<string>()
  let frontier = [...roots].filter((key) => !blocked.has(key))
  for (const key of frontier) reached.add(key)
  while (frontier.length > 0) {
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
  return reached
}

function isCertainRoot(candidate: Candidate, candidateKeys: ReadonlySet<string>): boolean {
  if (candidate.effect) return true
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
  const maybe = reach(candidates, uncertainRoots, live)

  const dead: DeadSymbol[] = []
  const unknown: DeadSymbol[] = []
  const publicExempted: DeadSymbol[] = []
  for (const candidate of candidates) {
    if (candidate.isPublic && !withoutPublic.has(candidate.key)) publicExempted.push(candidate.symbol)
    if (live.has(candidate.key)) continue
    if (maybe.has(candidate.key) || corpus.blind) unknown.push(candidate.symbol)
    else dead.push(candidate.symbol)
  }

  return {
    dead,
    unknown,
    publicExempted,
    unreadable: [...corpus.unreadable],
    filesScanned: corpus.facts.size,
    hints: hintsFor(input, corpus, candidates, dead, unknown, publicExempted),
  }
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, HINT_LIST_LIMIT).join(', ')
  return items.length > HINT_LIST_LIMIT ? `${shown} and ${items.length - HINT_LIST_LIMIT} more` : shown
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
  const unknownKeys = new Set(unknown.map((symbol) => keyOf(symbol.path, ownerKeyOf(symbol.kind, symbol.name))))
  const unknownBy = (reason: Uncertainty): Candidate[] => candidates.filter((c) => c.uncertain === reason && unknownKeys.has(c.key))
  const sourcesOf = (group: readonly Candidate[]): string => listed([...new Set(group.flatMap((c) => c.because))])

  if ((input.publicApi ?? []).length === 0 && dead.some((symbol) => symbol.exported)) {
    hints.push(
      `${PUBLIC_API_HINT_PREFIX} in .rsct.json, so every export is judged by references inside this repository ` +
        `alone. If consumers live outside it (a published library, or a framework that loads files by ` +
        `convention), declare those paths there or their exports will read as dead.`,
    )
  }
  if (publicExempted.length > 0) {
    hints.push(
      `${PUBLIC_EXEMPTED_HINT_PREFIX} ${publicExempted.length} export(s) nothing in this repository uses: ` +
        `${listed(publicExempted.map((symbol) => `${symbol.path}:${symbol.name}`))}.`,
    )
  }
  const tainted = unknownBy('tainted')
  if (corpus.blind || tainted.length > 0) {
    hints.push(
      `${UNREADABLE_HINT_PREFIX} on ${corpus.blind ? unknown.length : tainted.length} symbol(s): a file the scan ` +
        `could not parse, and read only for its imports, may hold the only reference. Files: ` +
        `${listed([...corpus.unreadable])}.`,
    )
  }
  const unparsedTargets = input.targets.filter((path) => corpus.unparsed.has(path))
  if (unparsedTargets.length > 0) {
    hints.push(`${UNPARSEABLE_TARGET_HINT_PREFIX} ${listed(unparsedTargets)}, so dead code in them is not checked.`)
  }
  const groups: Array<[Uncertainty, string, (group: readonly Candidate[]) => string]> = [
    ['script', SCRIPT_HINT_PREFIX, (g) => `: ${sourcesOf(g)} declare(s) no import or export, so their top-level names are shared with every other script and page. ${g.length} symbol(s) left unknown.`],
    ['eval', EVAL_HINT_PREFIX, (g) => ` in ${sourcesOf(g)} can reach any binding of its file. ${g.length} symbol(s) left unknown.`],
    ['entrypoint', ENTRYPOINT_HINT_PREFIX, (g) => ` ${sourcesOf(g)}, so what it exports cannot be told apart from an entrypoint's. ${g.length} export(s) left unknown rather than reported dead. Declare the file in "public_api" if it is an entrypoint or a published surface.`],
    ['dynamic', DYNAMIC_HINT_PREFIX, (g) => ` ${sourcesOf(g)}: import(), require() or a query import does not say which export it uses, so ${g.length} export(s) are left unknown rather than reported dead.`],
    ['unresolved', UNRESOLVED_HINT_PREFIX, (g) => ` ${sourcesOf(g)}: an import this scan cannot follow may name ${g.length} export(s), left unknown. Declare the alias in tsconfig "paths" to make them precise.`],
    ['escaped', ESCAPED_HINT_PREFIX, (g) => ` in ${sourcesOf(g)} (passed along, spread, destructured or read with a computed key), so any of its exports may be used. ${g.length} export(s) left unknown.`],
    ['nested', NESTED_HINT_PREFIX, (g) => ` (ns.inner.name), which this scan does not follow: ${g.length} export(s) left unknown.`],
    ['unbound', UNBOUND_HINT_PREFIX, (g) => ` (import(x), require(x), a glob with no fixed directory) in ${sourcesOf(g)}: any export here may be its target, so ${g.length} export(s) are left unknown.`],
  ]
  for (const [reason, prefix, text] of groups) {
    const group = unknownBy(reason)
    if (group.length > 0) hints.push(`${prefix}${text(group)}`)
  }
  const dependent = corpus.blind ? [] : candidates.filter((c) => c.uncertain === null && unknownKeys.has(c.key))
  if (dependent.length > 0) {
    hints.push(
      `${DEPENDENT_HINT_PREFIX}: ${listed(dependent.map((c) => `${c.symbol.path}:${c.symbol.name}`))}. ` +
        `They live or die with the symbols above.`,
    )
  }
  return hints
}

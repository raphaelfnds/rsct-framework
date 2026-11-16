import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve as resolvePath } from 'node:path'

import { matchesAnyGlob, toPosix } from './phase-scope.js'

export const DEFAULT_LANG_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.mts',
  '**/*.cts',
]

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
]

const DEFAULT_MAX_DEPTH = 2

export const DEFAULT_LANG_SUFFIXES = DEFAULT_LANG_GLOBS.map((glob) => glob.slice(glob.lastIndexOf('*') + 1)).join(', ')

const JS_RUNTIME_SUFFIX = /\.(?:js|mjs|cjs)$/

const RESOLVE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]

const INDEX_RESOLUTIONS: readonly string[] = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
  '/index.mts',
  '/index.cts',
]

const IMPORT_PATTERNS: readonly RegExp[] = [
  /import\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
]

export const DIRECTORY_SPECIFIER = /(?:^|\/)\.{0,2}$/

export interface ReverseDepInput {
  projectRoot: string
  seedPaths: string[]
  langGlobs?: readonly string[]
  excludeGlobs?: readonly string[]
  maxDepth?: number
  probe?: ResolveProbe
}

export interface DiscoveredImporter {
  file: string
  via_paths: string[]
  depth: number
}

export interface SeedImporter {
  file: string
  depth: number
}

export interface SeedImporters {
  seed: string
  count: number
  direct: number
  listed: SeedImporter[]
}

export const SEED_IMPORTERS_LISTED = 10

export interface ReverseDepStats {
  files_scanned: number
  files_parsed: number
  parse_errors: number
  cycles_skipped: number
  unresolved_js_specifiers: number
  case_inexact_specifiers: number
}

export type WalkCoverage = 'analyzed' | 'partial' | 'uncovered' | 'not-run'

export interface ReverseDepResult {
  declared: string[]
  discovered: DiscoveredImporter[]
  by_seed: SeedImporters[]
  stats: ReverseDepStats
  hints: string[]
  coverage: WalkCoverage
  uncovered_seeds: string[]
}

export const COVERAGE_HINT_PREFIX = 'Reverse-dep coverage:'

export const ZERO_IMPORTER_HINT_PREFIX = 'Reverse-dep walk found 0 importers'

function relPosix(projectRoot: string, abs: string): string {
  return toPosix(relative(projectRoot, abs))
}

export function seedIsCoverable(
  rel: string,
  langGlobs: readonly string[] = DEFAULT_LANG_GLOBS,
): boolean {
  if (isAbsolute(rel) || rel.startsWith('../')) return false
  return matchesAnyGlob(rel, langGlobs).matched
}

export function walkFiles(
  root: string,
  langGlobs: readonly string[],
  excludeGlobs: readonly string[],
): string[] {
  const results: string[] = []
  const recurse = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relPosix(root, full)
      if (entry.isDirectory()) {
        if (matchesAnyGlob(`${rel}/probe`, excludeGlobs).matched) continue
        recurse(full)
      } else if (entry.isFile()) {
        if (matchesAnyGlob(rel, excludeGlobs).matched) continue
        if (matchesAnyGlob(rel, langGlobs).matched) results.push(full)
      }
    }
  }
  recurse(root)
  return results
}

export function extractImports(content: string): string[] {
  const imports = new Set<string>()
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const spec = m[1]
      if (spec) imports.add(spec)
    }
  }
  return [...imports]
}

const NODENEXT_SOURCE_EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx'] as readonly string[]],
  ['.mjs', ['.mts'] as readonly string[]],
  ['.cjs', ['.cts'] as readonly string[]],
])

function hasExactEntry(path: string, entries: Map<string, Set<string>>): boolean {
  const dir = dirname(path)
  let names = entries.get(dir)
  if (!names) {
    try {
      names = new Set(readdirSync(dir))
    } catch {
      names = new Set<string>()
    }
    entries.set(dir, names)
  }
  return names.has(basename(path))
}

function hasExactPath(
  projectRoot: string,
  candidate: string,
  entries: Map<string, Set<string>>,
): boolean {
  const rel = relPosix(projectRoot, candidate)
  if (rel.startsWith('../') || isAbsolute(rel)) return hasExactEntry(candidate, entries)
  let walked = projectRoot
  for (const segment of rel.split('/')) {
    walked = join(walked, segment)
    if (!hasExactEntry(walked, entries)) return false
  }
  return true
}

export interface ResolveProbe {
  exists(abs: string): boolean
  isFile(abs: string): boolean
  isDirectory(abs: string): boolean
  hasExactPath(abs: string): boolean
}

export function diskProbe(projectRoot: string, entries: Map<string, Set<string>>): ResolveProbe {
  const stats = new Map<string, ReturnType<typeof statSync> | null>()
  const stat = (abs: string): ReturnType<typeof statSync> | null => {
    if (stats.has(abs)) return stats.get(abs) ?? null
    let answer: ReturnType<typeof statSync> | null
    try {
      answer = statSync(abs, { throwIfNoEntry: false }) ?? null
    } catch {
      answer = null
    }
    stats.set(abs, answer)
    return answer
  }
  return {
    exists: (abs) => existsSync(abs),
    isFile: (abs) => stat(abs)?.isFile() ?? false,
    isDirectory: (abs) => stat(abs)?.isDirectory() ?? false,
    hasExactPath: (abs) => hasExactPath(projectRoot, abs, entries),
  }
}

export function memoProbe(probe: ResolveProbe): ResolveProbe {
  const remember = (ask: (abs: string) => boolean): ((abs: string) => boolean) => {
    const answers = new Map<string, boolean>()
    return (abs) => {
      const known = answers.get(abs)
      if (known !== undefined) return known
      const answer = ask(abs)
      answers.set(abs, answer)
      return answer
    }
  }
  return {
    exists: remember((abs) => probe.exists(abs)),
    isFile: remember((abs) => probe.isFile(abs)),
    isDirectory: remember((abs) => probe.isDirectory(abs)),
    hasExactPath: (abs) => probe.hasExactPath(abs),
  }
}

type EntryKind = 'file' | 'dir' | 'other' | 'missing'

type WantedKind = 'file' | 'dir' | 'any'

type CaseState = 'absent' | 'exact' | 'inexact' | 'unknown'

interface Listing {
  kinds: Map<string, EntryKind>
  folded: Map<string, string[]>
}

interface FolderCase {
  state: CaseState
  real: string
}

interface CaseMemo {
  rootSegments: string[]
  listings: Map<string, Listing | null>
  folders: Map<string, FolderCase>
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '')
}

function entryKind(dir: string, entry: Dirent): EntryKind {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  if (!entry.isSymbolicLink()) return 'other'
  try {
    const target = statSync(join(dir, entry.name))
    return target.isFile() ? 'file' : target.isDirectory() ? 'dir' : 'other'
  } catch {
    return 'missing'
  }
}

function readListing(dir: string, memo: CaseMemo): Listing | null {
  const known = memo.listings.get(dir)
  if (known !== undefined) return known
  let listing: Listing | null
  try {
    const kinds = new Map<string, EntryKind>()
    const folded = new Map<string, string[]>()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      kinds.set(entry.name, entryKind(dir, entry))
      const key = entry.name.toLowerCase()
      const names = folded.get(key)
      if (names) names.push(entry.name)
      else folded.set(key, [entry.name])
    }
    listing = { kinds, folded }
  } catch {
    listing = null
  }
  memo.listings.set(dir, listing)
  return listing
}

function kindFits(kind: EntryKind | undefined, wanted: WantedKind): boolean {
  if (kind === undefined || kind === 'missing') return false
  return wanted === 'any' || kind === wanted
}

function matchName(listing: Listing, name: string, wanted: WantedKind): { state: CaseState; name: string } {
  if (kindFits(listing.kinds.get(name), wanted)) return { state: 'exact', name }
  const other = (listing.folded.get(name.toLowerCase()) ?? []).find(
    (candidate) => candidate !== name && kindFits(listing.kinds.get(candidate), wanted),
  )
  return other === undefined ? { state: 'absent', name } : { state: 'inexact', name: other }
}

function folderCase(folder: string, memo: CaseMemo): FolderCase {
  const known = memo.folders.get(folder)
  if (known !== undefined) return known
  const segments = pathSegments(folder)
  let shared = 0
  while (shared < segments.length && shared < memo.rootSegments.length && segments[shared] === memo.rootSegments[shared]) shared++
  shared = Math.max(shared, 1)
  const names: string[] = []
  let base = folder
  for (let i = segments.length; i > shared; i--) {
    names.unshift(basename(base))
    base = dirname(base)
  }
  let result: FolderCase = { state: 'exact', real: base }
  for (const name of names) {
    const listing = readListing(result.real, memo)
    if (listing === null) {
      result = { state: 'unknown', real: result.real }
      break
    }
    const match = matchName(listing, name, 'dir')
    if (match.state === 'absent') {
      result = { state: 'absent', real: result.real }
      break
    }
    result = { state: match.state === 'inexact' ? 'inexact' : result.state, real: join(result.real, match.name) }
  }
  memo.folders.set(folder, result)
  return result
}

function firstFolded(listing: Listing, names: readonly string[], wanted: WantedKind): CaseState {
  for (const name of names) {
    const match = matchName(listing, name, wanted)
    if (match.state !== 'absent') return match.state
  }
  return 'absent'
}

function storedSpelling(path: string, memo: CaseMemo): string {
  const absolute = resolvePath(path)
  const top = parse(absolute).root
  let spelled = top
  for (const name of pathSegments(absolute.slice(top.length))) {
    const listing = readListing(spelled, memo)
    const match = listing === null ? null : matchName(listing, name, 'dir')
    spelled = join(spelled, match === null || match.state === 'absent' ? name : match.name)
  }
  return spelled
}

function resolvesByCaseOnly(importerAbs: string, spec: string, memo: CaseMemo): boolean {
  if (!spec.startsWith('.') || spec.includes('\\')) return false
  const target = resolvePath(dirname(importerAbs), spec)
  const directoryOnly = DIRECTORY_SPECIFIER.test(spec)
  const parent = folderCase(dirname(target), memo)
  if (parent.state !== 'exact' && parent.state !== 'inexact') return false
  const listing = readListing(parent.real, memo)
  if (listing === null) return false
  const name = basename(target)
  const folderInexact = parent.state === 'inexact'
  if (!directoryOnly) {
    const asFile = firstFolded(listing, [name], 'file')
    if (asFile !== 'absent') return asFile === 'inexact' || folderInexact
    const withExtension = firstFolded(listing, RESOLVE_EXTENSIONS.map((ext) => name + ext), 'any')
    if (withExtension !== 'absent') return withExtension === 'inexact' || folderInexact
  }
  const asFolder = matchName(listing, name, 'dir')
  if (asFolder.state !== 'absent') {
    const inner = readListing(join(parent.real, asFolder.name), memo)
    if (inner !== null) {
      const index = firstFolded(inner, INDEX_RESOLUTIONS.map((idx) => idx.slice(1)), 'any')
      if (index !== 'absent') return index === 'inexact' || asFolder.state === 'inexact' || folderInexact
    }
  }
  const dot = name.lastIndexOf('.')
  const sourceExtensions = directoryOnly || dot < 0 ? undefined : NODENEXT_SOURCE_EXTENSIONS.get(name.slice(dot))
  if (sourceExtensions === undefined) return false
  const source = firstFolded(listing, sourceExtensions.map((ext) => name.slice(0, dot) + ext), 'any')
  return source !== 'absent' && (source === 'inexact' || folderInexact)
}

function byDepthThenFile(a: SeedImporter, b: SeedImporter): number {
  if (a.depth !== b.depth) return a.depth - b.depth
  return a.file.localeCompare(b.file)
}

function importersOfSeed(
  seed: string,
  declared: ReadonlySet<string>,
  reverseDeps: ReadonlyMap<string, ReadonlySet<string>>,
  maxDepth: number,
): SeedImporters {
  const seen = new Set<string>(declared)
  const found: SeedImporter[] = []
  const queue: SeedImporter[] = [{ file: seed, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift()!
    if (item.depth >= maxDepth) continue
    const importers = reverseDeps.get(item.file)
    if (!importers) continue
    for (const importer of importers) {
      if (seen.has(importer)) continue
      seen.add(importer)
      const next: SeedImporter = { file: importer, depth: item.depth + 1 }
      found.push(next)
      if (next.depth < maxDepth) queue.push(next)
    }
  }
  found.sort(byDepthThenFile)
  return {
    seed,
    count: found.length,
    direct: found.filter((importer) => importer.depth === 1).length,
    listed: found.slice(0, SEED_IMPORTERS_LISTED),
  }
}

const CASE_EXAMPLES_SHOWN = 5

function resolveNodeNextSource(target: string, probe: ResolveProbe): string | null {
  const sourceExtensions = NODENEXT_SOURCE_EXTENSIONS.get(target.slice(target.lastIndexOf('.')))
  if (!sourceExtensions) return null
  const stem = target.slice(0, target.lastIndexOf('.'))
  for (const ext of sourceExtensions) {
    const candidate = stem + ext
    if (probe.hasExactPath(candidate)) return candidate
  }
  return null
}

export function resolveImport(
  projectRoot: string,
  importerAbs: string,
  spec: string,
  entries: Map<string, Set<string>>,
  probe: ResolveProbe = diskProbe(projectRoot, entries),
): string | null {
  if (!spec.startsWith('.') && !isAbsolute(spec)) return null
  const target = isAbsolute(spec) ? spec : resolvePath(dirname(importerAbs), spec)
  const directoryOnly = DIRECTORY_SPECIFIER.test(spec)

  if (!directoryOnly && probe.isFile(target)) return target

  for (const ext of directoryOnly ? [] : RESOLVE_EXTENSIONS) {
    const candidate = target + ext
    if (probe.exists(candidate)) return candidate
  }

  if (probe.isDirectory(target)) {
    for (const idx of INDEX_RESOLUTIONS) {
      const candidate = target + idx
      if (probe.exists(candidate)) return candidate
    }
  }

  return resolveNodeNextSource(target, probe)
}

export function resolveImportCandidates(
  projectRoot: string,
  importerAbs: string,
  spec: string,
  entries: Map<string, Set<string>>,
  probe: ResolveProbe,
): string[] {
  const primary = resolveImport(projectRoot, importerAbs, spec, entries, probe)
  if (!primary) return []
  const source = resolveNodeNextSource(primary, probe)
  return source && source !== primary ? [primary, source] : [primary]
}

interface BfsItem {
  file: string
  depth: number
  via: string[]
}

export function walkReverseDeps(input: ReverseDepInput): ReverseDepResult {
  const projectRoot = input.projectRoot
  const langGlobs = input.langGlobs ?? DEFAULT_LANG_GLOBS
  const excludeGlobs = input.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH

  const declared = input.seedPaths.map((p) => {
    const abs = isAbsolute(p) ? p : resolvePath(projectRoot, p)
    return relPosix(projectRoot, abs)
  })

  const hints: string[] = []
  const stats: ReverseDepStats = {
    files_scanned: 0,
    files_parsed: 0,
    parse_errors: 0,
    cycles_skipped: 0,
    unresolved_js_specifiers: 0,
    case_inexact_specifiers: 0,
  }

  const notRun = (): ReverseDepResult => ({
    declared,
    discovered: [],
    by_seed: [],
    stats,
    hints,
    coverage: 'not-run',
    uncovered_seeds: [],
  })

  if (declared.length === 0) {
    hints.push('No seed paths provided — reverse-dep walk skipped.')
    return notRun()
  }
  if (!existsSync(projectRoot)) {
    hints.push(
      `projectRoot '${projectRoot}' does not exist — reverse-dep walk skipped.`,
    )
    return notRun()
  }

  let rootIsDirectory = false
  try {
    rootIsDirectory = statSync(projectRoot).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  if (!rootIsDirectory) {
    hints.push(
      `projectRoot '${projectRoot}' is not a directory — reverse-dep walk skipped.`,
    )
    return notRun()
  }
  if (maxDepth < 1) {
    hints.push(
      `maxDepth=${maxDepth} < 1 — reverse-dep walk has no depth budget; returning declared only.`,
    )
    return notRun()
  }

  const candidates = walkFiles(projectRoot, langGlobs, excludeGlobs)
  const directoryEntries = new Map<string, Set<string>>()
  const probe = memoProbe(input.probe ?? diskProbe(projectRoot, directoryEntries))
  const caseMemo: CaseMemo = { rootSegments: [], listings: new Map(), folders: new Map() }
  const caseRoot = storedSpelling(projectRoot, caseMemo)
  caseMemo.rootSegments = pathSegments(caseRoot)
  const caseExamples: string[] = []
  stats.files_scanned = candidates.length

  const reverseDeps = new Map<string, Set<string>>()
  for (const candidateAbs of candidates) {
    let content: string
    try {
      content = readFileSync(candidateAbs, 'utf8')
      stats.files_parsed++
    } catch {
      stats.parse_errors++
      continue
    }
    const candidateRel = relPosix(projectRoot, candidateAbs)
    const caseImporter = join(caseRoot, relative(projectRoot, candidateAbs))
    const imports = extractImports(content)
    for (const spec of imports) {
      if (resolvesByCaseOnly(caseImporter, spec, caseMemo)) {
        stats.case_inexact_specifiers++
        if (caseExamples.length < CASE_EXAMPLES_SHOWN) caseExamples.push(`${candidateRel} -> '${spec}'`)
      }
      const resolvedAbs = resolveImport(projectRoot, candidateAbs, spec, directoryEntries, probe)
      if (!resolvedAbs) {
        if (spec.startsWith('.') && JS_RUNTIME_SUFFIX.test(spec)) {
          stats.unresolved_js_specifiers++
        }
        continue
      }
      const resolvedRel = relPosix(projectRoot, resolvedAbs)
      if (resolvedRel === candidateRel) continue
      let set = reverseDeps.get(resolvedRel)
      if (!set) {
        set = new Set<string>()
        reverseDeps.set(resolvedRel, set)
      }
      set.add(candidateRel)
    }
  }

  const seen = new Set<string>(declared)
  const discoveredMap = new Map<string, DiscoveredImporter>()
  const queue: BfsItem[] = declared.map((d) => ({ file: d, depth: 0, via: [d] }))

  while (queue.length > 0) {
    const item = queue.shift()!
    if (item.depth >= maxDepth) continue
    const importers = reverseDeps.get(item.file)
    if (!importers) continue
    for (const importer of importers) {
      if (seen.has(importer)) {
        if (declared.includes(importer)) stats.cycles_skipped++
        continue
      }
      seen.add(importer)
      const nextDepth = item.depth + 1
      const nextVia = [...item.via, importer]
      discoveredMap.set(importer, {
        file: importer,
        via_paths: nextVia,
        depth: nextDepth,
      })
      if (nextDepth < maxDepth) {
        queue.push({ file: importer, depth: nextDepth, via: nextVia })
      }
    }
  }

  const discovered = [...discoveredMap.values()].sort(byDepthThenFile)
  const declaredSet = new Set(declared)
  const bySeed: SeedImporters[] = [...declaredSet].map((seed) => importersOfSeed(seed, declaredSet, reverseDeps, maxDepth))

  const uncoveredSeeds = declared.filter((d) => !seedIsCoverable(d, langGlobs))
  const coverage: WalkCoverage =
    uncoveredSeeds.length === 0
      ? 'analyzed'
      : uncoveredSeeds.length === declared.length
        ? 'uncovered'
        : 'partial'

  if (discovered.length === 0 && stats.files_scanned > 0) {
    if (coverage === 'uncovered') {
      hints.push(
        `${ZERO_IMPORTER_HINT_PREFIX}: none of the ${declared.length} declared path(s) is a file this walk can key on — it resolves imports to individual ${DEFAULT_LANG_SUFFIXES} files inside the project root. The importer set is UNAVAILABLE, not empty.`,
      )
    } else if (stats.unresolved_js_specifiers === 0) {
      hints.push(
        `${ZERO_IMPORTER_HINT_PREFIX} across ${stats.files_scanned} scanned files. If you expected importers, check that seed paths use project-relative posix form (e.g., 'src/lib/foo.ts') and that the project does not rely on tsconfig path aliases (not resolved in v1).`,
      )
    }
  }

  if (stats.unresolved_js_specifiers > 0) {
    hints.push(
      `${stats.unresolved_js_specifiers} import statement(s) with a relative .js/.mjs/.cjs specifier resolved to nothing, so this import graph is INCOMPLETE — treat the importer set as a lower bound, never as a complete answer. Candidate causes: NodeNext/ESM style, where TypeScript source imports './x.js' for a file stored as x.ts (v1 does not remap it); a deleted or generated file; a case mismatch on a case-sensitive filesystem.`,
    )
  }
  if (stats.case_inexact_specifiers > 0) {
    const more = stats.case_inexact_specifiers > caseExamples.length ? `, and ${stats.case_inexact_specifiers - caseExamples.length} more` : ''
    hints.push(
      `${stats.case_inexact_specifiers} relative import(s) reach a file only when letter case is ignored, or reach a different file when it is not: ${caseExamples.join('; ')}${more}. Windows and macOS disks usually ignore letter case and Linux disks do not, so this import graph differs between systems. Treat the importer set as a lower bound on every system, and fix the spelling to match the file on disk.`,
    )
  }
  if (stats.parse_errors > 0) {
    hints.push(
      `${stats.parse_errors} file(s) failed to read and were excluded from the import graph.`,
    )
  }
  if (stats.cycles_skipped > 0) {
    hints.push(
      `${stats.cycles_skipped} cycle path(s) skipped where a seed is also an importer of another seed.`,
    )
  }

  return {
    declared,
    discovered,
    by_seed: bySeed,
    stats,
    hints,
    coverage,
    uncovered_seeds: uncoveredSeeds,
  }
}

function listSeeds(seeds: readonly string[]): string {
  const overflow = seeds.length > 10 ? `, and ${seeds.length - 10} more` : ''
  return `${seeds.slice(0, 10).join(', ')}${overflow}`
}

export function coverageHints(result: ReverseDepResult): string[] {
  if (result.coverage === 'not-run') return []

  const lines: string[] = []
  const uncovered = result.uncovered_seeds

  if (uncovered.length > 0) {
    const reached = new Set(result.by_seed.filter((s) => s.count > 0).map((s) => s.seed))
    const found = uncovered.filter((seed) => reached.has(seed))
    const blind = uncovered.filter((seed) => !reached.has(seed))
    const whole =
      result.coverage === 'uncovered' && result.stats.files_scanned > 0 && found.length === 0
        ? ' No declared path is analyzable here, so the breakage category had no import graph to work from.'
        : ''
    const foundText =
      found.length > 0
        ? ` Importers of ${listSeeds(found)} were still found among the files it reads and are listed: a lower bound, since importers in other file types are not read.`
        : ''
    const blindText =
      blind.length === 0
        ? ''
        : found.length === 0
          ? ' For those paths the importer set is UNAVAILABLE, not empty.'
          : ` For ${listSeeds(blind)} the importer set is UNAVAILABLE, not empty.`
    lines.push(
      `${COVERAGE_HINT_PREFIX} ${uncovered.length} of ${result.declared.length} declared path(s) are not files this walk can key on — it resolves imports to individual ${DEFAULT_LANG_SUFFIXES} files inside the project root: ${listSeeds(uncovered)}.${foundText}${blindText}${whole}`,
    )
  }

  if (result.stats.files_scanned === 0) {
    lines.push(
      `${COVERAGE_HINT_PREFIX} 0 files matched the walk's file-type list (${DEFAULT_LANG_SUFFIXES}) under the project root after the default exclusions (node_modules, dist, build, coverage). No import graph was built, so an empty importer set here means UNKNOWN, not clean. Candidate causes: the project is written in another language; its sources sit under an excluded directory; project_root points somewhere unexpected.`,
    )
  }

  return lines
}

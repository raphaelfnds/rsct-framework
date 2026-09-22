import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

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

const DEFAULT_LANG_SUFFIXES = DEFAULT_LANG_GLOBS.map((glob) => glob.slice(glob.lastIndexOf('*') + 1)).join(', ')

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
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
]

export interface ReverseDepInput {
  projectRoot: string
  seedPaths: string[]
  langGlobs?: readonly string[]
  excludeGlobs?: readonly string[]
  maxDepth?: number
}

export interface DiscoveredImporter {
  file: string
  via_paths: string[]
  depth: number
}

export interface ReverseDepStats {
  files_scanned: number
  files_parsed: number
  parse_errors: number
  cycles_skipped: number
  unresolved_js_specifiers: number
}

export type WalkCoverage = | 'analyzed' | 'partial' | 'uncovered' | 'not-run'

export interface ReverseDepResult {
  declared: string[]
  discovered: DiscoveredImporter[]
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

function walkFiles(
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

function diskProbe(projectRoot: string, entries: Map<string, Set<string>>): ResolveProbe {
  const stat = (abs: string): ReturnType<typeof statSync> | null => {
    try {
      return statSync(abs)
    } catch {
      return null
    }
  }
  return {
    exists: (abs) => existsSync(abs),
    isFile: (abs) => stat(abs)?.isFile() ?? false,
    isDirectory: (abs) => stat(abs)?.isDirectory() ?? false,
    hasExactPath: (abs) => hasExactPath(projectRoot, abs, entries),
  }
}

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

  if (probe.isFile(target)) return target

  for (const ext of RESOLVE_EXTENSIONS) {
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
  }

  const notRun = (): ReverseDepResult => ({
    declared,
    discovered: [],
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
    const imports = extractImports(content)
    for (const spec of imports) {
      const resolvedAbs = resolveImport(projectRoot, candidateAbs, spec, directoryEntries)
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

  const discovered = [...discoveredMap.values()].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.file.localeCompare(b.file)
  })

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
    stats,
    hints,
    coverage,
    uncovered_seeds: uncoveredSeeds,
  }
}

export function coverageHints(result: ReverseDepResult): string[] {
  if (result.coverage === 'not-run') return []

  const lines: string[] = []
  const uncovered = result.uncovered_seeds

  if (uncovered.length > 0) {
    const shown = uncovered.slice(0, 10).join(', ')
    const overflow =
      uncovered.length > 10 ? `, and ${uncovered.length - 10} more` : ''

    const whole =
      result.coverage === 'uncovered' && result.stats.files_scanned > 0
        ? ' No declared path is analyzable here, so the breakage category had no import graph to work from.'
        : ''
    lines.push(
      `${COVERAGE_HINT_PREFIX} ${uncovered.length} of ${result.declared.length} declared path(s) are not files this walk can key on — it resolves imports to individual ${DEFAULT_LANG_SUFFIXES} files inside the project root: ${shown}${overflow}. For those paths the importer set is UNAVAILABLE, not empty.${whole}`,
    )
  }

  if (result.stats.files_scanned === 0) {
    lines.push(
      `${COVERAGE_HINT_PREFIX} 0 files matched the walk's file-type list (${DEFAULT_LANG_SUFFIXES}) under the project root after the default exclusions (node_modules, dist, build, coverage). No import graph was built, so an empty importer set here means UNKNOWN, not clean. Candidate causes: the project is written in another language; its sources sit under an excluded directory; project_root points somewhere unexpected.`,
    )
  }

  return lines
}

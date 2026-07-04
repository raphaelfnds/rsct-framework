import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

import { matchesAnyGlob, toPosix } from './phase-scope.js'

/**
 * Reverse-dependency walk for the V phase "possible breakages" check.
 *
 * Given a set of seed files the dev plans to edit, return the files that
 * import them (transitively up to maxDepth). Static-import / CJS-require /
 * dynamic-import / export-from patterns are detected via regex (no AST) —
 * acceptable trade-off for v1 JS/TS coverage. Dynamic-language coverage
 * (Python, Ruby, Go) is deferred to phase 2.
 *
 * Package imports (bare specifiers) are ignored; only relative and absolute
 * file imports are resolved. Path aliases from tsconfig `paths` are NOT
 * resolved in v1 — surfaces as a hint when seeds turn up no importers in
 * a project that obviously uses them.
 */

const DEFAULT_LANG_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
]

const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
]

const DEFAULT_MAX_DEPTH = 2

const RESOLVE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]

const INDEX_RESOLUTIONS: readonly string[] = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
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
}

export interface ReverseDepResult {
  declared: string[]
  discovered: DiscoveredImporter[]
  stats: ReverseDepStats
  hints: string[]
}

function relPosix(projectRoot: string, abs: string): string {
  return toPosix(relative(projectRoot, abs))
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
        // Probe with a virtual child so '**/node_modules/**' matches a node_modules dir
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

function extractImports(content: string): string[] {
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

function resolveImport(importerAbs: string, spec: string): string | null {
  if (!spec.startsWith('.') && !isAbsolute(spec)) return null
  const target = isAbsolute(spec) ? spec : resolvePath(dirname(importerAbs), spec)

  if (existsSync(target)) {
    try {
      const s = statSync(target)
      if (s.isFile()) return target
      if (s.isDirectory()) {
        for (const idx of INDEX_RESOLUTIONS) {
          const candidate = target + idx
          if (existsSync(candidate)) return candidate
        }
      }
    } catch {
      // fall through to extension probing
    }
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = target + ext
    if (existsSync(candidate)) return candidate
  }

  return null
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
  }

  if (declared.length === 0) {
    hints.push('No seed paths provided — reverse-dep walk skipped.')
    return { declared, discovered: [], stats, hints }
  }
  if (!existsSync(projectRoot)) {
    hints.push(
      `projectRoot '${projectRoot}' does not exist — reverse-dep walk skipped.`,
    )
    return { declared, discovered: [], stats, hints }
  }
  if (maxDepth < 1) {
    hints.push(
      `maxDepth=${maxDepth} < 1 — reverse-dep walk has no depth budget; returning declared only.`,
    )
    return { declared, discovered: [], stats, hints }
  }

  const candidates = walkFiles(projectRoot, langGlobs, excludeGlobs)
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
      const resolvedAbs = resolveImport(candidateAbs, spec)
      if (!resolvedAbs) continue
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

  if (discovered.length === 0 && stats.files_scanned > 0) {
    hints.push(
      `Reverse-dep walk found 0 importers across ${stats.files_scanned} scanned files. If you expected importers, check that seed paths use project-relative posix form (e.g., 'src/lib/foo.ts') and that the project does not rely on tsconfig path aliases (not resolved in v1).`,
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

  return { declared, discovered, stats, hints }
}

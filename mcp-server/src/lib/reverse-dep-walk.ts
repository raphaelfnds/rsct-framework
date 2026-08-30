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
 *
 * #54. What the walk CANNOT analyse is reported rather than left silent. An
 * empty importer set has two very different meanings — "nothing depends on
 * this" and "this walk could not look" — and before #54 they were
 * indistinguishable: a Java, Python or Go project scanned zero files and got no
 * hint at all, so the V phase read as clean. {@link WalkCoverage} names which
 * of the two happened, keyed on the declared seeds (their file type, and
 * whether they live inside the scanned root) — never on a path shape, so the
 * verdict cannot differ between Windows, Linux and macOS for one project.
 *
 * Two channels, deliberately: facts about the WALK go into `hints` and reach
 * every caller, while {@link coverageHints} returns V-phase advice that the
 * caller chooses whether to emit. Nothing that `hints` used to say was moved
 * into the gated channel — a phase that emits no advice must still not go
 * silent about a walk that found nothing.
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

/**
 * Human-readable form of {@link DEFAULT_LANG_GLOBS} for hint text.
 *
 * Safe to hard-code against the defaults: `langGlobs` is not reachable through
 * `rsct_phase_verification_start` — its input schema declares no such field and
 * the handler passes only `projectRoot` / `seedPaths` / `maxDepth`. So in
 * production the wording and the verdict are computed from the same list. A
 * future caller that overrides `langGlobs` must revisit this string.
 */
const DEFAULT_LANG_SUFFIXES = '.ts, .tsx, .js, .jsx, .mjs, .cjs'

/**
 * Specifiers that address a file and end in a JS runtime extension. Under
 * NodeNext/ESM, TypeScript source imports `'./x.js'` for a file stored as
 * `x.ts`; v1 does not remap that, so such a specifier resolves to nothing and
 * the import graph comes out empty. Counted, not fixed — see the parked
 * resolver finding in the issue record.
 */
const JS_RUNTIME_SUFFIX = /\.(?:js|mjs|cjs)$/

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
  /**
   * File-addressing specifiers ending `.js` / `.mjs` / `.cjs` that resolved to
   * nothing. Bare package specifiers are excluded — they are rejected by design
   * and are not a defect. A non-zero count on a project with no importers means
   * the resolver was blind, not that nothing depends on the seeds.
   */
  unresolved_js_specifiers: number
}

/**
 * How much of what was ASKED FOR the walk was able to look at.
 *
 * Keyed on the declared seeds, never on `discovered`: `analyzed` means every
 * declared path is inside the corpus this walk scans, NOT that the resolver
 * found every importer of it. Resolver blindness is a separate fact and has its
 * own hint (see `unresolved_js_specifiers`).
 */
export type WalkCoverage =
  /** Every declared seed is one the walk can look for importers of. */
  | 'analyzed'
  /** Some declared seeds are; the rest are listed in `uncovered_seeds`. */
  | 'partial'
  /** No declared seed is. The importer set is unavailable for the whole spec. */
  | 'uncovered'
  /** The walk returned before scanning, so nothing was assessed. */
  | 'not-run'

export interface ReverseDepResult {
  declared: string[]
  discovered: DiscoveredImporter[]
  stats: ReverseDepStats
  hints: string[]
  coverage: WalkCoverage
  /** Declared seeds the walk cannot resolve importers for. */
  uncovered_seeds: string[]
}

/**
 * Prefix every {@link coverageHints} line carries. Tests assert against this
 * symbol rather than a wording substring, so an absence assertion cannot start
 * passing for the wrong reason after a reword.
 */
export const COVERAGE_HINT_PREFIX = 'Reverse-dep coverage:'

/**
 * Prefix of the zero-importer hint. Exported for the same reason as
 * {@link COVERAGE_HINT_PREFIX}: the tests that assert this hint is ABSENT in a
 * given state would otherwise key on a wording substring and start passing for
 * the wrong reason after a reword.
 */
export const ZERO_IMPORTER_HINT_PREFIX = 'Reverse-dep walk found 0 importers'

function relPosix(projectRoot: string, abs: string): string {
  return toPosix(relative(projectRoot, abs))
}

/**
 * Can the walk look for importers of this seed?
 *
 * Two conditions, both on the already-`toPosix`ed project-relative form:
 *
 *  1. It lives inside the scanned root. Both halves of that test are required
 *     for cross-OS parity — on POSIX an out-of-tree path relativizes to
 *     `../…`, while on Windows a DIFFERENT-DRIVE path relativizes to an
 *     absolute `D:/…`. Checking only `../` would hand the same project two
 *     different verdicts on two operating systems, silently.
 *  2. Its file type is one the scan collects, tested against the SAME globs the
 *     scan used — the verdict is language coverage, never a path shape.
 *
 * A seed inside an EXCLUDED directory is still coverable on purpose: the
 * reverse map is keyed by the resolved import target, which need not itself
 * have been scanned, so importers of `dist/x.js` remain discoverable.
 *
 * Exported only so a test can reach the `isAbsolute` half directly: no seed
 * that a POSIX `relative()` can produce is ever absolute, so that clause is
 * unreachable through `walkReverseDeps` on the platform CI runs most.
 */
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
    unresolved_js_specifiers: 0,
  }

  // Every early return below is `not-run`: the walk stopped before it could
  // assess anything, so it must not imply a verdict about the project. In
  // particular `uncovered` ("no declared seed is coverable") must never become
  // vacuously true on an empty seed set — that is why the zero-seed case is
  // the FIRST of these, not a fall-through.
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
  // #54. `existsSync` passes for a FILE, and `readdirSync` then throws ENOTDIR
  // into the swallow in `walkFiles`, producing `files_scanned: 0` byte-identical
  // to a legitimately empty project. Refusing here keeps a bad `project_root`
  // from being reported as "this project has no analyzable files".
  let rootIsDirectory = false
  try {
    rootIsDirectory = statSync(projectRoot).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  if (!rootIsDirectory) {
    // Says "is not a directory", not "is not readable": a directory that exists
    // but cannot be READ passes this guard and lands in the swallowed
    // `readdirSync` failure, which this branch does not address. Claiming
    // otherwise would be the same over-reach the rest of this change removes.
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
      if (!resolvedAbs) {
        // Only a RELATIVE specifier counts. A bare package specifier is
        // rejected on purpose and is not a defect; and an absolute one is
        // excluded deliberately, because `isAbsolute` is platform-bound —
        // `import 'C:/vendor/x.js'` is absolute on win32 and bare on POSIX, so
        // counting it would make this number, and the hint it selects, differ
        // between operating systems for one project.
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
  // `declared.length > 0` is guaranteed — the zero-seed case returned `not-run`.
  const coverage: WalkCoverage =
    uncoveredSeeds.length === 0
      ? 'analyzed'
      : uncoveredSeeds.length === declared.length
        ? 'uncovered'
        : 'partial'

  // #54. This hint used to name two causes unconditionally — seed-path form and
  // tsconfig aliases — and on a polyglot or a NodeNext project BOTH are wrong,
  // sending the dev to fix things that are already correct.
  //
  // The advice is now chosen by cause, and the branch NEVER goes silent: an
  // earlier revision suppressed the hint in the two bad states and emitted the
  // replacement from the tool, which left a tier-skipped V phase — where the
  // tool's advisory is deliberately not emitted — saying nothing at all about a
  // walk that had found nothing. That is worse than a wrong hint, and it is the
  // very failure this issue exists to remove.
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
    // else: the unresolved-specifier hint below carries the explanation, and it
    // is the accurate one.
  }

  // Fires on ANY non-zero count, not only when the graph came out empty. One
  // import that happens to resolve would otherwise hide three hundred that did
  // not, and "nearly empty reads as complete" is the same defect as "empty
  // reads as clean", one notch over.
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

/**
 * Advisory lines for a walk that could not cover what it was asked about.
 * Empty when there is nothing honest to say.
 *
 * Deliberately NOT pushed into `result.hints` by the walk itself: a V phase
 * skipped by tier still runs the walk (`phase-verification-start.ts` calls it
 * before the tier branch), and a phase that verified nothing must not emit an
 * advisory implying it did. The caller gates; this function owns the wording so
 * the two cannot drift into separate copies.
 *
 * Every line states an OBSERVATION and lists candidate causes without picking
 * one. Naming a cause the code never measured is the same failure this whole
 * report exists to remove — one zero has many explanations.
 */
export function coverageHints(result: ReverseDepResult): string[] {
  if (result.coverage === 'not-run') return []

  const lines: string[] = []
  const uncovered = result.uncovered_seeds

  if (uncovered.length > 0) {
    const shown = uncovered.slice(0, 10).join(', ')
    const overflow =
      uncovered.length > 10 ? `, and ${uncovered.length - 10} more` : ''
    // Only when the zero-scan line below will NOT fire — it says the same thing
    // in its own words, and two ~300-character paragraphs repeating each other
    // is how a hint stops being read.
    const whole =
      result.coverage === 'uncovered' && result.stats.files_scanned > 0
        ? ' No declared path is analyzable here, so the breakage category had no import graph to work from.'
        : ''
    // "not files this walk can key on", not "the wrong file type": a DIRECTORY
    // seed, and an ordinary CHANGELOG.md, are both uncoverable, and blaming
    // their file type would misdiagnose the first one.
    lines.push(
      `${COVERAGE_HINT_PREFIX} ${uncovered.length} of ${result.declared.length} declared path(s) are not files this walk can key on — it resolves imports to individual ${DEFAULT_LANG_SUFFIXES} files inside the project root: ${shown}${overflow}. For those paths the importer set is UNAVAILABLE, not empty.${whole}`,
    )
  }

  if (result.stats.files_scanned === 0) {
    lines.push(
      `${COVERAGE_HINT_PREFIX} 0 files matched the walk's file-type list (${DEFAULT_LANG_SUFFIXES}) under the project root after the default exclusions (node_modules, dist, build, coverage). No import graph was built, so an empty importer set here means UNKNOWN, not clean. Candidate causes: the project is written in another language; its sources sit under an excluded directory; project_root points somewhere unexpected.`,
    )
  }

  // Resolver blindness is NOT reported here. It is a fact about the walk, not
  // about the V phase, so it belongs in `hints` where every caller sees it —
  // including a tier-skipped phase that does not emit this advisory at all.

  return lines
}

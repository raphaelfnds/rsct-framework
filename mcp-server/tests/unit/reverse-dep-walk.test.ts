import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COVERAGE_HINT_PREFIX,
  ZERO_IMPORTER_HINT_PREFIX,
  coverageHints,
  seedIsCoverable,
  walkReverseDeps,
} from '../../src/lib/reverse-dep-walk.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-revdep-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('walkReverseDeps — boundary cases', () => {
  it('returns empty discovered with a hint when seedPaths is empty', () => {
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: [] })
    expect(out.declared).toEqual([])
    expect(out.discovered).toEqual([])
    expect(out.hints.some((h) => h.includes('No seed paths provided'))).toBe(true)
  })

  it('returns empty + hint when projectRoot does not exist', () => {
    const out = walkReverseDeps({
      projectRoot: join(tmpRoot, 'does-not-exist'),
      seedPaths: ['src/foo.ts'],
    })
    expect(out.discovered).toEqual([])
    expect(out.hints.some((h) => h.includes('does not exist'))).toBe(true)
  })

  it('returns empty + hint when maxDepth=0', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
      maxDepth: 0,
    })
    expect(out.discovered).toEqual([])
    expect(out.hints.some((h) => h.includes('maxDepth=0 < 1'))).toBe(true)
  })
})

describe('walkReverseDeps — direct importers (depth 1)', () => {
  it('finds a direct ES module importer', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.declared).toEqual(['src/seed.ts'])
    expect(out.discovered).toHaveLength(1)
    expect(out.discovered[0]?.file).toBe('src/importer.ts')
    expect(out.discovered[0]?.depth).toBe(1)
    expect(out.discovered[0]?.via_paths).toEqual([
      'src/seed.ts',
      'src/importer.ts',
    ])
  })

  it('finds a CJS require importer', () => {
    writeFile('src/seed.js', 'module.exports = 1\n')
    writeFile('src/cjs.js', "const x = require('./seed')\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.js'],
    })
    expect(out.discovered.map((d) => d.file)).toContain('src/cjs.js')
  })

  it('finds a dynamic-import importer', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/dyn.ts', "const m = await import('./seed')\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered.map((d) => d.file)).toContain('src/dyn.ts')
  })

  it('finds an export-from re-exporter', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/reexport.ts', "export { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered.map((d) => d.file)).toContain('src/reexport.ts')
  })

  it('finds a side-effect-only importer', () => {
    writeFile('src/seed.ts', 'console.log("loaded")\n')
    writeFile('src/sfx.ts', "import './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered.map((d) => d.file)).toContain('src/sfx.ts')
  })
})

describe('walkReverseDeps — transitive (depth >= 2)', () => {
  it('finds a 2-hop transitive importer at depth 2', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/mid.ts', "import { x } from './seed'\nexport const y = x\n")
    writeFile('src/top.ts', "import { y } from './mid'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    const top = out.discovered.find((d) => d.file === 'src/top.ts')
    const mid = out.discovered.find((d) => d.file === 'src/mid.ts')
    expect(mid?.depth).toBe(1)
    expect(top?.depth).toBe(2)
    expect(top?.via_paths).toEqual(['src/seed.ts', 'src/mid.ts', 'src/top.ts'])
  })

  it('honors maxDepth=1 (does not return depth-2 importers)', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/mid.ts', "import { x } from './seed'\nexport const y = x\n")
    writeFile('src/top.ts', "import { y } from './mid'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
      maxDepth: 1,
    })
    expect(out.discovered.map((d) => d.file)).toEqual(['src/mid.ts'])
  })
})

describe('walkReverseDeps — resolution edge cases', () => {
  it('resolves an extension-less import to the .ts file', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered).toHaveLength(1)
  })

  it('resolves an import of a directory to its index.ts', () => {
    writeFile('src/pkg/index.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './pkg'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/pkg/index.ts'],
    })
    expect(out.discovered.map((d) => d.file)).toContain('src/importer.ts')
  })

  it('ignores bare-specifier (package) imports', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/uses-pkg.ts', "import { z } from 'zod'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered).toHaveLength(0)
  })

  it('skips self-imports without listing the file as its own importer', () => {
    writeFile(
      'src/self.ts',
      "import { x } from './self'\nexport const x = 1\n",
    )
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/self.ts'],
    })
    expect(out.discovered).toHaveLength(0)
  })
})

describe('walkReverseDeps — excludes + scanning', () => {
  it('excludes node_modules by default', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile(
      'node_modules/some-pkg/index.ts',
      "import { x } from '../../src/seed'\n",
    )
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered).toHaveLength(0)
    expect(out.stats.files_scanned).toBe(1)
  })

  it('excludes dist by default', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('dist/built.js', "require('../src/seed')\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.discovered).toHaveLength(0)
  })

  it('honors a custom excludeGlobs list', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('vendor/a.ts', "import { x } from '../src/seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
      excludeGlobs: ['**/vendor/**'],
    })
    expect(out.discovered).toHaveLength(0)
  })

  it('normalizes backslash seed paths to posix', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src\\seed.ts'],
    })
    expect(out.declared).toEqual(['src/seed.ts'])
    expect(out.discovered).toHaveLength(1)
  })
})

/**
 * #54 — coverage reporting.
 *
 * The defect: an empty importer set meant two different things — "nothing
 * depends on this" and "this walk could not look" — and the walk only ever said
 * the first. A Java / Python / Go project scanned zero files and got NO hint at
 * all, so the V phase read as clean.
 *
 * Every test below names the production mutation that turns it red, because a
 * coverage report that cannot fail is a coverage report nobody should trust.
 */
describe('walkReverseDeps — coverage verdict (#54)', () => {
  it('reports uncovered for a project whose declared path is not a JS/TS file', () => {
    // Mutation: make `seedIsCoverable` return true unconditionally.
    writeFile('src/Main.java', 'class Main {}\n')
    writeFile('pom.xml', '<project/>\n')
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/Main.java'],
    })
    expect(out.coverage).toBe('uncovered')
    expect(out.uncovered_seeds).toEqual(['src/Main.java'])
    expect(out.discovered).toEqual([])
  })

  it('reports uncovered for a POLYGLOT project, where one stray JS file makes files_scanned > 0', () => {
    // The shape that killed the first design. A Django / Spring / Rails repo
    // almost always carries a tooling config in JS, so a verdict keyed on
    // `stats.files_scanned === 0` would call this project "analyzed", stay
    // silent, and let the misleading zero-importer hint fire.
    //
    // Mutation: key the verdict on `stats.files_scanned === 0`.
    writeFile('app.py', 'import os\n')
    writeFile('services/billing.py', 'X = 1\n')
    writeFile('tailwind.config.js', 'module.exports = {}\n')
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['app.py'] })
    expect(out.stats.files_scanned).toBe(1)
    expect(out.coverage).toBe('uncovered')
    expect(out.uncovered_seeds).toEqual(['app.py'])
  })

  it('reports analyzed, and says nothing, for an ordinary TS project', () => {
    // Mutation: return 'uncovered' whenever `files_scanned > 0`.
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.coverage).toBe('analyzed')
    expect(out.uncovered_seeds).toEqual([])
    expect(coverageHints(out)).toEqual([])
  })

  it('reports partial when only SOME declared paths are analyzable, and names them', () => {
    // Mutation: collapse 'partial' into 'analyzed'.
    writeFile('src/a.ts', 'export const a = 1\n')
    writeFile('service/Main.java', 'class Main {}\n')
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/a.ts', 'service/Main.java'],
    })
    expect(out.coverage).toBe('partial')
    expect(out.uncovered_seeds).toEqual(['service/Main.java'])
    expect(coverageHints(out).join(' ')).toContain('service/Main.java')
  })

  it('treats a seed resolved OUTSIDE the project root as uncovered', () => {
    // The reverse map is keyed by inside-root relatives, so a '../' key can
    // never be hit — the walk is structurally incapable and used to say it
    // succeeded.
    //
    // Mutation: drop the inside-root half of `seedIsCoverable`.
    //
    // Note: only the '../' half is exercised here. The companion `isAbsolute`
    // half guards a Windows DIFFERENT-DRIVE seed, where `relative()` returns an
    // absolute path — a state no portable fixture can construct.
    writeFile('src/a.ts', 'export const a = 1\n')
    const relOut = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['../outside/x.ts'],
    })
    expect(relOut.coverage).toBe('uncovered')
  })

  it('rejects a seed whose relative form comes out ABSOLUTE', () => {
    // The companion half of the inside-root test, and the reason it is tested
    // directly: no POSIX `relative()` ever returns an absolute path, so this
    // clause is unreachable through `walkReverseDeps` on the platform CI runs
    // most — while on win32 a DIFFERENT-DRIVE seed lands here. Without this the
    // guard is unpinned: deleting `isAbsolute(rel) ||` leaves the suite green.
    //
    // '/abs/x.ts' is absolute under BOTH node:path implementations, so the
    // assertion holds identically on all three operating systems.
    //
    // Mutation: drop `isAbsolute(rel) ||` from `seedIsCoverable`.
    expect(seedIsCoverable('/abs/x.ts')).toBe(false)
    expect(seedIsCoverable('src/a.ts')).toBe(true)
  })

  it('reports not-run — never "uncovered" — on every early return', () => {
    // 'uncovered' means "no declared seed is coverable". On an EMPTY seed set
    // that would be vacuously true, and a healthy TS project passing no
    // declared_paths (the tool's default) would be told its coverage is
    // missing.
    //
    // Mutation: assess the seeds before the early returns.
    writeFile('src/seed.ts', 'export const x = 1\n')
    const noSeeds = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: [] })
    expect(noSeeds.coverage).toBe('not-run')
    expect(coverageHints(noSeeds)).toEqual([])

    const noRoot = walkReverseDeps({
      projectRoot: join(tmpRoot, 'does-not-exist'),
      seedPaths: ['src/seed.ts'],
    })
    expect(noRoot.coverage).toBe('not-run')
    expect(coverageHints(noRoot)).toEqual([])

    const noDepth = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
      maxDepth: 0,
    })
    expect(noDepth.coverage).toBe('not-run')
    expect(coverageHints(noDepth)).toEqual([])
  })

  it('refuses a projectRoot that exists but is a FILE, instead of reporting an empty project', () => {
    // `existsSync` passes for a file; `readdirSync` then throws ENOTDIR into a
    // swallowed catch, and the result is byte-identical to a legitimately empty
    // project — so a wrong project_root used to be reported as "no analyzable
    // files here".
    //
    // Mutation: remove the `statSync().isDirectory()` branch.
    writeFile('not-a-dir.txt', 'hello\n')
    const out = walkReverseDeps({
      projectRoot: join(tmpRoot, 'not-a-dir.txt'),
      seedPaths: ['src/seed.ts'],
    })
    expect(out.coverage).toBe('not-run')
    expect(out.hints.some((h) => h.includes('is not a directory'))).toBe(true)
    expect(coverageHints(out)).toEqual([])
  })

  it('reports the zero-scan observation when the seeds ARE in-language but nothing was scanned', () => {
    // A scaffolded-but-empty repo. The seeds are perfectly analyzable, so the
    // verdict is honestly 'analyzed' — but no graph was built, and silence here
    // is the same "empty reads as clean" one axis over.
    //
    // Mutation: drop the `files_scanned === 0` branch of `coverageHints`.
    writeFile('package.json', '{}\n')
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/server.ts'],
    })
    expect(out.stats.files_scanned).toBe(0)
    expect(out.coverage).toBe('analyzed')
    expect(coverageHints(out).join(' ')).toContain('0 files matched')
  })

  it('never lets a coverage line claim a scan found zero importers', () => {
    // The misdiagnosis this issue exists to remove. Every line must be an
    // observation carrying the shared prefix, never "we looked and found none".
    //
    // Mutation: reword any coverage line into "found 0 importers".
    writeFile('src/Main.java', 'class Main {}\n')
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/Main.java'],
    })
    const lines = coverageHints(out)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.startsWith(COVERAGE_HINT_PREFIX)).toBe(true)
      expect(line).not.toContain('found 0 importers')
    }
  })

  it('suppresses the zero-importer hint when NO declared seed was analyzable', () => {
    // Δ1. On the polyglot root the dev used to read "the importer set is
    // UNAVAILABLE" immediately followed by "check that seed paths use
    // project-relative posix form" — which prescribes the wrong action, since
    // no importer could ever have been found for a .py seed.
    //
    // Mutation: drop the `coverage !== 'uncovered'` guard on that hint.
    writeFile('app.py', 'import os\n')
    writeFile('tailwind.config.js', 'module.exports = {}\n')
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['app.py'] })
    expect(out.stats.files_scanned).toBe(1)
    expect(
      out.hints.some((h) => h.startsWith(ZERO_IMPORTER_HINT_PREFIX)),
    ).toBe(true)
    expect(out.hints.some((h) => h.includes('check that seed paths'))).toBe(
      false,
    )
  })
})

/**
 * #54 — the NodeNext blind spot, REPORTED not fixed.
 *
 * Under `"module": "NodeNext"` TypeScript source imports './x.js' for a file
 * stored as x.ts. `resolveImport` probes 'x.js', then 'x.js.ts', 'x.js.tsx' …
 * and gives up, so the import graph comes out empty. This repository is itself
 * NodeNext, so its own walk finds zero importers of any of its modules.
 *
 * Stage 1 does not change what resolves. It counts the failures and says so,
 * because "0 importers" with a blind resolver is exactly the silence this issue
 * exists to break.
 */
describe('walkReverseDeps — NodeNext specifiers are counted and reported (#54)', () => {
  it('counts unresolved .js specifiers and names the real cause', () => {
    // Mutation: drop the counter increment, or the `coverageHints` branch that
    // reads it.
    writeFile('src/b.ts', 'export const b = 1\n')
    writeFile('src/a.ts', "import { b } from './b.js'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/b.ts'],
    })
    expect(out.discovered).toEqual([])
    expect(out.stats.unresolved_js_specifiers).toBe(1)
    // In `hints`, not in `coverageHints`: it is a fact about the walk, so every
    // caller must see it — including a tier-skipped phase, which emits no
    // advisory at all.
    expect(out.hints.join(' ')).toContain('NodeNext')
  })

  it('suppresses the zero-importer hint when the resolver is the cause', () => {
    // That hint names two causes — seed-path form and tsconfig aliases — and on
    // a NodeNext project BOTH are wrong.
    //
    // Mutation: drop the `unresolved_js_specifiers === 0` guard on that hint.
    writeFile('src/b.ts', 'export const b = 1\n')
    writeFile('src/a.ts', "import { b } from './b.js'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/b.ts'],
    })
    expect(out.hints.some((h) => h.includes('check that seed paths'))).toBe(
      false,
    )
  })

  it('does NOT count a bare package specifier that happens to end in .js', () => {
    // Bare specifiers are rejected by design, not by defect — counting them
    // would blame the resolver for working correctly.
    //
    // Mutation: count before the relative/absolute specifier guard.
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/uses-pkg.ts', "import 'lodash/fp/map.js'\n")
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/seed.ts'],
    })
    expect(out.stats.unresolved_js_specifiers).toBe(0)
  })
})

describe('walkReverseDeps — multiple seeds + dedup', () => {
  it('deduplicates a shared importer of two seeds (single discovered entry)', () => {
    writeFile('src/a.ts', 'export const a = 1\n')
    writeFile('src/b.ts', 'export const b = 2\n')
    writeFile(
      'src/both.ts',
      "import { a } from './a'\nimport { b } from './b'\n",
    )
    const out = walkReverseDeps({
      projectRoot: tmpRoot,
      seedPaths: ['src/a.ts', 'src/b.ts'],
    })
    const both = out.discovered.filter((d) => d.file === 'src/both.ts')
    expect(both).toHaveLength(1)
  })
})

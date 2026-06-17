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

import { walkReverseDeps } from '../../src/lib/reverse-dep-walk.js'

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

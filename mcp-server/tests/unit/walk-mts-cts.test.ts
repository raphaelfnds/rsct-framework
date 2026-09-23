import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_LANG_GLOBS, coverageHints, seedIsCoverable, walkReverseDeps } from '../../src/lib/reverse-dep-walk.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-mts-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('the walk covers .mts and .cts (#101 Part A)', () => {
  it('finds an importer written as .mts', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.mts', "import { x } from './seed.js'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.ts'] })
    expect(out.discovered.map((d) => d.file)).toContain('src/importer.mts')
  })

  it('finds an importer written as .cts', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/importer.cts', "import { x } from './seed.js'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.ts'] })
    expect(out.discovered.map((d) => d.file)).toContain('src/importer.cts')
  })

  it('calls a .mts seed coverable, so importers and coverage cannot disagree', () => {
    expect(seedIsCoverable('src/thing.mts')).toBe(true)
    expect(seedIsCoverable('src/thing.cts')).toBe(true)
  })

  it('resolves a NodeNext .mjs specifier to its .mts source', () => {
    writeFile('src/seed.mts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed.mjs'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.mts'] })
    expect(out.discovered.map((d) => d.file)).toContain('src/importer.ts')
    expect(out.stats.unresolved_js_specifiers).toBe(0)
  })

  it('resolves a NodeNext .cjs specifier to its .cts source', () => {
    writeFile('src/seed.cts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './seed.cjs'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.cts'] })
    expect(out.discovered.map((d) => d.file)).toContain('src/importer.ts')
    expect(out.stats.unresolved_js_specifiers).toBe(0)
  })

  it('resolves a .mjs specifier case-exactly per segment, as ADR-016 requires', () => {
    writeFile('src/Sub/seed.mts', 'export const x = 1\n')
    writeFile('src/importer.ts', "import { x } from './sub/seed.mjs'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/Sub/seed.mts'] })
    expect(out.discovered.map((d) => d.file)).not.toContain('src/importer.ts')
  })

  it('names every scanned suffix in the coverage hint, derived from the scan list itself', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/thing.py'] })
    const hint = coverageHints(out).join(' ')
    for (const glob of DEFAULT_LANG_GLOBS) {
      expect(hint).toContain(glob.slice(glob.lastIndexOf('*') + 1))
    }
    expect(hint).toContain('.mts')
    expect(hint).toContain('.cts')
  })

  it('resolves an extensionless specifier to the file before a same-named directory index, as TypeScript and Node do', () => {
    writeFile('src/utils.ts', 'export const x = 1\n')
    writeFile('src/utils/index.ts', 'export const y = 1\n')
    writeFile('src/importer.ts', "import { x } from './utils'\n")
    expect(walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/utils.ts'] }).discovered.map((d) => d.file)).toContain('src/importer.ts')
    expect(walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/utils/index.ts'] }).discovered.map((d) => d.file)).not.toContain('src/importer.ts')
  })

  it('resolves "./utils/", "." and ".." to the directory index even beside a same-named file', () => {
    writeFile('src/utils.ts', 'export const x = 1\n')
    writeFile('src/utils/index.ts', 'export const y = 1\n')
    writeFile('src/importer.ts', "import { y } from './utils/'\n")
    writeFile('src/utils/inner.ts', "import { y } from '.'\n")
    writeFile('src/utils/deep/leaf.ts', "import { y } from '..'\n")
    const files = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/utils/index.ts'] }).discovered.map((d) => d.file)
    expect(files).toEqual(expect.arrayContaining(['src/importer.ts', 'src/utils/inner.ts', 'src/utils/deep/leaf.ts']))
  })

  it('finds an importer whose import braces hold a comment with a quote in it', () => {
    writeFile('src/seed.ts', 'export const used = 1\nexport const other = 2\n')
    writeFile('src/importer.ts', "import {\n  used, // it's the one we need\n  other,\n} from './seed.js'\n")
    writeFile('src/barrel.ts', "export {\n  used, // it's re-exported\n} from './seed.js'\n")
    const files = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.ts'] }).discovered.map((d) => d.file)
    expect(files).toEqual(expect.arrayContaining(['src/importer.ts', 'src/barrel.ts']))
  })

  it('scans a .mts file for its own imports, not only as a target', () => {
    writeFile('src/seed.ts', 'export const x = 1\n')
    writeFile('src/mid.mts', "import { x } from './seed.js'\nexport const y = x\n")
    writeFile('src/top.ts', "import { y } from './mid.mjs'\n")
    const out = walkReverseDeps({ projectRoot: tmpRoot, seedPaths: ['src/seed.ts'], maxDepth: 2 })
    const files = out.discovered.map((d) => d.file)
    expect(files).toContain('src/mid.mts')
    expect(files).toContain('src/top.ts')
  })
})

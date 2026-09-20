import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ENTRYPOINT_HINT_PREFIX,
  PUBLIC_API_HINT_PREFIX,
  UNREADABLE_HINT_PREFIX,
  clearSymbolScanCache,
  findDeadSymbols,
  languageOf,
  symbolScanCacheSize,
} from '../../src/lib/dead-code/references.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-dead-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function importerOf(...paths: string[]): string {
  writeFile('entry.ts', paths.map((p) => `import './${p.replace(/\.tsx?$/, '.js')}'`).join('\n') + '\n')
  return 'entry.ts'
}

async function deadNames(corpus: string[], targets: string[], publicApi?: string[]): Promise<string[]> {
  const result = await findDeadSymbols({
    projectRoot: tmpRoot,
    corpus,
    targets,
    ...(publicApi ? { publicApi } : {}),
  })
  return result.dead.map((d) => d.name).sort()
}

describe('languageOf', () => {
  it('maps the NodeNext suffixes onto the grammars that parse them', () => {
    expect(languageOf('a.mts')).toBe('typescript')
    expect(languageOf('a.cts')).toBe('typescript')
    expect(languageOf('a.tsx')).toBe('tsx')
    expect(languageOf('a.mjs')).toBe('javascript')
    expect(languageOf('a.py')).toBeNull()
    expect(languageOf('Makefile')).toBeNull()
  })
})

describe('findDeadSymbols — the basic predicate', () => {
  it('reports a symbol nothing references', async () => {
    writeFile('a.ts', 'export function orphan(): void {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['orphan'])
  })

  it('does NOT report a symbol used inside its own file, when the user is itself alive', async () => {
    writeFile('a.ts', 'function helper(): number { return 1 }\nexport const total = helper()\n')
    writeFile('b.ts', "import { total } from './a.js'\nexport const run = () => total\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })

  it('reports an export nothing imports, and the private helper that only it used', async () => {
    writeFile('a.ts', 'function helper(): number { return 1 }\nexport const total = helper()\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['helper', 'total'])
  })

  it('does NOT report a symbol another file imports and uses', async () => {
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })

  it('DOES report a symbol imported but never used — an unused import is not a use', async () => {
    writeFile('a.ts', 'export function ghost(): void {}\n')
    writeFile('b.ts', "import { ghost } from './a.js'\nexport const unrelated = 1\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual(['ghost'])
  })

  it('follows an alias, so a renamed import still counts as a use', async () => {
    writeFile('a.ts', 'export function real(): void {}\n')
    writeFile('b.ts', "import { real as alias } from './a.js'\nexport const run = () => alias()\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })

  it('counts a namespace member access as a use', async () => {
    writeFile('a.ts', 'export function member(): void {}\n')
    writeFile('b.ts', "import * as ns from './a.js'\nexport const run = () => ns.member()\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })

  it('does not let a same-named symbol in an unrelated file keep it alive', async () => {
    writeFile('a.ts', 'export function walk(): void {}\n')
    writeFile('b.ts', 'function walk(): void {}\nexport const run = () => walk()\n')
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['walk'])
  })

  it('does not count a mention inside a comment or a string', async () => {
    writeFile('a.ts', 'export function ghost(): void {}\n')
    writeFile('b.ts', '// ghost is discussed here\nexport const label = "ghost"\n')
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['ghost'])
  })
})

describe('findDeadSymbols — re-export chains', () => {
  it('follows a star re-export, however long the chain', async () => {
    writeFile('deep.ts', 'export function deepThing(): void {}\n')
    writeFile('mid.ts', "export * from './deep.js'\n")
    writeFile('barrel.ts', "export * from './mid.js'\n")
    writeFile('user.ts', "import { deepThing } from './barrel.js'\nexport const run = () => deepThing()\n")
    expect(await deadNames(['deep.ts', 'mid.ts', 'barrel.ts', 'user.ts'], ['deep.ts'])).toEqual([])
  })

  it('still reports a symbol a barrel re-exports that nobody imports', async () => {
    writeFile('deep.ts', 'export function unusedThing(): void {}\n')
    writeFile('barrel.ts', "export * from './deep.js'\n")
    expect(await deadNames(['deep.ts', 'barrel.ts'], ['deep.ts'])).toEqual(['unusedThing'])
  })
})

describe('findDeadSymbols — dead chains resolve to a fixed point', () => {
  it('reports a callee whose only caller is itself dead', async () => {
    writeFile('a.ts', 'function callee(): void {}\nfunction caller(): void { callee() }\n')
    expect(await deadNames(['a.ts'], ['a.ts'])).toEqual(['callee', 'caller'])
  })

  it('reports a three-link dead chain in one pass of the API', async () => {
    writeFile('a.ts', 'function third(): void {}\nfunction second(): void { third() }\nfunction first(): void { second() }\n')
    expect(await deadNames(['a.ts'], ['a.ts'])).toEqual(['first', 'second', 'third'])
  })

  it('keeps the whole chain alive when its head is reachable', async () => {
    writeFile('a.ts', 'function third(): void {}\nfunction second(): void { third() }\nexport function first(): void { second() }\n')
    writeFile('b.ts', "import { first } from './a.js'\nexport const run = () => first()\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })
})

describe('findDeadSymbols — what it refuses to claim', () => {
  it('returns unknown, not dead, when an unreadable file can reach the symbol', async () => {
    writeFile('a.ts', 'export function maybe(): void {}\n')
    writeFile('broken.ts', "import { maybe } from './a.js'\nfunction oops( {\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'broken.ts'], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['maybe'])
    expect(result.unreadable).toContain('broken.ts')
  })

  it('still reports dead symbols an unreadable file cannot reach', async () => {
    writeFile('a.ts', 'export function faraway(): void {}\n')
    writeFile('other.ts', 'export const x = 1\n')
    writeFile('broken.ts', "import { x } from './other.js'\nfunction oops( {\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'other.ts', 'broken.ts', importerOf('a.ts')],
      targets: ['a.ts'],
    })
    expect(result.dead.map((s) => s.name)).toEqual(['faraway'])
    expect(result.unknown).toEqual([])
  })

  it('treats a file in a language it cannot parse as unreadable rather than as evidence', async () => {
    writeFile('a.ts', 'export function fromPython(): void {}\n')
    writeFile('caller.py', 'import a\na.fromPython()\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'caller.py'], targets: ['a.ts'] })
    expect(result.unreadable).toContain('caller.py')
  })
})

describe('findDeadSymbols — declared public surface', () => {
  it('never reports an exported symbol of a public path', async () => {
    writeFile('api.ts', 'export function publicThing(): void {}\n')
    expect(await deadNames(['api.ts'], ['api.ts'], ['api.ts'])).toEqual([])
  })

  it('still reports a NON-exported symbol inside a public path', async () => {
    writeFile('api.ts', 'function privateHelper(): void {}\nexport function publicThing(): void {}\n')
    expect(await deadNames(['api.ts'], ['api.ts'], ['api.ts'])).toEqual(['privateHelper'])
  })

  it('accepts a glob, spanning whole segments as ADR-015 requires', async () => {
    writeFile('src/public/a.ts', 'export function exposed(): void {}\n')
    writeFile('src/deep/nested/b.ts', 'export function alsoExposed(): void {}\n')
    writeFile('src/internal/c.ts', 'export function hidden(): void {}\n')
    const corpus = ['src/public/a.ts', 'src/deep/nested/b.ts', 'src/internal/c.ts']
    const entry = importerOf('src/public/a.ts', 'src/deep/nested/b.ts', 'src/internal/c.ts')
    expect(await deadNames([...corpus, entry], corpus, ['src/public/**', '**/nested/**'])).toEqual(['hidden'])
  })

  it('reports everything exported when no public surface is declared', async () => {
    writeFile('api.ts', 'export function publicThing(): void {}\n')
    expect(await deadNames(['api.ts', importerOf('api.ts')], ['api.ts'])).toEqual(['publicThing'])
  })

  it('does not treat an empty declaration as a match-everything', async () => {
    writeFile('api.ts', 'export function publicThing(): void {}\n')
    expect(await deadNames(['api.ts', importerOf('api.ts')], ['api.ts'], [])).toEqual(['publicThing'])
  })
})

describe('findDeadSymbols — types are out of scope unless asked for', () => {
  it('does not report an unreferenced type by default', async () => {
    writeFile('a.ts', 'export type Unused = string\nexport interface AlsoUnused { x: string }\n')
    expect(await deadNames(['a.ts'], ['a.ts'])).toEqual([])
  })

  it('reports the same type when includeTypes is asked for', async () => {
    writeFile('a.ts', 'export type Unused = string\nexport interface AlsoUnused { x: string }\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
      includeTypes: true,
    })
    expect(result.dead.map((d) => d.name).sort()).toEqual(['AlsoUnused', 'Unused'])
  })

  it('still reports an unreferenced value while types are excluded', async () => {
    writeFile('a.ts', 'export type Unused = string\nexport function alsoDead(): void {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['alsoDead'])
  })
})

describe('findDeadSymbols — it says what it could not see', () => {
  it('warns that no public surface is declared when an export is reported dead', async () => {
    writeFile('a.ts', 'export function exposed(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
    })
    expect(result.hints.some((h) => h.startsWith(PUBLIC_API_HINT_PREFIX))).toBe(true)
  })

  it('stays quiet about the public surface once one is declared', async () => {
    writeFile('a.ts', 'export function exposed(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
      publicApi: ['other/**'],
    })
    expect(result.hints.some((h) => h.startsWith(PUBLIC_API_HINT_PREFIX))).toBe(false)
  })

  it('stays quiet when only a non-exported symbol is reported', async () => {
    writeFile('a.ts', 'function hidden(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts'], targets: ['a.ts'] })
    expect(result.dead.map((d) => d.name)).toEqual(['hidden'])
    expect(result.hints.some((h) => h.startsWith(PUBLIC_API_HINT_PREFIX))).toBe(false)
  })

  it('names the unreadable files when it withheld a verdict', async () => {
    writeFile('a.ts', 'export function maybe(): void {}\n')
    writeFile('broken.ts', "import { maybe } from './a.js'\nfunction oops( {\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'broken.ts', importerOf('a.ts')],
      targets: ['a.ts'],
    })
    const hint = result.hints.find((h) => h.startsWith(UNREADABLE_HINT_PREFIX))
    expect(hint).toBeDefined()
    expect(hint).toContain('broken.ts')
  })

  it('emits no withheld-verdict hint when everything was readable', async () => {
    writeFile('a.ts', 'export function exposed(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
    })
    expect(result.hints.some((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toBe(false)
  })
})

describe('findDeadSymbols — a file nobody imports cannot be told from an entrypoint', () => {
  it('leaves its exports unknown rather than calling them dead', async () => {
    writeFile('entry.ts', 'export function looksOrphaned(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['entry.ts'], targets: ['entry.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['looksOrphaned'])
  })

  it('names the file and says why in a hint', async () => {
    writeFile('entry.ts', 'export function looksOrphaned(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['entry.ts'], targets: ['entry.ts'] })
    const hint = result.hints.find((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))
    expect(hint).toBeDefined()
    expect(hint).toContain('entry.ts')
  })

  it('STILL reports a non-exported symbol there — only exports are unattributable', async () => {
    writeFile('entry.ts', 'function privateDead(): void {}\nexport function looksOrphaned(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['entry.ts'], targets: ['entry.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['privateDead'])
  })

  it('judges the exports once any file imports it, even for side effects', async () => {
    writeFile('a.ts', 'export function nowJudged(): void {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['nowJudged'])
  })
})

describe('the parse cache — the commit gate runs this check twice', () => {
  it('reuses a parse for identical content instead of re-parsing', async () => {
    clearSymbolScanCache()
    expect(symbolScanCacheSize()).toBe(0)
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    const corpus = ['a.ts', 'b.ts', importerOf('a.ts')]
    await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })
    const afterFirst = symbolScanCacheSize()
    expect(afterFirst).toBe(3)
    await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })
    expect(symbolScanCacheSize()).toBe(afterFirst)
  })

  it('does not serve a stale parse after the content changes', async () => {
    clearSymbolScanCache()
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    const corpus = ['a.ts', 'b.ts', importerOf('a.ts')]
    expect((await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })).dead).toEqual([])
    writeFile('a.ts', 'export function used(): void {}\nexport function fresh(): void {}\n')
    const second = await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })
    expect(second.dead.map((d) => d.name)).toEqual(['fresh'])
  })
})

describe('findDeadSymbols — scope', () => {
  it('judges only the target files, while reading the whole corpus as evidence', async () => {
    writeFile('target.ts', 'export function judged(): void {}\n')
    writeFile('elsewhere.ts', 'export function notJudged(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['target.ts', 'elsewhere.ts', importerOf('target.ts', 'elsewhere.ts')],
      targets: ['target.ts'],
    })
    expect(result.dead.map((s) => s.name)).toEqual(['judged'])
    expect(result.filesScanned).toBe(3)
  })
})

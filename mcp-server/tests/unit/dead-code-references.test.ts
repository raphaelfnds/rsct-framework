import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEPENDENT_HINT_PREFIX,
  DUAL_MODE_HINT_PREFIX,
  DYNAMIC_HINT_PREFIX,
  ENTRYPOINT_HINT_PREFIX,
  ESCAPED_HINT_PREFIX,
  EVAL_HINT_PREFIX,
  NESTED_HINT_PREFIX,
  PUBLIC_API_HINT_PREFIX,
  PUBLIC_EXEMPTED_HINT_PREFIX,
  SCRIPT_HINT_PREFIX,
  TYPE_CHECK_HINT_PREFIX,
  UNBOUND_HINT_PREFIX,
  UNPARSEABLE_TARGET_HINT_PREFIX,
  UNREADABLE_HINT_PREFIX,
  clearSymbolScanCache,
  corpusFrom,
  findDeadSymbols,
  languageOf,
  limitParseSizeForTests,
  limitSymbolScanCacheForTests,
  symbolScanCacheSize,
  symbolScanMisses,
  workingTreeReader,
  type SourceReader,
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
    writeFile('a.ts', 'function helper(): number { return 1 }\nexport const total = (): number => helper()\n')
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

describe('findDeadSymbols — default exports', () => {
  it('counts a default import as a use of the default-exported symbol', async () => {
    writeFile('a.ts', 'export default function sized(): number { return 1 }\n')
    writeFile('b.ts', "import sized from './a.js'\nexport const run = () => sized()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('counts it under whatever local name the importer chose', async () => {
    writeFile('a.ts', 'export default function sized(): number { return 1 }\n')
    writeFile('b.ts', "import renamed from './a.js'\nexport const run = () => renamed()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('still reports the default export when the importer never uses the binding', async () => {
    writeFile('a.ts', 'export default function sized(): number { return 1 }\n')
    writeFile('b.ts', "import sized from './a.js'\nexport const unrelated = 1\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['sized'])
  })

  it('does not let a default import stand in for a NAMED symbol of the same module', async () => {
    writeFile('a.ts', 'export default function first(): void {}\nexport function second(): void {}\n')
    writeFile('b.ts', "import first from './a.js'\nexport const run = () => first()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['second'])
  })

  it('handles a default-exported class', async () => {
    writeFile('a.ts', 'export default class Holder {}\n')
    writeFile('b.ts', "import Holder from './a.js'\nexport const run = () => new Holder()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
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

  it('leaves unknown a symbol a barrel re-exports when nothing imports the barrel', async () => {
    writeFile('deep.ts', 'export function unusedThing(): void {}\n')
    writeFile('barrel.ts', "export * from './deep.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['deep.ts', 'barrel.ts'], targets: ['deep.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['unusedThing'])
  })

  it('reports a symbol a barrel re-exports when the barrel is imported but the symbol is not', async () => {
    writeFile('deep.ts', 'export function unusedThing(): void {}\nexport function usedThing(): void {}\n')
    writeFile('barrel.ts', "export * from './deep.js'\n")
    writeFile('user.ts', "import { usedThing } from './barrel.js'\nexport const go = () => usedThing()\n")
    expect(await deadNames(['deep.ts', 'barrel.ts', 'user.ts'], ['deep.ts'])).toEqual(['unusedThing'])
  })
})

describe('findDeadSymbols — dead chains resolve to a fixed point', () => {
  it('reports a callee whose only caller is itself dead', async () => {
    writeFile('a.ts', 'function callee(): void {}\nfunction caller(): void { callee() }\nexport {}\n')
    expect(await deadNames(['a.ts'], ['a.ts'])).toEqual(['callee', 'caller'])
  })

  it('reports a three-link dead chain in one pass of the API', async () => {
    writeFile('a.ts', 'function third(): void {}\nfunction second(): void { third() }\nfunction first(): void { second() }\nexport {}\n')
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

  it('never puts a file in another language in the corpus, so it can be neither evidence nor unreadable', () => {
    expect(corpusFrom(['a.ts', 'caller.py', 'Comp.vue'])).toEqual(['a.ts', 'Comp.vue'])
  })

  it('leaves out vendored code and build output at a package root, and nothing else', () => {
    const known = [
      'a.ts',
      'node_modules/x/index.js',
      'dist/bundle.js',
      'packages/p/package.json',
      'packages/p/dist/y.js',
      'packages/p/coverage/lcov.js',
      'src/commands/build/run.ts',
      'src/dist-tools/z.ts',
    ]
    expect(corpusFrom(known)).toEqual(['a.ts', 'src/commands/build/run.ts', 'src/dist-tools/z.ts'])
  })
})

describe('findDeadSymbols — declared public surface', () => {
  it('never reports an exported symbol of a public path', async () => {
    writeFile('api.ts', 'export function publicThing(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['api.ts', importerOf('api.ts')], targets: ['api.ts'], publicApi: ['api.ts'] })
    expect(result.dead).toEqual([])
    expect(result.publicExempted.map((s) => s.name)).toEqual(['publicThing'])
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
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
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
    writeFile('a.ts', 'function hidden(): void {}\nexport {}\n')
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

  it('leaves a private helper that only an entrypoint export uses unknown too, and says why', async () => {
    writeFile('entry.ts', 'function helper(): void {}\nexport function main(): void { helper() }\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['entry.ts'], targets: ['entry.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name).sort()).toEqual(['helper', 'main'])
    const hint = result.hints.find((h) => h.startsWith(DEPENDENT_HINT_PREFIX))
    expect(hint).toContain('entry.ts:helper')
  })

  it('judges the exports once any file imports it, even for side effects', async () => {
    writeFile('a.ts', 'export function nowJudged(): void {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['nowJudged'])
  })
})

describe('findDeadSymbols — re-exports are followed by name, not only by star', () => {
  it('keeps a symbol alive when it is used through a named re-export', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "export { publicThing } from './impl.js'\n")
    writeFile('consumer.ts', "import { publicThing } from './index.js'\nexport const go = () => publicThing()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual([])
  })

  it('follows an aliased named re-export', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "export { publicThing as renamed } from './impl.js'\n")
    writeFile('consumer.ts', "import { renamed } from './index.js'\nexport const go = () => renamed()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual([])
  })

  it('follows a chain of named re-exports to the end', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('mid.ts', "export { publicThing as middle } from './impl.js'\n")
    writeFile('index.ts', "export { middle as outer } from './mid.js'\n")
    writeFile('consumer.ts', "import { outer } from './index.js'\nexport const go = () => outer()\n")
    expect(await deadNames(['impl.ts', 'mid.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual([])
  })

  it('follows `export * as ns from` into a member access', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\nexport function unusedThing(): void {}\n')
    writeFile('index.ts', "export * as ns from './impl.js'\n")
    writeFile('consumer.ts', "import { ns } from './index.js'\nexport const go = () => ns.publicThing()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual(['unusedThing'])
  })

  it('follows a re-export of an imported binding', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "import { publicThing } from './impl.js'\nexport { publicThing }\n")
    writeFile('consumer.ts', "import { publicThing } from './index.js'\nexport const go = () => publicThing()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual([])
  })

  it('reports a re-exported imported binding that nobody imports from the barrel', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "import { publicThing } from './impl.js'\nexport { publicThing }\n")
    writeFile('consumer.ts', "import './index.js'\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual(['publicThing'])
  })

  it('does not let `export *` pass the default export along, as the language does not', async () => {
    writeFile('impl.ts', 'export default function thing(): void {}\n')
    writeFile('barrel.ts', "export * from './impl.js'\n")
    writeFile('consumer.ts', "import thing from './barrel.js'\nexport const go = () => thing()\n")
    writeFile('entry.ts', "import './impl.js'\n")
    expect(await deadNames(['impl.ts', 'barrel.ts', 'consumer.ts', 'entry.ts'], ['impl.ts'])).toEqual(['thing'])
  })

  it('follows `export { default as X } from`', async () => {
    writeFile('impl.ts', 'export default function thing(): void {}\n')
    writeFile('index.ts', "export { default as Thing } from './impl.js'\n")
    writeFile('consumer.ts', "import { Thing } from './index.js'\nexport const go = () => Thing()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual([])
  })

  it('still reports a symbol the barrel re-exports by name when the importer never asks for it', async () => {
    writeFile('impl.ts', 'export function wanted(): void {}\nexport function unwanted(): void {}\n')
    writeFile('index.ts', "export { wanted, unwanted } from './impl.js'\n")
    writeFile('consumer.ts', "import { wanted } from './index.js'\nexport const go = () => wanted()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual(['unwanted'])
  })

  it('leaves a symbol exposed only through an unimported barrel unknown, not dead', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "export { publicThing } from './impl.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'index.ts'], targets: ['impl.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['publicThing'])
  })

  it('honours public_api declared on the barrel, which is what the hint tells you to do', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "export { publicThing } from './impl.js'\n")
    writeFile('consumer.ts', "import './index.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['impl.ts', 'index.ts', 'consumer.ts'],
      targets: ['impl.ts'],
      publicApi: ['index.ts'],
    })
    expect(result.dead).toEqual([])
    expect(result.publicExempted.map((s) => s.name)).toEqual(['publicThing'])
  })
})

describe('findDeadSymbols — liveness is reachability from a real use', () => {
  it('reports a function whose only caller is itself', async () => {
    writeFile('a.ts', 'export function rotting(n: number): number { return n > 0 ? rotting(n - 1) : 0 }\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['rotting'])
  })

  it('reports two functions that only call each other', async () => {
    writeFile('a.ts', 'function ping(n: number): number { return n > 0 ? pong(n - 1) : 0 }\nfunction pong(n: number): number { return ping(n) }\nexport {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['ping', 'pong'])
  })

  it('keeps a recursive function alive when something real calls it', async () => {
    writeFile('a.ts', 'export function walk(n: number): number { return n > 0 ? walk(n - 1) : 0 }\n')
    writeFile('b.ts', "import { walk } from './a.js'\nexport const go = () => walk(3)\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })
})

describe('findDeadSymbols — a local binding does not keep a top-level symbol alive', () => {
  it('reports a helper whose name is only reused as a parameter', async () => {
    writeFile('a.ts', 'function deadHelper(): void {}\nexport function live(deadHelper: number): number { return deadHelper }\n')
    writeFile('b.ts', "import { live } from './a.js'\nexport const go = () => live(1)\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['deadHelper'])
  })
})

describe('findDeadSymbols — each declarator is judged on its own', () => {
  it('does not accuse the function that feeds a used declarator in a shared statement', async () => {
    writeFile('a.ts', 'function compute(): number { return 1 }\nexport const unusedThing = 0, used = compute()\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const go = () => used\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['unusedThing'])
  })
})

describe('findDeadSymbols — exports declared away from the declaration', () => {
  it('reports a symbol exported by a bare clause that nobody imports', async () => {
    writeFile('a.ts', 'function rotting(): void {}\nexport { rotting }\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['rotting'])
  })

  it('keeps it alive when a consumer imports it under the clause alias', async () => {
    writeFile('a.ts', 'function inner(): void {}\nexport { inner as outer }\n')
    writeFile('b.ts', "import { outer } from './a.js'\nexport const go = () => outer()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('keeps `export default name` alive through a default import', async () => {
    writeFile('a.ts', 'function inner(): void {}\nexport default inner\n')
    writeFile('b.ts', "import dflt from './a.js'\nexport const go = () => dflt()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('reports an overload whose implementation nobody calls', async () => {
    writeFile('a.ts', 'export function f(a: string): void\nexport function f(a: unknown): void {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['f'])
  })
})

describe('findDeadSymbols — dynamic imports withhold rather than guess', () => {
  it('leaves the exports of a dynamically imported module unknown, and says why', async () => {
    writeFile('a.ts', 'export function lazyThing(): void {}\n')
    writeFile('b.ts', "export async function go(): Promise<void> { const m = await import('./a.js'); m.lazyThing() }\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', importerOf('b.ts')], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['lazyThing'])
    expect(result.hints.some((h) => h.startsWith(DYNAMIC_HINT_PREFIX))).toBe(true)
  })

  it('treats require() of a relative module the same way', async () => {
    writeFile('a.ts', 'export function lazyThing(): void {}\n')
    writeFile('b.ts', "const m = require('./a.js')\nexport const go = () => m.lazyThing()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', importerOf('b.ts')], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['lazyThing'])
  })

  it('still reports a PRIVATE dead symbol of a dynamically imported module', async () => {
    writeFile('a.ts', 'function privateDead(): void {}\nexport function lazyThing(): void {}\n')
    writeFile('b.ts', "export async function go(): Promise<void> { await import('./a.js') }\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', importerOf('b.ts')], targets: ['a.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['privateDead'])
  })
})

describe('findDeadSymbols — what an unreadable file can and cannot reach', () => {
  it('does not let an unreadable importer hide a PRIVATE dead symbol', async () => {
    writeFile('a.ts', 'function privateDead(): void {}\nexport function maybe(): void {}\n')
    writeFile('broken.ts', "import { maybe } from './a.js'\nfunction oops( {\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'broken.ts', importerOf('a.ts')], targets: ['a.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['privateDead'])
    expect(result.unknown.map((s) => s.name)).toEqual(['maybe'])
  })

  it('honours the imports of a .vue component it does not parse', async () => {
    writeFile('a.ts', 'export function helper(): void {}\n')
    writeFile('Comp.vue', "<script setup lang=\"ts\">\nimport { helper } from './a.js'\nhelper()\n</script>\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'Comp.vue', importerOf('a.ts')], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['helper'])
  })
})

describe('findDeadSymbols — where the bytes come from', () => {
  function reader(files: Record<string, string>): SourceReader {
    return (rel) => (rel in files ? { kind: 'text', text: files[rel] ?? '' } : { kind: 'absent' })
  }

  it('reads through the supplied reader, never the disk', async () => {
    writeFile('a.ts', 'export function onDisk(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'entry.ts'],
      targets: ['a.ts'],
      read: reader({ 'a.ts': 'export function inIndex(): void {}\n', 'entry.ts': "import './a.js'\n" }),
    })
    expect(result.dead.map((s) => s.name)).toEqual(['inIndex'])
  })

  it('counts a use the reader supplies even when the disk disagrees', async () => {
    writeFile('a.ts', 'export function ghost(): void {}\n')
    writeFile('b.ts', 'export const unrelated = 1\n')
    writeFile('entry.ts', "import './a.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'b.ts', 'entry.ts'],
      targets: ['a.ts'],
      read: reader({
        'a.ts': 'export function ghost(): void {}\n',
        'b.ts': "import { ghost } from './a.js'\nexport const g = () => ghost()\n",
        'entry.ts': "import './a.js'\n",
      }),
    })
    expect(result.dead).toEqual([])
  })

  it('skips a path the reader reports absent', async () => {
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'gone.ts', 'entry.ts'],
      targets: ['a.ts'],
      read: reader({ 'a.ts': 'export function orphan(): void {}\n', 'entry.ts': "import './a.js'\n" }),
    })
    expect(result.dead.map((s) => s.name)).toEqual(['orphan'])
    expect(result.unreadable).toEqual([])
  })

  it('withholds every verdict when a file cannot be read for another reason, and says so', async () => {
    const files: Record<string, string> = { 'a.ts': 'export function orphan(): void {}\n', 'entry.ts': "import './a.js'\n" }
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'locked.ts', 'entry.ts'],
      targets: ['a.ts'],
      read: (rel) => (rel === 'locked.ts' ? { kind: 'error' } : rel in files ? { kind: 'text', text: files[rel] ?? '' } : { kind: 'absent' }),
    })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['orphan'])
    expect(result.unreadable).toContain('locked.ts')
    expect(result.hints.some((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toBe(true)
  })
})

describe('findDeadSymbols — names are matched exactly', () => {
  it('keeps only the member actually used through a namespace import', async () => {
    writeFile('a.ts', 'export function alpha(): void {}\nexport function beta(): void {}\n')
    writeFile('b.ts', "import * as ns from './a.js'\nexport const go = () => ns.alpha()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['beta'])
  })

  it('does not let an import of one name keep another alive', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function other(): void {}\n')
    writeFile('b.ts', "import { other } from './a.js'\nexport const go = () => other()\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['used'])
  })

  it('maps an upper-case extension onto its grammar', () => {
    expect(languageOf('A.TS')).toBe('typescript')
    expect(languageOf('B.MJS')).toBe('javascript')
  })
})

describe('findDeadSymbols — resolution the way the bundler does it', () => {
  it('resolves a directory import to its index file', async () => {
    writeFile('lib/index.ts', 'export function fromIndex(): void {}\n')
    writeFile('b.ts', "import { fromIndex } from './lib'\nexport const go = () => fromIndex()\n")
    writeFile('entry.ts', "import './lib/index.js'\n")
    expect(await deadNames(['lib/index.ts', 'b.ts', 'entry.ts'], ['lib/index.ts'])).toEqual([])
  })

  it('resolves a directory import to an index.mts', async () => {
    writeFile('lib/index.mts', 'export function fromIndex(): void {}\n')
    writeFile('b.ts', "import { fromIndex } from './lib'\nexport const go = () => fromIndex()\n")
    writeFile('entry.ts', "import './lib/index.mjs'\n")
    expect(await deadNames(['lib/index.mts', 'b.ts', 'entry.ts'], ['lib/index.mts'])).toEqual([])
  })

  it('resolves an extensionless import to a .cts file', async () => {
    writeFile('mod.cts', 'export function fromCts(): void {}\n')
    writeFile('b.ts', "import { fromCts } from './mod'\nexport const go = () => fromCts()\n")
    writeFile('entry.ts', "import './mod.cjs'\n")
    expect(await deadNames(['mod.cts', 'b.ts', 'entry.ts'], ['mod.cts'])).toEqual([])
  })

  it('leaves unknown, on every operating system, what only a wrongly-cased import names', async () => {
    writeFile('Widget.ts', 'export function widget(): void {}\nexport function unusedWidget(): void {}\n')
    writeFile('b.ts', "import { widget } from './widget.js'\nexport const go = () => widget()\n")
    writeFile('entry.ts', "import './Widget.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['Widget.ts', 'b.ts', 'entry.ts'], targets: ['Widget.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['unusedWidget'])
    expect(result.unknown.map((s) => s.name)).toEqual(['widget'])
  })

  it('does the same beside a correctly-cased import of the same file', async () => {
    writeFile('src/utils.ts', 'export function other(): void {}\nexport function helper(): void {}\n')
    writeFile('src/a.ts', "import { other } from './utils'\nother()\n")
    writeFile('src/main.ts', "import { helper } from './Utils'\nhelper()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['src/utils.ts', 'src/a.ts', 'src/main.ts'], targets: ['src/utils.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['helper'])
  })

  it('leaves unknown what a wrongly-cased import of a package directory names', async () => {
    writeFile('lib/package.json', '{ "main": "./entry.ts" }\n')
    writeFile('lib/entry.ts', 'export function widget(): void {}\nexport function unusedWidget(): void {}\n')
    writeFile('b.ts', "import { widget } from './Lib'\nexport const go = () => widget()\n")
    writeFile('main.ts', "import './lib/entry.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['lib/entry.ts', 'b.ts', 'main.ts'],
      configs: ['lib/package.json'],
      targets: ['lib/entry.ts'],
    })
    expect(result.dead.map((s) => s.name)).toEqual(['unusedWidget'])
    expect(result.unknown.map((s) => s.name)).toEqual(['widget'])
  })

  it('covers every file a wrongly-cased import could mean', async () => {
    writeFile('src/utils.spec.ts', "import './utils.js'\n")
    writeFile('src/utils.ts', 'export function helper(): void {}\nexport function unusedHelper(): void {}\n')
    writeFile('src/main.ts', "import { helper } from './UTILS'\nhelper()\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['src/utils.spec.ts', 'src/utils.ts', 'src/main.ts'],
      targets: ['src/utils.ts'],
    })
    expect(result.dead.map((s) => s.name)).toEqual(['unusedHelper'])
    expect(result.unknown.map((s) => s.name)).toEqual(['helper'])
  })

  it('does not let an import of a directory that resolves nowhere blanket what is inside it', async () => {
    writeFile('src/one.ts', 'export function oneDead(): void {}\n')
    writeFile('src/two.ts', 'export function twoDead(): void {}\n')
    writeFile('src/decoy.ts', "import * as z from './'\nexport const x = z\n")
    writeFile('src/entry.ts', "import './one.js'\nimport './two.js'\nimport './decoy.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['src/one.ts', 'src/two.ts', 'src/decoy.ts', 'src/entry.ts'],
      targets: ['src/one.ts', 'src/two.ts'],
    })
    expect(result.dead.map((s) => s.name).sort()).toEqual(['oneDead', 'twoDead'])
  })

  it('leaves judged a sibling whose path merely starts with the one a wrongly-cased import names', async () => {
    writeFile('a.ts', 'export function widget(): void {}\n')
    writeFile('a.tsx', 'export function widget(): void {}\n')
    writeFile('b.ts', "import { widget } from './A'\nexport const go = () => widget()\n")
    writeFile('entry.ts', "import './a.js'\nimport './a.tsx'\nimport './b.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'a.tsx', 'b.ts', 'entry.ts'],
      targets: ['a.tsx'],
    })
    expect(result.dead.map((s) => s.name)).toEqual(['widget'])
  })

  it('does not let a wrongly-cased directory import reach a file named after the directory', async () => {
    writeFile('src.ts', 'export function besideTheDirectory(): void {}\n')
    writeFile('src/one.ts', 'export function inside(): void {}\n')
    writeFile('decoy.ts', "import * as z from './SRC/'\nexport const x = z\n")
    writeFile('entry.ts', "import './src.js'\nimport './src/one.js'\nimport './decoy.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['src.ts', 'src/one.ts', 'decoy.ts', 'entry.ts'],
      targets: ['src.ts', 'src/one.ts'],
    })
    expect(result.dead.map((s) => s.name).sort()).toEqual(['besideTheDirectory', 'inside'])
  })

  it('leaves unknown a wrongly-cased import of a style module written in TypeScript', async () => {
    writeFile('styles.css.ts', 'export const container = 1\nexport const unusedStyle = 2\n')
    writeFile('b.ts', "import { container } from './Styles.css'\nexport const go = () => container\n")
    writeFile('main.ts', "import './styles.css'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['styles.css.ts', 'b.ts', 'main.ts'], targets: ['styles.css.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['unusedStyle'])
    expect(result.unknown.map((s) => s.name)).toEqual(['container'])
  })
})

describe('findDeadSymbols — robustness', () => {
  it('ignores an import that resolves outside the project root', async () => {
    writeFile('a.ts', "import { x } from '../outside.js'\nexport function f(): unknown { return x }\n")
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['f'])
  })

  it('terminates on barrels that re-export each other', async () => {
    writeFile('a.ts', "export * from './b.js'\nexport function inA(): void {}\n")
    writeFile('b.ts', "export * from './a.js'\n")
    writeFile('consumer.ts', "import { inA } from './b.js'\nexport const go = () => inA()\n")
    expect(await deadNames(['a.ts', 'b.ts', 'consumer.ts'], ['a.ts'])).toEqual([])
  })
})

describe('findDeadSymbols — a public_api exemption is reported, never silent', () => {
  it('lists every export public_api exempted, and hints how many', async () => {
    writeFile('a.ts', 'export function exposedOne(): void {}\nexport function exposedTwo(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
      publicApi: ['**/*'],
    })
    expect(result.dead).toEqual([])
    expect(result.publicExempted.map((s) => s.name).sort()).toEqual(['exposedOne', 'exposedTwo'])
    expect(result.hints.some((h) => h.startsWith(PUBLIC_EXEMPTED_HINT_PREFIX))).toBe(true)
  })

  it('does not report an exemption when public_api covers nothing under review', async () => {
    writeFile('a.ts', 'export function exposed(): void {}\n')
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', importerOf('a.ts')],
      targets: ['a.ts'],
      publicApi: ['other/**'],
    })
    expect(result.publicExempted).toEqual([])
    expect(result.hints.some((h) => h.startsWith(PUBLIC_EXEMPTED_HINT_PREFIX))).toBe(false)
  })
})

describe('the parse cache — the commit gate runs this check twice', () => {
  it('reuses a parse for identical content instead of re-parsing', async () => {
    clearSymbolScanCache()
    expect(symbolScanCacheSize()).toBe(0)
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    const corpus = ['a.ts', 'b.ts', importerOf('a.ts')]
    const missesBefore = symbolScanMisses()
    await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })
    const afterFirst = symbolScanCacheSize()
    const missesAfterFirst = symbolScanMisses()
    expect(missesAfterFirst - missesBefore).toBe(3)
    expect(afterFirst).toBe(3)
    await findDeadSymbols({ projectRoot: tmpRoot, corpus, targets: ['a.ts'] })
    expect(symbolScanCacheSize()).toBe(afterFirst)
    expect(symbolScanMisses()).toBe(missesAfterFirst)
  })

  it('evicts one entry at the limit instead of dropping the whole cache', async () => {
    clearSymbolScanCache()
    limitSymbolScanCacheForTests(2)
    try {
      writeFile('a.ts', 'export const a = 1\n')
      writeFile('b.ts', 'export const b = 1\n')
      writeFile('c.ts', 'export const c = 1\n')
      await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', 'c.ts'], targets: [] })
      expect(symbolScanCacheSize()).toBe(2)
    } finally {
      limitSymbolScanCacheForTests(null)
      clearSymbolScanCache()
    }
  })

  it('keeps what fits when a check reads more files than the cache holds, instead of re-parsing all of them', async () => {
    clearSymbolScanCache()
    limitSymbolScanCacheForTests(2)
    try {
      writeFile('a.ts', 'export const a = 1\n')
      writeFile('b.ts', 'export const b = 1\n')
      writeFile('c.ts', 'export const c = 1\n')
      const input = { projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', 'c.ts'], targets: [] }
      await findDeadSymbols(input)
      for (let round = 0; round < 2; round++) {
        const before = symbolScanMisses()
        await findDeadSymbols(input)
        expect(symbolScanMisses() - before).toBe(1)
      }
    } finally {
      limitSymbolScanCacheForTests(null)
      clearSymbolScanCache()
    }
  })

  it('gives the place of a parse no check uses any more to a new one', async () => {
    clearSymbolScanCache()
    limitSymbolScanCacheForTests(2)
    try {
      writeFile('a.ts', 'export const a = 1\n')
      writeFile('b.ts', 'export const b = 1\n')
      const input = { projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts'], targets: [] }
      await findDeadSymbols(input)
      writeFile('a.ts', 'export const a = 2\n')
      const before = symbolScanMisses()
      await findDeadSymbols(input)
      expect(symbolScanMisses() - before).toBe(1)
      await findDeadSymbols(input)
      expect(symbolScanMisses() - before).toBe(1)
    } finally {
      limitSymbolScanCacheForTests(null)
      clearSymbolScanCache()
    }
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

describe('findDeadSymbols — a namespace used as a value leaves every export unknown', () => {
  const cases: Array<[string, string]> = [
    ['passed to a call', "import * as schema from './a.js'\nexport const db = connect(schema)\n"],
    ['read with a computed key', "import * as schema from './a.js'\nexport const pick = (k: 'users') => schema[k]\n"],
    ['destructured', "import * as schema from './a.js'\nconst { users } = schema\nexport const u = users\n"],
    ['spread', "import * as schema from './a.js'\nexport const all = { ...schema }\n"],
    ['through `import m = require()`', "import schema = require('./a')\nexport const db = connect(schema)\n"],
  ]
  for (const [label, consumer] of cases) {
    it(`when it is ${label}`, async () => {
      writeFile('a.ts', 'export const users = 1\nexport const posts = 2\n')
      writeFile('b.ts', consumer)
      const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts'], targets: ['a.ts'] })
      expect(result.dead).toEqual([])
      expect(result.unknown.map((s) => s.name).sort()).toEqual(['posts', 'users'])
      expect(result.hints.find((h) => h.startsWith(ESCAPED_HINT_PREFIX))).toContain('b.ts')
    })
  }

  it('does not let a member of another object keep a namespace member alive', async () => {
    writeFile('a.ts', 'export function alpha(): void {}\nexport function beta(): void {}\n')
    writeFile('b.ts', "import * as ns from './a.js'\nconst other = { beta: 1 }\nexport const go = () => { ns.alpha(); return other.beta }\n")
    expect(await deadNames(['a.ts', 'b.ts', importerOf('b.ts')], ['a.ts'])).toEqual(['beta'])
  })
})

describe('findDeadSymbols — a declaration that runs code when the module loads is never dead', () => {
  it('keeps a server whose only use is inside its own callback, and the app it listens on', async () => {
    writeFile(
      'a.ts',
      'declare function createApp(): { listen(port: number, ready: () => void): { address(): unknown } }\nconst app = createApp()\nconst server = app.listen(3000, () => server.address())\nexport {}\n',
    )
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('keeps a timer that clears itself', async () => {
    writeFile('a.ts', 'const timer = setInterval(() => clearInterval(timer), 1000)\nexport {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('still reports a plain constant nothing uses', async () => {
    writeFile('a.ts', 'const unused = 1\nexport {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['unused'])
  })
})

describe('findDeadSymbols — a classic script shares its top level with every other script', () => {
  it('leaves the top-level symbols of a script unknown, and says why', async () => {
    writeFile('a.js', 'function helper() {}\nvar counter = 0\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.js'], targets: ['a.js'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name).sort()).toEqual(['counter', 'helper'])
    expect(result.hints.find((h) => h.startsWith(SCRIPT_HINT_PREFIX))).toContain('a.js')
  })

  it('still judges a module', async () => {
    writeFile('a.js', 'function helper() {}\nexport {}\n')
    expect(await deadNames(['a.js'], ['a.js'])).toEqual(['helper'])
  })

  it('reads .mjs and .cjs as modules even with no import or export', async () => {
    writeFile('a.mjs', 'function helper() {}\n')
    writeFile('b.cjs', 'function other() {}\n')
    expect(await deadNames(['a.mjs', 'b.cjs'], ['a.mjs', 'b.cjs'])).toEqual(['helper', 'other'])
  })
})

describe('findDeadSymbols — a file too large to parse', () => {
  it('is read only for its imports, and named when it is a target', async () => {
    limitParseSizeForTests(200)
    try {
      writeFile('big.ts', `export function bigHelper(): void {}\nexport const pad = '${'x'.repeat(300)}'\n`)
      writeFile('a.ts', 'export function used(): void {}\n')
      writeFile('huge.ts', `import { used } from './a.js'\nused()\nexport const pad = '${'y'.repeat(300)}'\n`)
      writeFile('entry.ts', "import './big.js'\nimport './a.js'\n")
      const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['big.ts', 'a.ts', 'huge.ts', 'entry.ts'], targets: ['big.ts', 'a.ts'] })
      expect(result.dead).toEqual([])
      expect(result.unknown.map((s) => s.name)).toEqual(['used'])
      expect(result.hints.find((h) => h.startsWith(UNPARSEABLE_TARGET_HINT_PREFIX))).toContain('big.ts')
    } finally {
      limitParseSizeForTests(null)
    }
  })
})

describe('findDeadSymbols — a file that also runs as a plain script (developer decision 2026-09-23)', () => {
  it('keeps what it exports alive, judges the rest, and says a page could reach it', async () => {
    writeFile('umd.js', "var root = typeof module !== 'undefined' ? module : null\nfunction rotting() {}\nmodule.exports = { root }\n")
    writeFile('entry.ts', "import './umd.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['umd.js', 'entry.ts'], targets: ['umd.js'] })
    expect(result.dead.map((s) => s.name)).toEqual(['rotting'])
    expect(result.unknown).toEqual([])
    expect(result.hints.find((h) => h.startsWith(DUAL_MODE_HINT_PREFIX))).toContain('umd.js')
  })

  it('says nothing about a script tag for a CommonJS file with no such guard', async () => {
    writeFile('plain.js', 'var root = null\nfunction rotting() {}\nmodule.exports = { root }\n')
    writeFile('entry.ts', "import './plain.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['plain.js', 'entry.ts'], targets: ['plain.js'] })
    expect(result.dead.map((s) => s.name)).toEqual(['rotting'])
    expect(result.hints.some((h) => h.startsWith(DUAL_MODE_HINT_PREFIX))).toBe(false)
  })
})

describe('findDeadSymbols — the size cap this release ships', () => {
  it('counts the bytes, so a file of multi-byte text over 2 MB is not parsed', async () => {
    writeFile('big.ts', `export const note = '${'á'.repeat(1_100_000)}'\nexport function bigHelper(): void {}\n`)
    writeFile('entry.ts', "import './big.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['big.ts', 'entry.ts'], targets: ['big.ts'] })
    expect(result.oversized).toEqual(['big.ts'])
    expect(result.dead).toEqual([])
  })
})

describe('findDeadSymbols — a type check written as a declaration (developer decision 2026-09-22)', () => {
  it('leaves `const _name: Type = value` unknown with a hint, and still reports an unannotated alias', async () => {
    writeFile('s.ts', 'export const schema = 1\n')
    writeFile('a.ts', "import { schema } from './s.js'\ntype Tree = number\nconst _sameTree: Tree = schema\nconst _alias = schema\nexport {}\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['s.ts', 'a.ts', importerOf('a.ts')], targets: ['a.ts'] })
    expect(result.dead.map((s) => s.name)).toEqual(['_alias'])
    expect(result.unknown.map((s) => s.name)).toEqual(['_sameTree'])
    expect(result.hints.find((h) => h.startsWith(TYPE_CHECK_HINT_PREFIX))).toContain('a.ts:_sameTree')
  })
})

describe('findDeadSymbols — a direct eval can reach any binding of its module', () => {
  it('leaves every symbol of that file unknown, and says why', async () => {
    writeFile('a.ts', "function helper(): void {}\neval('helper()')\nexport {}\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts'], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['helper'])
    expect(result.hints.find((h) => h.startsWith(EVAL_HINT_PREFIX))).toContain('a.ts')
  })
})

describe('findDeadSymbols — a value and a type may share a name', () => {
  it('does not report a value its same-named type is built from', async () => {
    writeFile('a.ts', "const Status = { on: 1, off: 0 } as const\nexport type Status = (typeof Status)[keyof typeof Status]\n")
    writeFile('b.ts', "import type { Status } from './a.js'\nexport const s: Status = 1\n")
    expect(await deadNames(['a.ts', 'b.ts'], ['a.ts'])).toEqual([])
  })
})

describe('findDeadSymbols — a namespace inside a namespace', () => {
  it('leaves the symbol unknown with a hint of its own, and names no unreadable file', async () => {
    writeFile('impl.ts', 'export function a(): void {}\n')
    writeFile('mid.ts', "export * as inner from './impl.js'\n")
    writeFile('top.ts', "export * as outer from './mid.js'\n")
    writeFile('consumer.ts', "import { outer } from './top.js'\nexport const go = () => outer.inner.a()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'mid.ts', 'top.ts', 'consumer.ts', importerOf('consumer.ts')], targets: ['impl.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['a'])
    expect(result.hints.some((h) => h.startsWith(NESTED_HINT_PREFIX))).toBe(true)
    expect(result.hints.some((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toBe(false)
  })

  it('does the same through a namespace import', async () => {
    writeFile('impl.ts', 'export function a(): void {}\n')
    writeFile('mid.ts', "export * as inner from './impl.js'\n")
    writeFile('consumer.ts', "import * as ns from './mid.js'\nexport const go = () => ns.inner.a()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'mid.ts', 'consumer.ts'], targets: ['impl.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['a'])
  })

  it('and through a re-exported namespace binding', async () => {
    writeFile('impl.ts', 'export function a(): void {}\n')
    writeFile('mid.ts', "export * as inner from './impl.js'\n")
    writeFile('index.ts', "import * as m from './mid.js'\nexport { m }\n")
    writeFile('consumer.ts', "import { m } from './index.js'\nexport const go = () => m.inner.a()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'mid.ts', 'index.ts', 'consumer.ts'], targets: ['impl.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['a'])
  })
})

describe('findDeadSymbols — public_api is read relative to the project root', () => {
  it('matches a glob written relative to a project root below the repository root', async () => {
    writeFile('pkg/src/index.ts', 'export function publicThing(): void {}\n')
    writeFile('pkg/entry.ts', "import './src/index.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['pkg/src/index.ts', 'pkg/entry.ts'],
      targets: ['pkg/src/index.ts'],
      publicApi: ['src/index.ts'],
      publicApiPrefix: 'pkg/',
    })
    expect(result.dead).toEqual([])
    expect(result.publicExempted.map((s) => s.name)).toEqual(['publicThing'])
  })

  it('still matches a glob written relative to the repository root', async () => {
    writeFile('pkg/src/index.ts', 'export function publicThing(): void {}\n')
    writeFile('pkg/entry.ts', "import './src/index.js'\n")
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['pkg/src/index.ts', 'pkg/entry.ts'],
      targets: ['pkg/src/index.ts'],
      publicApi: ['pkg/src/index.ts'],
      publicApiPrefix: 'pkg/',
    })
    expect(result.dead).toEqual([])
  })
})

describe('findDeadSymbols — what it cannot parse is said out loud', () => {
  it('names a target the grammar could not read', async () => {
    writeFile('a.ts', 'export interface Box<in T> { v: T }\nfunction helper(): void {}\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', importerOf('a.ts')], targets: ['a.ts'] })
    expect(result.hints.find((h) => h.startsWith(UNPARSEABLE_TARGET_HINT_PREFIX))).toContain('a.ts')
  })

  it('names the unparseable importer that made it withhold a verdict', async () => {
    writeFile('a.ts', 'export function maybe(): void {}\n')
    writeFile('broken.ts', "import { maybe } from './a.js'\nfunction oops( {\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'broken.ts'], targets: ['a.ts'] })
    expect(result.hints.find((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toContain('broken.ts')
  })

  it('withholds every export when an unparseable file holds a computed import', async () => {
    writeFile('x/y.ts', 'export const z = 1\n')
    writeFile('broken.ts', 'export const load = (n: string) => import(`./x/${n}`)\nfunction oops( {\n')
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['x/y.ts', 'broken.ts', importerOf('x/y.ts')], targets: ['x/y.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['z'])
    expect(result.hints.find((h) => h.startsWith(UNBOUND_HINT_PREFIX))).toContain('broken.ts')
  })

  it('counts every withheld symbol when a file cannot be read, and adds no dependent hint', async () => {
    const files: Record<string, string> = { 'a.ts': 'export function one(): void {}\nexport function two(): void {}\n', 'entry.ts': "import './a.js'\n" }
    const result = await findDeadSymbols({
      projectRoot: tmpRoot,
      corpus: ['a.ts', 'locked.ts', 'entry.ts'],
      targets: ['a.ts'],
      read: (rel) => (rel === 'locked.ts' ? { kind: 'error' } : rel in files ? { kind: 'text', text: files[rel] ?? '' } : { kind: 'absent' }),
    })
    expect(result.hints.find((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toContain('on 2 symbol(s)')
    expect(result.hints.some((h) => h.startsWith(DEPENDENT_HINT_PREFIX))).toBe(false)
  })

  it('names only the file nothing imports in the entrypoint hint', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\n')
    writeFile('index.ts', "export { publicThing } from './impl.js'\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'index.ts'], targets: ['impl.ts'] })
    const hint = result.hints.find((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))
    expect(hint).toContain('index.ts')
    expect(hint).not.toContain('impl.ts')
  })
})

describe('findDeadSymbols — forms the first REVIEW left unpinned, end to end', () => {
  it('keeps alive a symbol used only through a shorthand property', async () => {
    writeFile('a.ts', 'export function helper(): void {}\n')
    writeFile('b.ts', "import { helper } from './a.js'\nexport const table = { helper }\n")
    writeFile('c.ts', "import { table } from './b.js'\ntable.helper()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', 'c.ts'], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('keeps alive a class used only in a type position', async () => {
    writeFile('a.ts', 'export class Holder { x = 1 }\n')
    writeFile('b.ts', "import { Holder } from './a.js'\nexport function take(h: Holder): number { return h.x }\n")
    writeFile('c.ts', "import { take } from './b.js'\ntake({ x: 1 })\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', 'c.ts'], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('judges abstract classes and generators', async () => {
    writeFile('a.ts', 'export abstract class Base {}\nexport function* gen(): Generator<number> { yield 1 }\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual(['Base', 'gen'])
  })

  it('follows `import * as ns; export { ns }` into ns.member', async () => {
    writeFile('impl.ts', 'export function publicThing(): void {}\nexport function unusedThing(): void {}\n')
    writeFile('index.ts', "import * as ns from './impl.js'\nexport { ns }\n")
    writeFile('consumer.ts', "import { ns } from './index.js'\nns.publicThing()\n")
    expect(await deadNames(['impl.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual(['unusedThing'])
  })

  it('follows `import { a }; export { a as b }` under the new name', async () => {
    writeFile('impl.ts', 'export function a(): void {}\n')
    writeFile('index.ts', "import { a } from './impl.js'\nexport { a as b }\n")
    writeFile('consumer.ts', "import { b } from './index.js'\nb()\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['impl.ts', 'index.ts', 'consumer.ts'], targets: ['impl.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('keeps member precision for a namespace re-exported by name', async () => {
    writeFile('impl.ts', 'export function a(): void {}\nexport function b(): void {}\n')
    writeFile('mid.ts', "export * as ns from './impl.js'\n")
    writeFile('index.ts', "export { ns } from './mid.js'\n")
    writeFile('consumer.ts', "import { ns } from './index.js'\nns.a()\n")
    expect(await deadNames(['impl.ts', 'mid.ts', 'index.ts', 'consumer.ts'], ['impl.ts'])).toEqual(['b'])
  })

  it('treats a call through a parameter named require as a dynamic import, so its target is withheld', async () => {
    writeFile('a.ts', 'export function lonely(): void {}\n')
    writeFile('b.ts', "export function load(require: (s: string) => unknown): unknown { return require('./a.js') }\n")
    const result = await findDeadSymbols({ projectRoot: tmpRoot, corpus: ['a.ts', 'b.ts', importerOf('a.ts', 'b.ts')], targets: ['a.ts'] })
    expect(result.dead).toEqual([])
    expect(result.unknown.map((s) => s.name)).toEqual(['lonely'])
  })

  it('does not let a parameter named require with a computed target withhold the whole project', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    writeFile('loader.ts', 'export function load(require: (s: string) => unknown, name: string): unknown { return require(name) }\n')
    writeFile('main.ts', "import { run } from './b.js'\nimport { load } from './loader.js'\nrun()\nload(() => 1, 'x')\n")
    expect(await deadNames(['a.ts', 'b.ts', 'loader.ts', 'main.ts'], ['a.ts'])).toEqual(['rotting'])
  })

  it('reads a call written right after a declaration, with no separator, as a top-level use', async () => {
    writeFile('a.ts', 'function helper(): void {}helper()\nexport {}\n')
    expect(await deadNames(['a.ts', importerOf('a.ts')], ['a.ts'])).toEqual([])
  })

  it('classifies a failed read that is not an absence as an error', () => {
    const read = workingTreeReader(tmpRoot)
    expect(read('missing.ts').kind).toBe('absent')
    expect(read('bad\u0000name.ts').kind).toBe('error')
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
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UNBOUND_HINT_PREFIX,
  UNRESOLVED_HINT_PREFIX,
  findDeadSymbols,
  type DeadCodeResult,
} from '../../src/lib/dead-code/references.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-resolve-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

async function scan(corpus: string[], targets: string[], configs: string[] = []): Promise<DeadCodeResult> {
  return findDeadSymbols({ projectRoot: tmpRoot, corpus, targets, configs })
}

function names(symbols: ReadonlyArray<{ name: string }>): string[] {
  return symbols.map((s) => s.name).sort()
}

const ALIASED = 'export function viaAlias(): void {}\nexport function other(): void {}\n'

describe('module resolution — tsconfig and jsconfig', () => {
  it('follows a "paths" alias to the file it names, so what it does not import is still judged', async () => {
    writeFile(
      'tsconfig.json',
      '{\n  "$schema": "https://json.schemastore.org/tsconfig",\n  // aliases\n  "compilerOptions": {\n    /* root */ "baseUrl": ".",\n    "paths": { "@/*": ["src/*"], },\n  },\n}\n',
    )
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from '@/lib/x'\nviaAlias()\n")
    const result = await scan(['src/lib/x.ts', 'src/app.ts'], ['src/lib/x.ts'], ['tsconfig.json'])
    expect(names(result.dead)).toEqual(['other'])
    expect(result.unknown).toEqual([])
  })

  it('resolves "paths" against the config directory when no baseUrl is set', async () => {
    writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "~lib/*": ["./src/lib/*"] } } }\n')
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from '~lib/x'\nviaAlias()\n")
    expect(names((await scan(['src/lib/x.ts', 'src/app.ts'], ['src/lib/x.ts'], ['tsconfig.json'])).dead)).toEqual(['other'])
  })

  it('reads "paths" from the config the nearest one extends', async () => {
    writeFile('tsconfig.base.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n')
    writeFile('packages/app/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }\n')
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('packages/app/main.ts', "import { viaAlias } from '@/lib/x'\nviaAlias()\n")
    const result = await scan(['src/lib/x.ts', 'packages/app/main.ts'], ['src/lib/x.ts'], ['tsconfig.base.json', 'packages/app/tsconfig.json'])
    expect(names(result.dead)).toEqual(['other'])
  })

  it('resolves a bare specifier against baseUrl', async () => {
    writeFile('jsconfig.json', '{ "compilerOptions": { "baseUrl": "src" } }\n')
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from 'lib/x'\nviaAlias()\n")
    expect(names((await scan(['src/lib/x.ts', 'src/app.ts'], ['src/lib/x.ts'], ['jsconfig.json'])).dead)).toEqual(['other'])
  })

  it('picks the most specific "paths" pattern, whatever order they are written in', async () => {
    writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "@/lib/*": ["./vendor-lib/*"] } } }\n')
    writeFile('vendor-lib/x.ts', ALIASED)
    writeFile('src/lib/x.ts', 'export function viaAlias(): void {}\n')
    writeFile('src/app.ts', "import { viaAlias } from '@/lib/x'\nviaAlias()\n")
    writeFile('entry.ts', "import './src/lib/x.js'\n")
    const result = await scan(['vendor-lib/x.ts', 'src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['vendor-lib/x.ts', 'src/lib/x.ts'], ['tsconfig.json'])
    expect(result.dead.map((s) => `${s.path}:${s.name}`).sort()).toEqual(['src/lib/x.ts:viaAlias', 'vendor-lib/x.ts:other'])
  })

  it('counts the JSX factory the config names as used by every file with JSX', async () => {
    writeFile('tsconfig.json', '{ "compilerOptions": { "jsx": "react", "jsxFactory": "h" } }\n')
    writeFile('src/jsx.ts', 'export function h(): void {}\nexport function unusedHelper(): void {}\n')
    writeFile('src/view.tsx', "import { h } from './jsx.js'\nexport const view = <div />\n")
    writeFile('entry.ts', "import './src/view.js'\n")
    const result = await scan(['src/jsx.ts', 'src/view.tsx', 'entry.ts'], ['src/jsx.ts'], ['tsconfig.json'])
    expect(names(result.dead)).toEqual(['unusedHelper'])
  })

  it('reads "paths" from a config the nearest one references', async () => {
    writeFile('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n')
    writeFile('tsconfig.app.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n')
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from '@/lib/x'\nviaAlias()\n")
    const result = await scan(['src/lib/x.ts', 'src/app.ts'], ['src/lib/x.ts'], ['tsconfig.json', 'tsconfig.app.json'])
    expect(names(result.dead)).toEqual(['other'])
  })
})

describe('module resolution — what it cannot resolve is unknown, never dead', () => {
  it('leaves unknown an export a bundler alias imports by name, and names the import it could not follow', async () => {
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from '@/lib/x'\nviaAlias()\n")
    writeFile('entry.ts', "import './src/lib/x.js'\n")
    const result = await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])
    expect(names(result.dead)).toEqual(['other'])
    expect(names(result.unknown)).toEqual(['viaAlias'])
    const hint = result.hints.find((h) => h.startsWith(UNRESOLVED_HINT_PREFIX))
    expect(hint).toContain('@/lib/x')
  })

  it('does not rescue a name through an unresolved import whose binding nobody uses', async () => {
    writeFile('src/lib/x.ts', ALIASED)
    writeFile('src/app.ts', "import { viaAlias } from '@/lib/x'\nexport const unrelated = 1\n")
    writeFile('entry.ts', "import './src/lib/x.js'\nimport './src/app.js'\n")
    expect(names((await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).dead)).toEqual(['other', 'viaAlias'])
  })

  it('treats a workspace package as a place in this repository, not as an external dependency', async () => {
    writeFile('package.json', '{ "private": true, "workspaces": ["packages/*"] }\n')
    writeFile('packages/utils/package.json', '{ "name": "@acme/utils", "main": "dist/index.js" }\n')
    writeFile('packages/utils/src/index.ts', 'export function usedByApp(): void {}\nexport function unusedInRepo(): void {}\n')
    writeFile('packages/utils/test/index.test.ts', "import '../src/index.js'\n")
    writeFile('packages/app/package.json', '{ "name": "app", "dependencies": { "@acme/utils": "workspace:*" } }\n')
    writeFile('packages/app/src/main.ts', "import { usedByApp } from '@acme/utils'\nusedByApp()\n")
    const result = await scan(
      ['packages/utils/src/index.ts', 'packages/utils/test/index.test.ts', 'packages/app/src/main.ts'],
      ['packages/utils/src/index.ts'],
      ['package.json', 'packages/utils/package.json', 'packages/app/package.json'],
    )
    expect(names(result.dead)).toEqual(['unusedInRepo'])
    expect(names(result.unknown)).toEqual(['usedByApp'])
  })

  it('does not let a workspace import shield a same-named export outside that package', async () => {
    writeFile('packages/utils/package.json', '{ "name": "@acme/utils" }\n')
    writeFile('packages/utils/src/index.ts', 'export function helper(): void {}\n')
    writeFile('packages/app/src/main.ts', "import { helper } from '@acme/utils'\nhelper()\n")
    writeFile('packages/app/src/local.ts', 'export function helper(): void {}\n')
    writeFile('packages/app/src/entry.ts', "import './local.js'\n")
    const result = await scan(
      ['packages/utils/src/index.ts', 'packages/app/src/main.ts', 'packages/app/src/local.ts', 'packages/app/src/entry.ts'],
      ['packages/app/src/local.ts'],
      ['packages/utils/package.json'],
    )
    expect(names(result.dead)).toEqual(['helper'])
  })

  it('ignores a declared external package, whatever names it shares with the target', async () => {
    writeFile('package.json', '{ "dependencies": { "zod": "^3.0.0" } }\n')
    writeFile('a.ts', 'export function z(): void {}\n')
    writeFile('b.ts', "import { z } from 'zod'\nz()\n")
    writeFile('entry.ts', "import './a.js'\n")
    expect(names((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'], ['package.json'])).dead)).toEqual(['z'])
  })

  it('ignores a Node builtin, with or without the node: prefix', async () => {
    writeFile('a.ts', 'export function join(): void {}\nexport function readFile(): void {}\n')
    writeFile('b.ts', "import { join } from 'node:path'\nimport { readFile } from 'fs'\njoin()\nreadFile()\n")
    writeFile('entry.ts', "import './a.js'\n")
    expect(names((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'])).dead)).toEqual(['join', 'readFile'])
  })

  it('treats an undeclared bare import as unresolved, so a same-named export is unknown', async () => {
    writeFile('a.ts', 'export function z(): void {}\n')
    writeFile('b.ts', "import { z } from 'zod'\nz()\n")
    writeFile('entry.ts', "import './a.js'\n")
    const result = await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['z'])
  })
})

describe('module resolution — what cannot be code', () => {
  it('does not read an import written inside a code fence of an MDX page as a real import', async () => {
    writeFile('src/a.ts', 'export function viaDocs(): void {}\n')
    writeFile('docs/page.mdx', "# Usage\n\n```ts\nimport { viaDocs } from '../src/a.js'\nimport { x } from 'some-example-lib'\nviaDocs()\n```\n")
    writeFile('entry.ts', "import './src/a.js'\n")
    const result = await scan(['src/a.ts', 'docs/page.mdx', 'entry.ts'], ['src/a.ts'])
    expect(names(result.dead)).toEqual(['viaDocs'])
  })

  it('does not read prose that mentions "import (" in an MDX page as a computed import', async () => {
    writeFile('src/a.ts', 'export function rotting(): void {}\n')
    writeFile('docs/post.mdx', '# Notes\n\nLocales now tree-shake out of the default import ([#6384](https://example.com)).\n')
    writeFile('entry.ts', "import './src/a.js'\n")
    const result = await scan(['src/a.ts', 'docs/post.mdx', 'entry.ts'], ['src/a.ts'])
    expect(names(result.dead)).toEqual(['rotting'])
  })

  it('still reads a computed import in an MDX export line', async () => {
    writeFile('src/a.ts', 'export function maybe(): void {}\n')
    writeFile('docs/post.mdx', 'export const mod = await import(process.env.TARGET)\n\n# Title\n')
    writeFile('entry.ts', "import './src/a.js'\n")
    const result = await scan(['src/a.ts', 'docs/post.mdx', 'entry.ts'], ['src/a.ts'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['maybe'])
  })

  it('still honours a real MDX import outside any fence', async () => {
    writeFile('src/a.ts', 'export function Widget(): void {}\n')
    writeFile('docs/page.mdx', "import { Widget } from '../src/a.js'\n\n<Widget />\n")
    writeFile('entry.ts', "import './src/a.js'\n")
    const result = await scan(['src/a.ts', 'docs/page.mdx', 'entry.ts'], ['src/a.ts'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['Widget'])
  })

  it('does not mistake a workspace package whose name holds a dot for an asset', async () => {
    writeFile('packages/utils/package.json', '{ "name": "acme.utils" }\n')
    writeFile('packages/utils/src/index.ts', 'export function helper(): void {}\n')
    writeFile('packages/utils/test/index.test.ts', "import '../src/index.js'\n")
    writeFile('packages/app/src/main.ts', "import { helper } from 'acme.utils'\nhelper()\n")
    const result = await scan(
      ['packages/utils/src/index.ts', 'packages/utils/test/index.test.ts', 'packages/app/src/main.ts'],
      ['packages/utils/src/index.ts'],
      ['packages/utils/package.json'],
    )
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['helper'])
  })

  it('treats an asset imported through an alias as reaching no code', async () => {
    writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }\n')
    writeFile('a.ts', 'export default function page(): void {}\n')
    writeFile('b.ts', "import logo from '@/public/logo.png'\nimport data from 'some-lib/data.json'\nconsole.log(logo, data)\n")
    writeFile('entry.ts', "import './a.js'\n")
    expect(names((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'], ['tsconfig.json'])).dead)).toEqual(['page'])
  })
})

describe('module resolution — computed and decorated specifiers', () => {
  it('leaves the exports of an import with a query unknown', async () => {
    writeFile('w.ts', 'export function onMessage(): void {}\n')
    writeFile('b.ts', "import Worker from './w.ts?worker'\nnew Worker()\n")
    writeFile('entry.ts', "import './w.js'\n")
    const result = await scan(['w.ts', 'b.ts', 'entry.ts'], ['w.ts'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['onMessage'])
  })

  it('leaves unknown every export under a template prefix, and nothing outside it', async () => {
    writeFile('src/locales/en.ts', 'export const greeting = 1\n')
    writeFile('src/other.ts', 'export const outside = 1\n')
    writeFile('src/i18n.ts', 'export const load = (l: string) => import(`./locales/${l}.ts`)\n')
    writeFile('entry.ts', "import './src/locales/en.js'\nimport './src/other.js'\nimport { load } from './src/i18n.js'\nload('en')\n")
    const result = await scan(['src/locales/en.ts', 'src/other.ts', 'src/i18n.ts', 'entry.ts'], ['src/locales/en.ts', 'src/other.ts'])
    expect(names(result.dead)).toEqual(['outside'])
    expect(names(result.unknown)).toEqual(['greeting'])
  })

  it('treats an import.meta.glob directory the same way', async () => {
    writeFile('src/pages/home.ts', 'export const title = 1\n')
    writeFile('src/router.ts', "export const pages = import.meta.glob('./pages/*.ts')\n")
    writeFile('entry.ts', "import './src/pages/home.js'\nimport { pages } from './src/router.js'\nvoid pages\n")
    const result = await scan(['src/pages/home.ts', 'src/router.ts', 'entry.ts'], ['src/pages/home.ts'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['title'])
  })

  it('maps a template prefix through a "paths" alias', async () => {
    writeFile('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n')
    writeFile('src/locales/en.ts', 'export const greeting = 1\n')
    writeFile('src/other.ts', 'export const outside = 1\n')
    writeFile('src/i18n.ts', 'export const load = (l: string) => import(`@/locales/${l}.ts`)\n')
    writeFile('entry.ts', "import './src/locales/en.js'\nimport './src/other.js'\nimport { load } from './src/i18n.js'\nload('en')\n")
    const result = await scan(['src/locales/en.ts', 'src/other.ts', 'src/i18n.ts', 'entry.ts'], ['src/locales/en.ts', 'src/other.ts'], ['tsconfig.json'])
    expect(names(result.dead)).toEqual(['outside'])
    expect(names(result.unknown)).toEqual(['greeting'])
  })

  it('leaves every export unknown when an import has no static part, and names the file that holds it', async () => {
    writeFile('a.ts', 'export function x(): void {}\nfunction privateDead(): void {}\n')
    writeFile('src/loader.ts', 'export const load = (n: string) => import(n)\n')
    writeFile('entry.ts', "import './a.js'\nimport { load } from './src/loader.js'\nload('a')\n")
    const result = await scan(['a.ts', 'src/loader.ts', 'entry.ts'], ['a.ts'])
    expect(names(result.dead)).toEqual(['privateDead'])
    expect(names(result.unknown)).toEqual(['x'])
    expect(result.hints.find((h) => h.startsWith(UNBOUND_HINT_PREFIX))).toContain('src/loader.ts')
  })

  it('follows `import m = require()` into the members it uses', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function unused(): void {}\n')
    writeFile('b.ts', "import m = require('./a')\nm.used()\n")
    expect(names((await scan(['a.ts', 'b.ts'], ['a.ts'])).dead)).toEqual(['unused'])
  })
})

describe('module resolution — the order the language uses', () => {
  it('prefers a file over a directory index of the same name', async () => {
    writeFile('utils.ts', 'export function fileHelper(): void {}\n')
    writeFile('utils/index.ts', 'export function dirHelper(): void {}\n')
    writeFile('b.ts', "import { fileHelper } from './utils'\nfileHelper()\n")
    writeFile('entry.ts', "import './utils/index.js'\nimport './utils.js'\n")
    const result = await scan(['utils.ts', 'utils/index.ts', 'b.ts', 'entry.ts'], ['utils.ts', 'utils/index.ts'])
    expect(names(result.dead)).toEqual(['dirHelper'])
    expect(result.unknown).toEqual([])
  })

  it('credits the TypeScript source when its compiled .js sits beside it', async () => {
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('a.js', 'export function used() {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nused()\n")
    writeFile('entry.ts', "import './a'\n")
    const result = await scan(['a.ts', 'a.js', 'b.ts', 'entry.ts'], ['a.ts'])
    expect(result.dead).toEqual([])
    expect(result.unknown).toEqual([])
  })
})

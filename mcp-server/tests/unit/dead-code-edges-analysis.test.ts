import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scanSymbols, type TreeSymbols } from '../../src/lib/comment-sweep/tree-engine.js'
import { parseJsonc } from '../../src/lib/dead-code/module-resolution.js'
import {
  DEPENDENT_HINT_PREFIX,
  DUAL_MODE_HINT_PREFIX,
  DYNAMIC_HINT_PREFIX,
  ENTRYPOINT_HINT_PREFIX,
  PUBLIC_EXEMPTED_HINT_PREFIX,
  SCRIPT_HINT_PREFIX,
  UNREADABLE_HINT_PREFIX,
  findDeadSymbols,
  workingTreeReader,
} from '../../src/lib/dead-code/references.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-dc-edge-'))
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function w(rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

const ALIASED = 'export function viaAlias(): void {}\nexport function other(): void {}\n'
const APP = "import { viaAlias } from '@/lib/x'\nviaAlias()\n"

const scan = (corpus: string[], targets: string[], configs: string[] = []) =>
  findDeadSymbols({ projectRoot: root, corpus, targets, configs })

const names = (symbols: ReadonlyArray<{ name: string }>): string[] => symbols.map((s) => s.name).sort()

async function aliasDead(configs: string[], app = APP): Promise<string[]> {
  w('src/lib/x.ts', ALIASED)
  w('src/app.ts', app)
  return names((await scan(['src/lib/x.ts', 'src/app.ts'], ['src/lib/x.ts'], configs)).dead)
}

async function sym(source: string): Promise<TreeSymbols> {
  const scanned = await scanSymbols('typescript', source)
  if (!scanned.ok) throw new Error(scanned.reason)
  return scanned.symbols
}

const effectOf = (symbols: TreeSymbols, name: string): boolean | undefined =>
  symbols.declarations.find((d) => d.name === name)?.effect

const refs = (symbols: TreeSymbols, name: string): number => symbols.references.filter((r) => r.name === name).length

describe('the config reader', () => {
  it('keeps a JSONC string that holds an escaped quote and a // inside it', () => {
    expect(parseJsonc('{"a": "x\\" // y", "b": 1}')).toEqual({ a: 'x" // y', b: 1 })
  })

  it('reads a config that starts with a byte-order mark', () => {
    expect(parseJsonc('﻿{"a": 1}')).toEqual({ a: 1 })
  })

  it('resolves "paths" targets against baseUrl when both are set', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["lib/*"] } } }')
    expect(await aliasDead(['tsconfig.json'], "import { viaAlias } from '@/x'\nviaAlias()\n")).toEqual(['other'])
  })

  it('reads "paths" through an array-valued extends', async () => {
    w('tsconfig.base.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    w('tsconfig.json', '{ "extends": ["./tsconfig.base.json"] }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('lets the later of two extended configs win, as TypeScript does', async () => {
    w('a.json', '{ "compilerOptions": { "paths": { "@/*": ["./nowhere/*"] } } }')
    w('b.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    w('tsconfig.json', '{ "extends": ["./a.json", "./b.json"] }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('resolves inherited "paths" against the config that declares them', async () => {
    w('configs/base.json', '{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }')
    w('tsconfig.json', '{ "extends": "./configs/base.json" }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('lets a config override the baseUrl it extends', async () => {
    w('tsconfig.base.json', '{ "compilerOptions": { "baseUrl": "." } }')
    w('tsconfig.json', '{ "extends": "./tsconfig.base.json", "compilerOptions": { "baseUrl": "src" } }')
    expect(await aliasDead(['tsconfig.json'], "import { viaAlias } from 'lib/x'\nviaAlias()\n")).toEqual(['other'])
  })

  it('lets a config override the "paths" it extends', async () => {
    w('tsconfig.base.json', '{ "compilerOptions": { "paths": { "@/*": ["./nowhere/*"] } } }')
    w('tsconfig.json', '{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('follows an extends written without the .json suffix', async () => {
    w('tsconfig.base.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    w('tsconfig.json', '{ "extends": "./tsconfig.base" }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('follows an extends that names a directory', async () => {
    w('base/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }')
    w('tsconfig.json', '{ "extends": "./base" }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('takes "paths" from the first reference that declares them', async () => {
    w('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.other.json" }] }')
    w('tsconfig.app.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    w('tsconfig.other.json', '{ "compilerOptions": { "paths": { "@/*": ["./nowhere/*"] } } }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('resolves a referenced config "paths" against its own baseUrl', async () => {
    w('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }')
    w('tsconfig.app.json', '{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["lib/*"] } } }')
    expect(await aliasDead(['tsconfig.json'], "import { viaAlias } from '@/x'\nviaAlias()\n")).toEqual(['other'])
  })

  it('keeps a config own "paths" over those of its references', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "references": [{ "path": "./tsconfig.other.json" }] }')
    w('tsconfig.other.json', '{ "compilerOptions": { "paths": { "@/*": ["./nowhere/*"] } } }')
    expect(await aliasDead(['tsconfig.json'])).toEqual(['other'])
  })

  it('finds the nearest config two directories up', async () => {
    w('packages/app/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
    w('packages/app/src/lib/x.ts', ALIASED)
    w('packages/app/src/main.ts', APP)
    const result = await scan(
      ['packages/app/src/lib/x.ts', 'packages/app/src/main.ts'],
      ['packages/app/src/lib/x.ts'],
      ['packages/app/tsconfig.json'],
    )
    expect(names(result.dead)).toEqual(['other'])
  })

  it('credits a package.json "module", "source", "types" and "exports" entry, not only "main"', async () => {
    const fields: Array<[string, string]> = [
      ['module', '{ "module": "./esm.ts" }'],
      ['source', '{ "source": "./esm.ts" }'],
      ['types', '{ "types": "./esm.ts" }'],
      ['exports', '{ "exports": { ".": "./esm.ts" } }'],
    ]
    for (const [field, manifest] of fields) {
      root = mkdtempSync(join(tmpdir(), `rsct-dc-entry-${field}-`))
      w('lib/package.json', manifest)
      w('lib/esm.ts', 'export function entryPoint(): void {}\nexport function unusedThere(): void {}\n')
      w('app.ts', "import { entryPoint } from './lib'\nentryPoint()\n")
      w('entry.ts', "import './lib/esm.js'\n")
      const result = await scan(['lib/esm.ts', 'app.ts', 'entry.ts'], ['lib/esm.ts'], ['lib/package.json'])
      expect(names(result.dead), field).toEqual(['unusedThere'])
    }
  })

  it('reads a typeof define guard as the mark of a file that also runs as a script', async () => {
    const scan = await sym("function helper() {}\nif (typeof define === 'function') define(function () { return helper })\nmodule.exports = helper\n")
    expect([scan.module, scan.dualMode]).toEqual([true, true])
  })

  it('says nothing about a script tag for a .cjs file, which is a module by its name', async () => {
    w('tool.cjs', "function rotting() {}\nif (typeof module !== 'undefined') module.exports = {}\n")
    w('entry.ts', "import './tool.cjs'\n")
    const result = await scan(['tool.cjs', 'entry.ts'], ['tool.cjs'])
    expect(names(result.dead)).toEqual(['rotting'])
    expect(result.hints.some((h) => h.startsWith(DUAL_MODE_HINT_PREFIX))).toBe(false)
  })

  it('says nothing about a script tag for a module that merely asks whether `module` exists', async () => {
    w('iso.ts', "export function used(): void {}\nfunction rotting(): void {}\nexport const kind = typeof module === 'undefined' ? 'esm' : 'cjs'\n")
    w('app.ts', "import { used, kind } from './iso.js'\nused()\nconsole.log(kind)\n")
    w('entry.ts', "import './app.js'\n")
    const result = await scan(['iso.ts', 'app.ts', 'entry.ts'], ['iso.ts'])
    expect(names(result.dead)).toEqual(['rotting'])
    expect(result.hints.some((h) => h.startsWith(DUAL_MODE_HINT_PREFIX))).toBe(false)
  })

  it('does not read an extended config outside the project root', async () => {
    w('shared/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["../repo/src/*"] } } }')
    w('repo/tsconfig.json', '{ "extends": "../shared/tsconfig.json" }')
    w('repo/src/lib/x.ts', ALIASED)
    w('repo/src/app.ts', APP)
    const result = await findDeadSymbols({
      projectRoot: join(root, 'repo'),
      corpus: ['src/lib/x.ts', 'src/app.ts'],
      targets: ['src/lib/x.ts'],
      configs: ['tsconfig.json'],
    })
    expect(result.dead).toEqual([])
  })
})

describe('what a package name means', () => {
  it('treats a devDependency as external', async () => {
    w('package.json', '{ "devDependencies": { "zod": "^3.0.0" } }')
    w('a.ts', 'export function z(): void {}\n')
    w('b.ts', "import { z } from 'zod'\nz()\n")
    w('entry.ts', "import './a.js'\n")
    expect(names((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'], ['package.json'])).dead)).toEqual(['z'])
  })

  it('bounds a computed import of a workspace package to that package', async () => {
    w('packages/utils/package.json', '{ "name": "@acme/utils" }')
    w('packages/utils/src/en.ts', 'export const greeting = 1\n')
    w('app.ts', 'export const load = (l: string) => import(`@acme/utils/src/${l}`)\n')
    w('entry.ts', "import './packages/utils/src/en.js'\nimport { load } from './app.js'\nload('en')\n")
    const result = await scan(
      ['packages/utils/src/en.ts', 'app.ts', 'entry.ts'],
      ['packages/utils/src/en.ts'],
      ['packages/utils/package.json'],
    )
    expect(names(result.unknown)).toEqual(['greeting'])
  })

  it('does not let a computed import of a declared package blind the scan', async () => {
    w('package.json', '{ "dependencies": { "some-lib": "1.0.0" } }')
    w('a.ts', 'export function x(): void {}\n')
    w('b.ts', 'export const load = (n: string) => import(`some-lib/${n}`)\n')
    w('entry.ts', "import './a.js'\nimport { load } from './b.js'\nload('q')\n")
    expect(names((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'], ['package.json'])).dead)).toEqual(['x'])
  })

  it('still blinds on an undeclared package prefix when a baseUrl is set', async () => {
    w('jsconfig.json', '{ "compilerOptions": { "baseUrl": "src" } }')
    w('src/a.ts', 'export function x(): void {}\n')
    w('src/b.ts', 'export const load = (n: string) => import(`mystery-pkg/${n}`)\n')
    w('entry.ts', "import './src/a.js'\nimport { load } from './src/b.js'\nload('q')\n")
    expect((await scan(['src/a.ts', 'src/b.ts', 'entry.ts'], ['src/a.ts'], ['jsconfig.json'])).dead).toEqual([])
  })

  it('does not let a workspace import reach a sibling package with a longer name', async () => {
    w('packages/utils/package.json', '{ "name": "@acme/utils" }')
    w('packages/utils/src/index.ts', 'export function helper(): void {}\n')
    w('packages/utils-extra/src/local.ts', 'export function helper(): void {}\n')
    w('app.ts', "import { helper } from '@acme/utils'\nhelper()\n")
    w('entry.ts', "import './packages/utils-extra/src/local.js'\n")
    const result = await scan(
      ['packages/utils/src/index.ts', 'packages/utils-extra/src/local.ts', 'app.ts', 'entry.ts'],
      ['packages/utils-extra/src/local.ts'],
      ['packages/utils/package.json'],
    )
    expect(names(result.dead)).toEqual(['helper'])
  })

  it('leaves unknown what an import of this repository own package name may reach', async () => {
    w('package.json', '{ "name": "my-app" }')
    w('src/a.ts', 'export function maybeUsed(): void {}\n')
    w('src/b.ts', "import { maybeUsed } from 'my-app'\nmaybeUsed()\n")
    w('entry.ts', "import './src/a.js'\nimport './src/b.js'\n")
    const result = await scan(['src/a.ts', 'src/b.ts', 'entry.ts'], ['src/a.ts'], ['package.json'])
    expect(result.dead).toEqual([])
    expect(names(result.unknown)).toEqual(['maybeUsed'])
  })

  it('reads a specifier that starts with # as a name, not as a query', async () => {
    w('jsconfig.json', '{ "compilerOptions": { "baseUrl": "src" } }')
    w('src/index.ts', 'export function onlyHere(): void {}\n')
    w('b.ts', "import { x } from '#utils'\nx()\n")
    w('entry.ts', "import './src/index.js'\n")
    expect(names((await scan(['src/index.ts', 'b.ts', 'entry.ts'], ['src/index.ts'], ['jsconfig.json'])).dead)).toEqual(['onlyHere'])
  })

  it('does not match a specifier shorter than the text around the star', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "paths": { "ab*ba": ["./x/*"] } } }')
    w('x/index.ts', ALIASED)
    w('app.ts', "import { viaAlias } from 'aba'\nviaAlias()\n")
    w('entry.ts', "import './x/index.js'\n")
    expect(names((await scan(['x/index.ts', 'app.ts', 'entry.ts'], ['x/index.ts'], ['tsconfig.json'])).unknown)).toEqual(['viaAlias'])
  })
})

describe('JSX settings keep the factory alive', () => {
  it('counts React as used by JSX under "jsx": "react"', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "jsx": "react" } }')
    w('src/react.ts', 'export default function createElement(): void {}\n')
    w('src/view.tsx', "import React from './react.js'\nexport const view = <div />\n")
    w('entry.ts', "import './src/view.js'\n")
    expect((await scan(['src/react.ts', 'src/view.tsx', 'entry.ts'], ['src/react.ts'], ['tsconfig.json'])).dead).toEqual([])
  })

  it('counts the jsxFragmentFactory as used', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" } }')
    w('src/jsx.ts', 'export function h(): void {}\nexport function Fragment(): void {}\n')
    w('src/view.tsx', "import { h, Fragment } from './jsx.js'\nexport const view = <></>\n")
    w('entry.ts', "import './src/view.js'\n")
    expect((await scan(['src/jsx.ts', 'src/view.tsx', 'entry.ts'], ['src/jsx.ts'], ['tsconfig.json'])).dead).toEqual([])
  })

  it('reads the root name of a dotted jsxFactory', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "jsxFactory": "React.createElement" } }')
    w('src/react.ts', 'export default function createElement(): void {}\n')
    w('src/view.tsx', "import React from './react.js'\nexport const view = <div />\n")
    w('entry.ts', "import './src/view.js'\n")
    expect((await scan(['src/react.ts', 'src/view.tsx', 'entry.ts'], ['src/react.ts'], ['tsconfig.json'])).dead).toEqual([])
  })
})

describe('an import the scan cannot follow leaves what it names unknown', () => {
  it('resolves a module whose file name starts with a dot', async () => {
    w('.config.ts', 'export function cfg(): void {}\n')
    w('b.ts', "import { cfg } from './.config'\ncfg()\n")
    w('entry.ts', "import './.config.js'\n")
    expect((await scan(['.config.ts', 'b.ts', 'entry.ts'], ['.config.ts'])).dead).toEqual([])
  })

  it('leaves unknown what an unresolvable root-relative import may name', async () => {
    w('a.ts', 'export function helper(): void {}\n')
    w('b.ts', "import { helper } from '/lib/helper'\nhelper()\n")
    w('entry.ts', "import './a.js'\n")
    expect((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'])).dead).toEqual([])
  })

  it('maps the fixed part of a computed import through "paths" and baseUrl', async () => {
    w('tsconfig.json', '{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["lib/*"] } } }')
    w('src/lib/locales/en.ts', 'export const greeting = 1\n')
    w('src/i18n.ts', 'export const load = (l: string) => import(`@/locales/${l}.ts`)\n')
    w('entry.ts', "import './src/lib/locales/en.js'\nimport { load } from './src/i18n.js'\nload('en')\n")
    const result = await scan(['src/lib/locales/en.ts', 'src/i18n.ts', 'entry.ts'], ['src/lib/locales/en.ts'], ['tsconfig.json'])
    expect(names(result.unknown)).toEqual(['greeting'])
  })

  it('leaves unknown a name a barrel re-exports from an unresolved module', async () => {
    w('src/lib/x.ts', ALIASED)
    w('src/barrel.ts', "export { viaAlias } from '@/lib/x'\n")
    w('src/app.ts', "import { viaAlias } from './barrel.js'\nviaAlias()\n")
    w('entry.ts', "import './src/lib/x.js'\n")
    expect(names((await scan(['src/lib/x.ts', 'src/barrel.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).unknown)).toEqual(['viaAlias'])
  })

  it('leaves every export unknown behind an unresolved star re-export', async () => {
    w('src/lib/x.ts', ALIASED)
    w('src/barrel.ts', "export * from '@/lib/x'\n")
    w('entry.ts', "import './src/lib/x.js'\nimport './src/barrel.js'\n")
    expect((await scan(['src/lib/x.ts', 'src/barrel.ts', 'entry.ts'], ['src/lib/x.ts'])).dead).toEqual([])
  })

  it('leaves every export unknown behind an unresolved dynamic import', async () => {
    w('src/lib/x.ts', ALIASED)
    w('src/app.ts', "export const load = () => import('@/lib/x')\n")
    w('entry.ts', "import './src/lib/x.js'\nimport { load } from './src/app.js'\nload()\n")
    expect((await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).dead).toEqual([])
  })

  it('leaves every export unknown when an unresolved namespace is used as a value', async () => {
    w('src/lib/x.ts', ALIASED)
    w('src/app.ts', "import * as ns from '@/lib/x'\nconsole.log(ns)\n")
    w('entry.ts', "import './src/lib/x.js'\n")
    expect((await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).dead).toEqual([])
  })

  it('follows the member uses of an unresolved namespace import', async () => {
    w('src/lib/x.ts', ALIASED)
    w('src/app.ts', "import * as ns from '@/lib/x'\nns.viaAlias()\n")
    w('entry.ts', "import './src/lib/x.js'\n")
    expect(names((await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).unknown)).toEqual(['viaAlias'])
  })

  it('counts a member use of a named import from an unresolved module', async () => {
    w('src/lib/x.ts', 'export const cfg = { run(): void {} }\n')
    w('src/app.ts', "import { cfg } from '@/lib/x'\ncfg.run()\n")
    w('entry.ts', "import './src/lib/x.js'\n")
    expect((await scan(['src/lib/x.ts', 'src/app.ts', 'entry.ts'], ['src/lib/x.ts'])).dead).toEqual([])
  })

  it('leaves every export unknown behind a computed import of an unknown package', async () => {
    w('a.ts', 'export function x(): void {}\n')
    w('b.ts', 'export const load = (n: string) => import(`@/lib/${n}`)\n')
    w('entry.ts', "import './a.js'\nimport { load } from './b.js'\nload('q')\n")
    expect((await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'])).dead).toEqual([])
  })

  it('leaves unknown a re-exported namespace that is used as a value', async () => {
    w('impl.ts', 'export function a(): void {}\nexport function b(): void {}\n')
    w('mid.ts', "export * as ns from './impl.js'\n")
    w('consumer.ts', "import { ns } from './mid.js'\nexport const all = Object.values(ns)\n")
    w('entry.ts', "import { all } from './consumer.js'\nconsole.log(all)\n")
    expect((await scan(['impl.ts', 'mid.ts', 'consumer.ts', 'entry.ts'], ['impl.ts'])).dead).toEqual([])
  })

  it('keeps a longer code fence open across a shorter one inside it', async () => {
    w('src/a.ts', 'export function viaDocs(): void {}\n')
    w('docs/page.mdx', "````md\n```ts\nimport { viaDocs } from '../src/a.js'\n```\n````\n")
    w('entry.ts', "import './src/a.js'\n")
    expect(names((await scan(['src/a.ts', 'docs/page.mdx', 'entry.ts'], ['src/a.ts'])).dead)).toEqual(['viaDocs'])
  })

  it('reads a directory where a file was expected as absent, not as an error', () => {
    mkdirSync(join(root, 'dir.ts'), { recursive: true })
    expect(workingTreeReader(root)('dir.ts').kind).toBe('absent')
  })

  it('keeps a redeclared var whose later initialiser runs code', async () => {
    w('a.ts', 'declare function init(): number\nvar x = 1\nvar x = init()\nexport {}\n')
    expect((await scan(['a.ts'], ['a.ts'])).dead).toEqual([])
  })

  it('spans every overload in the range a keep is bound to', async () => {
    const source = 'export function f(a: string): void\nexport function f(a: unknown): void {}\n'
    w('a.ts', source)
    w('entry.ts', "import './a.js'\n")
    const [dead] = (await scan(['a.ts', 'entry.ts'], ['a.ts'])).dead
    expect(source.slice(dead?.start, dead?.end)).toBe(source.trimEnd())
  })
})

describe('the hints say which reason applies, and to how many symbols', () => {
  it('names a file nobody imports as an entrypoint before naming an import with no fixed target', async () => {
    w('a.ts', 'export function orphan(): void {}\n')
    w('loader.ts', 'export const load = (n: string) => import(n)\n')
    const result = await scan(['a.ts', 'loader.ts'], ['a.ts'])
    expect(result.hints.some((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))).toBe(true)
  })

  it('calls a classic script that uses eval a script first', async () => {
    w('a.js', "function helper() {}\neval('helper()')\n")
    const result = await scan(['a.js'], ['a.js'])
    expect(result.hints.some((h) => h.startsWith(SCRIPT_HINT_PREFIX))).toBe(true)
  })

  it('counts only the symbols the unreadable file withheld', async () => {
    w('a.ts', 'export function maybe(): void {}\n')
    w('broken.ts', "import { maybe } from './a.js'\nfunction oops( {\n")
    w('c.ts', 'export function orphan(): void {}\n')
    const result = await scan(['a.ts', 'broken.ts', 'c.ts'], ['a.ts', 'c.ts'])
    expect(result.hints.find((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toContain('on 1 symbol(s)')
  })

  it('lists exactly ten items without an "and 0 more" tail', async () => {
    w('a.ts', Array.from({ length: 10 }, (_, i) => `export function e${i}(): void {}\n`).join(''))
    w('entry.ts', "import './a.js'\n")
    const result = await findDeadSymbols({ projectRoot: root, corpus: ['a.ts', 'entry.ts'], targets: ['a.ts'], publicApi: ['a.ts'] })
    expect(result.hints.find((h) => h.startsWith(PUBLIC_EXEMPTED_HINT_PREFIX))).not.toContain('more')
  })

  it('lists only the dependents in the dependent hint', async () => {
    w('entry.ts', 'function helper(): void {}\nexport function main(): void { helper() }\n')
    const result = await scan(['entry.ts'], ['entry.ts'])
    expect(result.hints.find((h) => h.startsWith(DEPENDENT_HINT_PREFIX))).not.toContain('entry.ts:main')
  })

  it('says nothing about an entrypoint export that is used', async () => {
    w('entry.ts', 'export function main(): void {}\nmain()\n')
    const result = await scan(['entry.ts'], ['entry.ts'])
    expect(result.hints.some((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))).toBe(false)
  })

  it('names the dynamically imported file in the dynamic hint', async () => {
    w('a.ts', 'export function lazyThing(): void {}\n')
    w('b.ts', "export async function go(): Promise<void> { const m = await import('./a.js'); m.lazyThing() }\n")
    w('entry.ts', "import './b.js'\n")
    const result = await scan(['a.ts', 'b.ts', 'entry.ts'], ['a.ts'])
    expect(result.hints.find((h) => h.startsWith(DYNAMIC_HINT_PREFIX))).toContain('a.ts')
  })

  it('counts the exports the entrypoint hint withholds', async () => {
    w('entry.ts', 'export function looksOrphaned(): void {}\n')
    const result = await scan(['entry.ts'], ['entry.ts'])
    expect(result.hints.find((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))).toContain('1 export(s) left unknown')
  })

  it('does not call a file a computed import reaches an entrypoint', async () => {
    w('src/locales/en.ts', 'export const greeting = 1\n')
    w('src/i18n.ts', 'export const load = (l: string) => import(`./locales/${l}.ts`)\n')
    w('entry.ts', "import { load } from './src/i18n.js'\nload('en')\n")
    const result = await scan(['src/locales/en.ts', 'src/i18n.ts', 'entry.ts'], ['src/locales/en.ts'])
    expect(result.hints.some((h) => h.startsWith(ENTRYPOINT_HINT_PREFIX))).toBe(false)
  })
})

describe('the scanner reads load-time effects and block scopes', () => {
  it('marks a declaration that awaits at load, with no call', async () => {
    expect(effectOf(await sym('declare const p: Promise<number>\nconst cfg = await p\nexport {}\n'), 'cfg')).toBe(true)
  })

  it('marks a declaration whose initialiser is a compound assignment', async () => {
    expect(effectOf(await sym('let n = 0\nconst x = (n += 1)\n'), 'x')).toBe(true)
  })

  it('marks a class whose static block holds no call', async () => {
    expect(effectOf(await sym('class K { static { for (const k of [1]) {} } }\n'), 'K')).toBe(true)
  })

  it('does not count a var inside a static block as a use of the top-level name', async () => {
    expect(refs(await sym('function helper(): void {}\nexport class K { static { var helper = 1; void helper } }\n'), 'helper')).toBe(0)
  })

  it('does not hoist a static block var into the enclosing function', async () => {
    expect(
      refs(
        await sym('function helper(): number { return 1 }\nexport function f(): number { class A { static { var helper = 2 } } return helper() }\n'),
        'helper',
      ),
    ).toBe(1)
  })

  it('does not count a qualified type name as a use of a local of that name', async () => {
    expect(refs(await sym("import * as ext from './ext.js'\nclass Config {}\nexport let c: ext.Config | undefined\n"), 'Config')).toBe(0)
  })

  it('does not count a for-in var binding as a use of the top-level name', async () => {
    expect(refs(await sym('function helper(): void {}\nexport function f(o: object): void { for (var helper in o) { void helper } }\n'), 'helper')).toBe(0)
  })

  it('reads the fixed directory of a glob with braces', async () => {
    expect((await sym("export const m = import.meta.glob('./{a,b}/*.ts')\n")).dynamicPrefixes).toEqual(['./'])
  })

  it('reads import.meta.globEager like glob', async () => {
    expect((await sym("export const m = import.meta.globEager('./x/*.ts')\n")).dynamicPrefixes).toEqual(['./x/'])
  })
})

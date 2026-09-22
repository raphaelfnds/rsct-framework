import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMPORT,
  NAMESPACE_IMPORT,
  ownerKeyOf,
  scanSymbols,
  type TreeLanguage,
  type TreeSymbols,
} from '../../src/lib/comment-sweep/tree-engine.js'

async function symbols(source: string, language: TreeLanguage = 'typescript'): Promise<TreeSymbols> {
  const result = await scanSymbols(language, source)
  if (!result.ok) throw new Error(`expected a scan, got ${result.reason}`)
  return result.symbols
}

function named(scan: TreeSymbols, name: string): number {
  return scan.references.filter((r) => r.name === name).length
}

function ownerOf(scan: TreeSymbols, name: string): string | null | undefined {
  return scan.references.find((r) => r.name === name)?.owner
}

describe('scanSymbols — declarations', () => {
  it('records every top-level value declaration with its export flag', async () => {
    const scan = await symbols(
      'const a = 1\nlet b = 2\nfunction c() {}\nclass D {}\nenum E { X }\nexport const f = 3\nexport function g() {}\n',
    )
    const byName = new Map(scan.declarations.map((d) => [d.name, d]))
    expect([...byName.keys()].sort()).toEqual(['D', 'E', 'a', 'b', 'c', 'f', 'g'])
    expect(byName.get('a')?.exported).toBe(false)
    expect(byName.get('f')?.exported).toBe(true)
    expect(byName.get('g')?.exported).toBe(true)
  })

  it('marks a default export as such, and a named export as not', async () => {
    const scan = await symbols('export default function first(): void {}\nexport function second(): void {}\n')
    const byName = new Map(scan.declarations.map((d) => [d.name, d]))
    expect(byName.get('first')?.defaultExport).toBe(true)
    expect(byName.get('first')?.exported).toBe(true)
    expect(byName.get('second')?.defaultExport).toBe(false)
  })

  it('does not mark a plain local declaration as a default export', async () => {
    const scan = await symbols('function local(): void {}\n')
    expect(scan.declarations.find((d) => d.name === 'local')?.defaultExport).toBe(false)
  })

  it('separates type declarations from value declarations', async () => {
    const scan = await symbols('export type A = string\nexport interface B { x: string }\nexport const c = 1\n')
    const kinds = new Map(scan.declarations.map((d) => [d.name, d.kind]))
    expect(kinds.get('A')).toBe('type')
    expect(kinds.get('B')).toBe('type')
    expect(kinds.get('c')).toBe('value')
  })

  it('records both names of a two-declarator statement', async () => {
    const scan = await symbols('const a = 1, b = 2\n')
    expect(scan.declarations.map((d) => d.name).sort()).toEqual(['a', 'b'])
  })

  it('carries a byte range that covers the declaration text', async () => {
    const source = 'const alpha = 1\n'
    const scan = await symbols(source)
    const alpha = scan.declarations.find((d) => d.name === 'alpha')
    expect(alpha).toBeDefined()
    expect(source.slice(alpha?.start ?? 0, alpha?.end ?? 0)).toBe('const alpha = 1')
  })

  it('includes the export keyword in the range, since dropping it changes the declaration', async () => {
    const source = 'export function beta(): void {}\n'
    const scan = await symbols(source)
    const beta = scan.declarations.find((d) => d.name === 'beta')
    expect(source.slice(beta?.start ?? 0, beta?.end ?? 0)).toBe('export function beta(): void {}')
  })

  it('includes the export keyword for a const declaration too', async () => {
    const source = 'export const gamma = 1\n'
    const scan = await symbols(source)
    const gamma = scan.declarations.find((d) => d.name === 'gamma')
    expect(source.slice(gamma?.start ?? 0, gamma?.end ?? 0)).toBe('export const gamma = 1')
  })

  it('does NOT count a declaration name as a reference to itself', async () => {
    const scan = await symbols('function lonely() {}\n')
    expect(named(scan, 'lonely')).toBe(0)
  })

  it('counts a use of a declared name as a reference', async () => {
    const scan = await symbols('function used() {}\nfunction caller() { return used() }\n')
    expect(named(scan, 'used')).toBe(1)
  })
})

describe('scanSymbols — imports', () => {
  it('carries the imported name and the alias separately', async () => {
    const scan = await symbols("import { alpha, beta as gamma } from './x.js'\n")
    expect(scan.imports).toHaveLength(1)
    expect(scan.imports[0]?.specifier).toBe('./x.js')
    expect(scan.imports[0]?.names).toEqual(
      expect.arrayContaining([
        { imported: 'alpha', local: 'alpha' },
        { imported: 'beta', local: 'gamma' },
      ]),
    )
  })

  it('marks a namespace import', async () => {
    const scan = await symbols("import * as ns from './y.js'\n")
    expect(scan.imports[0]?.names).toEqual([{ imported: NAMESPACE_IMPORT, local: 'ns' }])
  })

  it('marks a default import', async () => {
    const scan = await symbols("import def from './z.js'\n")
    expect(scan.imports[0]?.names).toEqual([{ imported: DEFAULT_IMPORT, local: 'def' }])
  })

  it('flags a star re-export, which names nothing on its own', async () => {
    const scan = await symbols("export * from './barrel.js'\n")
    expect(scan.imports[0]?.starReexport).toBe(true)
    expect(scan.imports[0]?.names).toEqual([])
  })

  it('reads a named re-export without flagging it as a star', async () => {
    const scan = await symbols("export { re } from './w.js'\n")
    expect(scan.imports[0]?.starReexport).toBe(false)
    expect(scan.imports[0]?.names).toEqual([{ imported: 're', local: 're' }])
  })

  it('does not treat an import binding as a local reference', async () => {
    const scan = await symbols("import { alpha } from './x.js'\n")
    expect(named(scan, 'alpha')).toBe(0)
  })
})

describe('scanSymbols — what must NOT count as a reference', () => {
  it('ignores a name that only appears inside a comment', async () => {
    const scan = await symbols('function ghost() {}\n// ghost is mentioned here\n')
    expect(named(scan, 'ghost')).toBe(0)
  })

  it('ignores a name that only appears inside a string literal', async () => {
    const scan = await symbols('function ghost() {}\nconst s = "ghost walks"\n')
    expect(named(scan, 'ghost')).toBe(0)
  })

  it('ignores a name that only appears inside a template literal', async () => {
    const scan = await symbols('function ghost() {}\nconst s = `ghost walks`\n')
    expect(named(scan, 'ghost')).toBe(0)
  })

  it('DOES count a name used inside a template interpolation', async () => {
    const scan = await symbols('function used() {}\nconst s = `call ${used()} here`\n')
    expect(named(scan, 'used')).toBe(1)
  })

  it('counts a name used inside a nested interpolation', async () => {
    const scan = await symbols('function inner() {}\nconst s = `a ${`b ${inner()}`}`\n')
    expect(named(scan, 'inner')).toBe(1)
  })
})

describe('scanSymbols — member access through a namespace', () => {
  it('records the object and the member separately', async () => {
    const scan = await symbols("import * as ns from './y.js'\nexport const v = ns.member\n")
    expect(scan.memberUses).toEqual(
      expect.arrayContaining([{ object: 'ns', member: 'member', owner: 'v' }]),
    )
  })
})

describe('scanSymbols — which declaration a reference sits in', () => {
  it('attributes a reference to the declaration that encloses it', async () => {
    const scan = await symbols('function target() {}\nfunction holder() { return target() }\n')
    expect(ownerOf(scan, 'target')).toBe('holder')
  })

  it('reports no owner for a reference at the top level', async () => {
    const scan = await symbols('function target() {}\ntarget()\n')
    expect(ownerOf(scan, 'target')).toBeNull()
  })

  it('attributes a reference inside a const initialiser to that const', async () => {
    const scan = await symbols('function target() {}\nconst held = target()\n')
    expect(ownerOf(scan, 'target')).toBe('held')
  })
})

describe('scanSymbols — scope: a local binding is not the top-level symbol', () => {
  it('does not count a parameter that shadows a top-level name', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(helper: number): number { return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a destructured parameter that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live({ helper }: { helper: number }): number { return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a local const that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(): number { const helper = 1; return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a catch binding that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(): void { try {} catch (helper) { throw helper } }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a var hoisted from a nested block', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(x: boolean): unknown { if (x) { var helper = 1 } return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a single arrow parameter that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport const live = (helper: number) => helper\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a for-of binding that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(): void { for (const helper of [1]) { void helper } }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a function-expression parameter that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport const live = function (helper: number): number { return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a C-style for binding that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport function live(): void { for (let helper = 0; helper < 1; helper++) {} }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('does not count a method parameter that shadows it', async () => {
    const scan = await symbols('function helper(): void {}\nexport class Live { run(helper: number): number { return helper } }\n')
    expect(named(scan, 'helper')).toBe(0)
  })

  it('STILL counts a use in a sibling scope that does not shadow it', async () => {
    const scan = await symbols(
      'function helper(): void {}\nexport function a(helper: number): number { return helper }\nexport function b(): void { helper() }\n',
    )
    expect(named(scan, 'helper')).toBe(1)
    expect(ownerOf(scan, 'helper')).toBe('b')
  })

  it('STILL counts a use in a parameter default, which is evaluated outside the shadow', async () => {
    const scan = await symbols('function helper(): number { return 1 }\nexport function live(x = helper()): number { return x }\n')
    expect(named(scan, 'helper')).toBe(1)
  })

  it('STILL counts a for-of that assigns an outer name instead of declaring one', async () => {
    const scan = await symbols('let helper = 0\nexport function live(): void { for (helper of [1]) {} }\n')
    expect(named(scan, 'helper')).toBe(1)
  })

  it('does not count a namespace member access through a shadowed name', async () => {
    const scan = await symbols("import * as ns from './a.js'\nexport function live(ns: { x: number }): number { return ns.x }\n")
    expect(scan.memberUses).toEqual([])
  })
})

describe('scanSymbols — each declarator owns only its own initialiser', () => {
  it('attributes a reference to the declarator whose initialiser holds it', async () => {
    const scan = await symbols('function compute(): number { return 1 }\nexport const unused = 0, used = compute()\n')
    expect(ownerOf(scan, 'compute')).toBe('used')
  })
})

describe('scanSymbols — exports declared away from the declaration', () => {
  it('marks a declaration exported by a bare export clause, under its alias', async () => {
    const scan = await symbols('function a(): void {}\nexport { a as b }\n')
    const a = scan.declarations.find((d) => d.name === 'a')
    expect(a?.exported).toBe(true)
    expect(a?.exposures).toEqual(['b'])
    expect(named(scan, 'a')).toBe(0)
  })

  it('marks a declaration exported as default by `export default name`', async () => {
    const scan = await symbols('function a(): void {}\nexport default a\n')
    const a = scan.declarations.find((d) => d.name === 'a')
    expect(a?.defaultExport).toBe(true)
    expect(a?.exposures).toEqual(['default'])
    expect(named(scan, 'a')).toBe(0)
  })

  it('exposes a named export under its own name and a default export only as default', async () => {
    const scan = await symbols('export function named(): void {}\nexport default function dflt(): void {}\n')
    const byName = new Map(scan.declarations.map((d) => [d.name, d]))
    expect(byName.get('named')?.exposures).toEqual(['named'])
    expect(byName.get('dflt')?.exposures).toEqual(['default'])
  })
})

describe('scanSymbols — overload signatures are declarations', () => {
  it('does not count the name of an overload signature as a reference', async () => {
    const scan = await symbols('export function f(a: string): void\nexport function f(a: unknown): void {}\n')
    expect(named(scan, 'f')).toBe(0)
    expect(scan.declarations.filter((d) => d.name === 'f')).toHaveLength(2)
  })
})

describe('scanSymbols — import and re-export edges are told apart', () => {
  it('marks an import edge as an import and a named re-export as a re-export', async () => {
    const scan = await symbols("import { a } from './a.js'\nexport { b as c } from './b.js'\nexport const use = () => a\n")
    const bySpec = new Map(scan.imports.map((e) => [e.specifier, e]))
    expect(bySpec.get('./a.js')?.kind).toBe('import')
    expect(bySpec.get('./b.js')?.kind).toBe('reexport')
    expect(bySpec.get('./b.js')?.names).toEqual([{ imported: 'b', local: 'c' }])
  })

  it('records `export * as ns from` as a namespace re-export under that name', async () => {
    const scan = await symbols("export * as ns from './x.js'\n")
    expect(scan.imports[0]?.kind).toBe('reexport')
    expect(scan.imports[0]?.namespaceReexport).toBe('ns')
    expect(scan.imports[0]?.starReexport).toBe(false)
  })

  it('records a dynamic import() as a dynamic edge', async () => {
    const scan = await symbols("export async function g(): Promise<unknown> { const m = await import('./a.js'); return m }\n")
    expect(scan.imports.map((e) => [e.specifier, e.kind])).toEqual([['./a.js', 'dynamic']])
  })

  it('records require() of a relative path as a dynamic edge', async () => {
    const scan = await symbols("const r = require('./a.js')\nexport const use = () => r\n")
    expect(scan.imports.map((e) => [e.specifier, e.kind])).toEqual([['./a.js', 'dynamic']])
  })
})

describe('scanSymbols — failure modes', () => {
  it('reports a parse error rather than an empty, clean-looking scan', async () => {
    const result = await scanSymbols('typescript', 'function broken( {\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('parse_error')
  })

  it('reports engine_unavailable when the grammars directory is absent', async () => {
    const result = await scanSymbols('typescript', 'const a = 1\n', null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('engine_unavailable')
  })
})

describe('scanSymbols — deeply nested code', () => {
  it('scans a 20000-term expression without overflowing the stack, and still sees every use', async () => {
    const scan = await symbols(`function used(): number { return 1 }\nexport const deep = ${'used() + '.repeat(20_000)}1\n`)
    expect(named(scan, 'used')).toBe(20_000)
  })
})

describe('scanSymbols — values and types are separate namespaces', () => {
  it('does not let a type parameter hide a value of the same name', async () => {
    const scan = await symbols(
      'const Schema = { parse: (x: unknown) => x }\nexport function validate<Schema>(input: Schema): unknown { return Schema.parse(input) }\n',
    )
    expect(scan.memberUses).toEqual(expect.arrayContaining([{ object: 'Schema', member: 'parse', owner: 'validate' }]))
  })

  it('still lets a type parameter hide a type of the same name', async () => {
    const scan = await symbols('type Helper = string\nexport function f<Helper>(x: Helper): Helper { return x }\n')
    expect(named(scan, 'Helper')).toBe(0)
  })

  it('does not let a parameter hide a type of the same name', async () => {
    const scan = await symbols('type Row = { id: number }\nexport function f(Row: number): Row { return { id: Row } }\n')
    expect(named(scan, 'Row')).toBe(1)
    expect(ownerOf(scan, 'Row')).toBe('f')
  })

  it('owns a reference inside a type by the type, never by a value of the same name', async () => {
    const scan = await symbols('const Status = { on: 1 } as const\nexport type Status = typeof Status\n')
    const owners = scan.references.filter((r) => r.name === 'Status').map((r) => r.owner)
    expect(owners).toEqual([ownerKeyOf('type', 'Status')])
    expect(ownerKeyOf('type', 'Status')).not.toBe(ownerKeyOf('value', 'Status'))
  })
})

describe('scanSymbols — a parameter default does not see the function body', () => {
  it('counts a use in a default even when the body declares a var of the same name', async () => {
    const scan = await symbols(
      'function helper(): number { return 1 }\nexport function live(x = helper()): number { var helper = 2; return x + helper }\n',
    )
    expect(named(scan, 'helper')).toBe(1)
  })
})

describe('scanSymbols — a parameter of a signature is local to that signature', () => {
  const cases: Array<[string, string]> = [
    ['an interface method signature', 'export interface I { m(ghost: number): void }'],
    ['a call signature', 'export interface I { (ghost: number): void }'],
    ['a construct signature', 'export interface I { new (ghost: number): I }'],
    ['a function type', 'export type F = (ghost: number) => void'],
    ['a constructor type', 'export type C = new (ghost: number) => object'],
    ['an abstract method signature', 'export abstract class A { abstract m(ghost: number): void }'],
    ['a class overload signature', 'export class K { m(ghost: number): void\n  m(x: unknown): void {} }'],
    ['a function overload signature', 'export function o(ghost: number): void\nexport function o(x: unknown): void {}'],
  ]
  for (const [label, source] of cases) {
    it(`does not count ${label} parameter as a use`, async () => {
      const scan = await symbols(`function ghost(): void {}\n${source}\n`)
      expect(named(scan, 'ghost')).toBe(0)
    })
  }
})

describe('scanSymbols — a binding used as a value is told apart from a member access on it', () => {
  it('records a bare use as a reference and a member access only as a member use', async () => {
    const scan = await symbols("import * as ns from './a.js'\nexport const all = Object.values(ns)\nexport const one = ns.x\n")
    expect(named(scan, 'ns')).toBe(1)
    expect(ownerOf(scan, 'ns')).toBe('all')
    expect(scan.memberUses).toEqual(expect.arrayContaining([{ object: 'ns', member: 'x', owner: 'one' }]))
  })

  it('records a qualified name in a type position as a member use', async () => {
    const scan = await symbols("import * as ns from './a.js'\nexport let v: ns.Foo | undefined\n")
    expect(named(scan, 'ns')).toBe(0)
    expect(scan.memberUses).toEqual(expect.arrayContaining([{ object: 'ns', member: 'Foo', owner: 'v' }]))
  })

  it('records a JSX member tag as a member use', async () => {
    const scan = await symbols("import * as ui from './ui.js'\nexport const v = <ui.Button />\n", 'tsx')
    expect(named(scan, 'ui')).toBe(0)
    expect(scan.memberUses).toEqual(expect.arrayContaining([{ object: 'ui', member: 'Button', owner: 'v' }]))
  })
})

describe('scanSymbols — code that runs when the module loads', () => {
  const cases: Array<[string, string, boolean]> = [
    ['export const server = listen()', 'server', true],
    ['const plain = 1', 'plain', false],
    ['const lazy = () => boot()', 'lazy', false],
    ['const inst = new Thing()', 'inst', true],
    ['const loaded = await load()', 'loaded', true],
    ['let counter = 0, bumped = counter++', 'bumped', true],
    ['const assigned = (target.x = 1)', 'assigned', true],
    ['const removed = delete target.x', 'removed', true],
    ['const tagged = sql`select 1`', 'tagged', true],
    ['@register class Decorated {}', 'Decorated', true],
    ['@register export class ExportDecorated {}', 'ExportDecorated', true],
    ['class WithStatic { static s = make() }', 'WithStatic', true],
    ['class WithBlock { static { init() } }', 'WithBlock', true],
    ['class Instance { y = make() }', 'Instance', false],
    ['class Method { m() { boot() } }', 'Method', false],
    ['class Extends extends mix(Base) {}', 'Extends', true],
    ['class MemberDecorated { @field z = 1 }', 'MemberDecorated', true],
    ['class MethodDecorated { @field m() {} }', 'MethodDecorated', true],
    ['class ComputedKey { [key()]() {} }', 'ComputedKey', true],
    ['enum Computed { A = compute() }', 'Computed', true],
    ['enum Plain { A = 1 }', 'Plain', false],
    ['function deferred() { boot() }', 'deferred', false],
  ]
  for (const [source, name, effect] of cases) {
    it(`${effect ? 'marks' : 'does not mark'} \`${source}\``, async () => {
      const scan = await symbols(`${source}\n`)
      expect(scan.declarations.find((d) => d.name === name)?.effect).toBe(effect)
    })
  }
})

describe('scanSymbols — `import m = require()`', () => {
  it('records it as a namespace import of the module', async () => {
    const scan = await symbols("import m = require('./a')\nexport const v = m.x\n")
    expect(scan.imports.map((e) => [e.specifier, e.kind, e.names])).toEqual([['./a', 'import', [{ imported: NAMESPACE_IMPORT, local: 'm' }]]])
    expect(scan.memberUses).toEqual(expect.arrayContaining([{ object: 'm', member: 'x', owner: 'v' }]))
  })
})

describe('scanSymbols — a dynamic import whose target is computed', () => {
  it('records the static prefix of a template', async () => {
    const scan = await symbols('export const load = (l: string) => import(`./locales/${l}.ts`)\n')
    expect(scan.dynamicPrefixes).toEqual(['./locales/'])
    expect(scan.unboundDynamic).toBe(false)
  })

  it('reads a template with no substitution as a plain specifier', async () => {
    const scan = await symbols('export const load = () => import(`./a.js`)\n')
    expect(scan.imports.map((e) => [e.specifier, e.kind])).toEqual([['./a.js', 'dynamic']])
  })

  it('records the static prefix of a concatenation', async () => {
    const scan = await symbols("export const load = (n: string) => require('./handlers/' + n)\n")
    expect(scan.dynamicPrefixes).toEqual(['./handlers/'])
  })

  it('records the directory of an import.meta.glob pattern', async () => {
    const scan = await symbols("export const pages = import.meta.glob('./pages/**/*.tsx')\n")
    expect(scan.dynamicPrefixes).toEqual(['./pages/'])
  })

  it('reads every positive pattern of a glob array and skips a negated one', async () => {
    const scan = await symbols("export const mods = import.meta.glob(['./a/*.ts', '!./a/x.ts', './b/**'])\n")
    expect(scan.dynamicPrefixes).toEqual(['./a/', './b/'])
    expect(scan.unboundDynamic).toBe(false)
  })

  it('records the directory of a require.context', async () => {
    const scan = await symbols("export const ctx = require.context('./dir', true, /x$/)\n")
    expect(scan.dynamicPrefixes).toEqual(['./dir/'])
  })

  it('flags an import whose target has no static part at all', async () => {
    const scan = await symbols('export const load = (name: string) => import(name)\n')
    expect(scan.unboundDynamic).toBe(true)
  })

  it('reads the specifier past a bundler comment', async () => {
    const scan = await symbols("export const load = () => import(/* webpackChunkName: \"a\" */ './a.js')\n")
    expect(scan.imports.map((e) => [e.specifier, e.kind])).toEqual([['./a.js', 'dynamic']])
  })

  it('does not treat a call through a parameter named require as an import', async () => {
    const scan = await symbols("export function load(require: (s: string) => unknown): unknown { return require('./a.js') }\n")
    expect(scan.imports).toEqual([])
    expect(scan.dynamicPrefixes).toEqual([])
    expect(scan.unboundDynamic).toBe(false)
  })
})

describe('scanSymbols — direct eval', () => {
  it('flags a direct eval, which can reach every binding of the module', async () => {
    expect((await symbols("eval('helper()')\n")).directEval).toBe(true)
  })

  it('does not flag an indirect eval or a shadowed one', async () => {
    expect((await symbols("window.eval('x')\n")).directEval).toBe(false)
    expect((await symbols("export function f(eval: (s: string) => void): void { eval('x') }\n")).directEval).toBe(false)
  })
})

describe('scanSymbols — module or classic script', () => {
  const cases: Array<[string, boolean]> = [
    ['const a = 1\nfunction b() {}', false],
    ['namespace N { export const a = 1 }', false],
    ["import './a.js'", true],
    ['export const a = 1', true],
    ['export {}', true],
    ["const x = require('./a')", true],
    ['module.exports = {}', true],
    ['exports.a = 1', true],
  ]
  for (const [source, isModule] of cases) {
    it(`reads \`${source.replace(/\n/g, ' ')}\` as ${isModule ? 'a module' : 'a script'}`, async () => {
      expect((await symbols(`${source}\n`)).module).toBe(isModule)
    })
  }
})

describe('scanSymbols — a JSX factory named by a pragma', () => {
  it('counts the factory as used when the file holds JSX', async () => {
    const scan = await symbols("/** @jsx h */\n/** @jsxFrag Fragment */\nimport { h, Fragment } from './jsx.js'\nexport const v = <div />\n", 'tsx')
    expect(scan.hasJsx).toBe(true)
    expect(scan.references).toEqual(expect.arrayContaining([{ name: 'h', owner: null }, { name: 'Fragment', owner: null }]))
  })

  it('does not count it when the file holds no JSX', async () => {
    const scan = await symbols("/** @jsx h */\nimport { h } from './jsx.js'\nexport const v = 1\n", 'tsx')
    expect(scan.hasJsx).toBe(false)
    expect(named(scan, 'h')).toBe(0)
  })
})

describe('scanSymbols — forms the first REVIEW left unpinned', () => {
  it('counts a shorthand property as a use', async () => {
    const scan = await symbols('function helper(): void {}\nexport const table = { helper }\n')
    expect(named(scan, 'helper')).toBe(1)
  })

  it('counts a use in a type position', async () => {
    const scan = await symbols('class Holder {}\nexport function take(h: Holder): void { void h }\n')
    expect(named(scan, 'Holder')).toBe(1)
  })

  it('does not let a var inside a nested function hide the outer name from the outer body', async () => {
    const scan = await symbols(
      'function helper(): number { return 1 }\nexport function live(): number { const inner = function () { var helper = 2; return helper }; return helper() + inner() }\n',
    )
    expect(named(scan, 'helper')).toBe(1)
  })

  const shadows: Array<[string, string]> = [
    ['a renamed destructured parameter', 'export function live({ a: helper }: { a: number }): number { return helper }'],
    ['an array pattern parameter', 'export function live([helper]: number[]): number { return helper }'],
    ['a rest parameter', 'export function live(...helper: number[]): number { return helper.length }'],
    ['an optional parameter', 'export function live(helper?: number): number { return helper ?? 0 }'],
    ['an unparenthesised arrow parameter', 'export const live = helper => helper'],
    ['a block-level function declaration', 'export function live(): void { { function helper(): void {} helper() } }'],
    ['a named function expression', 'export const live = function helper(n: number): number { return n > 0 ? helper(n - 1) : 0 }'],
    ['a block-level class', 'export function live(): unknown { { class helper {} return new helper() } }'],
  ]
  for (const [label, source] of shadows) {
    it(`does not count ${label} as a use of the top-level name`, async () => {
      const scan = await symbols(`function helper(): void {}\n${source}\n`)
      expect(named(scan, 'helper')).toBe(0)
    })
  }

  it('counts the default of a destructured parameter, while the binding itself shadows', async () => {
    const scan = await symbols('function helper(): void {}\nfunction other(): number { return 1 }\nexport function live({ helper = other() }: { helper?: number }): number { return helper }\n')
    expect(named(scan, 'helper')).toBe(0)
    expect(named(scan, 'other')).toBe(1)
  })

  it('records abstract classes and generators as declarations', async () => {
    const scan = await symbols('export abstract class Base {}\nexport function* gen(): Generator<number> { yield 1 }\n')
    expect(scan.declarations.map((d) => d.name).sort()).toEqual(['Base', 'gen'])
  })

  it('re-exports an imported binding under the clause alias', async () => {
    const scan = await symbols("import { a } from './impl.js'\nexport { a as b }\n")
    const reexport = scan.imports.find((e) => e.kind === 'reexport')
    expect(reexport?.specifier).toBe('./impl.js')
    expect(reexport?.names).toEqual([{ imported: 'a', local: 'b' }])
  })

  it('reads a call written right after a declaration, with no separator, as a top-level use', async () => {
    const scan = await symbols('function helper(){}helper()\n')
    expect(ownerOf(scan, 'helper')).toBeNull()
  })
})

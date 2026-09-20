import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMPORT,
  NAMESPACE_IMPORT,
  scanSymbols,
  type TreeSymbols,
} from '../../src/lib/comment-sweep/tree-engine.js'

async function symbols(source: string): Promise<TreeSymbols> {
  const result = await scanSymbols('typescript', source)
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

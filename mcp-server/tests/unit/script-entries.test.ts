import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const SCRIPTS = join(ROOT, 'src', 'scripts')
const DIST_SCRIPTS = join(ROOT, 'dist', 'scripts')

function typescriptFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'fixtures') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...typescriptFiles(full))
    else if (/\.(ts|mts|cts)$/.test(name)) out.push(full)
  }
  return out
}

function importedSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.push(m[1]!)
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]!)
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(m[1]!)
  return found
}

function insideScripts(path: string): boolean {
  const rel = relative(SCRIPTS, path)
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)
}

const launchers = readdirSync(SCRIPTS).filter((name) => name.endsWith('.ts'))
const compiled = existsSync(DIST_SCRIPTS) ? readdirSync(DIST_SCRIPTS).filter((name) => name.endsWith('.js')) : []

describe('hook launchers — src/scripts holds entry points only', () => {
  it('finds the launchers and their compiled files', () => {
    expect(launchers.length).toBeGreaterThan(0)
    expect(compiled.sort()).toEqual(launchers.map((name) => name.replace(/\.ts$/, '.js')).sort())
  })

  it('nothing in src or tests imports a launcher', () => {
    const offenders: string[] = []
    for (const file of [...typescriptFiles(join(ROOT, 'src')), ...typescriptFiles(join(ROOT, 'tests'))]) {
      for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue
        if (insideScripts(resolve(dirname(file), specifier))) {
          offenders.push(`${relative(ROOT, file)} imports ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it.each(launchers)('%s exports nothing', (name) => {
    const source = readFileSync(join(SCRIPTS, name), 'utf8')
    expect(source.split('\n').filter((line) => /^\s*export\b/.test(line))).toEqual([])
  })

  it.each(compiled)('compiled %s carries one entry and no check of how it was launched', (name) => {
    const lines = readFileSync(join(DIST_SCRIPTS, name), 'utf8').split('\n')
    expect(lines.filter((line) => line.startsWith('// src/scripts/'))).toEqual([`// src/scripts/${name.replace(/\.js$/, '.ts')}`])
    expect(lines.filter((line) => line.includes('process.argv[1]'))).toEqual([])
    expect(lines.filter((line) => /^export\b/.test(line))).toEqual([])
  })
})

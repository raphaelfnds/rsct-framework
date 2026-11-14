import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coverageHints, walkReverseDeps } from '../../src/lib/reverse-dep-walk.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-walk-found-'))
})

afterEach(() => {
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(base, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('2.25.0 — a seed the walk cannot key on, but that has importers, keeps them and is not called unavailable', () => {
  it('an in-root JSON seed imported by a TypeScript file', () => {
    writeFile('proj/src/config.json', '{}\n')
    writeFile('proj/src/main.ts', "import cfg from './config.json'\nexport const c = cfg\n")
    const out = walkReverseDeps({ projectRoot: join(base, 'proj'), seedPaths: ['src/config.json'] })
    expect(out.discovered.map((d) => d.file)).toEqual(['src/main.ts'])
    expect(out.coverage).toBe('uncovered')
    expect(out.uncovered_seeds).toEqual(['src/config.json'])
    const hint = coverageHints(out).join('\n')
    expect(hint).toContain('Importers of src/config.json were still found among the files it reads and are listed: a lower bound')
    expect(hint).not.toContain('UNAVAILABLE')
    expect(hint).not.toContain('No declared path is analyzable here')
  })

  it('a seed outside the project root imported from inside it', () => {
    writeFile('outside/x.ts', 'export const x = 1\n')
    writeFile('proj/src/exact.ts', "import { x } from '../../outside/x.js'\nexport const y = x\n")
    const out = walkReverseDeps({ projectRoot: join(base, 'proj'), seedPaths: ['../outside/x.ts'] })
    expect(out.discovered.map((d) => d.file)).toEqual(['src/exact.ts'])
    expect(out.coverage).toBe('uncovered')
    expect(out.uncovered_seeds).toEqual(['../outside/x.ts'])
    const hint = coverageHints(out).join('\n')
    expect(hint).toContain('Importers of ../outside/x.ts were still found')
    expect(hint).not.toContain('UNAVAILABLE')
  })

  it('names which uncovered seeds had importers and which stay unavailable', () => {
    writeFile('proj/src/config.json', '{}\n')
    writeFile('proj/src/style.css', 'a {}\n')
    writeFile('proj/src/main.ts', "import cfg from './config.json'\nexport const c = cfg\n")
    const out = walkReverseDeps({ projectRoot: join(base, 'proj'), seedPaths: ['src/config.json', 'src/style.css'] })
    expect(out.uncovered_seeds).toEqual(['src/config.json', 'src/style.css'])
    const hint = coverageHints(out).join('\n')
    expect(hint).toContain('Importers of src/config.json were still found')
    expect(hint).toContain('For src/style.css the importer set is UNAVAILABLE, not empty.')
    expect(hint).not.toContain('No declared path is analyzable here')
  })

  it('with no importer at all the hint is unchanged', () => {
    writeFile('proj/src/style.css', 'a {}\n')
    writeFile('proj/src/main.ts', 'export const c = 1\n')
    const out = walkReverseDeps({ projectRoot: join(base, 'proj'), seedPaths: ['src/style.css'] })
    expect(out.discovered).toEqual([])
    const hint = coverageHints(out).join('\n')
    expect(hint).toContain('src/style.css. For those paths the importer set is UNAVAILABLE, not empty. No declared path is analyzable here')
    expect(hint).not.toContain('were still found')
  })
})

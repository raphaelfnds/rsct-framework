import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { findDeadSymbols } from '../../src/lib/dead-code/references.js'

const ROOT = join(import.meta.dirname, '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'grammars') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(relative(ROOT, full).replace(/\\/g, '/'))
    }
  }
  return out
}

describe('the detector against this repository', () => {
  it('finds no dead value symbol in src, and names any it does', async () => {
    const corpus = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests'))]
    const targets = corpus.filter((f) => f.startsWith('src/'))
    const result = await findDeadSymbols({ projectRoot: ROOT, corpus, targets })
    const reported = result.dead.map((s) => `${s.path}:${s.name}`).sort()
    expect(reported).toEqual([])
  }, 60_000)
})

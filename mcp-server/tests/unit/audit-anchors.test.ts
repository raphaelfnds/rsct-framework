import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { retentionClassOf } from '../../src/lib/audit-retention.js'

const SRC = resolve(__dirname, '..', '..', 'src')
const RETENTION_MODULE = join('lib', 'audit-retention.ts')
const COMPARED = String.raw`\bevent(?:['"]\])?\s*[!=]==?\s*`
const LITERAL = new RegExp(String.raw`${COMPARED}(['"\x60])([^'"\x60]+)\1`, 'g')
const CONSTANT = new RegExp(String.raw`${COMPARED}([A-Z][A-Z0-9_]*)\b`, 'g')
const DECLARED = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]+)\2/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = join(dir, item.name)
    if (item.isDirectory()) return sourceFiles(full)
    return item.name.endsWith('.ts') ? [full] : []
  })
}

function comparedEvents(text: string, constants: Map<string, string>): string[] {
  const names = [...text.matchAll(LITERAL)].map((match) => match[2] ?? '')
  for (const match of text.matchAll(CONSTANT)) {
    const resolved = constants.get(match[1] ?? '')
    names.push(resolved ?? `unresolved:${match[1] ?? ''}`)
  }
  return names
}

function constantsIn(texts: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const text of texts) {
    for (const match of text.matchAll(DECLARED)) found.set(match[1] ?? '', match[3] ?? '')
  }
  return found
}

describe('audit-log readers and the retention rule name the same events (#93)', () => {
  const files = sourceFiles(SRC).filter((file) => relative(SRC, file) !== RETENTION_MODULE)
  const texts = files.map((file) => readFileSync(file, 'utf8'))
  const constants = constantsIn(texts)
  const compared = new Map<string, string>()
  files.forEach((file, index) => {
    for (const name of comparedEvents(texts[index] ?? '', constants)) {
      if (!compared.has(name)) compared.set(name, relative(SRC, file).split(sep).join('/'))
    }
  })

  it('finds the comparisons that exist today', () => {
    expect([...compared.keys()].sort()).toEqual([
      'approval.consumed',
      'classify.verdict',
      'plan_authorize.authorized',
      'plan_revoke.revoked',
      'review.dead_code_kept',
      'review.public_api_approved',
      'review.unverified_decision',
      'settings.baseline',
      'tutor.step',
    ])
  })

  it('every event a reader compares is one a cut never drops outright', () => {
    const dropped = [...compared.entries()].filter(([name]) => retentionClassOf(name) === 'dated')
    expect(dropped).toEqual([])
  })

  it('would catch a new comparison whose event the retention rule does not know', () => {
    const sample = [
      "if (entry.event === 'made.up_event') count++",
      'if (entry["event"] !== NEW_EVENT) return',
      'if (event == "double.quoted") x()',
    ].join('\n')
    const names = comparedEvents(sample, new Map([['NEW_EVENT', 'another.made_up']]))
    expect(names).toEqual(['made.up_event', 'double.quoted', 'another.made_up'])
    expect(names.map((name) => retentionClassOf(name))).toEqual(['dated', 'dated', 'dated'])
    expect(comparedEvents('if (event === MISSING_EVENT) x()', new Map())).toEqual(['unresolved:MISSING_EVENT'])
    expect(retentionClassOf('unresolved:MISSING_EVENT')).toBe('dated')
  })
})

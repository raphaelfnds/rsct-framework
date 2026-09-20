import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkDeadCode,
  checkStagedDeadCode,
  declarationSha256,
  mergeDeadCodeKeeps,
  readDeadCodeKeeps,
} from '../../src/lib/dead-code/review-gate.js'

let tmpRoot: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: tmpRoot, stdio: 'ignore' })
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-dcgate-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function commitAll(): void {
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
}

describe('checkDeadCode — the REVIEW gate', () => {
  it('passes when the touched files carry no dead symbol', async () => {
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
  })

  it('rejects a dead symbol in a touched file and names it', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_remaining')
    expect(check.reason).toContain('a.ts:rotting')
    expect(check.pending.map((p) => p.name)).toEqual(['rotting'])
  })

  it('hands back the declaration text and its sha256, so a keep can be bound to bytes', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    const pending = check.pending[0]
    expect(pending?.declaration).toBe('export function rotting(): void {}')
    expect(pending?.declaration_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('passes once the developer keeps it with the matching sha256', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const first = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (first.ok) throw new Error('expected a rejection')
    const pending = first.pending[0]!
    const second = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [
        {
          path: pending.path,
          name: pending.name,
          declaration_sha256: pending.declaration_sha256,
          note: 'kept on purpose, it fails the build when removed',
        },
      ],
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.kept).toBe(1)
  })

  it('refuses a keep whose declaration changed since the developer granted it', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const staleSha = createHash('sha256').update('export function rotting(): void {}', 'utf8').digest('hex')
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): number { return 1 }\n')
    const check = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: 'a.ts', name: 'rotting', declaration_sha256: staleSha, note: 'granted earlier' }],
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_keep_stale')
  })

  it('does not let a keep for one symbol cover another', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function first(): void {}\nexport function second(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const first = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (first.ok) throw new Error('expected a rejection')
    const one = first.pending.find((p) => p.name === 'first')!
    const second = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: one.path, name: one.name, declaration_sha256: one.declaration_sha256, note: 'keep' }],
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reject_kind).toBe('dead_code_remaining')
    expect(second.pending.map((p) => p.name)).toEqual(['second'])
  })

  it('ignores a touched file in a language it cannot analyse', async () => {
    writeFile('script.py', 'def orphan():\n    pass\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['script.py'], keeps: [] })
    expect(check.ok).toBe(true)
  })

  it('never judges an export of a declared public path', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      publicApi: ['a.ts'],
      keeps: [],
    })
    expect(check.ok).toBe(true)
  })
})

describe('checkStagedDeadCode — the commit gate', () => {
  it('passes when nothing staged is dead', async () => {
    writeFile('a.ts', 'export function used(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
  })

  it('refuses a staged file carrying a dead symbol, naming it and the path', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_staged')
    expect(check.reason).toContain('a.ts:rotting')
    expect(check.paths).toEqual(['a.ts'])
  })

  it('passes once the REVIEW recorded the developer keeping it', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const review = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (review.ok) throw new Error('expected the review to reject first')
    const pending = review.pending[0]!
    const records = mergeDeadCodeKeeps(
      undefined,
      [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'load-bearing' }],
      'spec-x',
      new Date().toISOString(),
    )
    const check = await checkStagedDeadCode({
      projectRoot: tmpRoot,
      stagedPaths: ['a.ts'],
      keeps: readDeadCodeKeeps(records),
    })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.kept).toBe(1)
  })

  it('refuses again once the kept declaration is edited', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    writeFile('b.ts', "import { used } from './a.js'\nexport const run = () => used()\n")
    commitAll()
    const review = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (review.ok) throw new Error('expected the review to reject first')
    const pending = review.pending[0]!
    const records = mergeDeadCodeKeeps(
      undefined,
      [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'load-bearing' }],
      'spec-x',
      new Date().toISOString(),
    )
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): number { return 7 }\n')
    const check = await checkStagedDeadCode({
      projectRoot: tmpRoot,
      stagedPaths: ['a.ts'],
      keeps: readDeadCodeKeeps(records),
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain('different declaration bytes')
  })
})

describe('readDeadCodeKeeps / mergeDeadCodeKeeps', () => {
  it('drops anything that is not a complete keep record', () => {
    expect(readDeadCodeKeeps('nope')).toEqual([])
    expect(readDeadCodeKeeps([{ path: 'a.ts' }])).toEqual([])
    expect(readDeadCodeKeeps([{ path: 'a.ts', name: 'x', declaration_sha256: 'abc' }])).toEqual([])
  })

  it('keeps a complete record', () => {
    const record = { path: 'a.ts', name: 'x', declaration_sha256: 'abc', note: 'why' }
    expect(readDeadCodeKeeps([record])).toEqual([record])
  })

  it('carries earlier keeps forward and replaces one granted again for the same bytes', () => {
    const first = mergeDeadCodeKeeps(
      undefined,
      [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'first' }],
      'spec-1',
      '2026-01-01T00:00:00.000Z',
    )
    const second = mergeDeadCodeKeeps(
      first,
      [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'second' }],
      'spec-2',
      '2026-01-02T00:00:00.000Z',
    )
    expect(second).toHaveLength(1)
    expect(second[0]?.note).toBe('second')
    expect(second[0]?.spec_ref).toBe('spec-2')
  })

  it('keeps both when the same symbol is kept for different declaration bytes', () => {
    const first = mergeDeadCodeKeeps(
      undefined,
      [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'old bytes' }],
      'spec-1',
      '2026-01-01T00:00:00.000Z',
    )
    const second = mergeDeadCodeKeeps(
      first,
      [{ path: 'a.ts', name: 'x', declaration_sha256: 'bb', note: 'new bytes' }],
      'spec-2',
      '2026-01-02T00:00:00.000Z',
    )
    expect(second).toHaveLength(2)
  })
})

describe('declarationSha256', () => {
  it('is stable across CRLF, so a checkout setting does not invalidate a keep', () => {
    const lf = 'export function a(): void {\n  return\n}'
    const crlf = 'export function a(): void {\r\n  return\r\n}'
    const symbol = { path: 'a.ts', name: 'a', kind: 'value' as const, exported: true, start: 0, end: lf.length }
    const crlfSymbol = { ...symbol, end: crlf.length }
    expect(declarationSha256(lf, symbol)).toBe(declarationSha256(crlf, crlfSymbol))
  })

  it('changes when the declaration body changes', () => {
    const a = 'export function x(): number { return 1 }'
    const b = 'export function x(): number { return 2 }'
    const symbol = { path: 'a.ts', name: 'x', kind: 'value' as const, exported: true, start: 0, end: a.length }
    expect(declarationSha256(a, symbol)).not.toBe(declarationSha256(b, { ...symbol, end: b.length }))
  })
})

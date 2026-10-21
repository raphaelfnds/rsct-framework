import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { appendAuditEntry, clearAuditMigrationMemo, decideAuditPath } from '../../src/lib/audit-log.js'
import { anchorHints } from '../../src/lib/gate-dialog.js'
import { pruneAuditLog } from '../../src/lib/audit-retention.js'
import { clearAnchorCache } from '../../src/lib/repo-anchor.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-audit-path-'))
  mkdirSync(join(root, '.rsct'), { recursive: true })
  clearAnchorCache()
  clearAuditMigrationMemo()
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

const NUL = String.fromCharCode(0)
const WINDOWS = process.platform === 'win32'
const fallback = (): string => join(root, '.rsct', 'audit.log')

describe('an audit.path no regular file can sit at is ignored, and the default log is used', () => {
  it.each([
    ['a NUL', `.rsct/a${NUL}b.log`, 'name'],
    ['a control character', `.rsct/a${String.fromCharCode(1)}b.log`, 'name'],
    ['a tab', `.rsct/a${String.fromCharCode(9)}b.log`, 'name'],
    ['the project folder itself', '.', 'not_a_file'],
    ['an existing folder', '.rsct', 'not_a_file'],
    ['a path through a file', '.rsct.json/audit.log', 'not_a_file'],
  ])('%s', (_what, path, reason) => {
    writeFileSync(join(root, '.rsct.json'), '{}', 'utf8')
    const decision = decideAuditPath(root, { path })
    expect(decision.path).toBe(fallback())
    expect(decision.escaped).toBeNull()
    expect(decision.unusable).toEqual({ path, reason })
  })

  it.runIf(WINDOWS).each([
    ['a stream of the default log', '.rsct/audit.log:x', 'stream'],
    ['the default data stream', '.rsct/audit.log::$DATA', 'stream'],
    ['a forbidden character', '.rsct/a?.log', 'name'],
    ['a pipe', '.rsct/a|b.log', 'name'],
    ['a reserved device name', '.rsct/NUL', 'name'],
    ['a reserved name with an extension', '.rsct/nul.log', 'name'],
    ['a reserved name as a folder', 'con/audit.log', 'name'],
    ['a reserved port name with a superscript digit', `.rsct/COM${String.fromCharCode(0xb9)}`, 'name'],
    ['a stream whose name holds a control character', `.rsct/audit.log:x${String.fromCharCode(9)}y`, 'stream'],
    ['a trailing dot', '.rsct/audit.log.', 'name'],
    ['a trailing space', '.rsct/audit.log ', 'name'],
  ])('on Windows, %s', (_what, path, reason) => {
    const decision = decideAuditPath(root, { path })
    expect(decision.path).toBe(fallback())
    expect(decision.unusable).toEqual({ path, reason })
  })

  it.runIf(WINDOWS)('while the value names a stream, retention cuts no log and the stream keeps what it holds', () => {
    const stream = `${fallback()}:x${String.fromCharCode(9)}y`
    const old = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'code.start' })
    writeFileSync(fallback(), `${old}\n`, 'utf8')
    writeFileSync(stream, `${old}\n`, 'utf8')
    const outcomes = pruneAuditLog(root, { path: `.rsct/audit.log:x${String.fromCharCode(9)}y` }, new Date('2026-10-21T12:00:00.000Z'))
    expect(outcomes.map((o) => ('reason' in o ? o.reason : o.status))).toEqual(['stream_path'])
    expect(readFileSync(stream, 'utf8')).toBe(`${old}\n`)
  })

  it.runIf(!WINDOWS)('outside Windows a colon is part of a file name and is kept', () => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    const decision = decideAuditPath(root, { path: 'logs/audit:x.log' })
    expect(decision.path).toBe(join(root, 'logs', 'audit:x.log'))
    expect(decision.unusable).toBeNull()
  })

  it('an ordinary path inside the project is used, whether the file exists yet or not', () => {
    expect(decideAuditPath(root, { path: 'logs/new/audit.log' })).toMatchObject({ path: join(root, 'logs', 'new', 'audit.log'), unusable: null, escaped: null })
    writeFileSync(join(root, '.rsct', 'other.log'), '', 'utf8')
    expect(decideAuditPath(root, { path: '.rsct/other.log' })).toMatchObject({ path: join(root, '.rsct', 'other.log'), unusable: null })
  })

  it('the project folder itself is refused even before the folder exists', () => {
    const missing = join(root, 'not-created-yet')
    const decision = decideAuditPath(missing, { path: '.' })
    expect(decision.unusable).toEqual({ path: '.', reason: 'not_a_file' })
    expect(decision.path).toBe(join(missing, '.rsct', 'audit.log'))
  })

  it('a path outside the project is still reported as escaped, not as unusable', () => {
    const decision = decideAuditPath(root, { path: '../elsewhere.log' })
    expect(decision.path).toBe(fallback())
    expect(decision.escaped).not.toBeNull()
    expect(decision.unusable).toBeNull()
  })

  it('writes land in the default log, which the developer can open', () => {
    const path = WINDOWS ? '.rsct/audit.log:x' : `.rsct/a${NUL}b.log`
    const result = appendAuditEntry(root, { event: 'probe.line', tool: 'test' }, { path })
    expect(result).toEqual({ ok: true, path: fallback() })
    expect(statSync(fallback()).size).toBeGreaterThan(0)
    expect(readFileSync(fallback(), 'utf8')).toContain('"probe.line"')
  })

  it('the tool hints name the ignored value and why, quoting what a terminal would hide', () => {
    const hints = anchorHints(root, { path: `.rsct/a${NUL}b.log` })
    const line = hints.find((hint) => hint.includes('audit.path'))
    expect(line).toBeDefined()
    expect(line).toContain('\\u0000')
    expect(line).toContain('a control character')
    expect(line).toContain('was ignored')
    expect(line).not.toContain('OUTSIDE')
    const folder = anchorHints(root, { path: '.rsct' }).find((hint) => hint.includes('audit.path'))
    expect(folder).toContain('names a folder')
  })
})

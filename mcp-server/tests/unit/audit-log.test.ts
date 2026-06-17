import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendAuditEntry, resolveAuditPath } from '../../src/lib/audit-log.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-audit-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

describe('lib/audit-log — resolveAuditPath', () => {
  it('defaults to <root>/.rsct/audit.log', () => {
    expect(resolveAuditPath(tmpRoot)).toBe(join(tmpRoot, '.rsct', 'audit.log'))
  })

  it('honors a relative path from audit.path (anchored at project root)', () => {
    const p = resolveAuditPath(tmpRoot, { path: 'logs/rsct.jsonl' })
    expect(p).toBe(join(tmpRoot, 'logs', 'rsct.jsonl'))
  })

  it('honors an absolute path from audit.path verbatim', () => {
    const abs = join(tmpRoot, 'absolute', 'a.log')
    expect(resolveAuditPath(tmpRoot, { path: abs })).toBe(abs)
  })
})

describe('lib/audit-log — appendAuditEntry', () => {
  it('creates the .rsct directory and appends a JSONL entry with auto-stamped ts', () => {
    const result = appendAuditEntry(tmpRoot, {
      event: 'test.event',
      tool: 'rsct_request_commit',
      detail: { foo: 'bar' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe(join(tmpRoot, '.rsct', 'audit.log'))
    const content = readFileSync(result.path, 'utf8')
    expect(content.endsWith('\n')).toBe(true)

    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.event).toBe('test.event')
    expect(parsed.tool).toBe('rsct_request_commit')
    expect(parsed.detail).toEqual({ foo: 'bar' })
    expect(typeof parsed.ts).toBe('string')
    expect(Number.isNaN(new Date(parsed.ts as string).getTime())).toBe(false)
  })

  it('appends across multiple calls (one JSON line per call)', () => {
    appendAuditEntry(tmpRoot, { event: 'a' })
    appendAuditEntry(tmpRoot, { event: 'b' })
    appendAuditEntry(tmpRoot, { event: 'c' })

    const content = readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(3)
    expect((JSON.parse(lines[0]!) as { event: string }).event).toBe('a')
    expect((JSON.parse(lines[1]!) as { event: string }).event).toBe('b')
    expect((JSON.parse(lines[2]!) as { event: string }).event).toBe('c')
  })

  it('returns { ok: false, reason: "disabled" } when audit.enabled === false', () => {
    const result = appendAuditEntry(tmpRoot, { event: 'noop' }, { enabled: false })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('disabled')
    expect(existsSync(join(tmpRoot, '.rsct'))).toBe(false)
  })

  it('returns { ok: false, reason: "write_failed" } when the parent path is a file (portable failure)', () => {
    // Place a regular file where the writer expects a directory; mkdirSync on a path
    // whose ancestor is a file fails with ENOTDIR/EEXIST on every platform we support.
    const blockingFile = join(tmpRoot, 'blocker')
    writeFileSync(blockingFile, 'not-a-dir', 'utf8')

    const result = appendAuditEntry(
      tmpRoot,
      { event: 'fail' },
      { path: join(blockingFile, 'audit.log') },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('write_failed')
      expect(typeof result.error).toBe('string')
    }
  })
})

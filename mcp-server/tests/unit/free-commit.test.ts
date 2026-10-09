import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deriveAuditCeiling,
  higherTier,
  isFreeTier,
} from '../../src/lib/free-commit.js'

const NOW = new Date('2026-07-11T12:00:00.000Z')
let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-free-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function makeProject(root: string, auditLines: Array<Record<string, unknown>>) {
  writeFileSync(
    join(root, '.rsct.json'),
    JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
    'utf8',
  )
  mkdirSync(join(root, '.rsct'), { recursive: true })
  const body = auditLines.map((l) => JSON.stringify({ ...l, ts: NOW.toISOString() })).join('\n') + '\n'
  writeFileSync(join(root, '.rsct', 'audit.log'), body, 'utf8')
}

describe('lib/free-commit — helpers', () => {
  it('isFreeTier is explicit membership (not a rank comparison)', () => {
    expect(isFreeTier('trivial')).toBe(true)
    expect(isFreeTier('small')).toBe(true)
    expect(isFreeTier('standard')).toBe(false)
    expect(isFreeTier('complex')).toBe(false)
    expect(isFreeTier(undefined)).toBe(false)
  })
  it('higherTier returns the higher-ranked tier', () => {
    expect(higherTier('trivial', 'complex')).toBe('complex')
    expect(higherTier('small', undefined)).toBe('small')
    expect(higherTier(undefined, undefined)).toBeUndefined()
  })
})

describe('lib/free-commit — deriveAuditCeiling', () => {
  it('reconstructs the tier ratchet as the MAX over classify.verdict tiers', () => {
    makeProject(tmpRoot, [
      { event: 'classify.verdict', tier: 'small' },
      { event: 'classify.verdict', tier: 'complex' },
      { event: 'classify.verdict', tier: 'trivial' }, // a later weaker classify must NOT lower it
    ])
    expect(deriveAuditCeiling(tmpRoot, null).auditTierMax).toBe('complex')
  })

  it('is CRLF-tolerant', () => {
    writeFileSync(
      join(tmpRoot, '.rsct.json'),
      JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
      'utf8',
    )
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'audit.log'),
      `${JSON.stringify({ event: 'classify.verdict', tier: 'small' })}\r\n${JSON.stringify({ event: 'classify.verdict', tier: 'complex' })}\r\n`,
      'utf8',
    )
    const c = deriveAuditCeiling(tmpRoot, null)
    expect(c.classifyEvidencePresent).toBe(true)
    expect(c.auditTierMax).toBe('complex')
  })

  it('fails closed (no evidence) when the log is absent', () => {
    const c = deriveAuditCeiling(tmpRoot, null)
    expect(c.classifyEvidencePresent).toBe(false)
    expect(c.auditTierMax).toBeNull()
  })
})

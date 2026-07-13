import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateMcpHealth } from '../../src/lib/health.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-health-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

const FIXED_NOW = new Date('2026-07-11T12:00:00.000Z')

/** Write a project that passes every health signal. */
function makeHealthyProject(root: string) {
  writeFileSync(
    join(root, '.rsct.json'),
    JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }, null, 2),
    'utf8',
  )
  mkdirSync(join(root, '.rsct'), { recursive: true })
  writeFileSync(
    join(root, '.rsct', 'audit.log'),
    `${JSON.stringify({ event: 'install', ts: FIXED_NOW.toISOString() })}\n`,
    'utf8',
  )
}

describe('lib/health — evaluateMcpHealth', () => {
  it('is healthy when config, phase-state and a non-empty audit log are intact', () => {
    makeHealthyProject(tmpRoot)
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(true)
    expect(h.reasons).toEqual([])
  })

  it('fails closed when `.rsct.json` is absent', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'x\n', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('config_absent')
  })

  it('fails closed when `.rsct.json` is unparseable', () => {
    makeHealthyProject(tmpRoot)
    writeFileSync(join(tmpRoot, '.rsct.json'), '{ not json', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('config_unparseable')
  })

  it('fails closed when phase-state.json is corrupt', () => {
    makeHealthyProject(tmpRoot)
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), '{ torn', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('phase_state_corrupt')
  })

  it('is healthy with a VALID phase-state.json present', () => {
    makeHealthyProject(tmpRoot)
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify({ spec_slug: 'foo' }, null, 2),
      'utf8',
    )
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(true)
  })

  it('fails closed when the audit log is absent (anti-wipe / HISTORY signal)', () => {
    writeFileSync(
      join(tmpRoot, '.rsct.json'),
      JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
      'utf8',
    )
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('audit_history_absent')
  })

  it('fails closed when the audit log exists but is EMPTY (wipe/truncate)', () => {
    makeHealthyProject(tmpRoot)
    writeFileSync(join(tmpRoot, '.rsct', 'audit.log'), '', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('audit_history_absent')
  })

  it('fails closed on a STALE phase-state lock (crashed writer)', () => {
    makeHealthyProject(tmpRoot)
    const staleLockedAt = new Date(FIXED_NOW.getTime() - 60_000).toISOString() // 60s old
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.lock'),
      JSON.stringify({ locked_at: staleLockedAt }),
      'utf8',
    )
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('phase_state_lock_stale')
  })

  it('fails closed on a garbage (unparseable) lock file', () => {
    makeHealthyProject(tmpRoot)
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.lock'), 'not-json', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('phase_state_lock_stale')
  })

  it('stays healthy with a FRESH (held) lock — a concurrent write is not a fault', () => {
    makeHealthyProject(tmpRoot)
    const freshLockedAt = new Date(FIXED_NOW.getTime() - 1_000).toISOString() // 1s old
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.lock'),
      JSON.stringify({ locked_at: freshLockedAt }),
      'utf8',
    )
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.reasons).not.toContain('phase_state_lock_stale')
    expect(h.healthy).toBe(true)
  })

  it('honors a custom audit.path from config', () => {
    writeFileSync(
      join(tmpRoot, '.rsct.json'),
      JSON.stringify({ rsct_version: '2.1.1', app: { name: 'x', org: 'y' } }),
      'utf8',
    )
    mkdirSync(join(tmpRoot, 'logs'), { recursive: true })
    writeFileSync(join(tmpRoot, 'logs', 'a.log'), 'entry\n', 'utf8')
    const h = evaluateMcpHealth(tmpRoot, {
      now: FIXED_NOW,
      config: { rsct_version: '2.1.1', app: { name: 'x', org: 'y' }, audit: { path: 'logs/a.log' } },
    })
    expect(h.reasons).not.toContain('audit_history_absent')
    expect(h.healthy).toBe(true)
  })

  it('accumulates multiple reasons', () => {
    // no config, no audit log
    const h = evaluateMcpHealth(tmpRoot, { now: FIXED_NOW })
    expect(h.healthy).toBe(false)
    expect(h.reasons).toContain('config_absent')
    expect(h.reasons).toContain('audit_history_absent')
  })
})

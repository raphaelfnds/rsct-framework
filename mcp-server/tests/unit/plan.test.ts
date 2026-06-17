import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findActivePlan, isPlanComplete } from '../../src/lib/plan.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rsct-plan-'))
})

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
})

const planBody = (status: string): string =>
  `# Plan\n\n| Field | Value |\n|---|---|\n| Status | ${status} |\n| Branch | feat/x |\n`

describe('lib/plan — findActivePlan', () => {
  it('returns null when no plan/spec files exist', () => {
    expect(findActivePlan(tmp)).toBeNull()
  })

  it('detects a plan_<slug>.md and reads its Status', () => {
    writeFileSync(join(tmp, 'plan_foo.md'), planBody('in progress'))
    const p = findActivePlan(tmp)
    expect(p?.slug).toBe('foo')
    expect(p?.status).toBe('in progress')
  })

  it('detects a spec_<slug>.md alias (CAP-53)', () => {
    writeFileSync(join(tmp, 'spec_bar.md'), planBody('completed'))
    const p = findActivePlan(tmp)
    expect(p?.slug).toBe('bar')
    expect(p?.status).toBe('completed')
  })

  it('links progress_<slug>.md when present', () => {
    writeFileSync(join(tmp, 'plan_foo.md'), planBody('x'))
    writeFileSync(join(tmp, 'progress_foo.md'), 'log\n')
    const p = findActivePlan(tmp)
    expect(p?.progress_path).toContain('progress_foo.md')
  })
})

describe('lib/plan — isPlanComplete', () => {
  it('is false for null / empty / in-progress', () => {
    expect(isPlanComplete(null)).toBe(false)
    expect(isPlanComplete(undefined)).toBe(false)
    expect(isPlanComplete('')).toBe(false)
    expect(isPlanComplete('in progress')).toBe(false)
    expect(isPlanComplete('blocked')).toBe(false)
  })

  it('is false for "incomplete" (must not match "complete")', () => {
    expect(isPlanComplete('incomplete')).toBe(false)
  })

  it('is true for completion words (EN + pt-BR)', () => {
    for (const s of [
      'completed',
      'Done',
      'CLOSED',
      'shipped',
      'finished',
      'concluído',
      'concluida',
      'Status: complete',
    ]) {
      expect(isPlanComplete(s)).toBe(true)
    }
  })
})

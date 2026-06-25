import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findActivePlan, findPlanBySlug, isPlanComplete } from '../../src/lib/plan.js'

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

describe('lib/plan — findPlanBySlug (T3/FV1: stable against mtime drift)', () => {
  it('returns null when neither plan_<slug>.md nor spec_<slug>.md exists', () => {
    expect(findPlanBySlug(tmp, 't3')).toBeNull()
  })

  it('resolves plan_<slug>.md and reads its Status', () => {
    writeFileSync(join(tmp, 'plan_t3.md'), planBody('in progress'))
    const p = findPlanBySlug(tmp, 't3')
    expect(p?.slug).toBe('t3')
    expect(p?.status).toBe('in progress')
  })

  it('falls back to spec_<slug>.md when no plan_<slug>.md', () => {
    writeFileSync(join(tmp, 'spec_t3.md'), planBody('completed'))
    const p = findPlanBySlug(tmp, 't3')
    expect(p?.slug).toBe('t3')
    expect(p?.status).toBe('completed')
  })

  it('resolves the token plan by slug even when an UNRELATED spec is newer (no mtime drift)', () => {
    // The whole point of FV1: token validation must not flip to a different plan
    // just because another spec_/plan_ was touched more recently.
    writeFileSync(join(tmp, 'plan_t3.md'), planBody('in progress'))
    writeFileSync(join(tmp, 'spec_unrelated.md'), '# other\n')
    // Make the unrelated spec deterministically NEWER (mtime drift) so
    // findActivePlan flips to it while findPlanBySlug stays pinned to 't3'.
    utimesSync(join(tmp, 'plan_t3.md'), new Date(1_000_000), new Date(1_000_000))
    utimesSync(join(tmp, 'spec_unrelated.md'), new Date(5_000_000), new Date(5_000_000))
    expect(findPlanBySlug(tmp, 't3')?.slug).toBe('t3')
    expect(findActivePlan(tmp)?.slug).toBe('unrelated')
  })

  it('links progress_<slug>.md when present', () => {
    writeFileSync(join(tmp, 'plan_t3.md'), planBody('x'))
    writeFileSync(join(tmp, 'progress_t3.md'), 'log\n')
    expect(findPlanBySlug(tmp, 't3')?.progress_path).toContain('progress_t3.md')
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

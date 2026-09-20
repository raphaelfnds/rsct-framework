import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPhaseState,
  stampClassifyVerdict,
  stampContextStale,
  stampPlanDisposition,
  stampReviewCompleted,
  type WritePhaseStateResult,
} from '../../src/lib/phase-scope.js'

let root: string
const CORRUPT = '{ "spec_slug": "feat-foo", "review_sweep": {'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-unreadable-'))
  mkdirSync(join(root, '.rsct'), { recursive: true })
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

const statePath = (): string => join(root, '.rsct', 'phase-state.json')
const raw = (): string => readFileSync(statePath(), 'utf8')

const writers: Array<[string, () => WritePhaseStateResult]> = [
  ['stampContextStale', () => stampContextStale(root, 'plan_closed')],
  ['stampClassifyVerdict', () => stampClassifyVerdict(root, { tier: 'complex' })],
  ['stampReviewCompleted', () => stampReviewCompleted(root, { spec_ref: 'feat-foo', completed_at: 'now' })],
  [
    'stampPlanDisposition',
    () => stampPlanDisposition(root, { plan_slug: 'feat-foo', decision: 'keep', decided_at: 'now' }),
  ],
]

describe('phase-state writers refuse an unreadable file instead of overwriting it (#77)', () => {
  for (const [name, write] of writers) {
    it(`${name} leaves a corrupt phase-state.json byte-identical`, () => {
      writeFileSync(statePath(), CORRUPT, 'utf8')
      const before = raw()
      const result = write()
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe('unreadable_state')
      expect(raw()).toBe(before)
    })

    it(`${name} says the file could not be read and that nothing was overwritten`, () => {
      writeFileSync(statePath(), CORRUPT, 'utf8')
      const result = write()
      expect(result.ok === false && result.error).toContain('could not be read')
      expect(result.ok === false && result.error).toContain('nothing was overwritten')
    })

    it(`${name} still writes when the file is readable`, () => {
      writeFileSync(statePath(), JSON.stringify({ spec_slug: 'feat-foo', bootstrap_at: 'earlier' }), 'utf8')
      expect(write().ok).toBe(true)
      const state = readPhaseState(root).state
      expect(state?.spec_slug).toBe('feat-foo')
      expect(state?.bootstrap_at).toBe('earlier')
    })
  }

  it('a top-level value that is not an object is refused too', () => {
    writeFileSync(statePath(), '"just a string"', 'utf8')
    const result = stampClassifyVerdict(root, { tier: 'small' })
    expect(result.ok === false && result.reason).toBe('unreadable_state')
    expect(raw()).toBe('"just a string"')
  })

  it('an absent file is not an unreadable one: the writer creates it', () => {
    const result = stampClassifyVerdict(root, { tier: 'small' })
    expect(result.ok).toBe(true)
    expect(readPhaseState(root).state?.last_classify?.tier).toBe('small')
  })
})

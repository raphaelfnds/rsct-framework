import { describe, it, expect } from 'vitest'
import {
  FINDING_ACTIONS,
  emptyActionsSummary,
  makeIdGenerator,
} from '../../src/lib/findings.js'

/**
 * The five values used to be hand-written in FOUR places. These tests pin the
 * single source, and in particular that the summary is DERIVED from the value
 * list — a hand-written initializer is the copy most likely to silently omit a
 * newly added action.
 */
describe('findings vocabulary (#19)', () => {
  it('carries exactly the five actions, ordered high to low', () => {
    expect([...FINDING_ACTIONS]).toEqual([
      'block',
      'address-now',
      'capture-as-issue',
      'defer',
      'accept',
    ])
  })

  it('derives a zero summary with one key per action — no hand-written copy', () => {
    const summary = emptyActionsSummary()
    expect(Object.keys(summary).sort()).toEqual([...FINDING_ACTIONS].sort())
    expect(Object.values(summary).every((v) => v === 0)).toBe(true)
  })

  it('returns a FRESH summary each call — a shared object would leak counts between phases', () => {
    const a = emptyActionsSummary()
    a.block = 3
    expect(emptyActionsSummary().block).toBe(0)
  })
})

describe('makeIdGenerator', () => {
  it('numbers sequentially across categories', () => {
    const next = makeIdGenerator('v')
    expect(next('gap')).toBe('v-gap-1')
    expect(next('breakage')).toBe('v-breakage-2')
    expect(next('gap')).toBe('v-gap-3')
  })

  it('keeps V and REVIEW ids distinguishable — they share an audit trail', () => {
    // findings_actions[] references these ids by hand, so a collision between
    // phases would let a dev resolve the wrong finding without noticing.
    expect(makeIdGenerator('v')('gap')).not.toBe(makeIdGenerator('r')('gap'))
  })

  it('each generator has its own counter', () => {
    const a = makeIdGenerator('v')
    a('gap')
    expect(makeIdGenerator('v')('gap')).toBe('v-gap-1')
  })
})

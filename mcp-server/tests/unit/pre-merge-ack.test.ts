import { describe, it, expect } from 'vitest'
import {
  evaluatePreMergeAck,
  preMergeAckHint,
  PRE_MERGE_ACK_ITEMS,
} from '../../src/lib/pre-merge-ack.js'

const full = () => ({
  plan_complete: true,
  adr_confirmed: true,
  issues_resolved: true,
  note: 'ADR-012 recorded; issue #7 closed',
})

describe('evaluatePreMergeAck', () => {
  it('missing ack ⇒ pre_merge_ack_missing', () => {
    expect(evaluatePreMergeAck(undefined)).toEqual({ ok: false, kind: 'pre_merge_ack_missing' })
  })

  it('all true + note ⇒ ok', () => {
    expect(evaluatePreMergeAck(full())).toEqual({ ok: true })
  })

  it('a false boolean lands in failing', () => {
    const d = evaluatePreMergeAck({ ...full(), plan_complete: false })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing).toContain('plan_complete')
    } else {
      throw new Error('expected incomplete')
    }
  })

  it('a MISSING boolean (undefined) is treated as not-attested (graceful, not a throw)', () => {
    const d = evaluatePreMergeAck({ adr_confirmed: true, issues_resolved: true, note: 'x' })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing).toContain('plan_complete')
    } else {
      throw new Error('expected incomplete')
    }
  })

  it('all three false ⇒ all three in failing (and note NOT required — no positive attestation)', () => {
    const d = evaluatePreMergeAck({
      plan_complete: false,
      adr_confirmed: false,
      issues_resolved: false,
    })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      for (const item of PRE_MERGE_ACK_ITEMS) expect(d.failing).toContain(item)
      expect(d.failing.some((f) => f.startsWith('note'))).toBe(false)
    } else {
      throw new Error('expected incomplete')
    }
  })

  it('note required when adr_confirmed is true and note is blank', () => {
    const d = evaluatePreMergeAck({ ...full(), note: '   ' })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing.some((f) => f.startsWith('note'))).toBe(true)
    } else {
      throw new Error('expected incomplete')
    }
  })

  it('note required when issues_resolved is true and note is missing', () => {
    const d = evaluatePreMergeAck({ plan_complete: true, adr_confirmed: false, issues_resolved: true })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      // adr_confirmed false is a failing item, and the note is required (issues true)
      expect(d.failing).toContain('adr_confirmed')
      expect(d.failing.some((f) => f.startsWith('note'))).toBe(true)
    } else {
      throw new Error('expected incomplete')
    }
  })
})

describe('preMergeAckHint', () => {
  it('missing hint names the checklist and states no dialog ran', () => {
    const h = preMergeAckHint({ kind: 'pre_merge_ack_missing' })
    expect(h).toContain('pre_merge_ack')
    expect(h).toContain('No OS dialog')
  })

  it('incomplete hint lists the failing items', () => {
    const h = preMergeAckHint({ kind: 'pre_merge_ack_incomplete', failing: ['plan_complete', 'note (…)'] })
    expect(h).toContain('plan_complete')
  })
})

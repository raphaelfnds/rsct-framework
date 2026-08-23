import { describe, it, expect } from 'vitest'
import {
  evaluatePreMergeAck,
  preMergeAckHint,
  PRE_MERGE_ACK_ITEMS,
  MAX_UNSWEPT_LISTED,
  MAX_FILES_SWEPT,
  describeCrossCheck,
  crossCheckBlockedReason,
} from '../../src/lib/pre-merge-ack.js'

const full = () => ({
  plan_complete: true,
  adr_confirmed: true,
  issues_resolved: true,
  hygiene_swept: true,
  note: 'ADR-012 recorded; issue #7 closed; swept 3 files',
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

  it('all four false ⇒ all four in failing (and note NOT required — no positive attestation)', () => {
    const d = evaluatePreMergeAck({
      plan_complete: false,
      adr_confirmed: false,
      issues_resolved: false,
      hygiene_swept: false,
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

// #62 — the fourth item and the coverage cross-check.
describe('evaluatePreMergeAck — hygiene_swept (#62)', () => {
  // Breaks on: deleting the `ack.hygiene_swept !== true` clause. Without it the
  // fourth item is decorative — an ack omitting it entirely would pass.
  it('a missing or false hygiene_swept lands in failing', () => {
    for (const v of [undefined, false] as const) {
      const d = evaluatePreMergeAck({ ...full(), hygiene_swept: v })
      expect(d.ok).toBe(false)
      if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
        expect(d.failing).toContain('hygiene_swept')
      } else throw new Error('expected incomplete')
    }
  })

  // Breaks on: dropping `hygiene_swept` from the attestedPositive disjunction.
  // Kept deliberately even though it changes no verdict on its own (a passing
  // ack already requires adr_confirmed, so the disjunction is already true) —
  // this pins the MESSAGE, so the reject names why the note is owed.
  it('hygiene_swept true with a blank note names the note requirement', () => {
    const d = evaluatePreMergeAck({
      plan_complete: true, adr_confirmed: false, issues_resolved: false,
      hygiene_swept: true, note: '   ',
    })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      const note = d.failing.find((f) => f.startsWith('note'))
      expect(note).toBeDefined()
      expect(note).toContain('hygiene_swept')
    } else throw new Error('expected incomplete')
  })

  // Breaks on: adding 'files_swept' to PRE_MERGE_ACK_ITEMS. That constant is
  // emitted verbatim as the audit label `pre_merge_ack_self_attested` at all
  // three call sites; an evidence ARRAY in it would make the label claim
  // something it is not.
  it('PRE_MERGE_ACK_ITEMS holds the four booleans and NOT files_swept', () => {
    expect([...PRE_MERGE_ACK_ITEMS]).toEqual([
      'plan_complete', 'adr_confirmed', 'issues_resolved', 'hygiene_swept',
    ])
  })
})

describe('evaluatePreMergeAck — files_swept coverage cross-check (#62)', () => {
  const swept = (files: string[], over: Record<string, unknown> = {}) =>
    ({ ...full(), files_swept: files, ...over })

  // Breaks on: skipping the cross-check when the booleans all pass. This is THE
  // machine-contradictable item — a carried path never claimed must reject even
  // on an otherwise perfect ack.
  it('a carried path absent from files_swept rejects a fully-attested ack', () => {
    const d = evaluatePreMergeAck(swept(['a.ts']), { carriedPaths: ['a.ts', 'b.ts'] })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing.some((f) => f.startsWith('files_swept'))).toBe(true)
      expect(d.unswept).toEqual(['b.ts'])
    } else throw new Error('expected incomplete')
  })

  // Breaks on: gating the cross-check behind the booleans (e.g. running it only
  // when hygiene_swept === true). The AC is explicit: it rejects regardless.
  it('runs even when hygiene_swept is false — independent of the booleans', () => {
    const d = evaluatePreMergeAck(swept([], { hygiene_swept: false }), {
      carriedPaths: ['a.ts'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing).toContain('hygiene_swept')
      expect(d.unswept).toEqual(['a.ts'])
    } else throw new Error('expected incomplete')
  })

  // Breaks on: comparing raw strings instead of normalizing both sides. Each
  // entry is a real shape an agent emits: Windows separators, a ./ prefix, a
  // trailing slash, and macOS NFD (readdir) against git's NFC.
  it('normalizes separators, ./ prefix, trailing slash and Unicode form', () => {
    // Built with .normalize() rather than typed literals, so the assertion does
    // not depend on how THIS file happens to be encoded on disk.
    const nfd = 'src/café.ts'.normalize('NFD') // e + combining acute (macOS readdir)
    const nfc = 'src/café.ts'.normalize('NFC') // precomposed e-acute (git)
    expect(nfd).not.toBe(nfc) // anti-vacuity: the two forms must really differ
    const d = evaluatePreMergeAck(
      swept(['src\\a.ts', './src/b.ts', 'src/dir/', nfd]),
      { carriedPaths: ['src/a.ts', 'src/b.ts', 'src/dir', nfc] },
    )
    expect(d.ok).toBe(true)
  })

  // Breaks on: folding case. A case-insensitive compare would pass on Windows
  // and fail on Linux for the identical input — the cross-OS divergence the
  // normalizer exists to avoid. Strict on all three is the honest choice.
  it('does NOT fold case — the same input must behave the same on every OS', () => {
    const d = evaluatePreMergeAck(swept(['src/Widget.ts']), {
      carriedPaths: ['src/widget.ts'],
    })
    expect(d.ok).toBe(false)
  })

  // Breaks on: rejecting when files_swept holds paths the range does not carry.
  // Only MISSING paths matter; a superset is an honest over-attestation.
  it('a superset files_swept passes — only missing paths reject', () => {
    expect(evaluatePreMergeAck(swept(['a.ts', 'b.ts', 'extra.ts']), {
      carriedPaths: ['a.ts'],
    }).ok).toBe(true)
  })

  // Breaks on: treating a null/undefined range as an empty one (or vice versa).
  // null means the git read was unavailable; [] means the range is genuinely
  // empty. Both skip the check here — the CALLER distinguishes them in its audit.
  it('skips the check when the range is unavailable or empty', () => {
    for (const carriedPaths of [undefined, null, []] as const) {
      const d = evaluatePreMergeAck(swept([]), { carriedPaths })
      expect(d.ok, String(carriedPaths)).toBe(true)
    }
  })

  // Breaks on: removing the MAX_UNSWEPT_LISTED cap, or dropping `unswept`.
  // The hint goes to chat and must stay readable; the audit must still name the
  // whole gap, so the two are deliberately different lengths.
  it('caps the listed names but carries the full gap on unswept', () => {
    const carried = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const d = evaluatePreMergeAck(swept([]), { carriedPaths: carried })
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.unswept).toHaveLength(25)
      const entry = d.failing.find((f) => f.startsWith('files_swept'))!
      expect(entry).toContain(`and ${25 - MAX_UNSWEPT_LISTED} more`)
      expect(entry).not.toContain('src/f24.ts')
    } else throw new Error('expected incomplete')
  })

  // Breaks on: moving the cap to a Zod `.max()`. Every field is optional at the
  // schema layer precisely so a bad payload yields a clean rejected envelope
  // instead of a ZodError throw; the cap must obey the same rule.
  it('an over-long files_swept rejects cleanly rather than throwing', () => {
    const d = evaluatePreMergeAck(
      swept(Array.from({ length: MAX_FILES_SWEPT + 1 }, (_, i) => `f${i}`)),
    )
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing.some((f) => f.startsWith('files_swept') && f.includes('cap'))).toBe(true)
    } else throw new Error('expected incomplete')
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

describe('#62 — describeCrossCheck / crossCheckBlockedReason', () => {
  // FOUR states, not two. Collapsing any pair loses information a forensic
  // reader needs: 'empty_range' must not read as 'enforced' (nothing was
  // checked), and 'rejected_revision' must not read as 'degraded' (a crafted
  // input and an unfetched ref are different events).
  // Breaks on: returning 'enforced' for an empty path list.
  it('labels a readable range with paths as enforced', () => {
    expect(describeCrossCheck({ status: 'ok', paths: ['a.ts'] })).toBe('enforced')
  })
  // Breaks on: treating an empty range as enforced, i.e. over-claiming.
  it('labels a readable but EMPTY range as empty_range, never enforced', () => {
    expect(describeCrossCheck({ status: 'ok', paths: [] })).toBe('empty_range')
  })
  // Breaks on: mapping 'unavailable' to anything else.
  it('labels an unreadable range as degraded', () => {
    expect(describeCrossCheck({ status: 'unavailable' })).toBe('degraded')
  })
  // Breaks on: folding rejected_revision into degraded — the two must stay
  // distinguishable, because one is an attack shape and one is bookkeeping.
  it('labels a refused revision as rejected_revision, NOT degraded', () => {
    expect(describeCrossCheck({ status: 'unsafe_revision', revision: '--exec=x' })).toBe(
      'rejected_revision',
    )
  })

  // Breaks on: dropping the revision from the message. The agent cannot fix what
  // it is not shown, and this reject has no override.
  it('names the offending revision in the blocked reason', () => {
    const r = crossCheckBlockedReason({ status: 'unsafe_revision', revision: '--exec=x' }, 'rebase')
    expect(r).toContain('--exec=x')
    expect(r).toContain('rebase')
    expect(r).toContain('OPTION')
  })
  // Breaks on: wording the unavailable case as if the operation had run.
  it('states that an unreadable range fails CLOSED and nothing ran', () => {
    const r = crossCheckBlockedReason({ status: 'unavailable' }, 'merge')
    expect(r).toContain('CLOSED')
    expect(r).toContain('No OS dialog was shown')
  })
})

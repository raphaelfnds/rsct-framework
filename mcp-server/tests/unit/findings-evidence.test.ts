import { describe, it, expect } from 'vitest'
import {
  coerceEvidence,
  describeEvidenceMix,
  readFindingsBaseline,
  summarizeEvidence,
  type FindingEvidence,
} from '../../src/lib/findings.js'

/**
 * #75. The evidence class: how a finding is known.
 *
 * Each test names the production mutation that reddens it — a test that cannot
 * fail proves nothing, and the record behind this issue includes three mutation
 * harnesses that reported "all mutants killed" without ever running a test.
 */

const MEASURED: FindingEvidence = {
  kind: 'measured',
  command: 'git rev-parse HEAD',
  output_excerpt: '5bb1b07…',
  also_explained_by: 'a detached HEAD would print the same shape',
}

describe('coerceEvidence — degradation never runs toward fact', () => {
  // MUTATION: return `{kind:'measured', …}` for the absent case.
  it('T1 — absent evidence degrades to hypothesis, recording that nothing was supplied', () => {
    const e = coerceEvidence(undefined)
    expect(e.kind).toBe('hypothesis')
    expect(e).toMatchObject({ degraded: true, degraded_from: 'absent' })
    // Asserted on content, not on `expect.any(String)`: an empty falsifier would
    // satisfy the type and still hand the dev a finding with no way to test it.
    expect(e).toMatchObject({ how_to_falsify: expect.stringContaining('no evidence class') })
    expect(coerceEvidence(null)).toEqual(e)
  })

  // MUTATION: pass the unknown kind through unchanged.
  it('T2 — an unrecognised kind degrades to hypothesis and names what it was', () => {
    const e = coerceEvidence({ kind: 'nonsense' })
    expect(e.kind).toBe('hypothesis')
    expect(e).toMatchObject({ degraded: true, degraded_from: 'unknown_kind:nonsense' })
  })

  // MUTATION: accept the partial object as `measured`.
  it('T3 — a `measured` claim missing its command is not a weaker measurement, it is none', () => {
    const e = coerceEvidence({ kind: 'measured', output_excerpt: 'x', also_explained_by: 'y' })
    expect(e.kind).toBe('hypothesis')
    expect(e).toMatchObject({ degraded_from: 'malformed' })
  })

  // MUTATION: drop the `nonEmpty` trim check, accepting whitespace as a value.
  it('T3b — whitespace is not a value: a blank also_explained_by degrades', () => {
    const e = coerceEvidence({ ...MEASURED, also_explained_by: '   ' })
    expect(e.kind).toBe('hypothesis')
  })

  it('T3c — a well-formed member of each kind survives intact', () => {
    expect(coerceEvidence(MEASURED)).toEqual(MEASURED)
    expect(
      coerceEvidence({ kind: 'reported', source: 'ADR-7', verified_against: 'commit', commit_sha: 'a'.repeat(40) }),
    ).toEqual({ kind: 'reported', source: 'ADR-7', verified_against: 'commit', commit_sha: 'a'.repeat(40) })
    expect(coerceEvidence({ kind: 'hypothesis', how_to_falsify: 'run it' })).toEqual({
      kind: 'hypothesis',
      how_to_falsify: 'run it',
    })
  })

  // MUTATION: set `degraded: true` on every returned hypothesis.
  //
  // The highest-consequence guard here. Every class the checklist assigns is
  // written to phase state and read back through readFindingsBaseline on the very
  // next call. Re-stamping `degraded` would make every honestly-declared
  // hypothesis count as `unrecorded` after ONE round-trip, flipping the headline
  // the dev reads from "22 hypotheses, labelled" to "22 unrecorded, nobody said
  // anything" — the mix lying in the one direction this design must not.
  it('T20 — coerceEvidence is idempotent: a declared hypothesis is never re-stamped as degraded', () => {
    const declared = { kind: 'hypothesis' as const, how_to_falsify: 'open the referenced ADR' }
    const once = coerceEvidence(declared)
    expect(once).not.toHaveProperty('degraded')
    expect(coerceEvidence(once)).toEqual(once)

    for (const input of [undefined, { kind: 'nonsense' }, MEASURED, declared]) {
      const a = coerceEvidence(input)
      expect(coerceEvidence(a)).toEqual(a)
    }
  })

  // MUTATION: drop the `degraded`/`degraded_from` preservation branch.
  it('T20b — a degraded hypothesis keeps its provenance across a round-trip', () => {
    const degraded = coerceEvidence(undefined)
    expect(coerceEvidence(JSON.parse(JSON.stringify(degraded)))).toEqual(degraded)
  })
})

describe('summarizeEvidence — the mix the dev sees before approving', () => {
  // MUTATION: fold `unrecorded` into `hypothesis` as a fourth exclusive class.
  it('T6 — unrecorded is a SUBSET of hypothesis; the three kinds sum to total', () => {
    const mix = summarizeEvidence([
      { evidence: MEASURED },
      { evidence: coerceEvidence(undefined) },
      { evidence: { kind: 'hypothesis', how_to_falsify: 'declared' } },
    ])
    expect(mix).toEqual({
      measurable: true,
      measured: 1,
      reported: 0,
      hypothesis: 2,
      unrecorded: 1,
      total: 3,
    })
    expect(mix.measured + mix.reported + mix.hypothesis).toBe(mix.total)
  })

  // MUTATION: index into `findings[0]` unguarded.
  it('T7 — an empty corpus is all zeros and does not throw', () => {
    expect(summarizeEvidence([])).toMatchObject({ measurable: true, total: 0, unrecorded: 0 })
  })

  // MUTATION: return `measurable: true` unconditionally.
  //
  // readFindingsBaseline returns null (not []) for foreign or hand-edited state.
  // A row of zeros from null ("unmeasurable") and from [] ("the phase ran and
  // found nothing") would render identically — a state read as if it were an
  // observation, which is the mechanism this issue was opened over.
  it('T19 — a null baseline is UNMEASURABLE, and says so rather than showing zeros', () => {
    const nullMix = summarizeEvidence(null)
    const emptyMix = summarizeEvidence([])
    expect(nullMix.measurable).toBe(false)
    expect(emptyMix.measurable).toBe(true)
    expect(describeEvidenceMix(nullMix)).toMatch(/unavailable/)
    expect(describeEvidenceMix(nullMix)).not.toEqual(describeEvidenceMix(emptyMix))
  })

  // MUTATION: default a missing `evidence` to `measured` in the loop.
  it('T6b — a finding with no evidence field counts as unrecorded, never as fact', () => {
    expect(summarizeEvidence([{}])).toMatchObject({ measured: 0, hypothesis: 1, unrecorded: 1 })
  })

  it('describeEvidenceMix names the unrecorded share only when there is one', () => {
    expect(describeEvidenceMix(summarizeEvidence([{ evidence: MEASURED }]))).toBe(
      '1 finding(s) — 1 measured, 0 reported, 0 hypothesis',
    )
    expect(describeEvidenceMix(summarizeEvidence([{}]))).toMatch(/\(1 unrecorded\)$/)
  })
})

describe('readFindingsBaseline — the choke point that carries evidence to five readers', () => {
  // MUTATION: drop entries lacking `evidence`.
  it('T4 — legacy findings with no evidence still parse, still gate, and read as hypothesis', () => {
    const baseline = readFindingsBaseline([
      { id: 'v-gap-1', category: 'gap', title: 'old' },
      { id: 'v-gap-2' },
    ])
    expect(baseline).toHaveLength(2)
    expect(baseline![0]!.evidence).toMatchObject({ kind: 'hypothesis', degraded_from: 'absent' })
    expect(summarizeEvidence(baseline)).toMatchObject({ total: 2, unrecorded: 2, measured: 0 })
  })

  // MUTATION: revert the single `f.evidence = coerceEvidence(rec.evidence)` line.
  //
  // This is also the #40 recovery guard: open_findings is what a rejected or
  // resumed caller gets back, and stripping evidence there would make a required
  // field unrecoverable.
  it('T5/T14 — a well-formed measured finding round-trips through the baseline intact', () => {
    const baseline = readFindingsBaseline([{ id: 'r-bug-1', evidence: MEASURED }])
    expect(baseline![0]!.evidence).toEqual(MEASURED)
  })

  // MUTATION: make `evidence` participate in the id/`null` guards.
  it('T4b — the generous contract is unchanged: id-less entries still drop, null still fails open', () => {
    expect(readFindingsBaseline(null)).toBeNull()
    expect(readFindingsBaseline([{ evidence: MEASURED }])).toBeNull()
    expect(readFindingsBaseline([{ id: '' }])).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { filterSectionsByQuery, makeExcerpt } from '../../src/lib/markdown.js'

/**
 * These two helpers were each written 2-3 times across `lib/` and `tools/` (#10)
 * and had no direct tests — they were exercised only through their callers, which
 * is how the copies drifted apart unnoticed in the first place.
 */
describe('makeExcerpt', () => {
  it('joins the first lines, trimmed, skipping blanks and HTML comments', () => {
    const body = '\n  first  \n<!-- a comment -->\n\nsecond\nthird\nfourth\n'
    expect(makeExcerpt(body)).toBe('first second third')
  })

  it('truncates with an ellipsis INSIDE the cap, not past it', () => {
    // The `- 3` matters: an ellipsis appended after slicing to the cap would
    // return maxChars + 3 characters, which is not a cap.
    const out = makeExcerpt('x'.repeat(400), { maxChars: 50 })
    expect(out).toHaveLength(50)
    expect(out.endsWith('...')).toBe(true)
  })

  it('honours a wider window — the anti-decisions divergence is configuration', () => {
    const body = 'one\ntwo\nthree\nfour\nfive'
    expect(makeExcerpt(body)).toBe('one two three')
    expect(makeExcerpt(body, { maxLines: 4 })).toBe('one two three four')
  })

  it('applies an extra skipLine filter on top of the built-in ones', () => {
    const body = '<!-- c -->\n**Status**: active\nreal content\nmore'
    expect(makeExcerpt(body, { skipLine: (l) => l.startsWith('**Status**') })).toBe(
      'real content more',
    )
  })

  it('returns an empty string when everything is filtered out', () => {
    expect(makeExcerpt('\n\n<!-- only comments -->\n')).toBe('')
  })
})

describe('filterSectionsByQuery', () => {
  const sections = [
    { heading: 'Deploy', body: 'runs on kubernetes' },
    { heading: 'Testing', body: 'vitest and playwright' },
  ]

  it('returns the input untouched when there is no query', () => {
    // Identity, not a filter that happens to match everything — the same array
    // reference, so no body gets lowercased for nothing.
    expect(filterSectionsByQuery(sections, undefined)).toBe(sections)
  })

  it('matches on heading or body, case-insensitively', () => {
    expect(filterSectionsByQuery(sections, 'KUBERNETES')).toHaveLength(1)
    expect(filterSectionsByQuery(sections, 'testing')).toHaveLength(1)
    expect(filterSectionsByQuery(sections, 'nothing here')).toHaveLength(0)
  })

  it('preserves the caller type — it is generic over the section shape', () => {
    const typed = [{ heading: 'A', body: 'x', category: 'k' }]
    const [first] = filterSectionsByQuery(typed, 'a')
    expect(first?.category).toBe('k')
  })
})

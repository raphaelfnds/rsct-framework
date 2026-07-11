import { describe, it, expect } from 'vitest'
import { parseNumstatZ } from '../../src/lib/git.js'

describe('lib/git — parseNumstatZ (binary/rename-safe numstat -z)', () => {
  it('parses a normal text record', () => {
    const r = parseNumstatZ('5\t3\tsrc/foo.ts\0')
    expect(r).toEqual({ files: 1, insertions: 5, deletions: 3, paths: ['src/foo.ts'] })
  })

  it('counts a BINARY file (- \\t -) as 0 lines but still counts the file', () => {
    const r = parseNumstatZ('-\t-\tassets/logo.png\0')
    expect(r.files).toBe(1)
    expect(r.insertions).toBe(0)
    expect(r.deletions).toBe(0)
    expect(r.paths).toEqual(['assets/logo.png'])
    // The whole point of the F1 fix: no NaN can leak into the totals.
    expect(Number.isFinite(r.insertions)).toBe(true)
    expect(Number.isFinite(r.deletions)).toBe(true)
  })

  it('handles a rename record (new-side path, counted once)', () => {
    const r = parseNumstatZ('2\t1\t\0old/a.ts\0new/b.ts\0')
    expect(r.files).toBe(1)
    expect(r.insertions).toBe(2)
    expect(r.deletions).toBe(1)
    expect(r.paths).toEqual(['new/b.ts'])
  })

  it('parses a mixed stream (normal + binary + rename) with a finite total', () => {
    const raw = '5\t3\tsrc/a.ts\0' + '-\t-\timg.png\0' + '2\t1\t\0old.ts\0new.ts\0'
    const r = parseNumstatZ(raw)
    expect(r.files).toBe(3)
    expect(r.insertions).toBe(7) // 5 + 0 + 2
    expect(r.deletions).toBe(4) // 3 + 0 + 1
    expect(r.paths).toEqual(['src/a.ts', 'img.png', 'new.ts'])
  })

  it('normalizes backslashes to forward slashes', () => {
    const r = parseNumstatZ('1\t0\tsrc\\win\\file.ts\0')
    expect(r.paths).toEqual(['src/win/file.ts'])
  })

  it('returns an all-zero result for an empty diff', () => {
    expect(parseNumstatZ('')).toEqual({ files: 0, insertions: 0, deletions: 0, paths: [] })
  })

  it('ignores a trailing NUL without inventing an empty path', () => {
    const r = parseNumstatZ('1\t1\tonly.ts\0')
    expect(r.files).toBe(1)
    expect(r.paths).toEqual(['only.ts'])
  })
})

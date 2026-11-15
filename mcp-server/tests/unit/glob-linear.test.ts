import { describe, it, expect } from 'vitest'
import { globToRegex, matchesAnyGlob } from '../../src/lib/phase-scope.js'

function referenceRegex(glob: string): RegExp {
  let out = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        const followedBySlash = glob[i + 2] === '/'
        if (atSegmentStart && followedBySlash && i + 3 < glob.length) {
          out += '(?:[^/]*/)*'
          i += 3
        } else {
          out += '.*'
          i += followedBySlash ? 3 : 2
        }
      } else {
        out += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      out += '[^/]'
      i++
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`
      i++
    } else {
      out += ch
      i++
    }
  }
  return new RegExp(`${out}$`)
}

function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function pick(next: () => number, alphabet: readonly string[], max: number): string {
  const length = Math.floor(next() * (max + 1))
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)]!
  return out
}

describe('2.25.1 — glob matching in linear time, same answers as before', () => {
  it('agrees with the previous regular-expression matcher on 40 000 random globs and paths', () => {
    const next = random(20261115)
    const globAlphabet = ['a', 'b', '.', '/', '*', '*', '?', '**/', '(', '+', '\\']
    const pathAlphabet = ['a', 'b', '.', '/', '(', '+', '\\', '\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]
    let checked = 0
    for (let n = 0; n < 40_000; n++) {
      const glob = pick(next, globAlphabet, 6)
      const path = pick(next, pathAlphabet, 9)
      const expected = referenceRegex(glob).test(path)
      expect(globToRegex(glob).test(path), `glob ${JSON.stringify(glob)} path ${JSON.stringify(path)}`).toBe(expected)
      checked++
    }
    expect(checked).toBe(40_000)
  })

  it('keeps the documented shapes: whole segments, the trailing slash rule, a mid-segment double star', () => {
    expect(globToRegex('**/api/**').test('src/api/x.ts')).toBe(true)
    expect(globToRegex('**/api/**').test('webapi/x.ts')).toBe(false)
    expect(globToRegex('dir/**').test('dir.ext')).toBe(false)
    expect(globToRegex('dir/**').test('dir/a/b')).toBe(true)
    expect(globToRegex('a**/b').test('axxb')).toBe(true)
    expect(globToRegex('src/*.ts').test('src/lib/x.ts')).toBe(false)
    expect(globToRegex('src/**').test('src/a\nb')).toBe(false)
    expect(globToRegex('src/*').test('src/a\nb')).toBe(true)
  })

  it('answers a pathological glob in well under 100 ms', () => {
    const path = 'a'.repeat(200)
    for (const glob of ['*a'.repeat(30) + '*b', '**/'.repeat(12) + 'x', `${'*'.repeat(40)}b`]) {
      const started = performance.now()
      const result = matchesAnyGlob(path, [glob]).matched
      const elapsed = performance.now() - started
      expect(result, glob).toBe(false)
      expect(elapsed, glob).toBeLessThan(100)
    }
  })
})

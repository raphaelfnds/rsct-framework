import { describe, it, expect } from 'vitest'
import {
  KEY_VALUE_REGEX,
  createDiffScanner,
  normalizeDiffLine,
  scanDiffForSecrets,
  unquoteGitPath,
} from '../../src/lib/secrets.js'

const PREVIOUS_KEY_VALUE_REGEX =
  /["']?([a-zA-Z][a-zA-Z0-9_.-]{1,})["']?\s*[:=]\s*["']?([^\s"',;}]+)["']?/g

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = ['a', 'b', 'k', 'Z', 't', '1', '9', '_', '.', '-', '"', "'", ' ', '\t', ':', '=', ',', ';', '}', '{', '/', 'x']

function randomLine(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * maxLength)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)]!
  return out
}

function pairs(regex: RegExp, valueGroup: number, text: string): string[] {
  regex.lastIndex = 0
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) out.push(`${m.index}|${m[0]}|${m[1]}|${m[valueGroup]}`)
  return out
}

function bestOf(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    work()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

function diffFor(file: string, added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join('\n')
}

describe('KEY_VALUE_REGEX keeps the previous matches exactly', () => {
  it('matches the previous pattern on 60,000 seeded random lines', () => {
    const next = mulberry32(0x5eed79)
    let compared = 0
    let withMatches = 0
    for (let i = 0; i < 60_000; i++) {
      const line = randomLine(next, 48)
      const previous = pairs(PREVIOUS_KEY_VALUE_REGEX, 2, line)
      const current = pairs(KEY_VALUE_REGEX, 3, line)
      expect(current, line).toEqual(previous)
      compared++
      if (previous.length > 0) withMatches++
    }
    expect(compared).toBe(60_000)
    expect(withMatches).toBeGreaterThan(5_000)
  })

  it('matches the previous pattern on hand-written edge shapes', () => {
    const shapes = [
      '9abc=x',
      'x"ab=1',
      'ab"cd=1',
      'a1b=c',
      'k=v"abc=1',
      'API_KEY = "sk-short"',
      "password: 'p'",
      'token=a=b=c',
      '"jwt_secret":"s"',
      'a=b, c=d; e=f}',
      '_.-ab-c.d=1',
    ]
    for (const shape of shapes) expect(pairs(KEY_VALUE_REGEX, 3, shape), shape).toEqual(pairs(PREVIOUS_KEY_VALUE_REGEX, 2, shape))
  })
})

describe('KEY_VALUE_REGEX runs in linear time', () => {
  const shapes: Array<[string, (n: number) => string]> = [
    ['one identifier run', (n) => 'a'.repeat(n)],
    ['a run before a word', (n) => `${'a'.repeat(n)} b`],
    ['letters between digits', (n) => 'a1'.repeat(n / 2)],
  ]
  for (const [name, make] of shapes) {
    it(`grows about linearly on ${name}`, () => {
      const small = make(20_000)
      const large = make(80_000)
      const t1 = Math.max(bestOf(3, () => pairs(KEY_VALUE_REGEX, 3, small)), 2)
      const t4 = bestOf(3, () => pairs(KEY_VALUE_REGEX, 3, large))
      expect(t4 / t1).toBeLessThan(10)
    })
  }
})

describe('the diff scanner reads every added line of every file', () => {
  it('keeps scanning a file after an added line that starts with ++', () => {
    const diff = diffFor('notes.txt', ['++x', 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'])
    const findings = scanDiffForSecrets(diff)
    expect(findings.map((f) => [f.file, f.line_number, f.reason])).toEqual([['notes.txt', 2, 'value-shape']])
  })

  it('does not take an added line shaped like a file header for a new file', () => {
    const diff = diffFor('real.txt', ['++ b/fake.txt', 'password=hunter2'])
    const findings = scanDiffForSecrets(diff)
    expect(findings.map((f) => f.file)).toEqual(['real.txt'])
  })

  it('attributes findings per file when two files follow each other without a diff line', () => {
    const diff = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-old',
      '+token=abc',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -0,0 +1 @@',
      '+password=def',
    ].join('\n')
    expect(scanDiffForSecrets(diff).map((f) => [f.file, f.line_number])).toEqual([
      ['one.txt', 1],
      ['two.txt', 1],
    ])
  })

  it('finds a secret written as UTF-16LE text', () => {
    const utf16 = Buffer.from('API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA', 'utf16le').toString('latin1')
    const asUtf8 = Buffer.from(utf16, 'latin1').toString('utf8')
    const findings = scanDiffForSecrets(diffFor('ps.txt', [asUtf8]))
    expect(findings.map((f) => f.reason)).toEqual(['value-shape'])
  })

  it('lets an end-anchored extra pattern match a line stored with CRLF', () => {
    const findings = scanDiffForSecrets(diffFor('crlf.txt', ['internal-ref-42\r']), [{ id: 'extra-0', pattern: /ref-\d+$/ }])
    expect(findings.map((f) => [f.reason, f.pattern_id])).toEqual([['extra-pattern', 'extra-0']])
  })

  it('reads a quoted file name', () => {
    const diff = ['diff --git "a/caf\\303\\251 x.txt" "b/caf\\303\\251 x.txt"', '+++ "b/caf\\303\\251 x.txt"', '@@ -0,0 +1 @@', '+token=abc'].join('\n')
    expect(scanDiffForSecrets(diff).map((f) => f.file)).toEqual(['café x.txt'])
  })

  it('gives the same findings fed line by line as fed whole', () => {
    const diff = diffFor('a.env', ['token=abc', 'x', 'secret: "s"'])
    const scanner = createDiffScanner()
    for (const raw of diff.split('\n')) scanner.line(raw)
    expect(scanner.findings).toEqual(scanDiffForSecrets(diff))
    expect(scanner.findings).toHaveLength(2)
  })
})

describe('normalizeDiffLine and unquoteGitPath', () => {
  it('drops NULs and one trailing carriage return only', () => {
    expect(normalizeDiffLine('a\0b\r')).toBe('ab')
    expect(normalizeDiffLine('ab\r\r')).toBe('ab\r')
    expect(normalizeDiffLine('plain')).toBe('plain')
  })

  it('decodes git C-style quoting and leaves unquoted paths alone', () => {
    expect(unquoteGitPath('"b/a\\tb"')).toBe('b/a\tb')
    expect(unquoteGitPath('"b/q\\"x"')).toBe('b/q"x')
    expect(unquoteGitPath('b/plain.txt')).toBe('b/plain.txt')
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TOOLS, HANDLERS } from '../../src/catalog.js'

// Issue #55 — doc-vs-code invariant, mirroring tests/unit/version-source.test.ts.
// The tool catalog size is hand-written into six places across four files, and
// NOTHING cross-checked them against the code: tests/integration/dist-standalone.
// test.ts asserts only `toBeGreaterThanOrEqual(29)`, so every one of the six could
// (and did) rot silently. This pins them to the live catalog — and, past the bare
// count, three things a count alone cannot catch: the boot-log NAME list (drift in
// names or order), the four per-group sizes written out in prose (bumping the
// total while leaving a group behind), and mcp-server/README.md's M2 figure, which
// had said 6 ever since rsct_request_rebase made it 7.
//
// Why the count is imported from src/catalog.ts and not src/index.ts: index.ts ends
// in a module-scope `main().catch(...)` that connects a StdioServerTransport, so
// importing it here would boot an MCP server inside the test process.
//
// Path note (same asymmetry as version-source.test.ts): from mcp-server/tests/unit/
// the repo root is THREE levels up.
const ROOT = resolve(__dirname, '..', '..', '..')

const read = (rel: string): string =>
  readFileSync(resolve(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n')

/**
 * Each anchor is deliberately narrow enough to exclude the HISTORICAL blocks by
 * construction — `mcp-server/README.md:6-36` (frozen at "catalog to 37") and the
 * milestone table at `:82-90` (rows like "ships in v2.5.0 (39 tools, unchanged)")
 * are RECORDS OF PAST RELEASES. A loose `/39/` here would rewrite history on every
 * bump. Patterns are also FILE-SCOPED: `mcp-server/README.md:9` reads "7 tools +
 * 5 resources", one `**` away from the root README's pattern.
 */
const SITES: { file: string; pattern: RegExp }[] = [
  { file: 'README.md', pattern: /\*\*(\d+) tools \+ 5 resources\*\*/g },
  { file: 'mcp-server/README.md', pattern: /\*\*(\d+) tools · 5 resources/g },
  { file: 'mcp-server/README.md', pattern: /the full catalog is (\d+) now/g },
  { file: 'examples/README.md', pattern: /currently ships (\d+) tools/g },
  { file: 'scripts/install.sh', pattern: /Adds (\d+) tools \+ 5 resources/g },
]

const ARITHMETIC = {
  file: 'README.md',
  pattern: /That's \*\*([\d +]+?) = (\d+) tools\*\*/g,
}

describe('tool catalog is the single source for the documented count (#55)', () => {
  it('TOOLS and HANDLERS stay in lockstep', () => {
    expect(Object.keys(HANDLERS)).toHaveLength(TOOLS.length)
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  for (const { file, pattern } of SITES) {
    it(`${file} ${pattern.source} — matches exactly once, and equals the live count`, () => {
      const matches = [...read(file).matchAll(pattern)]
      // Assert the MATCH COUNT before the value. A rotted anchor matches zero
      // times, and an `if (found) compare` test would go green on rot — printing
      // the same reassuring line as a healthy one. An anchor that matches twice
      // is worse: it silently pins whichever line came first.
      expect(matches).toHaveLength(1)
      expect(Number(matches[0]![1])).toBe(TOOLS.length)
    })
  }

  it("mcp-server/README.md's expected ready-log lists exactly the live catalog, in order", () => {
    // Stronger than any count: `mcp-server/README.md` documents the full
    // `"tools":[...]` array the server logs at startup. A count can agree while
    // the names have drifted; this cannot. Found during REVIEW — the six count
    // sites alone left this enumeration stale.
    const body = read('mcp-server/README.md')
    const block = /"tools":\[([^\]]+)\]/.exec(body)
    expect(block).not.toBeNull()

    const documented = [...block![1]!.matchAll(/"(rsct_[a-z_]+)"/g)].map((m) => m[1])
    expect(documented).toEqual(TOOLS.map((t) => t.name))
  })

  it("README.md's group breakdown adds up AND totals the live count", () => {
    const matches = [...read(ARITHMETIC.file).matchAll(ARITHMETIC.pattern)]
    expect(matches).toHaveLength(1)

    const [, addendText, totalText] = matches[0]!
    const addends = addendText!.split('+').map((s) => Number(s.trim()))
    const total = Number(totalText)

    expect(addends.every((n) => Number.isInteger(n) && n > 0)).toBe(true)
    // Three assertions, not one. The total alone would pass if someone bumped it
    // and left the per-group numbers behind — which is exactly how this line
    // becomes self-contradictory.
    expect(addends.reduce((a, b) => a + b, 0)).toBe(total)
    expect(total).toBe(TOOLS.length)

    // ...and the four group sizes are ALSO written out in prose on four other
    // lines of the same section. Checking only the addends inside the arithmetic
    // line left exactly the hole this test claims to close: bumping "17 tools
    // across the RSCT cycle" alone kept the suite green.
    const body = read('README.md')
    const group = (re: RegExp): number => {
      const hits = [...body.matchAll(re)]
      expect(hits).toHaveLength(1)
      return Number(hits[0]![1])
    }
    expect([
      group(/\*\*M1 — Recall:\*\* (\d+) read-only tools/g),
      group(/\*\*M2 — Enforcement:\*\* (\d+) tools/g),
      group(/^ *(\d+) tools across the RSCT cycle/gm),
      group(/^ *(\d+) more — `rsct_get_universe`/gm),
    ]).toEqual(addends)

    // Seventh anchor, in the OTHER file: mcp-server/README.md's live M2 section
    // stated 6 for as long as rsct_request_rebase had made it 7. Same rot class.
    const m2 = [...read('mcp-server/README.md').matchAll(/M2 adds \*\*(\d+) new tools\*\*/g)]
    expect(m2).toHaveLength(1)
    expect(Number(m2[0]![1])).toBe(addends[1])
  })
})

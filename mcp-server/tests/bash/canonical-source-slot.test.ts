import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runBlock } from './lib/block-harness.js'
import { bashAvailable } from './lib/bash-lint.js'

// #78: this was the only file under tests/bash/ with no bash gate, so on a machine
// whose `bash` is unusable the 32 of its 35 tests that spawn bash failed on file
// state — 'CLAUDE.md missing' — with nothing naming the real cause. The gate is
// applied per describe, by need, the way the four siblings apply it: the one
// describe below that spawns nothing is deliberately left ungated. Inert whenever a
// usable bash exists; when one is not, resolve-bash.test.ts says why.
const BASH = bashAvailable()

// #66 — the canonical-source handoff between 01-setup.md (which reserves the slot)
// and 02-canonical-source.md (which fills it).
//
// Every block below is extracted from the SHIPPED prompt by its CHECKPOINT anchor,
// so these assertions cannot drift from a hand-copied snapshot. The splice itself
// is an agent action, not bash — the tests that need a filled section produce it
// with a scripted stand-in and then assert with the real sanity block.
const ROOT = resolve(__dirname, '..', '..', '..')

const PROBE = 'Phase 1.3 executing canonical CLAUDE.md section detection'
const PREAMBLE = 'Phase 4 executing canonical canonical-source UPDATE-mode excision preamble'
const SANITY = 'Phase 4.b executing canonical canonical-source post-mutation sanity check'
const UNINSTALL = 'canonical-source excision skipped'

const REAL_BEGIN = '<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->'
const REAL_END = '<!-- RSCT-CANONICAL-SOURCE-END -->'
const SLOT_BEGIN = '<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN v=1.0.0 -->'
const SLOT_END = '<!-- RSCT-CANONICAL-SOURCE-SLOT-END -->'
const HEADING = '## 0. Canonical architectural source'

const header = ['<!-- RSCT_VERSION: 1.0.0 -->', '# CLAUDE.md — demo', '', 'protocol prose', '']

/** A CLAUDE.md as `/rsct-setup` renders it today: slot marked, never linked. */
const freshRender = [...header, SLOT_BEGIN, HEADING, '<TODO: run /rsct-universe>', SLOT_END, '', 'DEV TAIL'].join('\n')
/** A CLAUDE.md from an install predating the SLOT marker. */
const legacyRender = [
  ...header,
  HEADING,
  '<!-- Populated by prompts/02-canonical-source.md -->',
  '<TODO: run 02-canonical-source.md to generate this section>',
  '',
  'DEV TAIL',
].join('\n')
/** A linked project: the real section, filled. */
const linkedRender = [...header, REAL_BEGIN, HEADING, 'body', REAL_END, '', 'DEV TAIL'].join('\n')

function read(dir: string, rel = 'CLAUDE.md'): string {
  return readFileSync(join(dir, rel), 'utf8')
}

// NOT gated: these three are readFileSync + string comparison and spawn no bash
// (measured at 1-3 ms against ~1 s for every bash test in this file). Gating them
// would turn off the only checks still running on the very machine #78 is about —
// and they are the ones pinning prompts/06-universe.md's probe and the shipped
// CLAUDE.md.template. The siblings gate per describe BY NEED, never per file.
describe('#66 — the reserved slot never reads as a linked project', () => {
  // The whole design rests on this: the SLOT marker must NOT be a substring of the
  // real one, because prompts/06-universe.md:92 decides PROJECT_LINKED with a bare
  // `grep -qF "RSCT-CANONICAL-SOURCE-BEGIN"`. Reusing the real pair was measured
  // setting PROJECT_LINKED=yes on a never-linked project, which makes universe
  // state C ("exists, not linked") unreachable and routes every fresh install to
  // "already linked — refreshed".
  it('T2 — the SLOT marker is not a substring of the real marker', () => {
    expect(SLOT_BEGIN.includes('RSCT-CANONICAL-SOURCE-BEGIN')).toBe(false)
    expect(SLOT_END.includes('RSCT-CANONICAL-SOURCE-END')).toBe(false)
  })

  it('T3 — 06-universe.md still reports the linked-state probe verbatim', () => {
    // Pin the probe this design depends on. If it ever stops being a byte-literal
    // match on the real BEGIN marker, T2 stops protecting anything.
    const universe = readFileSync(join(ROOT, 'prompts', '06-universe.md'), 'utf8')
    expect(universe).toContain('grep -qF "RSCT-CANONICAL-SOURCE-BEGIN" "./CLAUDE.md"')
  })

  it('T2b — the shipped template renders a marked slot, not bare prose', () => {
    const tpl = readFileSync(join(ROOT, 'doc-templates', 'CLAUDE.md.template'), 'utf8')
    expect(tpl).toContain(SLOT_BEGIN)
    expect(tpl).toContain(SLOT_END)
    expect(tpl).toContain(HEADING)
    // D3: the placeholder must sit INSIDE the pair, or the excision cannot reach it.
    const begin = tpl.indexOf(SLOT_BEGIN)
    const end = tpl.indexOf(SLOT_END)
    expect(begin).toBeGreaterThan(-1)
    expect(tpl.indexOf('<TODO')).toBeGreaterThan(begin)
    expect(tpl.indexOf('<TODO')).toBeLessThan(end)
    // D1: the slot must come after the H1, never before it.
    expect(begin).toBeGreaterThan(tpl.indexOf('# CLAUDE.md'))
  })
})

describe.skipIf(!BASH)('#66 — the four-way mode probe', () => {
  const modeOf = (claudeMd: string | null): string => {
    const seedFiles = claudeMd === null ? {} : { 'CLAUDE.md': claudeMd }
    const r = runBlock(ROOT, { promptBasename: '02-canonical-source.md', anchor: PROBE, seedFiles })
    const m = r.out.match(/CS_MODE=(\S+)/)
    return m?.[1] ?? '<none>'
  }

  it('T7 — a filled section resolves to update', () => expect(modeOf(linkedRender)).toBe('update'))
  it('resolves the marked slot to create-slot', () => expect(modeOf(freshRender)).toBe('create-slot'))

  // The V found this one: every project installed BEFORE this fix carries an
  // unmarked placeholder. Without create-legacy it resolved to create-append, the
  // agent appended a SECOND section, and the sanity check aborted the link.
  it('T14 — an install predating the marker resolves to create-legacy', () =>
    expect(modeOf(legacyRender)).toBe('create-legacy'))

  it('T6 — a CLAUDE.md with no placeholder at all resolves to create-append', () =>
    expect(modeOf([...header, 'dev content only'].join('\n'))).toBe('create-append'))

  it('T16 — an absent CLAUDE.md resolves to create-append without crashing', () =>
    expect(modeOf(null)).toBe('create-append'))

  it('T7b — both pairs present resolve to update', () =>
    expect(modeOf([...header, SLOT_BEGIN, SLOT_END, REAL_BEGIN, HEADING, REAL_END].join('\n'))).toBe('update'))
})

describe.skipIf(!BASH)('#66 — update mode also clears the orphan placeholder', () => {
  // The Rv caught this: the probe reports `update` and the preamble used to remove
  // only the real pair, leaving the slot behind. The agent then wrote a second
  // section and the sanity check rejected a run it had no way to get right.
  it('removes an orphan SLOT alongside the old section', () => {
    const r = runBlock(ROOT, {
      promptBasename: '02-canonical-source.md',
      anchor: PREAMBLE,
      seedFiles: {
        'CLAUDE.md': [...header, SLOT_BEGIN, HEADING, SLOT_END, REAL_BEGIN, 'old body', REAL_END, 'DEV TAIL'].join('\n'),
      },
    })
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-SLOT')
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-BEGIN')
    expect(body).toContain('DEV TAIL')
  })
})

describe.skipIf(!BASH)('#66 — the Phase 4 preamble never truncates CLAUDE.md', () => {
  const preamble = (claudeMd: string) =>
    runBlock(ROOT, { promptBasename: '02-canonical-source.md', anchor: PREAMBLE, seedFiles: { 'CLAUDE.md': claudeMd } })

  it('excises a well-formed section and keeps the surrounding content', () => {
    const r = preamble(linkedRender)
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-BEGIN')
    expect(body).toContain('DEV TAIL')
  })

  // `sed '/A/,/B/d'` with an unmatched closing address deletes to END OF FILE. The
  // old block ran it unguarded and then asked "are the markers gone?" — which was
  // trivially true precisely because the whole tail had been deleted. Measured:
  // the developer's content did not survive.
  it('T13 — refuses to excise a lone BEGIN, and the dev tail survives', () => {
    const r = preamble([...header, REAL_BEGIN, HEADING, 'DEV TAIL', 'MORE DEV'].join('\n'))
    const body = read(r.dir)
    expect(r.out).toMatch(/MALFORMED/)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('MORE DEV')
  })

  // A stray END with no BEGIN resolves to create-append, so the preamble never
  // reaches its guard — it simply leaves the file alone, which is the safe
  // outcome. The orphan is caught downstream by the sanity check, which expects
  // exactly one END and would then find two. Asserted here so the division of
  // labour between the two blocks is pinned, not assumed.
  it('leaves a stray END untouched, deferring to the sanity check', () => {
    const r = preamble([...header, REAL_END, 'DEV TAIL'].join('\n'))
    const body = read(r.dir)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('RSCT-CANONICAL-SOURCE-END')
  })

  it('and the sanity check does catch that stray END once a section is added', () => {
    const r = runBlock(ROOT, {
      promptBasename: '02-canonical-source.md',
      anchor: SANITY,
      seedFiles: {
        'CLAUDE.md': [...header, REAL_BEGIN, HEADING, 'body', REAL_END, REAL_END, 'DEV TAIL'].join('\n'),
      },
    })
    expect(r.out).toMatch(/one real END/)
    expect(r.out).not.toMatch(/sanity check OK/)
  })
})

describe.skipIf(!BASH)('#66 — the post-mutation sanity check can actually fail', () => {
  const sanity = (claudeMd: string) =>
    runBlock(ROOT, { promptBasename: '02-canonical-source.md', anchor: SANITY, seedFiles: { 'CLAUDE.md': claudeMd } })

  const spliced = [...header, REAL_BEGIN, HEADING, 'body', REAL_END, '', 'DEV TAIL'].join('\n')

  it('T1 — passes on a correctly spliced file', () => {
    expect(sanity(spliced).out).toMatch(/sanity check OK/)
  })

  // The whole point of D2, and the assertion that was vacuous in the first draft:
  // `grep -cF "Canonical architectural source"` returns 1 for BOTH headings,
  // because the numbered one CONTAINS the unnumbered one. Only a column-anchored
  // byte match can tell them apart.
  it('T1b — fails on the unnumbered heading (the D2 mutation)', () => {
    const r = sanity(spliced.replace(HEADING, '## Canonical architectural source'))
    expect(r.out).toMatch(/numbered heading/)
    expect(r.out).not.toMatch(/sanity check OK/)
  })

  it('T5 — fails when the section was appended instead of replacing the slot', () => {
    const r = sanity([...header, SLOT_BEGIN, HEADING, '<TODO: x>', SLOT_END, REAL_BEGIN, HEADING, REAL_END].join('\n'))
    expect(r.out).toMatch(/SLOT residue|numbered heading|no TODO/)
    expect(r.out).not.toMatch(/sanity check OK/)
  })

  it('T4 — fails when the block landed above the H1 (the D1 bug)', () => {
    const r = sanity(['<!-- RSCT_VERSION: 1.0.0 -->', REAL_BEGIN, HEADING, REAL_END, '# CLAUDE.md — demo'].join('\n'))
    expect(r.out).toMatch(/must come after the first heading/)
    expect(r.out).not.toMatch(/sanity check OK/)
  })

  it('behaves identically on CRLF', () => {
    expect(sanity(spliced.replace(/\n/g, '\r\n')).out).toMatch(/sanity check OK/)
  })

  it('T16b — reports rather than crashing when CLAUDE.md is absent', () => {
    const r = runBlock(ROOT, { promptBasename: '02-canonical-source.md', anchor: SANITY, seedFiles: {} })
    expect(r.out).not.toMatch(/sanity check OK/)
    expect(r.out).not.toMatch(/integer expression expected/)
  })

  // Two false rejections the Rv found. Both aborted the link AFTER the file had
  // already been written, which is the worst possible moment to be wrong.
  it("does not reject the dev's own <TODO: notes elsewhere in the file", () => {
    const r = sanity([spliced, '', '## Deploy notes', '<TODO: describe the staging rollout>'].join('\n'))
    expect(r.out).toMatch(/sanity check OK/)
  })

  it('does not require the H1 to be literally "# CLAUDE.md"', () => {
    // An ADOPT-mode install keeps the project's own title; RSCT never rewrites it.
    const r = sanity(spliced.replace('# CLAUDE.md — demo', '# Acme API — engineering protocol'))
    expect(r.out).toMatch(/sanity check OK/)
  })
})

describe.skipIf(!BASH)('#66 — the uninstall reaches the placeholder and stops at the guard', () => {
  const uninstall = (claudeMd: string | null) =>
    runBlock(ROOT, {
      promptBasename: '03-uninstall.md',
      anchor: UNINSTALL,
      seedFiles: claudeMd === null ? {} : { 'CLAUDE.md': claudeMd },
    })

  it('T9 — removes a filled section and preserves the dev tail', () => {
    const r = uninstall(linkedRender)
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-BEGIN')
    expect(body).toContain('DEV TAIL')
  })

  // These two assert on FILE STATE, not on the message: the block warns on stderr
  // and does NOT exit non-zero (the uninstall continues with the rest of its work),
  // and the harness only returns stdout on a zero exit. File state is the real
  // invariant anyway — the guard exists so the developer's file survives.
  it('T11 — refuses a lone BEGIN instead of deleting to end of file', () => {
    const r = uninstall([...header, REAL_BEGIN, HEADING, 'DEV TAIL', 'MORE DEV'].join('\n'))
    const body = read(r.dir)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('MORE DEV')
    // Still present ⇒ it declined, rather than half-deleting.
    expect(body).toContain('RSCT-CANONICAL-SOURCE-BEGIN')
  })

  it('T12 — refuses a lone END rather than leaving it silently', () => {
    const r = uninstall([...header, REAL_END, 'DEV TAIL'].join('\n'))
    const body = read(r.dir)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('RSCT-CANONICAL-SOURCE-END')
  })

  it('leaves an unfilled slot to Phase 4.2 rather than touching it here', () => {
    const r = uninstall(freshRender)
    expect(r.out).toMatch(/not present — no-op/)
    expect(read(r.dir)).toContain('RSCT-CANONICAL-SOURCE-SLOT')
  })

  it('skips cleanly when 4.2 already deleted the file', () => {
    expect(uninstall(null).out).toMatch(/absent/)
  })

  // The Rv found the count guard was both too strict and too weak. Too strict:
  // it rejected two well-formed pairs, which the unguarded sed had handled. Too
  // weak: a file whose END precedes its BEGIN counts 1 each, passes, and the
  // range delete then runs to end of file. Both are pinned here.
  it('T18 — removes two well-formed pairs and keeps the text between them', () => {
    const r = uninstall(
      [...header, REAL_BEGIN, 'A', REAL_END, 'DEV MIDDLE', REAL_BEGIN, 'B', REAL_END, 'DEV TAIL'].join('\n'),
    )
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-BEGIN')
    expect(body).toContain('DEV MIDDLE')
    expect(body).toContain('DEV TAIL')
  })

  it('refuses a reversed pair instead of deleting to end of file', () => {
    const r = uninstall([...header, REAL_END, 'stray', REAL_BEGIN, 'body', 'DEV TAIL', 'MORE DEV'].join('\n'))
    const body = read(r.dir)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('MORE DEV')
  })

  // A CRLF checkout is the Windows default, so the excision must be CORRECT there:
  // the markers are matched unanchored, so a trailing `\r` cannot break the match.
  //
  // What this test deliberately does NOT assert is the resulting line endings. They
  // are platform-dependent: awk on MSYS strips `\r` from input records and the file
  // comes back LF, while GNU and BSD awk keep it as part of the record and CRLF
  // survives. An earlier version of this test pinned the Windows behaviour as
  // universal and went red on macOS and ubuntu in CI. Nothing downstream may depend
  // on either outcome.
  it('excises correctly on a CRLF file, whatever the platform does to line endings', () => {
    const r = uninstall([...header, REAL_BEGIN, 'body', REAL_END, 'DEV TAIL', ''].join('\n').replace(/\n/g, '\r\n'))
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-BEGIN')
    expect(body).not.toContain('body')
    expect(body).toContain('DEV TAIL')
  })
})

describe.skipIf(!BASH)('#66 — the uninstall removes the placeholder, marked or legacy', () => {
  // Phase 4.2. The Rv proved this block had zero coverage: deleting it outright
  // left the whole suite green, because every uninstall test anchored on 4.3.
  const phase42 = (claudeMd: string | null) =>
    runBlock(ROOT, {
      promptBasename: '03-uninstall.md',
      anchor: 'placeholder removal skipped',
      seedFiles: claudeMd === null ? {} : { 'CLAUDE.md': claudeMd },
    })

  it('T8 — removes the marked slot from a never-linked project', () => {
    const r = phase42(freshRender)
    const body = read(r.dir)
    expect(body).not.toContain('RSCT-CANONICAL-SOURCE-SLOT')
    expect(body).not.toContain('<TODO')
    expect(body).toContain('DEV TAIL')
  })

  // T15 — the residue this whole block was opened for. Every project installed
  // before the marker existed carries the UNMARKED form, which the first
  // implementation of this fix did not touch at all.
  it('T15 — removes the legacy unmarked placeholder of a pre-marker install', () => {
    const r = phase42(legacyRender)
    const body = read(r.dir)
    expect(body).not.toContain('<TODO')
    expect(body).not.toContain('Canonical architectural source')
    expect(body).not.toContain('/rsct-canonical-source')
    expect(body).toContain('DEV TAIL')
  })

  it('leaves a filled section alone — that is 4.3 work, behind its own scope question', () => {
    const r = phase42(linkedRender)
    expect(read(r.dir)).toContain('RSCT-CANONICAL-SOURCE-BEGIN')
  })

  it('refuses a reversed slot pair rather than truncating', () => {
    const r = phase42([...header, SLOT_END, 'stray', SLOT_BEGIN, HEADING, 'DEV TAIL', 'MORE DEV'].join('\n'))
    const body = read(r.dir)
    expect(body).toContain('DEV TAIL')
    expect(body).toContain('MORE DEV')
  })

  it('T16 — reports rather than warning about a file that is not there', () => {
    expect(phase42(null).out).toMatch(/absent/)
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { runBlock, nodeAvailable, assertNodePolicy, readIn, type RunBlockResult } from './lib/block-harness.js'

// Issue #45 — CLAUDE.md rule sections used to freeze forever. Phase 2 said "never
// overwrite present-en content", so a change to rules/X-*.md never reached an
// installed project: measured taking a real 2.3.0 install to 2.6.1, three rule files
// had changed and none propagated, leaving a CLAUDE.md that contradicted the binary
// enforcing it.
//
// Phase 4.3b reconciles them — but only where authorship is PROVABLE. That guard is
// what most of this file exists to pin: getting it wrong silently destroys a dev's
// deliberate local edits, which is strictly worse than the staleness it replaces.

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const ANCHOR = 'Phase 4.3b executing canonical rule-section reconciliation'
// § is U+00A7 (two bytes). Built from its code point so no source-encoding or shell
// round-trip can mangle it — the same reason the block itself uses fromCharCode(167).
const S = String.fromCharCode(167)

const RULE_C = ['# Rule C', '', 'canonical body line one.', 'canonical body line two.'].join('\n')
const RULE_D = ['# Rule D', '', 'protected branches are main and test.'].join('\n')
const RULES_SEED = {
  '.rsct/rules/C-reauthorize.md': `${RULE_C}\n`,
  '.rsct/rules/D-branch-protection.md': `${RULE_D}\n`,
}

/** Real prose around the markers, so "everything outside is preserved" is observable. */
function claudeMd(sections: string): string {
  return `# CLAUDE.md\n\ndev prose BEFORE the sections\n\n${sections}\ndev prose AFTER the sections\n`
}
function section(id: string, body: string, sha?: string): string {
  const hash = sha ? ` sha256-body=${sha}` : ''
  return `<!-- RSCT-${S}${id}-BEGIN v=1.0.0 source=inserted${hash} -->\n${body}\n<!-- RSCT-${S}${id}-END -->\n`
}
/** Mirrors the block's canonical form: CR stripped, trailing blanks dropped, one \n. */
function bodySha(body: string): string {
  return createHash('sha256')
    .update(`${body.replace(/\r/g, '').replace(/\n+$/, '')}\n`)
    .digest('hex')
}

const dirs: string[] = []
function run(opts: Parameters<typeof runBlock>[1]): RunBlockResult {
  const r = runBlock(ROOT, opts)
  dirs.push(r.dir)
  return r
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe.skipIf(!BASH || !NODE)('block: rule-section reconciliation (01-setup 4.3b — #45)', () => {
  // The block splices via `node`, so in CI strict mode a missing node must FAIL rather
  // than let the whole suite skip quietly (the anti-silent-skip policy).
  assertNodePolicy(!!process.env.RSCT_REQUIRE_BASH, NODE)

  // The free migration: a legacy hashless marker whose body already equals the shipped
  // rule gets its hash stamped, silently, with no risk. This is what makes every
  // install in the field classifiable without any release history on disk.
  it('STAMP: a hashless marker with a pristine body gains sha256-body', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', RULE_C)) },
    })
    expect(r.out).toMatch(/STAMP\s+§C/)
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).toContain(`sha256-body=${bodySha(RULE_C)}`)
    expect(cm).toContain('canonical body line one.')
    expect(cm).toContain('dev prose BEFORE the sections')
    expect(cm).toContain('dev prose AFTER the sections')
  }, 60_000)

  // Measured against a real 2.3.0 install: §A, §F and §G differed from their shipped
  // rule by exactly one trailing blank line — an artifact of the agent pasting the
  // body, not drift. Without the trim those three raise false alarms.
  it('STAMP: one trailing blank line is not drift', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', `${RULE_C}\n`)) },
    })
    expect(r.out).toMatch(/STAMP\s+§C/)
    expect(r.out).not.toMatch(/UNVERIFIED\s+§C/)
  }, 60_000)

  // THE #45 FIX: the shipped rule moved, the hash proves the body was untouched since
  // install, so it refreshes automatically. This is the case that was frozen forever.
  it('UPDATE: a changed rule reaches a provably-unmodified section', () => {
    const stale = '# Rule C\n\nOLD body from an earlier release.'
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', stale, bodySha(stale))) },
    })
    expect(r.out).toMatch(/UPDATE\s+§C/)
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).toContain('canonical body line one.')
    expect(cm).not.toContain('OLD body from an earlier release.')
    expect(cm).toContain(`sha256-body=${bodySha(RULE_C)}`)
  }, 60_000)

  it('SKIP: a second run changes the file byte for byte not at all', () => {
    const seed = claudeMd(section('C', RULE_C, bodySha(RULE_C)))
    const once = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': seed },
    })
    expect(once.out).toMatch(/SKIP\s+§C/)
    expect(readIn(once, 'CLAUDE.md')).toBe(seed)
    const twice = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      runs: 2,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': seed },
    })
    expect(readIn(twice, 'CLAUDE.md')).toBe(seed)
  }, 90_000)

  it('PRESERVE: a body edited after install is never rewritten', () => {
    const edited = `${RULE_C}\nOUR TEAM RULE: never force-push.`
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', edited, bodySha(RULE_C))) },
    })
    expect(r.out).toMatch(/PRESERVE\s+§C/)
    expect(readIn(r, 'CLAUDE.md')).toContain('OUR TEAM RULE: never force-push.')
  }, 60_000)

  it('UNVERIFIED: hashless and drifted is reported, never guessed', () => {
    const drifted = `${RULE_C}\nsomething different.`
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', drifted)) },
    })
    expect(r.out).toMatch(/UNVERIFIED\s+§C/)
    expect(r.out).toMatch(/SECTIONS_TO_ADOPT/)
    expect(readIn(r, 'CLAUDE.md')).toContain('something different.')
  }, 60_000)

  // The data-loss guard. `__all__` is the bulk-migration shortcut for legacy hashless
  // markers — it must NOT reach a body the hash proves the dev edited. One `__all__`
  // doing that would silently destroy every deliberate local edit in the file.
  it('__all__ adopts UNVERIFIED but never a proven dev edit', () => {
    const edited = `${RULE_C}\nOUR TEAM RULE: never force-push.`
    const drifted = `${RULE_D}\nand staging.`
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      preamble: 'SECTIONS_TO_ADOPT="__all__"',
      seedFiles: {
        ...RULES_SEED,
        'CLAUDE.md': claudeMd(`${section('C', edited, bodySha(RULE_C))}\n${section('D', drifted)}`),
      },
    })
    expect(r.out).toMatch(/PRESERVE\s+§C/)
    expect(r.out).toMatch(/ADOPT\s+§D/)
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm, 'a proven dev edit must survive __all__').toContain('OUR TEAM RULE: never force-push.')
    expect(cm).not.toContain('and staging.')
  }, 60_000)

  it('an explicit section id DOES override a proven dev edit', () => {
    const edited = `${RULE_C}\nOUR TEAM RULE: never force-push.`
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      preamble: 'SECTIONS_TO_ADOPT="C"',
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': claudeMd(section('C', edited, bodySha(RULE_C))) },
    })
    expect(r.out).toMatch(/ADOPT\s+§C/)
    expect(readIn(r, 'CLAUDE.md')).not.toContain('OUR TEAM RULE')
  }, 60_000)

  // Step A option 2b wraps the DEV'S OWN prose in markers. Its body will never match
  // canonical, so a classifier without the source= whitelist would auto-UPDATE and
  // destroy exactly the content the dev chose to keep.
  it('DEV_OWNED: a non-framework source= is untouchable, even with __all__', () => {
    const own = 'our own authorization rules, written by us.'
    const md = claudeMd(
      `<!-- RSCT-${S}C-BEGIN v=1.0.0 source=migrated-from-ptbr-preserved -->\n${own}\n<!-- RSCT-${S}C-END -->\n`,
    )
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      preamble: 'SECTIONS_TO_ADOPT="__all__ C"',
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': md },
    })
    expect(r.out).toMatch(/DEV_OWNED\s+§C/)
    expect(readIn(r, 'CLAUDE.md')).toContain(own)
  }, 60_000)

  // NOTE on assertions here: the `⚠` lines go to stderr, and the harness only
  // captures stdout when the block exits 0. The summary counters ARE on stdout, so
  // they are the reliable signal — and they are what a regression would move anyway.
  it('MALFORMED and ABSENT are counted, and nothing is mutated', () => {
    const dup = claudeMd(section('C', RULE_C) + section('C', RULE_C))
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': dup },
    })
    expect(r.out).toMatch(/MALFORMED=1/)
    expect(r.out).toMatch(/ABSENT=1/) // §D is seeded as a rule but has no marker pair
    expect(readIn(r, 'CLAUDE.md'), 'a malformed pair must never be touched').toBe(dup)
  }, 60_000)

  it('a CRLF CLAUDE.md classifies correctly and stays CRLF', () => {
    const seed = claudeMd(section('C', RULE_C)).replace(/\n/g, '\r\n')
    const r = run({
      promptBasename: '01-setup.md',
      anchor: ANCHOR,
      seedFiles: { ...RULES_SEED, 'CLAUDE.md': seed },
    })
    expect(r.out).toMatch(/STAMP\s+§C/)
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).toContain('\r\n')
    expect(cm.replace(/\r\n/g, '')).not.toContain('\n')
  }, 60_000)

  // #45 adds a field to the marker. The uninstall excision must still remove the
  // section — proven here rather than reasoned about, so it cannot regress silently.
  it('uninstall still excises a section carrying sha256-body', () => {
    const r = run({
      promptBasename: '03-uninstall.md',
      anchor: 'Phase 4.2 executing canonical RSCT-§X block excision',
      preamble: 'SECTIONS_TO_REMOVE="C"',
      seedFiles: { 'CLAUDE.md': claudeMd(section('C', RULE_C, bodySha(RULE_C))) },
    })
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).not.toContain('RSCT-')
    expect(cm).not.toContain('canonical body line one.')
    expect(cm).toContain('dev prose BEFORE the sections')
    expect(cm).toContain('dev prose AFTER the sections')
  }, 60_000)
})

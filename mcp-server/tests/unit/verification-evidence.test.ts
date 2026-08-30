import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATEGORY_PROMPTS,
  evidenceForSource,
  runVerificationChecklist,
} from '../../src/lib/verification-checklist.js'
import { summarizeEvidence } from '../../src/lib/findings.js'

/**
 * #75, V side. The V phase has NO agent-declared findings channel —
 * `phaseVerificationStartInputSchema` is `.strict()` with no `findings` field —
 * so every V finding is machine-produced and the framework has to classify its
 * own record or the class covers half of it.
 */

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-vev-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/**
 * A corpus rich enough that every emission site in the checklist fires.
 *
 * Run at `specTier: 'complex'` on purpose. `verification-checklist.ts` caps
 * knowledge prompts at `tierMaxPrompts = specTier === 'complex' ? 10 : 5`, so a
 * fixture built at the schema default (`standard`) would emit FIVE of the ten
 * `knowledge-category:*` sources and the exhaustiveness assertion below would
 * pass over half the space — green and blind. That is the trap this test exists
 * to not fall into.
 */
function seedFullCorpus(): void {
  writeFile(
    'documentation/decisions.md',
    '## ADR-1 — Pessimistic lock closes the read-SUM-write race\n\nWe took a pessimistic lock on the stock record.\n',
  )
  writeFile(
    'documentation/knowledge/anti-decisions.md',
    '## AD-1 — Batch threshold sync rejected\n\nWe rejected propagating stock via a batch threshold sync.\n',
  )
  for (const cat of Object.keys(CATEGORY_PROMPTS)) {
    writeFile(`documentation/knowledge/${cat}.md`, `# ${cat}\n\nContent for ${cat}.\n`)
  }
  writeFile(
    'documentation/architecture.md',
    '# Architecture\n\n## Layers\n\ntext\n\n## Boundaries\n\ntext\n',
  )
  writeFile('documentation/impact/stock.md', '# stock impact\n\nCouplings.\n')
}

function runFull() {
  seedFullCorpus()
  return runVerificationChecklist({
    projectRoot: tmpRoot,
    declaredPaths: ['src/stock.ts'],
    // `via_paths` is the real field name (lib/reverse-dep-walk.ts:110). The first
    // draft of this fixture said `via`, which the checklist reads as
    // `imp.via_paths[0]` — it threw rather than quietly grouping under an
    // `<unknown-seed>` bucket and letting the assertions pass on a corpus the
    // production code cannot actually produce.
    discoveredImporters: [
      { file: 'src/order.ts', depth: 1, via_paths: ['src/stock.ts'] },
      { file: 'src/report.ts', depth: 2, via_paths: ['src/stock.ts', 'src/order.ts'] },
    ],
    specClaims: ['Cascade delete propagates the stock record to every pedido registro'],
    specTier: 'complex',
    existingProjectFiles: ['src/stock.ts', 'legacy/stock.ts'],
    // #75 Part B added `contract-surface`. Without a graph here the corpus would
    // no longer reach every emittable source, and T21-self — the guard that
    // exists to stop exactly that — would keep passing while covering less than
    // it claims. Adding a source means extending this fixture, and T21-self is
    // what makes forgetting it fail.
    universeLinked: true,
    appName: 'checkout',
    contractGraph: {
      available: true,
      contracts: [
        {
          id: 'stock-api',
          producer: 'checkout',
          surface: ['src/stock.ts'],
          consumers: ['billing'],
        },
      ],
      note: null,
    },
  })
}

describe('evidenceForSource — a total table whose default is the weakest class', () => {
  const raw = {
    id: 'v-gap-1',
    category: 'gap' as const,
    severity: 'defer' as const,
    title: 't',
    detail: 'd',
    affected_paths: ['src/a.ts', 'documentation/impact/a.md'],
  }

  // MUTATION: change `startsWith('knowledge-category:')` to `===`.
  it('T10 — knowledge-category is matched by PREFIX, since the literal is interpolated', () => {
    for (const cat of Object.keys(CATEGORY_PROMPTS)) {
      const e = evidenceForSource({ ...raw, source: `knowledge-category:${cat}` })
      expect(e.kind).toBe('hypothesis')
      expect(e).not.toHaveProperty('degraded')
    }
  })

  // MUTATION: flip the reverse-dep-walk row to `hypothesis`.
  it('T10b — the walk is the one MEASURED source, and it says what else explains it', () => {
    const e = evidenceForSource({ ...raw, source: 'reverse-dep-walk' })
    expect(e.kind).toBe('measured')
    if (e.kind !== 'measured') throw new Error('unreachable')
    expect(e.command).toContain('reverse-dep')
    // The load-bearing field. A measured finding that names no alternative is
    // the failure mode this whole issue was opened over.
    expect(e.also_explained_by).toMatch(/EDGES, not semantics/)
  })

  // MUTATION: give premise-check the `measured` row.
  it('T10c — a premise-check hit is a HYPOTHESIS: shared vocabulary is not a claim about code', () => {
    const e = evidenceForSource({ ...raw, source: 'premise-check' })
    expect(e.kind).toBe('hypothesis')
    if (e.kind !== 'hypothesis') throw new Error('unreachable')
    expect(e.how_to_falsify).toMatch(/vocabulary coincidence/)
  })

  it('T10d — doc-derived sources are REPORTED against a working tree, never a commit', () => {
    for (const source of ['impact-doc', 'architecture-overview']) {
      const e = evidenceForSource({ ...raw, source })
      expect(e.kind).toBe('reported')
      if (e.kind !== 'reported') throw new Error('unreachable')
      expect(e.verified_against).toBe('working_tree')
      expect(e.commit_sha).toBeUndefined()
    }
  })

  // MUTATION: make the default arm return `{kind:'measured', …}`.
  it('T11 — an unrecognised source degrades to the WEAKEST class and names the literal', () => {
    const e = evidenceForSource({ ...raw, source: 'some-future-scanner' })
    expect(e.kind).toBe('hypothesis')
    expect(e).toMatchObject({ degraded: true, degraded_from: 'unknown_source:some-future-scanner' })
  })
})

describe('runVerificationChecklist — every emitted source is classified', () => {
  // A SELF-TEST ON THE CHECKER. T21 below only proves what its corpus reaches, so
  // this pins that the corpus reaches everything: the six fixed source literals,
  // the interpolated `knowledge-category:*` family, and `contract-surface` from
  // #75 Part B. Without it, T21 shrinks to a partial guard the day an emission
  // site stops firing or a new one is added — which already happened once, when
  // Part B introduced a source this corpus did not reach.
  it('T21-self — the fixture exercises every source kind the checklist can emit', () => {
    const kinds = new Set(
      runFull().findings.map((f) =>
        f.source.startsWith('knowledge-category:') ? 'knowledge-category:*' : f.source,
      ),
    )
    expect([...kinds].sort()).toEqual([
      'architecture-overview',
      'basename-overlap',
      'contract-surface',
      'impact-doc',
      'knowledge-category:*',
      'premise-check',
      'reverse-dep-walk',
    ])
  })

  // MUTATION: delete any row from evidenceForSource (each falls to the default).
  //
  // The drift alarm. It does not hard-code the source list: it collects whatever
  // the checklist actually emitted and asserts none of it reached the default
  // arm, naming the offender when one does. A source literal added years from
  // now fails this on the day it lands.
  it('T21 — no source the checklist can emit falls through to the default arm', () => {
    const r = runFull()
    expect(r.findings.length).toBeGreaterThan(0)

    const unclassified = r.findings
      .filter((f) => f.evidence.kind === 'hypothesis' && f.evidence.degraded === true)
      .map((f) => f.source)

    expect(unclassified).toEqual([])
  })

  // MUTATION: cap tierMaxPrompts at 5 for 'complex' too.
  it('T21b — the fixture reaches all ten knowledge categories, not the standard-tier five', () => {
    const r = runFull()
    const cats = r.findings
      .filter((f) => f.source.startsWith('knowledge-category:'))
      .map((f) => f.source.slice('knowledge-category:'.length))
      .sort()
    expect(cats).toEqual(Object.keys(CATEGORY_PROMPTS).sort())
  })

  // MUTATION: drop the `.map` that assigns evidence in runVerificationChecklist.
  it('T21c — every finding carries a class, and the corpus is not all one kind', () => {
    const r = runFull()
    expect(r.findings.every((f) => f.evidence !== undefined)).toBe(true)

    const mix = summarizeEvidence(r.findings)
    expect(mix.measurable).toBe(true)
    expect(mix.total).toBe(r.findings.length)
    expect(mix.measured + mix.reported + mix.hypothesis).toBe(mix.total)
    // A fixture where everything landed in one class could not tell a working
    // table from a constant function.
    expect(mix.measured).toBeGreaterThan(0)
    expect(mix.reported).toBeGreaterThan(0)
    expect(mix.hypothesis).toBeGreaterThan(0)
    expect(mix.unrecorded).toBe(0)
  })

  // This is the #79 corpus shape: a V phase whose findings are overwhelmingly
  // vocabulary matches. The class does not stop them being raised — it makes the
  // dev able to see what they are worth before answering 22 of them.
  it('T21d — a premise-check-only run reads as all hypothesis, never as fact', () => {
    writeFile(
      'documentation/decisions.md',
      '## ADR-1 — Pedido registro sync\n\nThe pedido registro is synced.\n',
    )
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/a.ts'],
      discoveredImporters: [],
      specClaims: ['The pedido registro propagates on delete'],
      specTier: 'standard',
    })
    const premise = r.findings.filter((f) => f.source === 'premise-check')
    expect(premise.length).toBeGreaterThan(0)
    expect(premise.every((f) => f.evidence.kind === 'hypothesis')).toBe(true)
    expect(summarizeEvidence(premise).measured).toBe(0)
  })
})

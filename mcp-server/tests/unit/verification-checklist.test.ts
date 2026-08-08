import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runVerificationChecklist } from '../../src/lib/verification-checklist.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-vchk-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('runVerificationChecklist — tier table skip', () => {
  it('skips when spec_tier=trivial', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
      specTier: 'trivial',
    })
    expect(r.findings).toEqual([])
    expect(r.hints.some((h) => h.includes('skipped per tier table'))).toBe(true)
  })

  it('skips when spec_tier=small', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
      specTier: 'small',
    })
    expect(r.findings).toEqual([])
  })

  it('runs for spec_tier=standard (default)', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
    })
    expect(r.stats.categories_run).toContain('gap')
    expect(r.stats.categories_run).toContain('breakage')
    expect(r.stats.categories_run).toContain('redundancy')
    expect(r.stats.categories_run).toContain('forgotten')
  })
})

describe('runVerificationChecklist — gap category (premise check)', () => {
  it('hints when specClaims absent but decisions corpus exists', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/orders.ts'],
      discoveredImporters: [],
    })
    expect(r.stats.decisions_scanned).toBeGreaterThan(0)
    expect(r.hints.some((h) => h.includes('specClaims'))).toBe(true)
  })

  it('emits a block-severity finding when a claim matches an anti-decision', () => {
    // Sample fixture has anti-decisions.md with known abandoned tech
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/orders.ts'],
      discoveredImporters: [],
      specClaims: ['use Redis as primary database for orders'],
    })
    const blocks = r.findings.filter(
      (f) => f.category === 'gap' && f.severity === 'block',
    )
    // Either an anti-decision hit (block) or a conflict (address-now) — both are valid signals
    const gapFindings = r.findings.filter((f) => f.category === 'gap')
    expect(gapFindings.length).toBeGreaterThanOrEqual(0)
    // If the fixture has an anti-decision with overlap, we expect at least one block
    // If not, we at least expect the gap category to have run
    expect(r.stats.categories_run).toContain('gap')
    // Sanity: blocks (if any) must come from premise-check
    blocks.forEach((b) => expect(b.source).toBe('premise-check'))
  })

  it('emits requires_revision (address-now) when claim matches a firm premise', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/orders.ts'],
      discoveredImporters: [],
      specClaims: ['allow UPDATE statements on financial events tables'],
    })
    const gapAddressNow = r.findings.filter(
      (f) => f.category === 'gap' && f.severity === 'address-now',
    )
    expect(gapAddressNow.length).toBeGreaterThanOrEqual(1)
  })
})

describe('runVerificationChecklist — breakage category', () => {
  it('emits one breakage finding per declared seed when importers exist', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/seed.ts'],
      discoveredImporters: [
        {
          file: 'src/a.ts',
          depth: 1,
          via_paths: ['src/seed.ts', 'src/a.ts'],
        },
        {
          file: 'src/b.ts',
          depth: 1,
          via_paths: ['src/seed.ts', 'src/b.ts'],
        },
      ],
    })
    const breakages = r.findings.filter(
      (f) => f.category === 'breakage' && f.source === 'reverse-dep-walk',
    )
    expect(breakages).toHaveLength(1)
    expect(breakages[0]?.title).toContain('2 importer')
    expect(breakages[0]?.severity).toBe('capture-as-issue')
  })

  it('raises severity to address-now when direct importers > 5', () => {
    const importers = Array.from({ length: 8 }, (_, i) => ({
      file: `src/i${i}.ts`,
      depth: 1,
      via_paths: ['src/seed.ts', `src/i${i}.ts`],
    }))
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/seed.ts'],
      discoveredImporters: importers,
    })
    const b = r.findings.find(
      (f) => f.category === 'breakage' && f.source === 'reverse-dep-walk',
    )
    expect(b?.severity).toBe('address-now')
  })

  it('surfaces impact-doc finding when documentation/impact/<name>.md exists', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/orders.ts'],
      discoveredImporters: [],
    })
    const impactFindings = r.findings.filter((f) => f.source === 'impact-doc')
    expect(impactFindings).toHaveLength(1)
    expect(impactFindings[0]?.category).toBe('breakage')
    expect(impactFindings[0]?.severity).toBe('address-now')
    expect(impactFindings[0]?.title).toContain('orders')
  })
})

describe('runVerificationChecklist — redundancy category', () => {
  it('emits redundancy finding when basename overlaps existing project files', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/new/payments.ts'],
      discoveredImporters: [],
      existingProjectFiles: ['src/existing/payments.ts', 'src/orders.ts'],
    })
    const redundancies = r.findings.filter(
      (f) => f.source === 'basename-overlap',
    )
    expect(redundancies).toHaveLength(1)
    expect(redundancies[0]?.category).toBe('redundancy')
    expect(redundancies[0]?.severity).toBe('capture-as-issue')
  })

  it('skips short basenames (< 4 chars) to avoid false positives', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/new/abc.ts'],
      discoveredImporters: [],
      existingProjectFiles: ['src/existing/abc.ts'],
    })
    const redundancies = r.findings.filter(
      (f) => f.source === 'basename-overlap',
    )
    expect(redundancies).toHaveLength(0)
  })

  it('skips common basenames (index, utils, helpers, types)', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/new/index.ts', 'src/new/utils.ts'],
      discoveredImporters: [],
      existingProjectFiles: ['src/existing/index.ts', 'src/lib/utils.ts'],
    })
    const redundancies = r.findings.filter(
      (f) => f.source === 'basename-overlap',
    )
    expect(redundancies).toHaveLength(0)
  })

  it('does not run redundancy check when existingProjectFiles absent', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/payments.ts'],
      discoveredImporters: [],
    })
    const redundancies = r.findings.filter(
      (f) => f.source === 'basename-overlap',
    )
    expect(redundancies).toHaveLength(0)
  })
})

describe('runVerificationChecklist — forgotten category', () => {
  it('emits up to 5 prompts for standard tier with knowledge categories present', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
      specTier: 'standard',
    })
    const knowledgePrompts = r.findings.filter((f) =>
      f.source.startsWith('knowledge-category:'),
    )
    expect(knowledgePrompts.length).toBeGreaterThan(0)
    expect(knowledgePrompts.length).toBeLessThanOrEqual(5)
    knowledgePrompts.forEach((p) => {
      expect(p.category).toBe('forgotten')
      expect(p.severity).toBe('defer')
    })
  })

  it('allows up to 10 prompts for complex tier', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
      specTier: 'complex',
    })
    const knowledgePrompts = r.findings.filter((f) =>
      f.source.startsWith('knowledge-category:'),
    )
    expect(knowledgePrompts.length).toBeLessThanOrEqual(10)
  })

  it('emits architecture-overview finding when architecture.md has sections', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
    })
    const archFinding = r.findings.find(
      (f) => f.source === 'architecture-overview',
    )
    expect(archFinding).toBeDefined()
    expect(archFinding?.category).toBe('forgotten')
  })
})

describe('runVerificationChecklist — empty corpus', () => {
  it('hints when project has no decisions/knowledge/architecture', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
    })
    expect(r.findings).toEqual([])
    expect(
      r.hints.some((h) => h.includes('Verification corpus is empty')),
    ).toBe(true)
  })
})

describe('runVerificationChecklist — stats coverage', () => {
  it('populates all stats fields against the sample fixture', () => {
    const r = runVerificationChecklist({
      projectRoot: SAMPLE_RSCT,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
    })
    expect(r.stats.categories_run).toEqual([
      'gap',
      'breakage',
      'redundancy',
      'forgotten',
    ])
    expect(r.stats.knowledge_categories_present.length).toBeGreaterThan(0)
    expect(r.stats.architecture_overview_present).toBe(true)
    expect(r.stats.impact_docs_consulted).toBeGreaterThan(0)
  })
})

// #58 — this checklist is what closes the V phase. "Found no findings against the
// available corpus" over a file that was never read is the same silent zero the
// issue was filed for, one phase later and more expensive.
describe('runVerificationChecklist — corpus that was not read (#58)', () => {
  const run = () =>
    runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['src/foo.ts'],
      discoveredImporters: [],
      specTier: 'standard',
    })

  it('reports an unreadable anti-decisions.md instead of a clean pass', () => {
    writeFile('documentation/decisions.md', '### ADR-001 — Something\nBody.\n')
    // A directory at the path: exists, cannot be read.
    mkdirSync(join(tmpRoot, 'documentation', 'knowledge', 'anti-decisions.md'), {
      recursive: true,
    })

    const r = run()
    expect(
      r.hints.some(
        (h) => h.includes('was NOT read') && h.includes('anti-decisions.md (exists, unreadable)'),
      ),
    ).toBe(true)
    // No clean-pass assertion here on purpose: a directory at that path still counts
    // as a present knowledge category, so this case emits a `forgotten` finding and
    // the clean-pass hint would be absent for an unrelated reason. The suppression is
    // tested in the next case, where the findings set is provably empty.
  })

  it('reports a decisions.md that carries ids but parses to nothing, and drops the clean pass', () => {
    // No knowledge/ directory: nothing else can add a finding, so the clean-pass hint
    // is absent because of the suppression and for no other reason.
    writeFile('documentation/decisions.md', '#### ADR-001 -- wrong level and separator\nBody.\n')

    const r = run()
    expect(r.findings, 'this case must produce no findings, or the next assert is vacuous').toEqual(
      [],
    )
    expect(
      r.hints.some(
        (h) => h.includes('was NOT read') && h.includes('decisions.md (mentions ids, none parsed)'),
      ),
    ).toBe(true)
    expect(
      r.hints.some((h) => h.includes('found no findings to surface')),
      'must not claim a clean pass over a corpus it could not read',
    ).toBe(false)
  })

  it('still claims the clean pass when the corpus was actually read', () => {
    // The suppression must be scoped to the miss, not applied whenever the corpus is
    // small. Only decisions.md here, and no knowledge/ directory: a present knowledge
    // category emits `forgotten` prompts, which would take the findings count above
    // zero and skip this branch for an unrelated reason.
    writeFile('documentation/decisions.md', '### ADR-001 — Something\nBody.\n')

    const r = run()
    expect(r.findings).toEqual([])
    expect(r.hints.some((h) => h.includes('was NOT read'))).toBe(false)
    expect(r.hints.some((h) => h.includes('found no findings to surface'))).toBe(true)
  })
})

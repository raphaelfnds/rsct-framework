import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import {
  readUniverseGovernanceIndex,
  readUniverseDoc,
  isSafeDocSlug,
} from '../../src/lib/universe-content.js'

const SAMPLE_UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-universe')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-unic-'))
}

function seedUniverse(opts: { govDocs?: string[]; index?: boolean; emptyGov?: boolean } = {}): string {
  const u = tmp()
  if (opts.emptyGov) {
    mkdirSync(join(u, 'docs', 'governance'), { recursive: true })
  } else if (opts.govDocs) {
    mkdirSync(join(u, 'docs', 'governance'), { recursive: true })
    for (const d of opts.govDocs) {
      writeFileSync(join(u, 'docs', 'governance', `${d}.md`), `# ${d}\n\n## Section A\n\nbody of ${d}\n`)
    }
  }
  if (opts.index) {
    mkdirSync(join(u, 'docs'), { recursive: true })
    writeFileSync(join(u, 'docs', 'INDEX.md'), '# Index\n\n## Governance\n\nlinks\n')
  }
  return u
}

describe('lib/universe-content — readUniverseGovernanceIndex', () => {
  it('lists governance slugs (sorted, README excluded) + has_index from the fixture', () => {
    const idx = readUniverseGovernanceIndex(SAMPLE_UNIVERSE)
    expect(idx.available).toBe(true)
    expect(idx.docs).toEqual(['canonical-sources-map', 'document-control', 'naming-standards'])
    expect(idx.has_index).toBe(true)
    expect(idx.governance_dir).not.toBeNull()
    expect(idx.governance_dir!.includes('\\')).toBe(false) // forward-slashed (FV7)
  })

  it('README.md is excluded from the slug list', () => {
    const u = seedUniverse({ govDocs: ['naming-standards'] })
    writeFileSync(join(u, 'docs', 'governance', 'README.md'), '# readme\n')
    const idx = readUniverseGovernanceIndex(u)
    expect(idx.docs).toEqual(['naming-standards'])
  })

  it('dir present but EMPTY → available:true, docs:[] (distinct from dir-missing — FV4)', () => {
    const idx = readUniverseGovernanceIndex(seedUniverse({ emptyGov: true }))
    expect(idx.available).toBe(true)
    expect(idx.docs).toEqual([])
    expect(idx.has_index).toBe(false)
  })

  it('no docs/governance/ → empty/unavailable index (dir-missing)', () => {
    const u = tmp()
    writeFileSync(join(u, '.universe.json'), '{"name":"x"}')
    const idx = readUniverseGovernanceIndex(u)
    expect(idx).toEqual({ available: false, governance_dir: null, docs: [], has_index: false })
  })

  it('has_index true even when governance dir is empty (INDEX is independent)', () => {
    const idx = readUniverseGovernanceIndex(seedUniverse({ emptyGov: true, index: true }))
    expect(idx.available).toBe(true)
    expect(idx.docs).toEqual([])
    expect(idx.has_index).toBe(true)
  })
})

describe('lib/universe-content — readUniverseDoc', () => {
  it('reads a governance doc and parses sections', () => {
    const d = readUniverseDoc(SAMPLE_UNIVERSE, 'naming-standards')
    expect(d.exists).toBe(true)
    expect(d.path).toBe('docs/governance/naming-standards.md')
    expect(d.sections.map((s) => s.heading)).toContain('Git branch naming')
  })

  it("slug 'INDEX' routes to docs/INDEX.md (not docs/governance/INDEX.md)", () => {
    const d = readUniverseDoc(SAMPLE_UNIVERSE, 'INDEX')
    expect(d.exists).toBe(true)
    expect(d.path).toBe('docs/INDEX.md')
    expect(d.sections.map((s) => s.heading)).toContain('Governance')
  })

  it('missing governance doc → exists:false', () => {
    expect(readUniverseDoc(SAMPLE_UNIVERSE, 'does-not-exist').exists).toBe(false)
  })

  it('CRLF governance doc parses cleanly (no trailing \\r in heading — FV)', () => {
    const u = tmp()
    mkdirSync(join(u, 'docs', 'governance'), { recursive: true })
    writeFileSync(join(u, 'docs', 'governance', 'naming-standards.md'), '# T\r\n\r\n## Git branch naming\r\n\r\n- feat/x\r\n')
    const d = readUniverseDoc(u, 'naming-standards')
    expect(d.sections).toHaveLength(1)
    expect(d.sections[0]!.heading).toBe('Git branch naming')
  })

  it('rejects path-traversal / separator / absolute slugs (FV6)', () => {
    const u = tmp()
    mkdirSync(join(u, 'docs', 'governance'), { recursive: true })
    writeFileSync(join(u, '.universe.json'), '{"secret":"no-leak"}')
    writeFileSync(join(u, 'docs', 'governance', 'naming-standards.md'), '## H\n\nx\n')
    for (const bad of ['../.universe.json', '../../etc/passwd', 'a/b', 'a\\b', '..', 'foo/../bar']) {
      expect(readUniverseDoc(u, bad).exists).toBe(false)
    }
    const absSlug = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    expect(readUniverseDoc(u, absSlug).exists).toBe(false)
    // a legit slug still reads alongside the guard
    expect(readUniverseDoc(u, 'naming-standards').exists).toBe(true)
  })
})

describe('lib/universe-content — isSafeDocSlug', () => {
  it('accepts kebab-case slugs, rejects unsafe ones', () => {
    expect(isSafeDocSlug('naming-standards')).toBe(true)
    expect(isSafeDocSlug('INDEX')).toBe(true)
    expect(isSafeDocSlug('')).toBe(false)
    expect(isSafeDocSlug('a/b')).toBe(false)
    expect(isSafeDocSlug('a\\b')).toBe(false)
    expect(isSafeDocSlug('..')).toBe(false)
    expect(isSafeDocSlug(42 as unknown)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { getUniverseHandler } from '../../src/tools/get-universe.js'

const SAMPLE_RSCT_UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-rsct-universe')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-gu-'))
}

describe('rsct_get_universe — universe linked (sample-rsct-universe → sample-universe)', () => {
  it('scope=governance (default) returns all governance docs with sections', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE })
    expect(out.universe_available).toBe(true)
    expect(out.scope).toBe('governance')
    expect(out.governance.docs).toEqual(['canonical-sources-map', 'document-control', 'naming-standards'])
    expect(out.docs.map((d) => d.slug)).toEqual(['canonical-sources-map', 'document-control', 'naming-standards'])
    expect(out.docs.every((d) => d.exists && d.sections.length > 0)).toBe(true)
    expect(out.hints).toEqual([])
  })

  it('scope=governance + doc narrows to one file', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, doc: 'naming-standards' })
    expect(out.docs.map((d) => d.slug)).toEqual(['naming-standards'])
    expect(out.docs[0]!.path).toBe('docs/governance/naming-standards.md')
  })

  it('scope=index reads docs/INDEX.md', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, scope: 'index' })
    expect(out.docs.map((d) => d.slug)).toEqual(['INDEX'])
    expect(out.docs[0]!.exists).toBe(true)
    expect(out.docs[0]!.path).toBe('docs/INDEX.md')
  })

  it('scope=all reads INDEX + governance', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, scope: 'all' })
    expect(out.docs.map((d) => d.slug)).toEqual([
      'INDEX', 'canonical-sources-map', 'document-control', 'naming-standards',
    ])
  })

  it('query filters sections case-insensitively', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, doc: 'naming-standards', query: 'BRANCH' })
    const ns = out.docs[0]!
    expect(ns.sections.length).toBeGreaterThan(0)
    expect(ns.sections.every((s) => /branch/i.test(s.heading) || /branch/i.test(s.body))).toBe(true)
  })

  it('unknown doc → empty docs + an available-list hint', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, doc: 'nope' })
    expect(out.docs).toEqual([])
    expect(out.hints.join(' ')).toMatch(/No docs\/governance\/nope\.md/)
    expect(out.hints.join(' ')).toMatch(/naming-standards/)
  })

  it('query with no match across the requested doc → no-match hint', async () => {
    const out = await getUniverseHandler({ project_root: SAMPLE_RSCT_UNIVERSE, doc: 'naming-standards', query: 'zzzznotfound' })
    expect(out.docs[0]!.sections).toEqual([])
    expect(out.hints.join(' ')).toMatch(/matched no section/)
  })
})

describe('rsct_get_universe — no universe / degraded', () => {
  it('rsct project with NO universe → universe_available:false + link hint', async () => {
    const p = tmp()
    writeFileSync(join(p, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'solo', org: 'acme' } }))
    const out = await getUniverseHandler({ project_root: p })
    expect(out.rsct_installed).toBe(true)
    expect(out.universe_available).toBe(false)
    expect(out.docs).toEqual([])
    expect(out.governance.available).toBe(false)
    expect(out.hints.join(' ')).toMatch(/rsct-canonical-source/)
  })

  it('configured-but-missing universe → universe_available:false + the note hint', async () => {
    const p = tmp()
    writeFileSync(
      join(p, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'solo', org: 'acme' }, universe: { local: join(p, 'gone') } }),
    )
    const out = await getUniverseHandler({ project_root: p })
    expect(out.universe_available).toBe(false)
    expect(out.universe_note).toMatch(/configured but not found/)
    expect(out.hints.join(' ')).toMatch(/configured but not found/)
  })

  it('universe linked but governance unscaffolded → available:true block, empty docs + scaffold hint', async () => {
    const parent = tmp()
    const proj = join(parent, 'app'); mkdirSync(proj)
    const uni = join(parent, 'acme-universe'); mkdirSync(uni, { recursive: true })
    writeFileSync(join(uni, '.universe.json'), '{"name":"acme-universe","registered_apps":[]}')
    writeFileSync(join(proj, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'app', org: 'acme' }, universe: { local: uni } }))
    const out = await getUniverseHandler({ project_root: proj })
    expect(out.universe_available).toBe(true)
    expect(out.governance.available).toBe(false)
    expect(out.docs).toEqual([])
    expect(out.hints.join(' ')).toMatch(/no governance docs/)
    expect(out.hints.join(' ')).toMatch(/rsct-init-universe/)
  })

  it('non-rsct project → rsct_installed:false + universe_available:false', async () => {
    const out = await getUniverseHandler({ project_root: tmp() })
    expect(out.rsct_installed).toBe(false)
    expect(out.universe_available).toBe(false)
    expect(out.docs).toEqual([])
  })
})

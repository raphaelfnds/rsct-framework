import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { detectTopology, confirmedTopologyMode } from '../../src/lib/topology.js'
import type { RsctConfig } from '../../src/lib/project-root.js'
import { statusHandler } from '../../src/tools/status.js'
import { loadContextHandler } from '../../src/tools/load-context.js'

const UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-universe')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-topo-'))
}
function cfg(p: Partial<RsctConfig> = {}): RsctConfig {
  return { rsct_version: '1.0.0', app: { name: 'registered-app', org: 'acme' }, ...p }
}

// Build a sibling multi-repo layout: parent/{app-a, acme-universe(applications/app-a,app-b)}.
function multiRepoLayout(appName = 'app-a'): { proj: string; uni: string } {
  const parent = tmp()
  const proj = join(parent, appName)
  mkdirSync(proj)
  const uni = join(parent, 'acme-universe')
  mkdirSync(join(uni, 'applications', 'app-a'), { recursive: true })
  mkdirSync(join(uni, 'applications', 'app-b'), { recursive: true })
  writeFileSync(join(uni, '.universe.json'), '{"name":"acme-universe","registered_apps":["app-a","app-b"]}')
  return { proj, uni }
}

describe('lib/topology — detectTopology inference', () => {
  it('no universe → mono (high)', () => {
    const r = detectTopology(cfg(), tmp(), { home: tmp() })
    expect(r.block.inferred_mode).toBe('mono')
    expect(r.block.confidence).toBe('high')
    expect(r.block.signals.universe_available).toBe(false)
    expect(r.universe_root).toBeNull()
  })

  it('universe + ≥2 registered apps external → multi-repo (high)', () => {
    const { proj, uni } = multiRepoLayout()
    const r = detectTopology(
      cfg({ app: { name: 'app-a', org: 'acme' }, universe: { local: uni } }),
      proj,
      { home: tmp() },
    )
    expect(r.block.inferred_mode).toBe('multi-repo')
    expect(r.block.confidence).toBe('high')
    expect(r.block.signals.registered_apps_count).toBe(2)
    expect(r.block.signals.universe_external).toBe(true)
    expect(r.universe_root).toBe(uni)
  })

  it('≥2 nested app markers, no universe → monorepo (low)', () => {
    const proj = tmp()
    mkdirSync(join(proj, 'packages', 'a'), { recursive: true })
    mkdirSync(join(proj, 'packages', 'b'), { recursive: true })
    writeFileSync(join(proj, 'packages', 'a', 'package.json'), '{}')
    writeFileSync(join(proj, 'packages', 'b', 'package.json'), '{}')
    const r = detectTopology(cfg(), proj, { home: tmp() })
    expect(r.block.inferred_mode).toBe('monorepo')
    expect(r.block.confidence).toBe('low')
    expect(r.block.signals.nested_app_markers).toBe(2)
  })

  it('node_modules is NOT counted as a nested marker (V FV5)', () => {
    const proj = tmp()
    mkdirSync(join(proj, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(proj, 'node_modules', 'y'), { recursive: true })
    writeFileSync(join(proj, 'node_modules', 'x', 'package.json'), '{}')
    writeFileSync(join(proj, 'node_modules', 'y', 'package.json'), '{}')
    const r = detectTopology(cfg(), proj, { home: tmp() })
    expect(r.block.signals.nested_app_markers).toBe(0)
    expect(r.block.inferred_mode).toBe('mono')
  })

  it('confirmed_mode overrides inference; effective = confirmed', () => {
    const r = detectTopology(cfg({ topology: { mode: 'mono' } }), tmp(), { home: tmp() })
    expect(r.block.confirmed_mode).toBe('mono')
    expect(r.block.effective_mode).toBe('mono')
  })

  it('effective = inferred when unconfirmed', () => {
    const r = detectTopology(cfg(), tmp(), { home: tmp() })
    expect(r.block.confirmed_mode).toBeNull()
    expect(r.block.effective_mode).toBe(r.block.inferred_mode)
  })

  it('null config → mono NONE block, never throws', () => {
    const r = detectTopology(null, tmp())
    expect(r.block.inferred_mode).toBe('mono')
    expect(r.universe_root).toBeNull()
    expect(r.hint).toBeNull()
  })

  it('FV1: confirmed multi-repo but no universe → inactive-gate hint', () => {
    const r = detectTopology(cfg({ topology: { mode: 'multi-repo' } }), tmp(), { home: tmp() })
    expect(r.hint).toMatch(/not active yet/)
  })

  it('FV1: confirmed multi-repo + universe but no contracts.json → inactive hint', () => {
    const { proj, uni } = multiRepoLayout()
    const r = detectTopology(
      cfg({ app: { name: 'app-a', org: 'acme' }, topology: { mode: 'multi-repo' }, universe: { local: uni } }),
      proj,
      { home: tmp() },
    )
    expect(r.hint).toMatch(/contracts\.json is missing|not active yet/)
  })

  it('no FV1 hint when multi-repo + universe + contracts.json present', () => {
    const r = detectTopology(
      cfg({ topology: { mode: 'multi-repo' }, universe: { local: UNIVERSE } }),
      tmp(),
      { home: tmp() },
    )
    expect(r.hint).toBeNull()
  })
})

describe('lib/topology — confirmedTopologyMode (gate hot path)', () => {
  it('reads a valid mode', () => {
    expect(confirmedTopologyMode(cfg({ topology: { mode: 'multi-repo' } }))).toBe('multi-repo')
  })
  it('null when no topology / null config', () => {
    expect(confirmedTopologyMode(cfg())).toBeNull()
    expect(confirmedTopologyMode(null)).toBeNull()
  })
})

describe('topology — status ⇄ load_context parity (single source)', () => {
  it('the topology block is present and identical across both', async () => {
    const proj = tmp()
    writeFileSync(
      join(proj, '.rsct.json'),
      JSON.stringify(cfg({ topology: { mode: 'multi-repo' }, universe: { local: UNIVERSE } })),
    )
    const s = await statusHandler({ project_root: proj })
    const l = await loadContextHandler({ project_root: proj })
    expect(s.topology).toEqual(l.topology)
    expect(s.topology.confirmed_mode).toBe('multi-repo')
  })

  it('mono confirmed → topology block present but NO topology hint noise', async () => {
    const proj = tmp()
    writeFileSync(join(proj, '.rsct.json'), JSON.stringify(cfg({ topology: { mode: 'mono' } })))
    const s = await statusHandler({ project_root: proj })
    expect(s.topology.confirmed_mode).toBe('mono')
    // the FV1 inactive-gate hint fires ONLY for confirmed multi-repo; mono is quiet.
    expect(s.hints.some((h) => /topolog|contract gate|multi-repo/i.test(h))).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import {
  resolveUniverseRoot,
  readUniverse,
  getUniverse,
} from '../../src/lib/universe.js'
import type { RsctConfig } from '../../src/lib/project-root.js'
import { statusHandler } from '../../src/tools/status.js'
import { loadContextHandler } from '../../src/tools/load-context.js'

const UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-universe')
const SAMPLE_RSCT_UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-rsct-universe')

function cfg(partial: Partial<RsctConfig> = {}): RsctConfig {
  return { rsct_version: '1.0.0', app: { name: 'registered-app', org: 'acme' }, ...partial }
}

// An isolated temp HOME keeps candidate-path probing hermetic (FV3).
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-uni-'))
}

describe('lib/universe — resolveUniverseRoot', () => {
  it('finds the universe via config.universe.local (absolute)', () => {
    const r = resolveUniverseRoot(cfg({ universe: { local: UNIVERSE } }), tmp(), { home: tmp() })
    expect(r).toEqual({ kind: 'found', path: UNIVERSE })
  })

  it('reports configured-but-missing when local is set but absent', () => {
    const missing = join(tmp(), 'does-not-exist')
    const r = resolveUniverseRoot(cfg({ universe: { local: missing } }), tmp(), { home: tmp() })
    expect(r).toEqual({ kind: 'configured-missing', path: missing })
  })

  it('finds the universe via a sibling candidate path (../<name>-universe)', () => {
    const parent = tmp()
    const proj = join(parent, 'my-app'); mkdirSync(proj)
    const sib = join(parent, 'acme-universe'); mkdirSync(join(sib, 'applications'), { recursive: true })
    writeFileSync(join(sib, '.universe.json'), '{"name":"acme-universe","registered_apps":[]}')
    const r = resolveUniverseRoot(cfg({ universe: { name: 'acme' } }), proj, { home: tmp() })
    expect(r).toEqual({ kind: 'found', path: sib })
  })

  it('returns none when no universe is configured or discoverable', () => {
    const r = resolveUniverseRoot(cfg(), tmp(), { home: tmp() })
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('lib/universe — readUniverse', () => {
  it('parses .universe.json and lists the applications/ registry (dirs = ground truth)', () => {
    const data = readUniverse(UNIVERSE)
    expect(data).not.toBeNull()
    expect(data!.name).toBe('acme-universe')
    expect(data!.registeredFromJson).toEqual(['registered-app', 'ghost-app'])
    expect(data!.registeredFromDirs).toEqual(['registered-app']) // ghost-app has no dir
  })

  it('returns null (degraded) on a corrupt .universe.json', () => {
    const d = tmp()
    writeFileSync(join(d, '.universe.json'), '{ not valid json')
    expect(readUniverse(d)).toBeNull()
  })

  it('returns null when there is no .universe.json', () => {
    expect(readUniverse(tmp())).toBeNull()
  })
})

describe('lib/universe — getUniverse (single source)', () => {
  it('available + this app registered → no hint', () => {
    const r = getUniverse(cfg({ app: { name: 'registered-app', org: 'acme' }, universe: { local: UNIVERSE } }), tmp())
    expect(r.block.available).toBe(true)
    expect(r.block.name).toBe('acme-universe')
    expect(r.block.registered_apps_count).toBe(1)
    expect(r.block.this_app_registered).toBe(true)
    expect(r.block.note).toBeNull()
    expect(r.hint).toBeNull()
  })

  it('available + this app NOT registered → registration hint', () => {
    const r = getUniverse(cfg({ app: { name: 'other-app', org: 'acme' }, universe: { local: UNIVERSE } }), tmp())
    expect(r.block.available).toBe(true)
    expect(r.block.this_app_registered).toBe(false)
    expect(r.hint).toMatch(/not registered/)
    expect(r.hint).toMatch(/rsct-setup/)
  })

  it('reconciliation note when the app is in the JSON index but has no dir', () => {
    const r = getUniverse(cfg({ app: { name: 'ghost-app', org: 'acme' }, universe: { local: UNIVERSE } }), tmp())
    expect(r.block.this_app_registered).toBe(true) // in JSON
    expect(r.block.note).toMatch(/no applications\/ghost-app\/ dir/)
  })

  it('configured-but-missing → available:false + note + fix hint', () => {
    const missing = join(tmp(), 'gone')
    const r = getUniverse(cfg({ universe: { local: missing } }), tmp())
    expect(r.block.available).toBe(false)
    expect(r.block.local_path).toBe(missing)
    expect(r.block.note).toMatch(/configured but not found/)
    expect(r.hint).toMatch(/fix .rsct.json universe.local|re-run/)
  })

  it('degraded (unreadable .universe.json) → available:false + note', () => {
    const d = tmp()
    writeFileSync(join(d, '.universe.json'), '{ broken')
    const r = getUniverse(cfg({ universe: { local: d } }), tmp())
    expect(r.block.available).toBe(false)
    expect(r.block.note).toMatch(/found but unreadable/)
  })

  it('no universe → NONE block, no hint (behaves like today)', () => {
    const r = getUniverse(cfg(), tmp(), { home: tmp() })
    expect(r.block).toEqual({
      available: false, name: null, local_path: null,
      registered_apps_count: 0, this_app_registered: false, note: null,
    })
    expect(r.hint).toBeNull()
  })

  it('null config → NONE block (non-rsct project)', () => {
    const r = getUniverse(null, tmp())
    expect(r.block.available).toBe(false)
    expect(r.hint).toBeNull()
  })
})

describe('status / load_context — universe block parity (FV4 anti-drift)', () => {
  it('both surface the same universe block for the same project', async () => {
    const s = await statusHandler({ project_root: SAMPLE_RSCT_UNIVERSE })
    const l = await loadContextHandler({ project_root: SAMPLE_RSCT_UNIVERSE })
    expect(s.universe).toEqual(l.universe)
    expect(s.universe.available).toBe(true)
    expect(s.universe.name).toBe('acme-universe')
    expect(s.universe.this_app_registered).toBe(true) // app = registered-app
  })

  it('clean up the phase-state stamp written into the fixture', () => {
    // status/load_context stamp .rsct/phase-state.json into the fixture (gitignored).
    try { rmSync(join(SAMPLE_RSCT_UNIVERSE, '.rsct'), { recursive: true, force: true }) } catch { /* ignore */ }
    expect(true).toBe(true)
  })
})

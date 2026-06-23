import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { getTopologyHandler } from '../../src/tools/get-topology.js'

const UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-universe')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-gettopo-'))
}
function writeCfg(root: string, body: object): string {
  writeFileSync(join(root, '.rsct.json'), JSON.stringify(body))
  return root
}

describe('rsct_get_topology', () => {
  it('non-rsct project → rsct_installed false + hint', async () => {
    const out = await getTopologyHandler({ project_root: tmp() })
    expect(out.rsct_installed).toBe(false)
    expect(out.hints.join(' ')).toMatch(/rsct-setup/)
  })

  it('rsct project, topology unconfirmed → hint to confirm', async () => {
    const r = writeCfg(tmp(), { rsct_version: '1.0.0', app: { name: 'a', org: 'o' } })
    const out = await getTopologyHandler({ project_root: r })
    expect(out.topology.confirmed_mode).toBeNull()
    expect(out.hints.join(' ')).toMatch(/not yet confirmed/)
  })

  it('multi-repo producer → produced contracts + consumer-depend hint', async () => {
    const r = writeCfg(tmp(), {
      rsct_version: '1.0.0',
      app: { name: 'registered-app', org: 'acme' },
      topology: { mode: 'multi-repo' },
      universe: { local: UNIVERSE },
    })
    const out = await getTopologyHandler({ project_root: r })
    expect(out.universe_available).toBe(true)
    expect(out.produced.map((c) => c.id)).toEqual(['orders-api'])
    expect(out.hints.join(' ')).toMatch(/consumer app\(s\) depend/)
  })

  it('consumer view: app consumes other apps surfaces', async () => {
    const r = writeCfg(tmp(), {
      rsct_version: '1.0.0',
      app: { name: 'reporting', org: 'acme' },
      topology: { mode: 'multi-repo' },
      universe: { local: UNIVERSE },
    })
    const out = await getTopologyHandler({ project_root: r })
    expect(out.consumed.map((c) => c.id).sort()).toEqual(['events-stream', 'orders-api'])
  })

  it('RV2: confirmed mono contradicting high-confidence multi-repo → downgrade hint', async () => {
    const parent = tmp()
    const proj = join(parent, 'app-a')
    mkdirSync(proj)
    const uni = join(parent, 'acme-universe')
    mkdirSync(join(uni, 'applications', 'app-a'), { recursive: true })
    mkdirSync(join(uni, 'applications', 'app-b'), { recursive: true })
    writeFileSync(join(uni, '.universe.json'), '{"name":"acme-universe","registered_apps":["app-a","app-b"]}')
    writeFileSync(
      join(proj, '.rsct.json'),
      JSON.stringify({
        rsct_version: '1.0.0',
        app: { name: 'app-a', org: 'acme' },
        topology: { mode: 'mono' },
        universe: { local: uni },
      }),
    )
    const out = await getTopologyHandler({ project_root: proj })
    expect(out.hints.join(' ')).toMatch(/signals strongly suggest 'multi-repo'/)
  })

  it('multi-repo but no contracts.json → inactive-gate (FV1) hint', async () => {
    const parent = tmp()
    const proj = join(parent, 'app')
    mkdirSync(proj)
    const uni = join(parent, 'acme-universe')
    mkdirSync(join(uni, 'applications', 'app'), { recursive: true })
    writeFileSync(join(uni, '.universe.json'), '{"name":"acme-universe","registered_apps":["app"]}')
    writeFileSync(
      join(proj, '.rsct.json'),
      JSON.stringify({
        rsct_version: '1.0.0',
        app: { name: 'app', org: 'acme' },
        topology: { mode: 'multi-repo' },
        universe: { local: uni },
      }),
    )
    const out = await getTopologyHandler({ project_root: proj })
    expect(out.hints.join(' ')).toMatch(/INACTIVE/)
  })
})

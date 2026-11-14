import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTopologyHandler, type GetTopologyOutput } from '../../src/tools/get-topology.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-topo-paths-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const ORDERS = { id: 'orders-api', producer: 'api', surface: ['api/**'], consumers: ['web'] }
const BILLING = { id: 'billing-events', producer: 'api', surface: ['events/billing/**'], consumers: ['ledger'] }

function writeContracts(dir: string, contracts: unknown[]): void {
  writeFileSync(join(dir, 'contracts.json'), JSON.stringify({ contract_version: '1.0.0', contracts }))
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

function universeRepo(contracts: unknown[]): string {
  const dir = join(base, 'u')
  mkdirSync(join(dir, 'applications', 'api'), { recursive: true })
  writeFileSync(join(dir, '.universe.json'), JSON.stringify({ name: 'acme', registered_apps: ['api', 'web', 'ledger'] }))
  writeContracts(dir, contracts)
  git(dir, 'init', '-q', '-b', 'main')
  commitAll(dir, 'universe')
  return dir
}

function project(universeLocal: string | null, topology: Record<string, unknown> | null = { mode: 'multi-repo' }): string {
  const dir = join(base, 'project')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(
    join(dir, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'api', org: 'acme' },
      ...(topology !== null && { topology }),
      ...(universeLocal !== null && { universe: { local: universeLocal } }),
    }),
  )
  commitAll(dir, 'project')
  return dir
}

async function topology(root: string, paths?: string[]): Promise<GetTopologyOutput> {
  return getTopologyHandler({ project_root: root, ...(paths !== undefined && { paths }) })
}

describe('2.25.0 — rsct_get_topology paths: contracts touched, read the way V and the commit gate read them', () => {
  it('relative, ./, absolute and backslash spellings of one file give the same answer', async () => {
    const root = project(universeRepo([ORDERS, BILLING]))
    for (const spelling of ['api/openapi.yaml', './api/openapi.yaml', join(root, 'api', 'openapi.yaml'), 'api\\openapi.yaml']) {
      const out = await topology(root, [spelling])
      expect(out.paths_check?.paths, spelling).toEqual(['api/openapi.yaml'])
      expect(out.paths_check?.contracts_touched.map((c) => c.id), spelling).toEqual(['orders-api'])
      expect(out.paths_check?.consumers, spelling).toEqual(['web'])
    }
  })

  it('still lists a contract the universe working tree deleted but HEAD keeps', async () => {
    const u = universeRepo([ORDERS, BILLING])
    writeContracts(u, [BILLING])
    const out = await topology(project(u), ['api/openapi.yaml'])
    expect(out.contracts.contracts.map((c) => c.id)).toEqual(['billing-events'])
    expect(out.paths_check?.contracts_touched.map((c) => c.id)).toEqual(['orders-api'])
  })

  it('answers for a linked universe even when multi-repo is not confirmed, like V', async () => {
    const out = await topology(project(universeRepo([ORDERS]), null), ['api/x.ts'])
    expect(out.paths_check?.universe_linked).toBe(true)
    expect(out.paths_check?.contracts_touched.map((c) => c.id)).toEqual(['orders-api'])
  })

  it('reports a path outside the project root as such, never as untouched', async () => {
    const root = project(universeRepo([ORDERS]))
    const out = await topology(root, ['../elsewhere/api/x.ts', 'api/x.ts'])
    expect(out.paths_check?.outside_root).toEqual(['../elsewhere/api/x.ts'])
    expect(out.paths_check?.paths).toEqual(['api/x.ts'])
    expect(out.hints.join('\n')).toContain('1 path(s) are outside the project root and are not matched against any surface: ../elsewhere/api/x.ts.')
  })

  it('says contracts do not apply when no universe resolves, and UNKNOWN when contracts.json is unreadable', async () => {
    const lone = await topology(project(null), ['api/x.ts'])
    expect(lone.paths_check?.universe_linked).toBe(false)
    expect(lone.hints.join('\n')).toContain('no universe resolves for this project, so contracts do not apply here (not "none touched")')
    rmSync(join(base, 'project'), { recursive: true, force: true })
    const u = universeRepo([ORDERS])
    writeFileSync(join(u, 'contracts.json'), '{ not json')
    commitAll(u, 'broken')
    const broken = await topology(project(u), ['api/x.ts'])
    expect(broken.paths_check?.contracts_readable).toBe(false)
    expect(broken.hints.join('\n')).toContain('whether these paths touch a contract is UNKNOWN')
  })

  it('writes nothing to the audit log, so the commit dialog keeps its comparison', async () => {
    const root = project(universeRepo([ORDERS]))
    const log = join(root, '.rsct', 'audit.log')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(log, '{"event":"marker"}\n')
    await topology(root, ['api/x.ts'])
    expect(readFileSync(log, 'utf8')).toBe('{"event":"marker"}\n')
  })

  it('reports a folder as a folder to list files in, never as untouched', async () => {
    const root = project(universeRepo([ORDERS]))
    mkdirSync(join(root, 'api'), { recursive: true })
    const out = await topology(root, ['api', 'api/', '.'])
    expect(out.paths_check?.folders).toEqual(['api', '.'])
    expect(out.paths_check?.paths).toEqual([])
    const hint = out.hints.join('\n')
    expect(hint).toContain('2 path(s) are folders, and surfaces are matched against files, so list the files you plan to change in them: api, ..')
    expect(hint).toContain('No file was given to match.')
    expect(hint).not.toContain('No declared contract surface is touched')
  })

  it('a planned file that does not exist yet is matched as a file', async () => {
    const out = await topology(project(universeRepo([ORDERS])), ['api/new-endpoint.ts'])
    expect(out.paths_check?.folders).toEqual([])
    expect(out.paths_check?.contracts_touched.map((c) => c.id)).toEqual(['orders-api'])
  })

  it('does not echo the first-record line, since the query records nothing', async () => {
    const out = await topology(project(universeRepo([ORDERS])), ['api/x.ts'])
    expect(out.paths_check?.notes.join('\n')).not.toContain('first record')
  })

  it('says UNKNOWN when no .rsct.json names an app', async () => {
    const dir = join(base, 'project')
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', universe: { local: universeRepo([ORDERS]) } }))
    commitAll(dir, 'project')
    const out = await topology(dir, ['api/x.ts'])
    expect(out.paths_check?.app_names).toEqual([])
    expect(out.hints.join('\n')).toContain('no .rsct.json names an app.name, so no surface can match')
  })

  it('without paths the answer has no paths_check, as before', async () => {
    const out = await topology(project(universeRepo([ORDERS])))
    expect(out.paths_check).toBeUndefined()
    expect(existsSync(join(base, 'project', '.rsct', 'audit.log'))).toBe(false)
  })
})

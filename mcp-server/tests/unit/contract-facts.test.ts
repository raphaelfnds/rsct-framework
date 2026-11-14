import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendAuditEntry } from '../../src/lib/audit-log.js'
import { gatherContractFacts, universeFactsChanged, type ContractFacts } from '../../src/lib/contract-facts.js'
import { defaultGitExecutor } from '../../src/lib/git.js'
import { phaseVerificationStartHandler } from '../../src/tools/phase-verification-start.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-cfacts-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const ORDERS = { id: 'orders-api', producer: 'api', surface: ['api/**'], consumers: ['web'] }

function writeContracts(dir: string, contracts: unknown[]): void {
  writeFileSync(join(dir, 'contracts.json'), JSON.stringify({ contract_version: '1.0.0', contracts }))
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

function universeRepo(dir: string, contracts: unknown[], withGit = true): string {
  mkdirSync(join(dir, 'applications', 'api'), { recursive: true })
  writeFileSync(join(dir, '.universe.json'), JSON.stringify({ name: 'acme', registered_apps: ['api', 'web'] }))
  writeContracts(dir, contracts)
  if (withGit) {
    git(dir, 'init', '-q', '-b', 'main')
    commitAll(dir, 'universe')
  }
  return dir
}

function rsctJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ rsct_version: '1.0.0', app: { name: 'api', org: 'acme' }, topology: { mode: 'multi-repo' }, ...extra })
}

function project(universeLocal: string | null, extra: Record<string, unknown> = {}): string {
  const dir = join(base, 'project')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.rsct.json'), rsctJson({ ...(universeLocal !== null && { universe: { local: universeLocal } }), ...extra }))
  commitAll(dir, 'project')
  return dir
}

function facts(root: string, home = join(base, 'home'), paths = ['api/openapi.yaml']): ContractFacts {
  const f = gatherContractFacts({ projectRoot: root, config: null, readPaths: () => paths, executor: defaultGitExecutor, home })
  if (f === null) throw new Error('paths unreadable')
  return f
}

function record(root: string, f: ContractFacts): void {
  appendAuditEntry(root, f.baseline)
}

describe('contract facts — each source fires on its own', () => {
  it('fires from the working tree only, for a contract the setup adds without committing', () => {
    const u = universeRepo(join(base, 'u'), [])
    writeContracts(u, [ORDERS])
    expect(facts(project(u)).ids).toEqual(['orders-api'])
  })

  it('fires from HEAD when the working-tree contracts.json was emptied', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    writeContracts(u, [])
    expect(facts(project(u)).ids).toEqual(['orders-api'])
  })

  it('fires from the fetched upstream when HEAD was rewound locally', () => {
    const remote = join(base, 'u-remote.git')
    mkdirSync(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    const u = universeRepo(join(base, 'u'), [])
    writeContracts(u, [ORDERS])
    commitAll(u, 'add orders')
    git(u, 'remote', 'add', 'origin', remote)
    git(u, 'push', '-q', '-u', 'origin', 'main')
    git(u, 'reset', '-q', '--hard', 'HEAD~1')
    expect(facts(project(u)).ids).toEqual(['orders-api'])
  })

  it('does not fire for another app or other paths', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    expect(facts(project(u), join(base, 'home'), ['web/index.ts']).ids).toEqual([])
  })
})

describe('contract facts — the .rsct.json files the gate reads', () => {
  it('reads the strictest of HEAD and the working tree, and says they disagree', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    writeFileSync(join(p, '.rsct.json'), rsctJson({ topology: { mode: 'mono' }, universe: { local: u } }))
    const f = facts(p)
    expect(f.multiRepo).toBe(true)
    expect(f.ids).toEqual(['orders-api'])
    expect(f.lines.join('\n')).toContain('disagree on topology.mode')
  })

  it('a .rsct.json planted in a subfolder passed as the project root does not hide the top one', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    mkdirSync(join(p, 'sub'))
    writeFileSync(join(p, 'sub', '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'other', org: 'acme' } }))
    const f = facts(join(p, 'sub'))
    expect(f.multiRepo).toBe(true)
    expect(f.ids).toEqual(['orders-api'])
  })
})

describe('contract facts — compared with the last approved commit', () => {
  it('reads the recorded universe too when a decoy candidate wins the name lookup', () => {
    const home = join(base, 'home')
    const real = universeRepo(join(home, 'projects', 'acme-universe'), [ORDERS])
    const p = project(null)
    const first = facts(p, home)
    expect(first.ids).toEqual(['orders-api'])
    record(p, first)
    universeRepo(join(base, 'acme-universe'), [], false)
    const after = facts(p, home)
    expect(after.ids).toEqual(['orders-api'])
    expect(after.lines.join('\n')).toContain('now also reads the universe')
    expect(real.length).toBeGreaterThan(0)
  })

  it('reports a universe HEAD that moved backwards', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    commitAll(u, 'second')
    const p = project(u)
    record(p, facts(p))
    git(u, 'reset', '-q', '--hard', 'HEAD~1')
    expect(facts(p).lines.join('\n')).toContain('moved backwards')
  })

  it('reports contracts gone and contracts changed', () => {
    const payments = { id: 'payments-api', producer: 'api', surface: ['pay/**'], consumers: ['web'] }
    const u = universeRepo(join(base, 'u'), [ORDERS, payments])
    const p = project(u)
    record(p, facts(p))
    writeContracts(u, [{ ...ORDERS, surface: ['api/v1/**'] }])
    commitAll(u, 'narrow and drop')
    const lines = facts(p).lines.join('\n')
    expect(lines).toContain('Contracts gone from the universe')
    expect(lines).toContain('payments-api')
    expect(lines).toContain('Contracts changed in the universe')
  })

  it('reports the gate switched off when no .rsct.json says multi-repo any more', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    record(p, facts(p))
    writeFileSync(join(p, '.rsct.json'), rsctJson({ topology: { mode: 'mono' } }))
    commitAll(p, 'mono')
    const f = facts(p)
    expect(f.multiRepo).toBe(false)
    expect(f.lines.join('\n')).toContain('was on (multi-repo)')
    expect(universeFactsChanged(f)).toBe(true)
  })

  it('a first read counts as a change; an unchanged one after a record does not', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    const first = facts(p)
    expect(universeFactsChanged(first)).toBe(true)
    record(p, first)
    expect(universeFactsChanged(facts(p))).toBe(false)
  })

  it('says when the universe is not a git repository', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS], false)
    expect(facts(project(u)).lines.join('\n')).toContain('not a git repository')
  })
})

describe('V reads the same facts as the commit gate', () => {
  it('finds the contract from the universe HEAD when its working tree was emptied', async () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    writeContracts(u, [])
    const p = project(u)
    mkdirSync(join(p, '.rsct'), { recursive: true })
    writeFileSync(join(p, '.rsct', 'phase-state.json'), JSON.stringify({ spec_slug: 'feat-x' }))
    const started = await phaseVerificationStartHandler({ project_root: p, spec_ref: 'feat-x', spec_tier: 'standard', declared_paths: ['api/openapi.yaml'] })
    expect(started.findings.some((f) => f.title.includes("Contract 'orders-api' surface touched"))).toBe(true)
  })
})

describe('contract facts — the universe cannot go quiet (REVIEW round 1)', () => {
  it('an orphan branch with a broken contracts.json is a change, not silence', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    record(p, facts(p))
    git(u, 'checkout', '-q', '--orphan', 'x')
    writeFileSync(join(u, 'contracts.json'), '{ broken')
    const f = facts(p)
    expect(universeFactsChanged(f)).toBe(true)
    expect(f.lines.join('\n')).toMatch(/no longer resolves|another branch|can be read/)
  })

  it('a switch to another branch of the universe is a change', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    record(p, facts(p))
    git(u, 'checkout', '-q', '-b', 'other')
    expect(facts(p).lines.join('\n')).toContain('another branch')
  })

  it('recorded contracts that can no longer be read in a universe without git are a change', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS], false)
    const p = project(u)
    record(p, facts(p))
    writeFileSync(join(u, 'contracts.json'), '{ broken')
    expect(universeFactsChanged(facts(p))).toBe(true)
  })

  it('a malformed recorded baseline counts as no record instead of failing', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    const recorded = facts(p).baseline as { scopes: Record<string, unknown> }
    const broken = Object.fromEntries(Object.keys(recorded.scopes).map((k) => [k, { mode: 'x' }]))
    appendAuditEntry(p, { event: 'universe.baseline', scopes: { ...broken, other: 7 } })
    const f = facts(p)
    expect(f.ids).toEqual(['orders-api'])
    expect(universeFactsChanged(f)).toBe(true)
  })

  it('reads the HEAD .rsct.json of a project opened through a link to its folder', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const p = project(u)
    writeFileSync(join(p, '.rsct.json'), rsctJson({ topology: { mode: 'mono' }, universe: { local: u } }))
    const link = join(base, 'link-to-project')
    symlinkSync(p, link, process.platform === 'win32' ? 'junction' : 'dir')
    const f = facts(link)
    expect(f.multiRepo).toBe(true)
    expect(f.ids).toEqual(['orders-api'])
  })
})

describe('contract facts — a project folder reached through a link (2.24.2)', () => {
  const PAYMENTS = { id: 'payments-api', producer: 'api', surface: ['api/**'], consumers: ['web'] }

  function linkedProject(universeLocal: string): { real: string; linked: string } {
    const real = join(base, 'real', 'project')
    mkdirSync(real, { recursive: true })
    git(real, 'init', '-q', '-b', 'main')
    writeFileSync(join(real, '.rsct.json'), rsctJson({ universe: { local: universeLocal } }))
    commitAll(real, 'project')
    mkdirSync(join(base, 'link'), { recursive: true })
    const linked = join(base, 'link', 'project')
    symlinkSync(real, linked, 'junction')
    return { real, linked }
  }

  it('reads the universe found from the folder as written and from its real folder, and says they differ', () => {
    universeRepo(join(base, 'real', 'u'), [ORDERS])
    universeRepo(join(base, 'link', 'u'), [PAYMENTS])
    const { linked } = linkedProject('../u')
    const f = facts(linked)
    expect([...f.ids].sort()).toEqual(['orders-api', 'payments-api'])
    expect(f.lines.join('\n')).toContain('reached through a link')
  })

  it('says nothing when both folders find the same universe', () => {
    const u = universeRepo(join(base, 'u'), [ORDERS])
    const { linked } = linkedProject(u)
    const f = facts(linked)
    expect(f.ids).toEqual(['orders-api'])
    expect(f.lines.join('\n')).not.toContain('reached through a link')
  })

  it('says nothing when the link is the project folder itself and the .rsct.json sits in a parent', () => {
    const u = universeRepo(join(base, 'real', 'u'), [ORDERS])
    const mono = join(base, 'real', 'mono')
    mkdirSync(join(mono, 'sub'), { recursive: true })
    git(mono, 'init', '-q', '-b', 'main')
    writeFileSync(join(mono, '.rsct.json'), rsctJson({ universe: { local: '../u' } }))
    writeFileSync(join(mono, 'sub', 'a.txt'), 'a\n')
    commitAll(mono, 'mono')
    mkdirSync(join(base, 'link'), { recursive: true })
    symlinkSync(join(mono, 'sub'), join(base, 'link', 'proj'), 'junction')
    const f = facts(join(base, 'link', 'proj'))
    expect(f.ids).toEqual(['orders-api'])
    expect(f.lines.join('\n')).not.toContain('reached through a link')
    expect(u).toBeTruthy()
  })

  it('says nothing for a project read through its real folder', () => {
    universeRepo(join(base, 'real', 'u'), [ORDERS])
    const { real } = linkedProject('../u')
    const f = facts(real)
    expect(f.ids).toEqual(['orders-api'])
    expect(f.lines.join('\n')).not.toContain('reached through a link')
  })
})

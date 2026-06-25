import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectOnboarding, parseGitRemoteOrg } from '../../src/lib/onboarding-detect.js'
import { detectTopology } from '../../src/lib/topology.js'
import {
  detectOnboardingHandler,
  detectOnboardingInputSchema,
} from '../../src/tools/detect-onboarding.js'
import type { RsctConfig } from '../../src/lib/project-root.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-onb-'))
}
function cfg(p: Partial<RsctConfig> = {}): RsctConfig {
  return { rsct_version: '1.0.0', app: { name: 'app-a', org: 'acme' }, ...p }
}
// Make a sibling app dir; with `org` it gets an RSCT .rsct.json, else bare.
function mkApp(parent: string, name: string, org?: string): string {
  const d = join(parent, name)
  mkdirSync(d, { recursive: true })
  if (org) {
    writeFileSync(join(d, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name, org } }))
  }
  return d
}
function mkGitRemote(dir: string, url: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`)
}
function mkUniverse(parent: string, name: string, registered: string[]): string {
  const uni = join(parent, name)
  for (const app of registered) mkdirSync(join(uni, 'applications', app), { recursive: true })
  if (registered.length === 0) mkdirSync(uni, { recursive: true })
  writeFileSync(
    join(uni, '.universe.json'),
    JSON.stringify({ name, registered_apps: registered }),
  )
  return uni
}
// Always probe an EMPTY home so the real ~/projetos/<org>-universe never leaks in.
function opts() {
  return { home: tmp() }
}

describe('onboarding-detect — universe≠app guard (G3)', () => {
  it('is_universe_repo short-circuits → is-universe/guard, no sibling scan', () => {
    const parent = tmp()
    const root = mkUniverse(parent, 'acme-universe', [])
    mkApp(parent, 'acme-api', 'acme') // a real sibling that must NOT be scanned
    const d = detectOnboarding(cfg({ app: { name: 'acme-universe', org: 'acme' } }), root, opts())
    expect(d.is_universe_repo).toBe(true)
    expect(d.situation).toBe('is-universe')
    expect(d.recommended_route).toBe('guard-universe-repo')
    expect(d.siblings).toEqual([])
    expect(d.hints.some((h) => /UNIVERSE .*not an application/i.test(h))).toBe(true)
  })

  it('dual-marker repo (.universe.json + .rsct.json) still routes to guard', () => {
    const parent = tmp()
    const root = mkUniverse(parent, 'acme-universe', [])
    writeFileSync(join(root, '.rsct.json'), JSON.stringify(cfg({ app: { name: 'x', org: 'acme' } })))
    const d = detectOnboarding(cfg({ app: { name: 'x', org: 'acme' } }), root, opts())
    expect(d.is_universe_repo).toBe(true)
    expect(d.recommended_route).toBe('guard-universe-repo')
  })
})

describe('onboarding-detect — siblings → suggest CREATE (G1)', () => {
  it('≥1 rsct_json sibling, no universe → siblings-no-universe/offer-create (sorted, other-org excluded)', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme')
    mkApp(parent, 'acme-jobs', 'acme')
    mkApp(parent, 'globex-thing', 'globex')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.situation).toBe('siblings-no-universe')
    expect(d.recommended_route).toBe('offer-create-universe')
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-jobs', 'acme-web'])
    expect(d.siblings.every((s) => s.matched_by === 'rsct_json')).toBe(true)
  })

  it('org normalization: sibling org "acme-23" matches self "acme"', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme-23')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web'])
    expect(d.situation).toBe('siblings-no-universe')
  })

  it('case-variant org ("Acme" vs "acme") matches after case-fold', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'Acme')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web'])
  })

  it('unrelated siblings only → solo', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'globex-a', 'globex')
    mkApp(parent, 'random-no-rsct')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.situation).toBe('solo')
    expect(d.recommended_route).toBe('none')
    expect(d.siblings).toEqual([])
  })
})

describe('onboarding-detect — git_remote fallback is ADVISORY (R5)', () => {
  it('git_remote-only sibling does NOT, alone, trigger create-offer', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const sib = join(parent, 'acme-mobile')
    mkdirSync(sib, { recursive: true })
    mkGitRemote(sib, 'git@github.com:acme/acme-mobile.git')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.situation).toBe('solo')
    expect(d.siblings.map((s) => s.matched_by)).toEqual(['git_remote'])
    expect(d.hints.some((h) => /advisory/i.test(h))).toBe(true)
  })

  it('git_remote sibling alongside a confirmed rsct_json sibling → offer-create, both listed', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme')
    const sib = join(parent, 'acme-mobile')
    mkdirSync(sib, { recursive: true })
    mkGitRemote(sib, 'https://github.com/acme/acme-mobile.git')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.recommended_route).toBe('offer-create-universe')
    expect(d.siblings.map((s) => s.dir).sort()).toEqual(['acme-mobile', 'acme-web'])
  })

  it('git_remote with a DIFFERENT org is excluded', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme')
    const sib = join(parent, 'foreign')
    mkdirSync(sib, { recursive: true })
    mkGitRemote(sib, 'git@github.com:globex/foreign.git')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web'])
  })

  it('an rsct_json sibling with a DIFFERENT org is NOT rescued by git_remote', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const sib = mkApp(parent, 'mislabeled', 'globex') // rsct says globex
    mkGitRemote(sib, 'git@github.com:acme/mislabeled.git') // git says acme
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings).toEqual([]) // rsct_json org wins → not ours
  })
})

describe('onboarding-detect — fresh install (config=null, org from .git/config)', () => {
  it('detects siblings using self org parsed from ./.git/config', () => {
    const parent = tmp()
    const root = join(parent, 'acme-api')
    mkdirSync(root, { recursive: true })
    mkGitRemote(root, 'https://github.com/acme/acme-api.git')
    mkApp(parent, 'acme-web', 'acme')
    const d = detectOnboarding(null, root, opts())
    expect(d.app.org).toBe('acme')
    expect(d.situation).toBe('siblings-no-universe')
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web'])
  })
})

describe('onboarding-detect — universe states', () => {
  it('universe found but app not linked → has-universe-unlinked/offer-link', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkUniverse(parent, 'acme-universe', ['app-x'])
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.universe.available).toBe(true)
    expect(d.universe.linked).toBe(false)
    expect(d.situation).toBe('has-universe-unlinked')
    expect(d.recommended_route).toBe('offer-link-existing')
  })

  it('linked + registered → has-universe-linked/none', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const uni = mkUniverse(parent, 'acme-universe', ['acme-api'])
    const d = detectOnboarding(
      cfg({ app: { name: 'acme-api', org: 'acme' }, universe: { local: uni } }),
      root,
      opts(),
    )
    expect(d.universe.linked).toBe(true)
    expect(d.universe.this_app_registered).toBe(true)
    expect(d.situation).toBe('has-universe-linked')
    expect(d.recommended_route).toBe('none')
  })

  it('linked but NOT registered → offer-register/none (Phase 4.8 self-guards)', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const uni = mkUniverse(parent, 'acme-universe', ['app-x'])
    const d = detectOnboarding(
      cfg({ app: { name: 'acme-api', org: 'acme' }, universe: { local: uni } }),
      root,
      opts(),
    )
    expect(d.universe.linked).toBe(true)
    expect(d.universe.this_app_registered).toBe(false)
    expect(d.situation).toBe('offer-register')
    expect(d.recommended_route).toBe('none')
    expect(d.hints.some((h) => /not registered/i.test(h))).toBe(true)
  })

  it('configured-missing universe → fix-universe-link, never register', () => {
    const root = tmp()
    const d = detectOnboarding(
      cfg({ universe: { local: join(tmp(), 'does-not-exist') } }),
      root,
      opts(),
    )
    expect(d.universe.configured_missing).toBe(true)
    expect(d.situation).toBe('universe-configured-missing')
    expect(d.recommended_route).toBe('fix-universe-link')
    expect(d.siblings).toEqual([])
  })
})

describe('onboarding-detect — traversal / fail-graceful', () => {
  it('a universe dir (in-scan) and a symlink sibling are skipped', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme')
    // A .universe.json-bearing dir whose name is NOT `<org>-universe`, so
    // getUniverse's name-based probe won't auto-resolve it → the SIBLING SCAN
    // runs and must skip it via isUniverseDir (never list it as an app).
    mkUniverse(parent, 'acme-governance', ['app-x'])
    // a symlink to a same-org app — must be skipped (best-effort; Windows may EPERM)
    const realApp = mkApp(tmp(), 'acme-linked', 'acme')
    let symlinkMade = true
    try {
      symlinkSync(realApp, join(parent, 'acme-symlinked'), 'dir')
    } catch {
      symlinkMade = false
    }
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.situation).toBe('siblings-no-universe')
    expect(d.siblings.map((s) => s.dir)).not.toContain('acme-governance') // universe dir skipped
    expect(d.siblings.map((s) => s.dir)).toContain('acme-web')
    if (symlinkMade) expect(d.siblings.map((s) => s.dir)).not.toContain('acme-symlinked')
  })

  it('malformed sibling .rsct.json does not throw and is skipped', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const bad = join(parent, 'broken')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, '.rsct.json'), 'not json {')
    mkApp(parent, 'acme-web', 'acme')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web']) // broken excluded, no throw
  })

  it('CRLF .git/config and origin-vs-upstream resolve the origin org', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const sib = join(parent, 'acme-web')
    mkdirSync(join(sib, '.git'), { recursive: true })
    // origin = acme, upstream = globex, with CRLF line endings
    const conf =
      '[remote "upstream"]\r\n\turl = git@github.com:globex/acme-web.git\r\n' +
      '[remote "origin"]\r\n\turl = git@github.com:acme/acme-web.git\r\n'
    writeFileSync(join(sib, '.git', 'config'), conf)
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => `${s.dir}:${s.matched_by}`)).toEqual(['acme-web:git_remote'])
  })

  it('case-INSENSITIVE git config keywords (URL=, [REMOTE "origin"]) still resolve', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const sib = join(parent, 'acme-web')
    mkdirSync(join(sib, '.git'), { recursive: true })
    writeFileSync(join(sib, '.git', 'config'), '[REMOTE "origin"]\n  URL = git@github.com:acme/acme-web.git\n')
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme' } }), root, opts())
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web'])
  })
})

describe('onboarding-detect — accepted false-positive + guards', () => {
  it('org-2024 vs org-2025 collapse to the same key (documented accepted FP)', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    mkApp(parent, 'acme-web', 'acme-2025') // self org normalizes to "acme" too
    const d = detectOnboarding(cfg({ app: { name: 'acme-api', org: 'acme-2024' } }), root, opts())
    expect(d.app.org).toBe('acme') // -\d* stripped
    expect(d.siblings.map((s) => s.dir)).toEqual(['acme-web']) // collapse → matched
  })

  it('no derivable org (config=null, no .git remote) → no sibling scan', () => {
    const parent = tmp()
    const root = join(parent, 'orphan')
    mkdirSync(root, { recursive: true })
    mkApp(parent, 'acme-web', 'acme')
    const d = detectOnboarding(null, root, opts())
    expect(d.app.org).toBeNull()
    expect(d.siblings).toEqual([])
    expect(d.situation).toBe('solo')
  })

  it('digits/dash-only org surfaces app.org as null, not empty string', () => {
    const d = detectOnboarding(cfg({ app: { name: 'x', org: '-9' } }), tmp(), opts())
    expect(d.app.org).toBeNull()
    expect(d.siblings).toEqual([])
  })
})

describe('onboarding-detect — parseGitRemoteOrg (documented scope)', () => {
  it('parses the supported shapes; rejects out-of-scope', () => {
    expect(parseGitRemoteOrg('git@github.com:acme/repo.git')).toBe('acme')
    expect(parseGitRemoteOrg('https://github.com/acme/repo.git')).toBe('acme')
    expect(parseGitRemoteOrg('https://user:tok@github.com/acme/repo')).toBe('acme')
    expect(parseGitRemoteOrg('ssh://git@host.com:2222/acme/repo.git')).toBe('acme')
    expect(parseGitRemoteOrg('git://github.com/acme/repo.git')).toBe('acme')
    expect(parseGitRemoteOrg('git@gitlab.com:group/subgroup/repo.git')).toBe('group')
    expect(parseGitRemoteOrg('https://github.com/acme/repo/')).toBe('acme') // trailing slash
    expect(parseGitRemoteOrg('git@github.com:acme/repo')).toBe('acme') // no .git
    // out of scope → null
    expect(parseGitRemoteOrg('file:///home/x/repo')).toBeNull()
    expect(parseGitRemoteOrg('C:\\Users\\x\\repo')).toBeNull()
    expect(parseGitRemoteOrg('git@host:onlyrepo')).toBeNull() // no org/repo split
    expect(parseGitRemoteOrg('')).toBeNull()
  })
})

describe('onboarding-detect — tool handler + schema + shared-primitive parity', () => {
  it('handler returns rsct_installed + a situation', async () => {
    const root = tmp()
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify(cfg({ app: { name: 'lonely', org: 'zzznoorghere' } })),
    )
    const out = await detectOnboardingHandler({ project_root: root })
    expect(out.rsct_installed).toBe(true)
    expect(typeof out.situation).toBe('string')
    expect(out).toHaveProperty('recommended_route')
  })

  it('input schema is strict (rejects unknown keys)', () => {
    expect(() => detectOnboardingInputSchema.parse({ bogus: 1 })).toThrow()
    expect(detectOnboardingInputSchema.parse({})).toEqual({})
  })

  it('detector and topology agree on universe availability (shared getUniverse)', () => {
    const parent = tmp()
    const root = mkApp(parent, 'acme-api')
    const uni = mkUniverse(parent, 'acme-universe', ['acme-api', 'app-b'])
    const c = cfg({ app: { name: 'acme-api', org: 'acme' }, universe: { local: uni } })
    const d = detectOnboarding(c, root, opts())
    const t = detectTopology(c, root, opts())
    expect(d.universe.available).toBe(t.block.signals.universe_available)
    expect(d.universe.available).toBe(true)
  })
})

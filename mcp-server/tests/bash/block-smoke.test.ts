import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import {
  runBlock,
  nodeAvailable,
  assertNodePolicy,
  extractBlockByAnchor,
  readIn,
  hasIn,
  type RunBlockResult,
} from './lib/block-harness.js'

// T0.c — curated smoke for 3 self-contained, high-risk prompt mutation blocks
// (gitignore backfill, .rsct.json secrets merge, .mcp.json scrub). Each block is
// extracted from the real prompt by anchor and run against a fixture in a temp
// dir; assertions are on file state (see spec_t0c §9 V findings).

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const STRICT = !!process.env.RSCT_REQUIRE_BASH // CI strict mode (anti-silent-skip)

const dirs: string[] = []
function run(opts: Parameters<typeof runBlock>[1]): RunBlockResult {
  const r = runBlock(ROOT, opts)
  dirs.push(r.dir)
  return r
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

const countBegin = (s: string) => (s.match(/RSCT-BEGIN/g) ?? []).length

// True iff `needle` appears on its own line strictly between the RSCT-BEGIN and
// RSCT-END markers (proves a backfilled line lands INSIDE the block, not after END).
const inMarkerRange = (s: string, needle: string) => {
  const lines = s.replace(/\r/g, '').split('\n')
  const begin = lines.findIndex((l) => l.includes('RSCT-BEGIN'))
  const end = lines.findIndex((l) => l.includes('RSCT-END'))
  if (begin < 0 || end < 0 || end <= begin) return false
  return lines.slice(begin + 1, end).some((l) => l.trim() === needle)
}

describe('block-harness self-test + node policy', () => {
  it('extractBlockByAnchor returns the single matching block', () => {
    const b = extractBlockByAnchor(ROOT, '01-setup.md', 'CHECKPOINT: Phase 4.4b executing')
    expect(b.source).toBe('01-setup.md')
    expect(b.code).toContain('RSCT-BEGIN')
  })
  it('throws when the anchor matches no block', () => {
    expect(() => extractBlockByAnchor(ROOT, '01-setup.md', 'NO_SUCH_ANCHOR_xyz')).toThrow(/matched 0/)
  })
  it('node policy throws when required but absent; honours live policy', () => {
    expect(() => assertNodePolicy(true, false)).toThrow(/node is required/)
    expect(() => assertNodePolicy(STRICT, NODE)).not.toThrow() // CI has node
  })
})

// --- Block 1: gitignore backfill (01-setup 4.4b) — pure bash ------------------
const GI_ANCHOR = 'CHECKPOINT: Phase 4.4b executing'

describe.skipIf(!BASH)('block: gitignore backfill (01-setup 4.4b)', () => {
  it('fresh — creates the marker-wrapped block with all patterns', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR })
    const gi = readIn(r, '.gitignore')
    for (const pat of ['RSCT-BEGIN', 'plan_*.md', 'progress_*.md', 'spec_*.md',
      '.rsct/audit.log', '.rsct/approvals-seen.json', '.rsct/phase-state.json',
      '.rsct/phase-state.lock', '/rsct-framework/', '# RSCT-END']) {
      expect(gi, `missing ${pat}`).toContain(pat)
    }
  }, 60_000)

  it('idempotent — re-run does not duplicate the block', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, runs: 2 })
    expect(countBegin(readIn(r, '.gitignore'))).toBe(1)
  }, 60_000)

  it('backfill — adds spec_*.md (CAP-16) and phase-state lines (CAP-25) to an old block', () => {
    const old = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '# RSCT-END',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect(gi).toContain('spec_*.md')
    expect(gi).toContain('.rsct/phase-state.json')
    expect(gi).toContain('.rsct/phase-state.lock')
    expect(countBegin(gi)).toBe(1) // no duplicate block
  }, 60_000)

  it('backfill — adds /rsct-framework/ to a pre-1.1.x block, inside the marker range', () => {
    // Old block that already has phase-state.lock (the anchor) but lacks the
    // framework-clone line; the new clause must backfill it INSIDE the markers.
    const old = [
      'node_modules/',
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      'spec_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '.rsct/phase-state.lock',
      '# RSCT-END',
      '*.log',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect(gi).toContain('/rsct-framework/')
    expect(inMarkerRange(gi, '/rsct-framework/'), 'must land INSIDE the marker range').toBe(true)
    expect(countBegin(gi)).toBe(1) // no duplicate block
    expect(gi).toContain('node_modules/') // user content preserved
    expect(gi).toContain('*.log')
  }, 60_000)

  it('backfill — chains lock + /rsct-framework/ on a block missing both', () => {
    // Block predates BOTH the CAP-25 lock line and the framework-clone line.
    // The CAP-25 clause inserts the lock anchor first; the framework clause then
    // anchors on it. Validates the sequential-clause ordering (V FV1 / CASE 2).
    const old = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '# RSCT-END',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect(gi).toContain('.rsct/phase-state.lock')
    expect(inMarkerRange(gi, '/rsct-framework/')).toBe(true)
    expect(countBegin(gi)).toBe(1)
  }, 60_000)

  it('idempotent — /rsct-framework/ appears exactly once after a re-run', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, runs: 2 })
    const gi = readIn(r, '.gitignore')
    expect((gi.match(/\/rsct-framework\//g) ?? []).length).toBe(1)
  }, 60_000)

  it('CRLF — backfill lands on a CRLF .gitignore (tr -d \\r path)', () => {
    const oldCrlf = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '# RSCT-END',
      '',
    ].join('\r\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': oldCrlf } })
    expect(readIn(r, '.gitignore')).toContain('spec_*.md')
  }, 60_000)

  it('legacy — warns and does NOT add a marker block over a pre-marker list', () => {
    const legacy = ['node_modules/', 'plan_*.md', 'progress_*.md', ''].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': legacy } })
    expect(r.out).toMatch(/pre-marker plan-tracking block/)
    expect(countBegin(readIn(r, '.gitignore'))).toBe(0) // no marker block injected
  }, 60_000)
})

// --- Block 2: .rsct.json secrets_extra_patterns merge (01-setup 4.4) ----------
const SEC_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical text-based secrets'
// Hand-formatted seed: the single-line "app" object proves no whole-file reformat.
const RSCT_JSON = `{
  "rsct_version": "1.0.0",
  "app": { "name": "demo", "org": "acme" },
  "secrets_extra_patterns": [],
  "protected_branches": ["main"]
}
`
const patternsOf = (r: RunBlockResult): string[] =>
  JSON.parse(readIn(r, '.rsct.json')).secrets_extra_patterns

describe.skipIf(!BASH || !NODE)('block: .rsct.json secrets_extra_patterns merge (01-setup 4.4)', () => {
  it('append — adds canonical = patterns for the SENSITIVE_VARS', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SEC_ANCHOR,
      preamble: 'SENSITIVE_VARS="API_KEY DB_PASSWORD"',
      seedFiles: { '.rsct.json': RSCT_JSON },
    })
    const pats = patternsOf(r)
    expect(pats).toContain('API_KEY\\s*=\\s*\\S+')
    expect(pats).toContain('DB_PASSWORD\\s*=\\s*\\S+')
  }, 60_000)

  it('no whole-file reformat — formatting outside the array is byte-preserved (AP5/CAP-15)', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SEC_ANCHOR,
      preamble: 'SENSITIVE_VARS="API_KEY"',
      seedFiles: { '.rsct.json': RSCT_JSON },
    })
    const raw = readIn(r, '.rsct.json')
    expect(raw).toContain('"app": { "name": "demo", "org": "acme" }')
    expect(raw).toContain('"protected_branches": ["main"]')
  }, 60_000)

  it('idempotent — re-run does not duplicate ("already converged")', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SEC_ANCHOR,
      preamble: 'SENSITIVE_VARS="API_KEY"',
      seedFiles: { '.rsct.json': RSCT_JSON }, runs: 2,
    })
    expect(patternsOf(r).filter((p) => p === 'API_KEY\\s*=\\s*\\S+')).toHaveLength(1)
    expect(r.out).toMatch(/already converged/)
  }, 60_000)

  it('legacy migration (CAP-51) — \\bWORD\\b is rewritten to the = shape', () => {
    const legacy = JSON.stringify({ secrets_extra_patterns: ['\\bAPI_KEY\\b'] }, null, 2) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: SEC_ANCHOR,
      preamble: 'SENSITIVE_VARS="API_KEY"',
      seedFiles: { '.rsct.json': legacy },
    })
    const pats = patternsOf(r)
    expect(pats).toContain('API_KEY\\s*=\\s*\\S+')
    expect(pats).not.toContain('\\bAPI_KEY\\b')
  }, 60_000)

  it('dev regex preserved — a custom pattern survives verbatim', () => {
    const withCustom = JSON.stringify({ secrets_extra_patterns: ['^custom.*$'] }, null, 2) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: SEC_ANCHOR,
      preamble: 'SENSITIVE_VARS="API_KEY"',
      seedFiles: { '.rsct.json': withCustom },
    })
    expect(patternsOf(r)).toContain('^custom.*$')
  }, 60_000)
})

// --- Block 3: .mcp.json rsct scrub (03-uninstall 4.V.a2) ----------------------
const MCP_ANCHOR = 'CHECKPOINT: Phase 4.V.a2'
const mcpServersOf = (r: RunBlockResult): Record<string, unknown> =>
  JSON.parse(readIn(r, '.mcp.json')).mcpServers ?? {}

describe.skipIf(!BASH || !NODE)('block: .mcp.json rsct scrub (03-uninstall 4.V.a2)', () => {
  it('scrub preserves other servers, removes rsct, keeps the file', () => {
    const seed = JSON.stringify({ mcpServers: { rsct: { command: 'rsct-mcp' }, other: { command: 'foo' } } }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: MCP_ANCHOR, seedFiles: { '.mcp.json': seed } })
    expect(hasIn(r, '.mcp.json')).toBe(true)
    const servers = mcpServersOf(r)
    expect(servers.rsct).toBeUndefined()
    expect(servers.other).toBeDefined()
  }, 60_000)

  it('delete-if-only-rsct — removes the file when rsct was the sole entry', () => {
    const seed = JSON.stringify({ mcpServers: { rsct: { command: 'rsct-mcp' } } }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: MCP_ANCHOR, seedFiles: { '.mcp.json': seed } })
    expect(hasIn(r, '.mcp.json')).toBe(false)
  }, 60_000)

  it('no-op when there is no rsct entry', () => {
    const seed = JSON.stringify({ mcpServers: { other: { command: 'foo' } } }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: MCP_ANCHOR, seedFiles: { '.mcp.json': seed } })
    expect(hasIn(r, '.mcp.json')).toBe(true)
    expect(mcpServersOf(r).other).toBeDefined()
    expect(r.out).toMatch(/nothing to scrub/)
  }, 60_000)

  it('idempotent — a second scrub is a clean no-op', () => {
    const seed = JSON.stringify({ mcpServers: { rsct: { command: 'rsct-mcp' }, other: { command: 'foo' } } }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: MCP_ANCHOR, seedFiles: { '.mcp.json': seed }, runs: 2 })
    expect(hasIn(r, '.mcp.json')).toBe(true)
    expect(mcpServersOf(r).rsct).toBeUndefined()
    expect(mcpServersOf(r).other).toBeDefined()
  }, 60_000)
})

// --- Block 4 (T1.b): universe app registration (01-setup 4.8) ------------------
const REG_ANCHOR = 'CHECKPOINT: Phase 4.8'
const APP_TEMPLATE = readFileSync(
  resolve(ROOT, 'universe-templates', 'applications', '_app.md.template'), 'utf8',
)
// Project .rsct.json: universe.local is a relative SUBDIR (resolves to native path
// cross-OS). HOME defaults to the temp dir (hermetic), so seed the app template under
// .rsct/universe-templates/ — exactly where the block reads it ($HOME/.rsct/...).
const PROJECT_RSCT = JSON.stringify(
  { rsct_version: '1.0.0', app: { name: 'demo-app', org: 'acme' }, universe: { name: 'acme-universe', local: 'acme-universe' } },
  null, 2,
) + '\n'
const UNIVERSE_JSON = JSON.stringify(
  { universe_version: '1.0.0', org: 'acme', name: 'acme-universe', registered_apps: [] }, null, 2,
) + '\n'
const baseSeed = (): Record<string, string> => ({
  '.rsct.json': PROJECT_RSCT,
  'acme-universe/.universe.json': UNIVERSE_JSON,
  '.rsct/universe-templates/applications/_app.md.template': APP_TEMPLATE,
})
const appsOf = (r: RunBlockResult): string[] =>
  JSON.parse(readIn(r, 'acme-universe/.universe.json')).registered_apps

describe.skipIf(!BASH || !NODE)('block: universe app registration (01-setup 4.8 / T1.b)', () => {
  it('registers: renders the app README and indexes it in registered_apps[]', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: REG_ANCHOR, seedFiles: baseSeed() })
    const readme = readIn(r, 'acme-universe/applications/demo-app/README.md')
    expect(readme).toContain('# demo-app') // [APP_NAME] substituted
    expect(readme).toContain('acme') // [ORG_SLUG] substituted (Repository line)
    expect(appsOf(r)).toContain('demo-app')
  }, 60_000)

  it('idempotent: re-run does not duplicate the registry entry', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: REG_ANCHOR, seedFiles: baseSeed(), runs: 2 })
    expect(appsOf(r).filter((a) => a === 'demo-app')).toHaveLength(1)
  }, 60_000)

  it('collision: never overwrites an existing app README, only reconciles the index', () => {
    const seed = { ...baseSeed(), 'acme-universe/applications/demo-app/README.md': '# CUSTOM dev content\n' }
    const r = run({ promptBasename: '01-setup.md', anchor: REG_ANCHOR, seedFiles: seed })
    expect(readIn(r, 'acme-universe/applications/demo-app/README.md')).toBe('# CUSTOM dev content\n')
    expect(r.out).toMatch(/already exists/)
    expect(appsOf(r)).toContain('demo-app') // index reconciled
  }, 60_000)

  it('no universe configured → safe no-op', () => {
    const noUni = JSON.stringify({ rsct_version: '1.0.0', app: { name: 'demo-app', org: 'acme' } }, null, 2) + '\n'
    const r = run({ promptBasename: '01-setup.md', anchor: REG_ANCHOR, seedFiles: { '.rsct.json': noUni } })
    expect(r.out).toMatch(/skipping registration/)
    expect(hasIn(r, 'acme-universe')).toBe(false)
  }, 60_000)

  it('text-splice: other .universe.json fields are byte-preserved (no whole-file reformat)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: REG_ANCHOR, seedFiles: baseSeed() })
    const raw = readIn(r, 'acme-universe/.universe.json')
    expect(raw).toContain('"org": "acme"')
    expect(raw).toContain('"universe_version": "1.0.0"')
  }, 60_000)

  it('never runs git against the universe (hands-off — §3.5)', () => {
    // Structural guarantee: the block issues NO git command of any kind.
    const block = extractBlockByAnchor(ROOT, '01-setup.md', REG_ANCHOR)
    expect(block.code).not.toMatch(/\bgit\s/)
  })
})

// --- Block 4: display-version stamp (01-setup 4.4) — reads $HOME/.rsct/VERSION ----
// HOME is hermetic (= temp dir), so seeding '.rsct/VERSION' provides the release
// version source; '.rsct.json' / 'CLAUDE.md' are seeded into the same dir ($(pwd)).
const VER_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical display-version stamp'
// Hand-formatted .rsct.json (single-line app object) → proves no whole-file reformat.
const VER_RSCT_JSON = [
  '{',
  '  "rsct_version": "1.0.0",',
  '  "app": { "name": "demo", "org": "bluelt-23" },',
  '  "protected_branches": ["main", "test"],',
  '  "install": {',
  '    "applied_at": "2026-06-12T16:17:25Z",',
  '    "mode": "CREATE",',
  '    "setup_commit_sha_before": "c36f66ee",',
  '    "canonical_source_added": true',
  '  }',
  '}',
  '',
].join('\n')
const VER_CLAUDE_MD = [
  '<!-- RSCT_VERSION: 1.0.0 -->',
  '<!-- Generated by RSCT Framework v1.0.0 -->',
  '<!-- RSCT_APP: demo | updated: 2026-06-12 -->',
  '<!-- RSCT_UNIVERSE: bluelt-universe | updated: 2026-06-12 -->',
  '',
  '# CLAUDE.md — demo',
  '',
  '<!-- RSCT-§A-BEGIN v=1.0.0 source=inserted -->',
  'rule A',
  '<!-- RSCT-§A-END -->',
  '',
].join('\n')
const verSeed = (release = '1.1.0'): Record<string, string> => ({
  '.rsct/VERSION': `${release}\n`,
  '.rsct.json': VER_RSCT_JSON,
  'CLAUDE.md': VER_CLAUDE_MD,
})

describe.skipIf(!BASH)('block: display-version stamp (01-setup 4.4)', () => {
  it('stamps all 3 display fields to the release version', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: verSeed('1.1.0') })
    expect(readIn(r, '.rsct.json')).toContain('"rsct_version": "1.1.0"')
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).toContain('<!-- RSCT_VERSION: 1.1.0 -->')
    expect(cm).toContain('<!-- Generated by RSCT Framework v1.1.0 -->')
  }, 60_000)

  it('does NOT touch RSCT_APP / RSCT_UNIVERSE or the v= marker schema id', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: verSeed('1.1.0') })
    const cm = readIn(r, 'CLAUDE.md')
    expect(cm).toContain('<!-- RSCT_APP: demo | updated: 2026-06-12 -->')
    expect(cm).toContain('<!-- RSCT_UNIVERSE: bluelt-universe | updated: 2026-06-12 -->')
    expect(cm).toContain('v=1.0.0') // marker schema id stays
    expect(cm).not.toContain('v=1.1.0') // no marker drift
  }, 60_000)

  it('preserves the other .rsct.json fields (no whole-file reformat)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: verSeed('1.1.0') })
    const raw = readIn(r, '.rsct.json')
    expect(raw).toContain('"app": { "name": "demo", "org": "bluelt-23" }')
    expect(raw).toContain('"applied_at": "2026-06-12T16:17:25Z"')
    expect(raw).toContain('"setup_commit_sha_before": "c36f66ee"')
  }, 60_000)

  it('idempotent — re-run yields a single stamped value', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: verSeed('1.1.0'), runs: 2 })
    const json = readIn(r, '.rsct.json')
    expect((json.match(/"rsct_version": "1\.1\.0"/g) ?? []).length).toBe(1)
    const cm = readIn(r, 'CLAUDE.md')
    expect((cm.match(/<!-- RSCT_VERSION: 1\.1\.0 -->/g) ?? []).length).toBe(1)
    expect((cm.match(/Generated by RSCT Framework v1\.1\.0/g) ?? []).length).toBe(1)
  }, 60_000)

  it('CRLF .rsct.json — stamp still lands', () => {
    const crlf = VER_RSCT_JSON.replace(/\n/g, '\r\n')
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: { ...verSeed('1.1.0'), '.rsct.json': crlf } })
    expect(readIn(r, '.rsct.json')).toContain('"rsct_version": "1.1.0"')
  }, 60_000)

  it('fallback — no $HOME/.rsct/VERSION → fields unchanged (non-destructive)', () => {
    const seed = verSeed('1.1.0')
    delete seed['.rsct/VERSION']
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: seed })
    expect(readIn(r, '.rsct.json')).toContain('"rsct_version": "1.0.0"')
    expect(readIn(r, 'CLAUDE.md')).toContain('<!-- RSCT_VERSION: 1.0.0 -->')
    expect(r.out).toMatch(/leaving version fields as-is/)
  }, 60_000)

  it('semver guard — non-numeric VERSION is rejected (skip, non-destructive)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: VER_ANCHOR, seedFiles: { ...verSeed(), '.rsct/VERSION': 'garbage-v2\n' } })
    expect(readIn(r, '.rsct.json')).toContain('"rsct_version": "1.0.0"')
  }, 60_000)
})

// --- Block 5: universe local-path probe w/ org→name inference (01-setup 1.9, T1.d) --
// HOME is hermetic (= temp dir); the block probes $HOME/projetos/<name>-universe etc.
// ORG_SLUG is injected via preamble (the shipped block uses `: "${ORG_SLUG:=…}"`).
const UNI_ANCHOR = 'Phase 1.9 executing canonical universe local-path probe'
const UNI_JSON = '{"name":"x","registered_apps":[]}\n'

describe.skipIf(!BASH)('block: universe discovery probe (01-setup 1.9 — T1.d)', () => {
  it('infers the universe name from an org slug suffix (bluelt-23 → bluelt-universe)', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: UNI_ANCHOR,
      preamble: 'ORG_SLUG=bluelt-23',
      seedFiles: { 'projetos/bluelt-universe/.universe.json': UNI_JSON },
    })
    expect(r.out).toMatch(/FOUND: .*\/projetos\/bluelt-universe$/m)
  }, 60_000)

  it('false-positive guard — a same-named dir WITHOUT .universe.json is not FOUND', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: UNI_ANCHOR,
      preamble: 'ORG_SLUG=bluelt-23',
      seedFiles: { 'projetos/bluelt-universe/README.md': '# not a universe\n' },
    })
    expect(r.out).not.toMatch(/FOUND:/)
  }, 60_000)

  it('fallback — universe literally named <org>-universe still found (foo-9-universe)', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: UNI_ANCHOR,
      preamble: 'ORG_SLUG=foo-9',
      seedFiles: { 'projetos/foo-9-universe/.universe.json': UNI_JSON },
    })
    expect(r.out).toMatch(/FOUND: .*\/projetos\/foo-9-universe$/m)
  }, 60_000)

  it('no-suffix org still works (acme → acme-universe)', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: UNI_ANCHOR,
      preamble: 'ORG_SLUG=acme',
      seedFiles: { 'projetos/acme-universe/.universe.json': UNI_JSON },
    })
    expect(r.out).toMatch(/FOUND: .*\/projetos\/acme-universe$/m)
  }, 60_000)

  it('no universe present → nothing FOUND', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: UNI_ANCHOR, preamble: 'ORG_SLUG=bluelt-23' })
    expect(r.out).not.toMatch(/FOUND:/)
  }, 60_000)
})

// --- Block 6: update-check consent ask-once (01-setup 4.9 — T4) — uses node --------
// Writes $HOME/.rsct/update-check.json; HOME is hermetic (= temp dir). CONSENT is
// injected via preamble (the shipped block reads it from the dev's answer).
const CONSENT_ANCHOR = 'Phase 4.9 executing canonical update-check consent'
const CC_FILE = '.rsct/update-check.json'

describe.skipIf(!BASH || !NODE)('block: update-check consent (01-setup 4.9 — T4)', () => {
  it('records consent "yes" on first run (opt-in)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR, preamble: 'CONSENT=yes' })
    expect(readIn(r, CC_FILE)).toContain('"consent": "yes"')
  }, 60_000)

  it('defaults to "no" when CONSENT is unset (privacy-first)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR })
    expect(readIn(r, CC_FILE)).toContain('"consent": "no"')
  }, 60_000)

  it('ask-once — does NOT change an already-recorded consent', () => {
    const seeded = JSON.stringify({ consent: 'yes', latest_tag: 'v9.9.9' }, null, 2) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR,
      preamble: 'CONSENT=no', // would flip to "no" if the ask-once guard failed
      seedFiles: { [CC_FILE]: seeded },
    })
    expect(readIn(r, CC_FILE)).toContain('"consent": "yes"') // unchanged
    expect(r.out).toMatch(/already recorded/)
  }, 60_000)

  it('merge — preserves other cache fields when recording consent', () => {
    // File exists but has NO consent field yet → ask runs, node merge keeps latest_tag.
    const seeded = JSON.stringify({ latest_tag: 'v9.9.9' }, null, 2) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR,
      preamble: 'CONSENT=yes', seedFiles: { [CC_FILE]: seeded },
    })
    const cc = readIn(r, CC_FILE)
    expect(cc).toContain('"consent": "yes"')
    expect(cc).toContain('"latest_tag": "v9.9.9"') // preserved
  }, 60_000)
})

// --- Block 7: topology persistence (01-setup 4.10 — T2) ----------------------
const TOPO_ANCHOR = 'Phase 4.10 executing canonical topology persistence'
const TOPO_RSCT_JSON =
  JSON.stringify(
    { rsct_version: '1.0.0', app: { name: 'billing', org: 'acme' }, install: { mode: 'CREATE' } },
    null,
    2,
  ) + '\n'

describe.skipIf(!BASH)('block: topology persistence (01-setup 4.10 — T2)', () => {
  it('inserts topology.mode into a .rsct.json without one (sibling install.mode untouched)', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': TOPO_RSCT_JSON },
      env: { TOPOLOGY_MODE: 'multi-repo' },
    })
    const o = JSON.parse(readIn(r, '.rsct.json'))
    expect(o.topology.mode).toBe('multi-repo')
    expect(o.install.mode).toBe('CREATE') // sibling "mode" key NOT clobbered
    expect(o.rsct_version).toBe('1.0.0')
  }, 60_000)

  it('updates an existing topology.mode in place (one key)', () => {
    const withTopo =
      JSON.stringify({ rsct_version: '1.0.0', topology: { mode: 'mono' }, app: { name: 'b', org: 'a' } }, null, 2) +
      '\n'
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': withTopo },
      env: { TOPOLOGY_MODE: 'multi-repo' },
    })
    const json = readIn(r, '.rsct.json')
    expect(JSON.parse(json).topology.mode).toBe('multi-repo')
    expect((json.match(/"topology"/g) ?? []).length).toBe(1)
  }, 60_000)

  it('idempotent — re-run yields exactly one topology key', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': TOPO_RSCT_JSON },
      env: { TOPOLOGY_MODE: 'monorepo' },
      runs: 2,
    })
    const json = readIn(r, '.rsct.json')
    expect((json.match(/"topology"/g) ?? []).length).toBe(1)
    expect(JSON.parse(json).topology.mode).toBe('monorepo')
  }, 60_000)

  it('CRLF .rsct.json — persists, install.mode untouched', () => {
    const crlf = TOPO_RSCT_JSON.replace(/\n/g, '\r\n')
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': crlf },
      env: { TOPOLOGY_MODE: 'multi-repo' },
    })
    const o = JSON.parse(readIn(r, '.rsct.json'))
    expect(o.topology.mode).toBe('multi-repo')
    expect(o.install.mode).toBe('CREATE')
  }, 60_000)

  it('invalid TOPOLOGY_MODE → not written (gate stays off)', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': TOPO_RSCT_JSON },
      env: { TOPOLOGY_MODE: 'bogus' },
    })
    expect(readIn(r, '.rsct.json')).not.toContain('"topology"')
    expect(r.out).toMatch(/No valid topology/)
  }, 60_000)

  it('no TOPOLOGY_MODE → no-op', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: TOPO_ANCHOR,
      seedFiles: { '.rsct.json': TOPO_RSCT_JSON },
    })
    expect(readIn(r, '.rsct.json')).not.toContain('"topology"')
  }, 60_000)
})

// --- Block: create-universe decline ask-once (01-setup Phase 3 — DX-1b) ---------
const DECLINE_ANCHOR = 'CHECKPOINT: Phase 3 recording create-universe decline'
const RSCT_WITH_INSTALL =
  JSON.stringify(
    {
      rsct_version: '1.0.0',
      app: { name: 'sample', org: 'acme' },
      install: { applied_at: '2026-01-01T00:00:00Z', mode: 'CREATE', canonical_source_added: false },
    },
    null,
    2,
  ) + '\n'

describe.skipIf(!BASH || !NODE)('block: create-universe decline ask-once (01-setup Phase 3)', () => {
  it('injects install.create_universe_declined_at; file stays valid JSON; siblings preserved', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: DECLINE_ANCHOR, seedFiles: { '.rsct.json': RSCT_WITH_INSTALL } })
    const o = JSON.parse(readIn(r, '.rsct.json'))
    expect(typeof o.install.create_universe_declined_at).toBe('string')
    expect(o.install.create_universe_declined_at.length).toBeGreaterThan(0)
    expect(o.install.applied_at).toBe('2026-01-01T00:00:00Z')
    expect(o.app.name).toBe('sample')
  }, 60_000)

  it('idempotent — re-run does not add a second flag', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: DECLINE_ANCHOR, seedFiles: { '.rsct.json': RSCT_WITH_INSTALL }, runs: 2 })
    const txt = readIn(r, '.rsct.json')
    expect((txt.match(/create_universe_declined_at/g) ?? []).length).toBe(1)
    expect(() => JSON.parse(txt)).not.toThrow()
  }, 60_000)

  it('empty install {} → no trailing comma, valid JSON', () => {
    const empty = JSON.stringify({ rsct_version: '1.0.0', app: { name: 's', org: 'o' }, install: {} }) + '\n'
    const r = run({ promptBasename: '01-setup.md', anchor: DECLINE_ANCHOR, seedFiles: { '.rsct.json': empty } })
    const o = JSON.parse(readIn(r, '.rsct.json'))
    expect(typeof o.install.create_universe_declined_at).toBe('string')
  }, 60_000)

  it('CRLF .rsct.json → flag added, still valid JSON', () => {
    const crlf = RSCT_WITH_INSTALL.replace(/\n/g, '\r\n')
    const r = run({ promptBasename: '01-setup.md', anchor: DECLINE_ANCHOR, seedFiles: { '.rsct.json': crlf } })
    expect(() => JSON.parse(readIn(r, '.rsct.json'))).not.toThrow()
    expect(readIn(r, '.rsct.json')).toContain('create_universe_declined_at')
  }, 60_000)
})

// --- Block: contract additive-splice (01-setup Phase 4.11 — DX-1b) --------------
const CONTRACT_ANCHOR = 'CHECKPOINT: Phase 4.11 executing contract additive-splice'
const CONTRACTS_EMPTY =
  JSON.stringify(
    {
      contract_version: '1.0.0',
      _help: 'declare cross-repo contracts here BY HAND',
      _example: { id: 'billing-api', producer: 'billing', surface: ['openapi/billing.yaml'], consumers: ['web'] },
      contracts: [],
    },
    null,
    2,
  ) + '\n'
const CONTRACTS_ONE =
  JSON.stringify(
    {
      contract_version: '1.0.0',
      contracts: [{ id: 'orders-api', producer: 'orders', surface: ['openapi/orders.yaml'], consumers: ['web'] }],
    },
    null,
    2,
  ) + '\n'
const contractEnv = { CONTRACT_SCRATCH: 'scratch', CONTRACTS_JSON: 'contracts.json' }

describe.skipIf(!BASH || !NODE)('block: contract additive-splice (01-setup Phase 4.11)', () => {
  it('empty array → first entry added; valid JSON; decorative keys preserved', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': CONTRACTS_EMPTY,
        'scratch/id': 'payments-api',
        'scratch/producer': 'payments',
        'scratch/surface/1': 'openapi/payments.yaml',
        'scratch/surface/2': 'src/api/**',
        'scratch/consumers/1': 'web',
        'scratch/consumers/2': 'reporting',
        'scratch/description': 'Payments REST API',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.map((c: { id: string }) => c.id)).toEqual(['payments-api'])
    expect(o.contracts[0].surface).toEqual(['openapi/payments.yaml', 'src/api/**'])
    expect(o.contracts[0].consumers).toEqual(['web', 'reporting'])
    expect(o.contracts[0].description).toBe('Payments REST API')
    expect(o._example.id).toBe('billing-api') // decorative keys preserved
  }, 60_000)

  it('populated array → entry appended; both present; valid JSON', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': CONTRACTS_ONE,
        'scratch/id': 'events-stream',
        'scratch/producer': 'events',
        'scratch/surface/1': 'proto/**',
        'scratch/consumers/1': 'analytics',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['events-stream', 'orders-api'])
  }, 60_000)

  it('idempotent — existing id left untouched (no duplicate, original preserved)', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': CONTRACTS_ONE,
        'scratch/id': 'orders-api',
        'scratch/producer': 'orders',
        'scratch/surface/1': 'openapi/orders-v2.yaml',
        'scratch/consumers/1': 'mobile',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.length).toBe(1)
    expect(o.contracts[0].surface).toEqual(['openapi/orders.yaml']) // untouched
    expect(r.out).toMatch(/already has id=orders-api/)
  }, 60_000)

  it('adversarial free-text (quotes / backslash / $ / newline) → valid JSON, round-trips', () => {
    const hostile = 'has "quotes", \\ backslash, $VAR, `backtick`, \'apostrophe\', and\na newline'
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': CONTRACTS_EMPTY,
        'scratch/id': 'weird-api',
        'scratch/producer': 'weird',
        'scratch/surface/1': 'src/**',
        'scratch/consumers/1': 'web',
        'scratch/description': hostile,
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts[0].description).toBe(hostile)
  }, 60_000)

  it('CRLF contracts.json → entry added, valid JSON', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': CONTRACTS_EMPTY.replace(/\n/g, '\r\n'),
        'scratch/id': 'x-api',
        'scratch/producer': 'x',
        'scratch/surface/1': 'a/**',
        'scratch/consumers/1': 'y',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts[0].id).toBe('x-api')
  }, 60_000)

  it('idempotency is structural — tab-around-colon id is matched (no dup)', () => {
    const tabbed =
      '{\n  "contract_version": "1.0.0",\n  "contracts": [{ "id"\t:\t"orders-api", "producer": "orders", "surface": ["a/**"], "consumers": ["web"] }]\n}\n'
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': tabbed,
        'scratch/id': 'orders-api',
        'scratch/producer': 'orders',
        'scratch/surface/1': 'b/**',
        'scratch/consumers/1': 'mobile',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.length).toBe(1) // matched despite tab-around-colon → no dup
  }, 60_000)

  it('id check is field-scoped — a new id equal to an existing entry producer is still added', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json':
          JSON.stringify({ contract_version: '1.0.0', contracts: [{ id: 'web-api', producer: 'web', surface: ['a/**'], consumers: ['x'] }] }, null, 2) + '\n',
        'scratch/id': 'web',
        'scratch/producer': 'web',
        'scratch/surface/1': 'b/**',
        'scratch/consumers/1': 'y',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['web', 'web-api']) // producer value never false-matched as id
  }, 60_000)

  it('id check is value-scoped — a new id matching text inside a description is still added', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json':
          JSON.stringify({ contract_version: '1.0.0', contracts: [{ id: 'a-api', producer: 'a', surface: ['a/**'], consumers: ['x'], description: 'mentions "id": "ghost" inside prose' }] }, null, 2) + '\n',
        'scratch/id': 'ghost',
        'scratch/producer': 'g',
        'scratch/surface/1': 'g/**',
        'scratch/consumers/1': 'y',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['a-api', 'ghost']) // no false-match inside description
  }, 60_000)

  it('inline (single-line) empty array → entry added inline, valid JSON', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': '{"contract_version":"1.0.0","contracts":[]}\n',
        'scratch/id': 'i-api',
        'scratch/producer': 'i',
        'scratch/surface/1': 'a/**',
        'scratch/consumers/1': 'y',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts[0].id).toBe('i-api')
  }, 60_000)

  it('inline (single-line) populated array → entry appended inline, valid JSON', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': '{"contract_version":"1.0.0","contracts":[{"id":"one","producer":"o","surface":["a"],"consumers":["b"]}]}\n',
        'scratch/id': 'two',
        'scratch/producer': 't',
        'scratch/surface/1': 'b/**',
        'scratch/consumers/1': 'c',
      },
    })
    const o = JSON.parse(readIn(r, 'contracts.json'))
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['one', 'two'])
  }, 60_000)

  it('malformed existing contracts array → warns, file untouched (no corruption)', () => {
    const broken = '{ "contract_version": "1.0.0", "contracts": [ {bad json} ] }\n'
    const r = run({
      promptBasename: '01-setup.md',
      anchor: CONTRACT_ANCHOR,
      env: contractEnv,
      seedFiles: {
        'contracts.json': broken,
        'scratch/id': 'z-api',
        'scratch/producer': 'z',
        'scratch/surface/1': 'a/**',
        'scratch/consumers/1': 'y',
      },
    })
    // The WARN goes to stderr (success exit 0); the load-bearing guarantee is that the
    // malformed file is left byte-for-byte untouched (no corruption / partial splice).
    expect(readIn(r, 'contracts.json')).toBe(broken)
  }, 60_000)
})

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
      '.rsct/phase-state.lock', '# RSCT-END']) {
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

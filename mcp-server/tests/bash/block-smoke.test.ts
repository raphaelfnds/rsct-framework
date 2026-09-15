import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
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
import { STAMP_RE, readScriptRegistration } from '../../src/lib/version-drift.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const STRICT = !!process.env.RSCT_REQUIRE_BASH

const dirs: string[] = []
function run(opts: Parameters<typeof runBlock>[1]): RunBlockResult {
  const r = runBlock(ROOT, opts)
  dirs.push(r.dir)
  return r
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }) } catch { }
  }
})

const countBegin = (s: string) => (s.match(/RSCT-BEGIN/g) ?? []).length

const inMarkerRange = (s: string, needle: string) => markerRange(s).includes(needle)

const markerRange = (s: string): string[] => {
  const lines = s.replace(/\r/g, '').split('\n')
  const begin = lines.findIndex((l) => l.includes('RSCT-BEGIN'))
  const end = lines.findIndex((l) => l.includes('RSCT-END'))
  if (begin < 0 || end < 0 || end <= begin) return []
  return lines.slice(begin + 1, end).map((l) => l.trim()).filter(Boolean)
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
    expect(() => assertNodePolicy(STRICT, NODE)).not.toThrow()
  })
})

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
    expect(countBegin(gi)).toBe(1)
  }, 60_000)

  it('backfill — adds /rsct-framework/ to a pre-1.1.x block, inside the marker range', () => {
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
    expect(countBegin(gi)).toBe(1)
    expect(gi).toContain('node_modules/')
    expect(gi).toContain('*.log')
  }, 60_000)

  it('backfill — chains lock + /rsct-framework/ on a block missing both', () => {
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

  it('#73 fresh — the block ignores .claude/settings.local.json', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR })
    const gi = readIn(r, '.gitignore')
    expect(inMarkerRange(gi, '.claude/settings.local.json')).toBe(true)
    expect(markerRange(gi).filter((l) => l.startsWith('.claude')), gi)
      .toEqual(['.claude/settings.local.json'])
  }, 60_000)

  it('#73 backfill — adds it to a block written before this release', () => {
    const old = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      'spec_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '.rsct/phase-state.lock',
      '/rsct-framework/',
      '# RSCT-END',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect(r.out, r.out).toMatch(/#73 backfill: added \.claude\/settings\.local\.json/)
    expect(inMarkerRange(gi, '.claude/settings.local.json')).toBe(true)
    expect(countBegin(gi)).toBe(1)
    expect(inMarkerRange(gi, '/rsct-framework/')).toBe(true)
    expect(inMarkerRange(gi, 'plan_*.md')).toBe(true)
  }, 60_000)

  it('#73 backfill — anchors INSIDE the block when the dev wrote /rsct-framework/ themselves', () => {
    const old = [
      '# my own rules',
      '/rsct-framework/',
      'node_modules/',
      '',
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      'spec_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '.rsct/phase-state.lock',
      '/rsct-framework/',
      '# RSCT-END',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect(inMarkerRange(gi, '.claude/settings.local.json'), gi).toBe(true)
    expect((gi.match(/\.claude\/settings\.local\.json/g) ?? []).length, gi).toBe(1)
    expect(gi.split('\n').slice(0, 4)).toEqual(['# my own rules', '/rsct-framework/', 'node_modules/', ''])
  }, 60_000)

  it('#73 backfill — does not duplicate a line the dev already ignores themselves', () => {
    const old = [
      '# my own rules',
      '.claude/settings.local.json',
      'node_modules/',
      '',
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      'spec_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '.rsct/phase-state.lock',
      '/rsct-framework/',
      '# RSCT-END',
      '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    const gi = readIn(r, '.gitignore')
    expect((gi.match(/\.claude\/settings\.local\.json/g) ?? []).length, gi).toBe(1)
    expect(gi.split('\n').slice(0, 4)).toEqual(['# my own rules', '.claude/settings.local.json', 'node_modules/', ''])
    expect(inMarkerRange(gi, '.claude/settings.local.json'), gi).toBe(false)
    expect(r.out, r.out).not.toMatch(/#73 backfill: added/)
  }, 60_000)

  it('#73 backfill — idempotent, and survives a CRLF .gitignore', () => {
    const old = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md',
      'progress_*.md',
      'spec_*.md',
      '.rsct/audit.log',
      '.rsct/approvals-seen.json',
      '.rsct/phase-state.json',
      '.rsct/phase-state.lock',
      '/rsct-framework/',
      '# RSCT-END',
      '',
    ].join('\r\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old }, runs: 2 })
    const gi = readIn(r, '.gitignore')
    expect(inMarkerRange(gi, '.claude/settings.local.json')).toBe(true)
    expect((gi.match(/\.claude\/settings\.local\.json/g) ?? []).length).toBe(1)
  }, 60_000)

  const FORCE_COMMENT = [
    '# Use `git add --force plan_<slug>.md progress_<slug>.md` (or spec_*) to',
    '# commit on feature branches. Verify they are absent before any merge to',
    '# main/test.',
  ]
  const INVARIANT_LINE = '# RSCT plan tracking — branch-local files, NEVER track on main/test'
  const blockWithComment = (comment: string[], eol = '\n') => [
    'node_modules/',
    '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
    INVARIANT_LINE,
    '# spec_*.md is an accepted alias of plan_*.md (same rule, same intent).',
    ...comment,
    'plan_*.md',
    'progress_*.md',
    'spec_*.md',
    '.rsct/audit.log',
    '.rsct/approvals-seen.json',
    '.rsct/phase-state.json',
    '.rsct/phase-state.lock',
    '/rsct-framework/',
    '# RSCT-END',
    '',
  ].join(eol)

  it('fresh — the generated block never advises git add --force (#51)', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR })
    expect(readIn(r, '.gitignore')).not.toContain('--force')
  }, 60_000)

  it('cleanup — strips the stale --force advice from an existing block (#51)', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: GI_ANCHOR,
      seedFiles: { '.gitignore': blockWithComment(FORCE_COMMENT) },
    })
    const gi = readIn(r, '.gitignore')
    expect(gi).not.toContain('--force')
    for (const line of FORCE_COMMENT) expect(gi, `still present: ${line}`).not.toContain(line)
    expect(gi).toContain(INVARIANT_LINE)
    expect(inMarkerRange(gi, 'plan_*.md'), 'the ignore pattern must survive').toBe(true)
    expect(inMarkerRange(gi, 'progress_*.md')).toBe(true)
    expect(gi).toContain('.rsct/phase-state.lock')
    expect(gi).toContain('node_modules/')
    expect(countBegin(gi)).toBe(1)
  }, 60_000)

  for (const idx of [0, 1, 2]) {
    it(`cleanup — declines when the dev edited comment line ${idx + 1} (#51)`, () => {
      const edited = FORCE_COMMENT.map((l, i) =>
        i === idx ? `${l} — team exception, see the wiki` : l,
      )
      const r = run({
        promptBasename: '01-setup.md',
        anchor: GI_ANCHOR,
        seedFiles: { '.gitignore': blockWithComment(edited) },
      })
      const gi = readIn(r, '.gitignore')
      for (const line of edited) expect(gi, `wrongly removed: ${line}`).toContain(line)
    }, 60_000)
  }

  it('cleanup — declines when the block has no END marker (#51)', () => {
    const seed = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      ...FORCE_COMMENT,
      'plan_*.md',
      '',
      '# my own notes',
      '# main/test.',
      '',
    ].join('\n')
    const r = run({
      promptBasename: '01-setup.md',
      anchor: GI_ANCHOR,
      seedFiles: { '.gitignore': seed },
    })
    const gi = readIn(r, '.gitignore')
    expect(gi, "the dev's own trailing line must survive").toContain('# my own notes\n# main/test.')
  }, 60_000)

  it('cleanup — works on a CRLF .gitignore (#51)', () => {
    const r = run({
      promptBasename: '01-setup.md',
      anchor: GI_ANCHOR,
      seedFiles: { '.gitignore': blockWithComment(FORCE_COMMENT, '\r\n') },
    })
    const gi = readIn(r, '.gitignore')
    expect(gi).not.toContain('--force')
    expect(inMarkerRange(gi, 'plan_*.md')).toBe(true)
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
    expect(countBegin(readIn(r, '.gitignore'))).toBe(0)
  }, 60_000)
})

const SEC_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical text-based secrets'
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

const REG_ANCHOR = 'CHECKPOINT: Phase 4.8'
const APP_TEMPLATE = readFileSync(
  resolve(ROOT, 'universe-templates', 'applications', '_app.md.template'), 'utf8',
)
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
    expect(readme).toContain('# demo-app')
    expect(readme).toContain('acme')
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
    expect(appsOf(r)).toContain('demo-app')
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
    const block = extractBlockByAnchor(ROOT, '01-setup.md', REG_ANCHOR)
    expect(block.code).not.toMatch(/\bgit\s/)
  })
})

const VER_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical display-version stamp'
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
    expect(cm).toContain('v=1.0.0')
    expect(cm).not.toContain('v=1.1.0')
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

const CONSENT_ANCHOR = 'Phase 4.9 executing canonical update-check notice'
const CC_FILE = '.rsct/update-check.json'

describe.skipIf(!BASH)('block: update check informational (01-setup 4.9 — #38)', () => {
  it('reports the posture and how to turn it off', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR })
    expect(r.exit).toBe(0)
    expect(r.out).toMatch(/ON by default/)
    expect(r.out).toMatch(/update_check/)
    expect(r.out).toMatch(/RSCT_UPDATE_CHECK=off/)
  }, 60_000)

  it('writes nothing — no cache file is created', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR })
    expect(existsSync(join(r.dir, CC_FILE))).toBe(false)
  }, 60_000)

  it('leaves an existing cache byte-identical (never clobbers a recorded choice)', () => {
    const seeded = JSON.stringify({ consent: 'no', latest_tag: 'v9.9.9' }, null, 2) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: CONSENT_ANCHOR,
      seedFiles: { [CC_FILE]: seeded },
    })
    expect(readIn(r, CC_FILE)).toBe(seeded)
  }, 60_000)
})

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
    expect(o.install.mode).toBe('CREATE')
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
    expect(o._example.id).toBe('billing-api')
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
    expect(o.contracts[0].surface).toEqual(['openapi/orders.yaml'])
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
    expect(o.contracts.length).toBe(1)
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
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['web', 'web-api'])
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
    expect(o.contracts.map((c: { id: string }) => c.id).sort()).toEqual(['a-api', 'ghost'])
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
    expect(readIn(r, 'contracts.json')).toBe(broken)
  }, 60_000)
})

const SANITIZER_ANCHOR = 'CHECKPOINT: Phase 4.V.b executing canonical sanitizer script copy'
const GUARD_ANCHOR = 'CHECKPOINT: Phase 4.V.d executing canonical edit-scope guard install'

const SRC_BODY = "import { readFileSync } from 'node:fs'\nconst marker = 'body-line'\n"
const SRC_FILE = `#!/usr/bin/env node\n${SRC_BODY}`
const stampPreamble = (version: string): string =>
  `SANITIZER_SRC="$(pwd)/fake-dist/sanitize-permissions.js"\nRSCT_MCP_VERSION=${version}`

const lineOf = (r: RunBlockResult, rel: string, n: number): string =>
  readIn(r, rel).split(/\r?\n/)[n] ?? ''

describe.skipIf(!BASH)('block: script version stamp (01-setup 4.V.b)', () => {
  const TARGET = '.rsct/scripts/sanitize-permissions.js'

  it('writes the exact stamp format that lib/version-drift.ts parses', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SANITIZER_ANCHOR,
      preamble: stampPreamble('9.9.9'),
      seedFiles: { 'fake-dist/sanitize-permissions.js': SRC_FILE },
    })
    expect(lineOf(r, TARGET, 0)).toBe('#!/usr/bin/env node')
    expect(lineOf(r, TARGET, 1)).toBe('// rsct-mcp v=9.9.9 — installed by /rsct-setup')
    expect(lineOf(r, TARGET, 2)).toBe("import { readFileSync } from 'node:fs'")
  }, 60_000)

  it('the stamp line matches the regex version-drift.ts uses', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SANITIZER_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { 'fake-dist/sanitize-permissions.js': SRC_FILE },
    })
    const m = STAMP_RE.exec(lineOf(r, TARGET, 1))
    expect(m?.[1]).toBe('2.3.0')
  }, 60_000)

  it('is idempotent — a second run reports no rewrite needed', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SANITIZER_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { 'fake-dist/sanitize-permissions.js': SRC_FILE },
      runs: 2,
    })
    expect(r.out).toContain('no rewrite needed')
  }, 60_000)
})

describe.skipIf(!BASH || !NODE)('block: guard version stamp (01-setup 4.V.d)', () => {
  it('stamps the edit-scope guard with the same format as the sanitizer', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: GUARD_ANCHOR,
      preamble: stampPreamble('9.9.9'),
      seedFiles: {
        'fake-dist/sanitize-permissions.js': SRC_FILE,
        'fake-dist/edit-scope-guard.js': SRC_FILE,
        '.claude/settings.json': '{}\n',
      },
    })
    expect(lineOf(r, '.rsct/scripts/edit-scope-guard.js', 1)).toBe(
      '// rsct-mcp v=9.9.9 — installed by /rsct-setup',
    )
  }, 60_000)
})

const SESSION_HOOK_ANCHOR =
  'CHECKPOINT: Phase 4.V.c executing canonical structured-merge SessionStart hook install'
const SESSION_SCRUB_ANCHOR =
  'CHECKPOINT: Phase 4.V.a executing canonical structured-merge SessionStart hook scrub'
const GUARD_SCRUB_ANCHOR =
  'CHECKPOINT: Phase 4.V.a1 executing canonical structured-merge PreToolUse guard scrub'

const HOOK_SEED = {
  'fake-dist/sanitize-permissions.js': SRC_FILE,
  'fake-dist/edit-scope-guard.js': SRC_FILE,
  '.claude/settings.json': '{}\n',
}

describe.skipIf(!BASH || !NODE)('block: hook registration round-trip (#24)', () => {
  it('the SessionStart entry 4.V.c writes is recognized as registered', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: HOOK_SEED,
    })
    expect(readScriptRegistration(r.dir, 'sanitize-permissions.js')).toBe('registered')
  }, 60_000)

  it('the PreToolUse entry 4.V.d writes is recognized as registered', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: GUARD_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: HOOK_SEED,
    })
    expect(readScriptRegistration(r.dir, 'edit-scope-guard.js')).toBe('registered')
  }, 60_000)

  it('re-running 4.V.c does not duplicate the entry', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: HOOK_SEED,
      runs: 2,
    })
    expect(r.out).toContain('already present')
    const settings = JSON.parse(readIn(r, '.claude/settings.json')) as {
      hooks?: { SessionStart?: unknown[] }
    }
    expect(settings.hooks?.SessionStart).toHaveLength(1)
    expect(readScriptRegistration(r.dir, 'sanitize-permissions.js')).toBe('registered')
  }, 90_000)

  it('re-running 4.V.d does not duplicate the entry', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: GUARD_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: HOOK_SEED,
      runs: 2,
    })
    expect(r.out).toContain('already present')
    const settings = JSON.parse(readIn(r, '.claude/settings.json')) as {
      hooks?: { PreToolUse?: unknown[] }
    }
    expect(settings.hooks?.PreToolUse).toHaveLength(1)
    expect(readScriptRegistration(r.dir, 'edit-scope-guard.js')).toBe('registered')
  }, 90_000)

  it('an install that never ran reads as unregistered, not as a parse accident', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: 'SANITIZER_SRC=""\nRSCT_MCP_VERSION=2.3.0',
      seedFiles: HOOK_SEED,
    })
    expect(readScriptRegistration(r.dir, 'sanitize-permissions.js')).toBe('unregistered')
  }, 60_000)

  it('the uninstall scrub flips both hooks back to unregistered', () => {
    const installed = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: HOOK_SEED,
    })
    expect(readScriptRegistration(installed.dir, 'sanitize-permissions.js')).toBe('registered')

    const settingsAfterInstall = readIn(installed, '.claude/settings.json')
    const guardInstalled = run({
      promptBasename: '01-setup.md', anchor: GUARD_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { ...HOOK_SEED, '.claude/settings.json': settingsAfterInstall },
    })
    expect(readScriptRegistration(guardInstalled.dir, 'edit-scope-guard.js')).toBe('registered')

    const both = readIn(guardInstalled, '.claude/settings.json')
    const scrubbed = run({
      promptBasename: '03-uninstall.md', anchor: SESSION_SCRUB_ANCHOR,
      seedFiles: { '.claude/settings.json': both },
    })
    expect(readScriptRegistration(scrubbed.dir, 'sanitize-permissions.js')).toBe('unregistered')
    expect(readScriptRegistration(scrubbed.dir, 'edit-scope-guard.js')).toBe('registered')

    const guardScrubbed = run({
      promptBasename: '03-uninstall.md', anchor: GUARD_SCRUB_ANCHOR,
      seedFiles: { '.claude/settings.json': readIn(scrubbed, '.claude/settings.json') },
    })
    expect(hasIn(guardScrubbed, '.claude/settings.json')).toBe(false)
    expect(readScriptRegistration(guardScrubbed.dir, 'edit-scope-guard.js')).toBe('unregistered')
  }, 120_000)
})

const CAP_RESOLVE_ANCHOR = 'CHECKPOINT: Phase 3 resolving commit-message cap'
const CAP_BACKFILL_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical commit-message-cap backfill'

const MINIMAL_RSCT_JSON = JSON.stringify(
  { rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, protected_branches: ['main'] },
  null,
  2,
) + '\n'

const capOf = (raw: string): unknown =>
  (JSON.parse(raw) as { commit_message_max_lines?: unknown }).commit_message_max_lines

describe.skipIf(!BASH)('block: commit-message cap resolution (01-setup Phase 3, #26)', () => {
  const resolved = (preamble: string): string => {
    const r = run({ promptBasename: '01-setup.md', anchor: CAP_RESOLVE_ANCHOR, preamble })
    const m = /commit-message cap: (\d+) non-empty lines/.exec(r.out)
    return m?.[1] ?? `NO MATCH: ${r.out}`
  }

  it('defaults to 15 when nothing was answered', () => {
    expect(resolved('RSCT_JSON_COMMIT_MAX_LINES=""')).toBe('15')
  })

  it('takes the dev answer', () => {
    expect(resolved('RSCT_JSON_COMMIT_MAX_LINES=""\nCOMMIT_MSG_MAX_LINES=40')).toBe('40')
  })

  it('an existing project value WINS over anything captured this run (ask-once)', () => {
    expect(resolved('RSCT_JSON_COMMIT_MAX_LINES=25\nCOMMIT_MSG_MAX_LINES=40')).toBe('25')
  })

  it('degrades a non-numeric answer to the default instead of emitting it', () => {
    for (const bad of ['abc', '1.5', '-3', '12x', '" "']) {
      expect(resolved(`RSCT_JSON_COMMIT_MAX_LINES=""\nCOMMIT_MSG_MAX_LINES=${bad}`)).toBe('15')
    }
  })

  it('clamps to the same range lib/commit-message.ts enforces', () => {
    expect(resolved('RSCT_JSON_COMMIT_MAX_LINES=""\nCOMMIT_MSG_MAX_LINES=0')).toBe('1')
    expect(resolved('RSCT_JSON_COMMIT_MAX_LINES=""\nCOMMIT_MSG_MAX_LINES=9999')).toBe('500')
  })
})

describe.skipIf(!BASH || !NODE)('block: commit-message cap backfill (01-setup 4.4, #26)', () => {
  it('splices a bare JSON number into an .rsct.json that lacks the key', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: CAP_BACKFILL_ANCHOR,
      preamble: 'COMMIT_MSG_MAX_LINES=40',
      seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON },
    })
    const raw = readIn(r, '.rsct.json')
    expect(capOf(raw)).toBe(40)
    expect(typeof capOf(raw)).toBe('number')
    expect(raw).toContain('"commit_message_max_lines": 40')
  })

  it('preserves an existing value on an update run', () => {
    const seeded = JSON.stringify(
      { rsct_version: '1.0.0', commit_message_max_lines: 7, app: { name: 'a', org: 'o' } },
      null,
      2,
    ) + '\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: CAP_BACKFILL_ANCHOR,
      preamble: 'COMMIT_MSG_MAX_LINES=40',
      seedFiles: { '.rsct.json': seeded },
    })
    expect(readIn(r, '.rsct.json')).toBe(seeded)
  })

  it('is idempotent — a second run neither duplicates nor rewrites', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: CAP_BACKFILL_ANCHOR,
      preamble: 'COMMIT_MSG_MAX_LINES=40',
      seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON },
      runs: 2,
    })
    const raw = readIn(r, '.rsct.json')
    expect(raw.match(/commit_message_max_lines/g)).toHaveLength(1)
    expect(capOf(raw)).toBe(40)
  })

  it('leaves a CRLF file valid and does not mix line endings into the splice', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: CAP_BACKFILL_ANCHOR,
      preamble: 'COMMIT_MSG_MAX_LINES=20',
      seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON.replace(/\n/g, '\r\n') },
    })
    const raw = readIn(r, '.rsct.json')
    expect(capOf(raw)).toBe(20)
    expect(raw).toContain('"commit_message_max_lines": 20,\r\n')
  })

  it('keeps the document valid JSON when the root object is otherwise empty', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: CAP_BACKFILL_ANCHOR,
      preamble: 'COMMIT_MSG_MAX_LINES=15',
      seedFiles: { '.rsct.json': '{}\n' },
    })
    expect(capOf(readIn(r, '.rsct.json'))).toBe(15)
  })
})

describe.skipIf(!BASH || !NODE)('block: .rsct.json CREATE render carries the cap (01-setup 4.4, #26)', () => {
  it('renders the REAL template into valid JSON with a bare-number cap', () => {
    const template = readFileSync(resolve(ROOT, 'doc-templates/rsct.json.template'), 'utf8')
    const r = run({
      promptBasename: '01-setup.md',
      anchor: 'CHECKPOINT: Phase 4.4 executing canonical .rsct.json CREATE render',
      preamble: [
        'APP_NAME=acme-api',
        'ORG_SLUG=acme',
        'TEST_FRAMEWORK="Vitest"',
        'APPLIED_AT=2026-01-01T00:00:00Z',
        'MODE=CREATE',
        'SETUP_COMMIT_SHA_BEFORE=abc1234',
        'PROTECTED_BRANCHES="main dev"',
        'COMMIT_MSG_MAX_LINES=40',
      ].join('\n'),
      seedFiles: { '.rsct/doc-templates/rsct.json.template': template },
    })
    const raw = readIn(r, '.rsct.json')
    const parsed = JSON.parse(raw) as { commit_message_max_lines?: unknown; app?: unknown }
    expect(parsed.commit_message_max_lines).toBe(40)
    expect(typeof parsed.commit_message_max_lines).toBe('number')
    expect(raw).not.toContain('"commit_message_max_lines": "')
    expect(raw).not.toContain('[COMMIT_MSG_MAX_LINES]')
  }, 60_000)
})

const BOM = '﻿'

describe.skipIf(!BASH || !NODE)('block: UTF-8 BOM tolerance (#12)', () => {
  it('4.V.c registers the SessionStart hook in a BOM-prefixed settings.json', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { ...HOOK_SEED, '.claude/settings.json': BOM + '{}\n' },
    })
    expect(readScriptRegistration(r.dir, 'sanitize-permissions.js')).toBe('registered')
    expect(readIn(r, '.claude/settings.json').charCodeAt(0)).not.toBe(0xfeff)
  }, 60_000)

  it('4.V.d registers the PreToolUse hook in a BOM-prefixed settings.json', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: GUARD_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { ...HOOK_SEED, '.claude/settings.json': BOM + '{}\n' },
    })
    expect(readScriptRegistration(r.dir, 'edit-scope-guard.js')).toBe('registered')
  }, 60_000)

  it('the uninstall scrub still removes the hook from a BOM-prefixed file', () => {
    const installed = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { ...HOOK_SEED, '.claude/settings.json': BOM + '{}\n' },
    })
    const scrubbed = run({
      promptBasename: '03-uninstall.md', anchor: SESSION_SCRUB_ANCHOR,
      seedFiles: { '.claude/settings.json': BOM + readIn(installed, '.claude/settings.json') },
    })
    expect(scrubbed.out).not.toContain('malformed')
    expect(readScriptRegistration(scrubbed.dir, 'sanitize-permissions.js')).toBe('unregistered')
  }, 90_000)

  it('the Phase 1.9 detector reports a hook count, not SETTINGS_MALFORMED', () => {
    const installed = run({
      promptBasename: '01-setup.md', anchor: SESSION_HOOK_ANCHOR,
      preamble: stampPreamble('2.3.0'),
      seedFiles: { ...HOOK_SEED, '.claude/settings.json': BOM + '{}\n' },
    })
    const r = run({
      promptBasename: '03-uninstall.md',
      anchor: 'CHECKPOINT: Phase 1.9 scanning .claude/settings.json',
      seedFiles: { '.claude/settings.json': BOM + readIn(installed, '.claude/settings.json') },
    })
    expect(r.out).toContain('HOOK_MATCHES=1')
    expect(r.out).not.toContain('SETTINGS_MALFORMED')
  }, 90_000)
})

const MCPC2_ANCHOR = 'CHECKPOINT: Phase 4.V.c2 evaluating project-scope MCP registration'

describe.skipIf(!BASH || !NODE)('block: project MCP approval (01-setup 4.V.c2, #73)', () => {
  const PRE = 'SANITIZER_SRC=/tmp/fake-sanitizer.js'
  const scope = (v: string) => ({ '.rsct/mcp-scope': `${v}\n` })
  const settingsLocal = (r: RunBlockResult) =>
    JSON.parse(readIn(r, '.claude/settings.local.json')) as {
      enabledMcpjsonServers?: string[]
      disabledMcpjsonServers?: string[]
      hooks?: unknown
    }

  it('project scope — writes .mcp.json AND approves it', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE, seedFiles: scope('project') })
    expect(r.exit, r.out).toBe(0)
    const mcp = JSON.parse(readIn(r, '.mcp.json')) as { mcpServers: Record<string, { command: string; args: string[] }> }
    expect(mcp.mcpServers.rsct.command).toBe('rsct-mcp')
    expect(settingsLocal(r).enabledMcpjsonServers).toEqual(['rsct'])
    expect(r.out).toMatch(/approved rsct for this project/)
  }, 60_000)

  it('idempotent — a re-run neither duplicates nor rewrites the approval', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE, seedFiles: scope('project'), runs: 2 })
    expect(r.exit, r.out).toBe(0)
    expect(settingsLocal(r).enabledMcpjsonServers).toEqual(['rsct'])
    expect(r.out).toMatch(/already approved for this project/)
  }, 60_000)

  it('preserves a dev-owned settings.local.json instead of replacing it', () => {
    const seeded = '{\n  "enabledMcpjsonServers": ["other-server"],\n  "hooks": {"SessionStart": []}\n}\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE,
      seedFiles: { ...scope('project'), '.claude/settings.local.json': seeded },
    })
    expect(r.exit, r.out).toBe(0)
    const s = settingsLocal(r)
    expect(s.enabledMcpjsonServers).toEqual(['other-server', 'rsct'])
    expect(s.hooks, 'unrelated keys must survive').toBeDefined()
  }, 60_000)

  it('never overrides an explicit refusal recorded in disabledMcpjsonServers', () => {
    const seeded = '{\n  "disabledMcpjsonServers": ["rsct"]\n}\n'
    const r = run({
      promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE,
      seedFiles: { ...scope('project'), '.claude/settings.local.json': seeded },
    })
    expect(r.exit, r.out).toBe(0)
    expect(hasIn(r, '.mcp.json'), 'positive control: registration still happens').toBe(true)
    const s = settingsLocal(r)
    expect(s.enabledMcpjsonServers, 'must not approve over a refusal').toBeUndefined()
    expect(s.disabledMcpjsonServers).toEqual(['rsct'])
    expect(r.out).toMatch(/REJECTED rsct here/)
  }, 60_000)

  it('user scope — writes neither the registration nor the approval', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE, seedFiles: scope('user') })
    expect(r.exit, r.out).toBe(0)
    expect(hasIn(r, '.mcp.json')).toBe(false)
    expect(hasIn(r, '.claude/settings.local.json'), 'no approval outside project scope').toBe(false)
    expect(r.out).toMatch(/not project.*\.mcp\.json not written/)
  }, 60_000)

  it('refuses valid-JSON-but-not-an-object instead of reporting a phantom approval', () => {
    const CAPTURE = `${PRE}\nexec 2>&1`
    for (const bad of ['null', '[]', '"x"', '42']) {
      const r = run({
        promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: CAPTURE,
        seedFiles: { ...scope('project'), '.claude/settings.local.json': `${bad}\n` },
      })
      expect(r.out, `${bad} must not claim success`).not.toMatch(/approved rsct for this project/)
      expect(r.out, `${bad} must not print the all-set notes`).toMatch(/rsct was NOT approved for this project/)
      expect(r.out, `${bad}: the guard must be what refuses`).toMatch(/is valid JSON but not an object/)
      expect(r.out, `${bad} must not surface a raw stack`).not.toMatch(/TypeError|at Object\.<anonymous>/)
      expect(hasIn(r, '.mcp.json'), `${bad}: registration still happens`).toBe(true)
      expect(readIn(r, '.claude/settings.local.json').trim()).toBe(bad)
    }
  }, 90_000)

  it('tolerates a BOM-prefixed settings.local.json', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: MCPC2_ANCHOR, preamble: PRE,
      seedFiles: { ...scope('project'), '.claude/settings.local.json': '\uFEFF{"hooks":{}}\n' },
    })
    expect(r.exit, r.out).toBe(0)
    expect(settingsLocal(r).enabledMcpjsonServers).toEqual(['rsct'])
  }, 60_000)
})

const APPROVAL_ANCHOR = 'CHECKPOINT: Phase 4.V.a3'

describe.skipIf(!BASH || !NODE)('block: MCP approval scrub (03-uninstall 4.V.a3, #73)', () => {
  const local = '.claude/settings.local.json'
  const readLocal = (r: RunBlockResult) => JSON.parse(readIn(r, local)) as Record<string, unknown>

  it('removes only the rsct value and preserves every other key', () => {
    const seed = JSON.stringify({
      enabledMcpjsonServers: ['other-server', 'rsct'],
      disabledMcpjsonServers: ['nope'],
      permissions: { allow: ['Bash(ls:*)'] },
    }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR, seedFiles: { [local]: seed } })
    expect(hasIn(r, local), 'a shared file is rewritten, never removed').toBe(true)
    const cfg = readLocal(r)
    expect(cfg.enabledMcpjsonServers).toEqual(['other-server'])
    expect(cfg.disabledMcpjsonServers, 'a recorded refusal is the dev\'s, not ours').toEqual(['nope'])
    expect(cfg.permissions, 'unrelated keys must survive').toBeDefined()
  }, 60_000)

  it('deletes the file only when the approval was all it held', () => {
    const seed = JSON.stringify({ enabledMcpjsonServers: ['rsct'] }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR, seedFiles: { [local]: seed } })
    expect(hasIn(r, local)).toBe(false)
    expect(r.out).toMatch(/it held only the rsct approval/)
  }, 60_000)

  it('keeps the file when another key survives the scrub', () => {
    const seed = JSON.stringify({ enabledMcpjsonServers: ['rsct'], permissions: {} }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR, seedFiles: { [local]: seed } })
    expect(hasIn(r, local)).toBe(true)
    const cfg = readLocal(r)
    expect(cfg.enabledMcpjsonServers, 'an emptied array is dropped, not left as []').toBeUndefined()
    expect(cfg.permissions).toBeDefined()
  }, 60_000)

  it('no-op when there is no rsct approval, and idempotent on a second run', () => {
    const seed = JSON.stringify({ enabledMcpjsonServers: ['other-server'] }, null, 2) + '\n'
    const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR, seedFiles: { [local]: seed }, runs: 2 })
    expect(hasIn(r, local)).toBe(true)
    expect(readLocal(r).enabledMcpjsonServers).toEqual(['other-server'])
    expect(r.out).toMatch(/nothing to scrub/)
  }, 60_000)

  it('skips a file that is valid JSON but not an object, without throwing', () => {
    for (const bad of ['null', '[]', '"x"']) {
      const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR, seedFiles: { [local]: `${bad}\n` } })
      expect(r.exit, `${bad}: ${r.out}`).toBe(0)
      expect(readIn(r, local).trim(), `${bad} must be left untouched`).toBe(bad)
    }
  }, 90_000)

  it('absent file is a clean no-op', () => {
    const r = run({ promptBasename: '03-uninstall.md', anchor: APPROVAL_ANCHOR })
    expect(r.exit, r.out).toBe(0)
    expect(hasIn(r, local)).toBe(false)
  }, 60_000)
})

const SQL_RESOLVE_ANCHOR = 'CHECKPOINT: Phase 3 resolving SQL dialect'
const SQL_BACKFILL_ANCHOR = 'CHECKPOINT: Phase 4.4 executing canonical sql_dialect backfill'
const dialectOf = (raw: string): unknown => (JSON.parse(raw.replace(/^﻿/, '')) as { sql_dialect?: unknown }).sql_dialect

describe.skipIf(!BASH)('block: SQL dialect resolution (01-setup Phase 3, #62)', () => {
  const resolved = (preamble: string): string => {
    const r = run({ promptBasename: '01-setup.md', anchor: SQL_RESOLVE_ANCHOR, preamble })
    const m = /sql dialect: (\S+)/.exec(r.out)
    return m?.[1] ?? `NO MATCH: ${r.out}`
  }

  it('keeps only the three valid values, case-folded', () => {
    expect(resolved('RSCT_JSON_SQL_DIALECT=""\nSQL_DIALECT=PostgreSQL')).toBe('postgresql')
    expect(resolved('RSCT_JSON_SQL_DIALECT=""\nSQL_DIALECT=mysql')).toBe('mysql')
    expect(resolved('RSCT_JSON_SQL_DIALECT=""\nSQL_DIALECT=none')).toBe('none')
  })

  it('an unknown or empty answer is not declared', () => {
    for (const bad of ['postgres', '""', 'sqlite']) {
      expect(resolved(`RSCT_JSON_SQL_DIALECT=""\nSQL_DIALECT=${bad}`)).toBe('not')
    }
  })

  it('an existing project value wins (ask-once)', () => {
    expect(resolved('RSCT_JSON_SQL_DIALECT=mysql\nSQL_DIALECT=postgresql')).toBe('mysql')
  })
})

describe.skipIf(!BASH || !NODE)('block: sql_dialect backfill (01-setup 4.4, #62)', () => {
  it('splices a valid dialect into an .rsct.json that lacks the key', () => {
    const r = run({
      promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR,
      preamble: 'SQL_DIALECT=postgresql',
      seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON },
    })
    expect(dialectOf(readIn(r, '.rsct.json'))).toBe('postgresql')
  })

  it('writes nothing for an invalid or empty dialect', () => {
    for (const bad of ['postgres', '']) {
      const r = run({
        promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR,
        preamble: `SQL_DIALECT="${bad}"`,
        seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON },
      })
      expect(readIn(r, '.rsct.json')).toBe(MINIMAL_RSCT_JSON)
    }
  })

  it('preserves an existing value and is idempotent', () => {
    const seeded = JSON.stringify({ rsct_version: '1.0.0', sql_dialect: 'mysql', app: { name: 'a', org: 'o' } }, null, 2) + '\n'
    const kept = run({ promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR, preamble: 'SQL_DIALECT=postgresql', seedFiles: { '.rsct.json': seeded } })
    expect(readIn(kept, '.rsct.json')).toBe(seeded)
    const twice = run({ promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR, preamble: 'SQL_DIALECT=none', seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON }, runs: 2 })
    expect(readIn(twice, '.rsct.json').match(/sql_dialect/g)).toHaveLength(1)
  })

  it('handles CRLF and a UTF-8 BOM', () => {
    const crlf = run({ promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR, preamble: 'SQL_DIALECT=mysql', seedFiles: { '.rsct.json': MINIMAL_RSCT_JSON.replace(/\n/g, '\r\n') } })
    const rawCrlf = readIn(crlf, '.rsct.json')
    expect(dialectOf(rawCrlf)).toBe('mysql')
    expect(rawCrlf).toContain('"sql_dialect": "mysql",\r\n')
    const bom = run({ promptBasename: '01-setup.md', anchor: SQL_BACKFILL_ANCHOR, preamble: 'SQL_DIALECT=none', seedFiles: { '.rsct.json': `﻿${MINIMAL_RSCT_JSON}` } })
    expect(dialectOf(readIn(bom, '.rsct.json'))).toBe('none')
  })
})

describe.skipIf(!BASH || !NODE)('block: .rsct.json CREATE render carries sql_dialect (01-setup 4.4, #62)', () => {
  const render = (dialect: string): string => {
    const template = readFileSync(resolve(ROOT, 'doc-templates/rsct.json.template'), 'utf8')
    const r = run({
      promptBasename: '01-setup.md',
      anchor: 'CHECKPOINT: Phase 4.4 executing canonical .rsct.json CREATE render',
      preamble: [
        'APP_NAME=acme-api', 'ORG_SLUG=acme', 'TEST_FRAMEWORK="Vitest"', 'APPLIED_AT=2026-01-01T00:00:00Z',
        'MODE=CREATE', 'SETUP_COMMIT_SHA_BEFORE=abc1234', 'PROTECTED_BRANCHES="main"', 'COMMIT_MSG_MAX_LINES=15',
        `SQL_DIALECT="${dialect}"`,
      ].join('\n'),
      seedFiles: { '.rsct/doc-templates/rsct.json.template': template },
    })
    return readIn(r, '.rsct.json')
  }

  it('renders a declared dialect', () => {
    expect(dialectOf(render('postgresql'))).toBe('postgresql')
  }, 60_000)

  it('drops the key entirely when no dialect was declared, keeping valid JSON', () => {
    const raw = render('')
    expect(raw).not.toContain('sql_dialect')
    expect(raw).not.toContain('[SQL_DIALECT]')
    expect(() => JSON.parse(raw)).not.toThrow()
  }, 60_000)
})

describe.skipIf(!BASH)('block: gitignore backfill adds .rsct/reports/ (01-setup 4.4b, #62)', () => {
  it('fresh block lists it', () => {
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR })
    expect(inMarkerRange(readIn(r, '.gitignore'), '.rsct/reports/')).toBe(true)
  }, 60_000)

  it('an old block gets it inside the markers, once, and a CRLF file stays readable', () => {
    const old = [
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md', 'progress_*.md', 'spec_*.md',
      '.rsct/audit.log', '.rsct/approvals-seen.json', '.rsct/phase-state.json', '.rsct/phase-state.lock',
      '/rsct-framework/', '', '.claude/settings.local.json',
      '# RSCT-END', '',
    ].join('\r\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old }, runs: 2 })
    const gi = readIn(r, '.gitignore')
    expect(inMarkerRange(gi, '.rsct/reports/')).toBe(true)
    expect(gi.replace(/\r/g, '').split('\n').filter((l) => l === '.rsct/reports/')).toHaveLength(1)
  }, 60_000)

  it('a dev who already ignores it elsewhere gets no second copy', () => {
    const old = [
      '.rsct/reports/', '',
      '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b',
      'plan_*.md', 'progress_*.md', 'spec_*.md',
      '.rsct/audit.log', '.rsct/approvals-seen.json', '.rsct/phase-state.json', '.rsct/phase-state.lock',
      '/rsct-framework/', '', '.claude/settings.local.json',
      '# RSCT-END', '',
    ].join('\n')
    const r = run({ promptBasename: '01-setup.md', anchor: GI_ANCHOR, seedFiles: { '.gitignore': old } })
    expect(readIn(r, '.gitignore').split('\n').filter((l) => l === '.rsct/reports/')).toHaveLength(1)
  }, 60_000)
})

describe.skipIf(!BASH)('block: uninstall removes REVIEW sweep reports only (03-uninstall 4.V.c, #62)', () => {
  it('deletes review-comments reports, counts them, keeps other files', () => {
    const r = run({
      promptBasename: '03-uninstall.md', anchor: 'REPORTS_REMOVED=0',
      seedFiles: {
        '.rsct/reports/review-comments-aaaa.md': 'a\n',
        '.rsct/reports/review-comments-bbbb.md': 'b\n',
        '.rsct/reports/dev-notes.md': 'mine\n',
      },
    })
    expect(r.out).toContain('REVIEW sweep reports removed: 2')
    expect(hasIn(r, '.rsct/reports/review-comments-aaaa.md')).toBe(false)
    expect(hasIn(r, '.rsct/reports/dev-notes.md')).toBe(true)
  }, 60_000)

  it('drops the empty reports directory', () => {
    const r = run({ promptBasename: '03-uninstall.md', anchor: 'REPORTS_REMOVED=0', seedFiles: { '.rsct/reports/review-comments-cccc.md': 'c\n' } })
    expect(r.out).toContain('REVIEW sweep reports removed: 1')
    expect(existsSync(join(r.dir, '.rsct', 'reports'))).toBe(false)
  }, 60_000)
})

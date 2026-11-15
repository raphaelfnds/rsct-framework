import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectAppliesTo, GLOBS_PER_ENTRY_MAX, readAppliesToLine } from '../../src/lib/applies-to.js'
import { extractAntiDecisions } from '../../src/lib/anti-decisions.js'
import { extractDecisions } from '../../src/lib/decisions.js'
import { declaredCandidates, decisionsCovering, readBoundCorpus, type BoundDecision } from '../../src/lib/decision-scope.js'
import { checkPremise } from '../../src/lib/premise-check.js'
import { runVerificationChecklist } from '../../src/lib/verification-checklist.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { getDecisionsHandler } from '../../src/tools/get-decisions.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

const c = (...codes: number[]): string => String.fromCharCode(...codes)

let root: string
let tick = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-decision-scope-'))
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function decisionsMd(opts: { premiseLine?: string; adrLine?: string; extra?: string } = {}): string {
  return [
    '# Architectural decisions — a',
    '',
    '## Firm premises (non-negotiable)',
    '',
    '### #1 — Money amounts are integer cents',
    ...(opts.premiseLine === undefined ? ['**Applies to**: `src/money/**`'] : opts.premiseLine === '' ? [] : [opts.premiseLine]),
    'All amounts are integer cents.',
    'Never store money as float.',
    '',
    '---',
    '',
    '## Durable architectural decisions (ADRs)',
    '',
    '### ADR-002 — Retries go through the shared client',
    '**Status**: active',
    ...(opts.adrLine === undefined ? ['**Applies to**: src/http/client.ts, src/jobs/*.ts'] : opts.adrLine === '' ? [] : [opts.adrLine]),
    '**Decision**: every retry uses the shared client.',
    '',
    ...(opts.extra === undefined ? [] : [opts.extra]),
  ].join('\n')
}

const ANTI = [
  '# Anti-decisions — a',
  '',
  '## Entries',
  '',
  '### AD-001 — Float money in the ledger',
  '- **Applies to:** `src/ledger/**`',
  '- **Tried:** float columns for invoice money.',
  '- **Abandoned because:** rounding drift in the audit.',
  '',
].join('\n')

function corpus(decisions = decisionsMd(), anti: string | null = ANTI): void {
  write('documentation/decisions.md', decisions)
  if (anti !== null) write('documentation/knowledge/anti-decisions.md', anti)
}

function checklist(declaredPaths: string[], specTier: 'trivial' | 'small' | 'standard' | 'complex' = 'complex', projectRoot = root) {
  return runVerificationChecklist({ projectRoot, declaredPaths, discoveredImporters: [], specTier })
}

describe('Applies to — reading the line (6.1)', () => {
  it('reads the four spellings, in any case, and drops backticks, ./ and backslashes', () => {
    for (const line of [
      '**Applies to**: src/a.ts',
      '**Applies to:** src/a.ts',
      '- **Applies to**: src/a.ts',
      '- **Applies to:** src/a.ts',
      '  **applies TO**:src/a.ts',
    ]) {
      expect(readAppliesToLine(line), line).toEqual({ binds: true, globs: ['src/a.ts'], rejected: [] })
    }
    expect(readAppliesToLine('**Applies to**: `./src/**`, src\\win\\*.ts')).toEqual({ binds: true, globs: ['src/**', 'src/win/*.ts'], rejected: [] })
    expect(readAppliesToLine('**Applies**: src/a.ts')).toBeNull()
    expect(readAppliesToLine('Applies to: src/a.ts')).toBeNull()
  })

  it('binds only when every comma item is a path token', () => {
    expect(readAppliesToLine('**Applies to**: all money handling code')).toEqual({ binds: false, value: 'all money handling code' })
    expect(readAppliesToLine('**Applies to**: src/a.ts, the billing module')).toEqual({ binds: false, value: 'src/a.ts, the billing module' })
    expect(readAppliesToLine('**Applies to**:')).toEqual({ binds: false, value: '' })
    expect(readAppliesToLine('**Applies to**: src/a.ts,')).toEqual({ binds: false, value: 'src/a.ts,' })
    expect(readAppliesToLine(`**Applies to**: src/a${c(0xa0)}b.ts`)?.binds).toBe(false)
  })

  it('rejects absolute paths, parent segments, long globs, star piles and hidden characters, and the line still binds', () => {
    const long = `src/${'a'.repeat(260)}`
    const read = readAppliesToLine(`**Applies to**: /etc/x, C:/x, ../x, src/../x, ${long}, src/*a*b*c*d*e, src/a${c(0x200b)}b, src/ok.ts`)
    expect(read).toEqual({
      binds: true,
      globs: ['src/ok.ts'],
      rejected: [
        '/etc/x (an absolute path)',
        'C:/x (an absolute path)',
        '../x (leaves the project folder)',
        'src/../x (leaves the project folder)',
        `${long} (longer than 256 characters)`,
        "src/*a*b*c*d*e (more than 4 '*' in one segment)",
        `src/a${c(0x200b)}b (a control or invisible character)`,
      ],
    })
    expect(readAppliesToLine('**Applies to**: src/*a*b*c*d.ts')).toEqual({ binds: true, globs: ['src/*a*b*c*d.ts'], rejected: [] })
  })

  it('collapses repeated **/ segments', () => {
    expect(readAppliesToLine('**Applies to**: **/**/x.ts, a/**/**/**/b/**/**')).toEqual({ binds: true, globs: ['**/x.ts', 'a/**/b/**'], rejected: [] })
  })

  it('caps the globs one entry carries and merges several lines', () => {
    const many = Array.from({ length: GLOBS_PER_ENTRY_MAX + 2 }, (_, i) => `src/f${i}.ts`)
    const got = collectAppliesTo([`**Applies to**: ${many.join(', ')}`, '**Applies to**: src/f0.ts, prose here'].join('\n'))
    expect(got?.globs).toHaveLength(GLOBS_PER_ENTRY_MAX)
    expect(got?.rejected).toEqual([
      `src/f${GLOBS_PER_ENTRY_MAX}.ts (more than ${GLOBS_PER_ENTRY_MAX} globs on one entry)`,
      `src/f${GLOBS_PER_ENTRY_MAX + 1}.ts (more than ${GLOBS_PER_ENTRY_MAX} globs on one entry)`,
    ])
    expect(got?.unbound).toEqual(['src/f0.ts, prose here'])
    expect(collectAppliesTo('no line here')).toBeUndefined()
  })

  it('reads a CRLF line, and leaves unread a line with a line separator inside', () => {
    expect(readAppliesToLine(`**Applies to**: src/a.ts${c(13)}`)).toEqual({ binds: true, globs: ['src/a.ts'], rejected: [] })
    expect(readAppliesToLine(`**Applies to**: src/a.ts${c(0x2028)}never`)).toBeNull()
  })
})

describe('Applies to — the excerpts skip a binding line (6.5, 6.6)', () => {
  const claim = 'Store invoice money amounts as float values in the ledger'
  const premise = (line: string | null): string =>
    [
      '### #1 — Money amounts in the ledger',
      ...(line === null ? [] : [line]),
      'All invoice amounts are integer cents.',
      'Reason: rounding drift found in the 2024 audit.',
      'Never store money as float.',
      '',
    ].join('\n')

  it('a binding line never enters the decision excerpt, so the premise check keeps its conflict', () => {
    const without = extractDecisions(premise(null)).premises[0]!
    const withLine = extractDecisions(premise('**Applies to**: `src/ledger/**`, `src/invoice/*.ts`')).premises[0]!
    expect(withLine.excerpt).toBe(without.excerpt)
    expect(checkPremise(claim, [without]).recommendation).toBe('conflict')
    expect(checkPremise(claim, [withLine]).recommendation).toBe('conflict')
    expect(withLine.applies_to).toEqual({ globs: ['src/ledger/**', 'src/invoice/*.ts'], rejected: [], unbound: [] })
    expect(without.applies_to).toBeUndefined()
  })

  it('a binding line never enters the anti-decision excerpt', () => {
    const body = (line: string | null): string =>
      [
        '### AD-001 — Float money in the ledger',
        ...(line === null ? [] : [line]),
        '- **Tried:** float columns for invoice money.',
        '- **Hoped to gain:** simpler maths.',
        '- **Abandoned because:** rounding drift in the audit.',
        '- **Do not revisit unless:** a decimal type is unavailable.',
        '',
      ].join('\n')
    const without = extractAntiDecisions(body(null))[0]!
    const withLine = extractAntiDecisions(body('- **Applies to:** `src/ledger/**`'))[0]!
    expect(withLine.excerpt).toBe(without.excerpt)
    expect(withLine.applies_to?.globs).toEqual(['src/ledger/**'])
  })

  it('a prose "Applies to" line stays in both excerpts and binds nothing', () => {
    const decision = extractDecisions(premise('**Applies to**: never for the ledger')).premises[0]!
    expect(decision.excerpt.startsWith('**Applies to**: never for the ledger')).toBe(true)
    expect(decision.applies_to).toEqual({ globs: [], rejected: [], unbound: ['never for the ledger'] })
    const anti = extractAntiDecisions(['### AD-002 — X', '- **Applies to:** every queue we run', '- **Tried:** y.', ''].join('\n'))[0]!
    expect(anti.excerpt).toContain('every queue we run')
  })
})

describe('declared paths and coverage (6.2)', () => {
  const files = ['src/money/a.ts', 'src/money/deep/b.ts', 'src/http/client.ts', 'docs/x.md']

  it('expands folders and globs to the files under them, keeps the declared string and its folder spelling', () => {
    expect(declaredCandidates(['src/money'], files).sort()).toEqual(['src/money', 'src/money/', 'src/money/a.ts', 'src/money/deep/b.ts'])
    expect(declaredCandidates(['src/**/*.ts'], files)).toEqual(expect.arrayContaining(['src/money/a.ts', 'src/money/deep/b.ts', 'src/http/client.ts']))
    expect(declaredCandidates(['./src/http/client.ts'], files).sort()).toEqual(['src/http/client.ts', 'src/http/client.ts/'])
    expect(declaredCandidates([''], files).sort()).toEqual([...files].sort())
  })

  it('drops declared paths outside the project folder', () => {
    expect(declaredCandidates(['../other/a.ts', '..', '/abs/a.ts', 'C:/abs/a.ts'], files)).toEqual([])
    const any: BoundDecision = { key: 'k', label: 'ADR-009', title: 't', file: 'f', globs: ['**'], added_since_head: false }
    expect(decisionsCovering([any], declaredCandidates(['../other/a.ts'], files))).toEqual([])
  })

  it('a folder the plan creates matches through its folder spelling', () => {
    const entry: BoundDecision = { key: 'k', label: 'premise #1', title: 't', file: 'f', globs: ['src/newfolder/**'], added_since_head: false }
    expect(decisionsCovering([entry], declaredCandidates(['src/newfolder'], files))).toEqual([{ entry, path: 'src/newfolder/', glob: 'src/newfolder/**' }])
  })
})

describe('V — one aggregated finding (6.2, V adjustments 9 and 10)', () => {
  it('raises one gap finding, last, measured, with the ids in its title; every other id stays put', () => {
    corpus(decisionsMd(), ANTI)
    write('src/money/a.ts', 'export const a = 1\n')
    write('src/ledger/l.ts', 'export const l = 1\n')
    write('src/jobs/retry.ts', 'export const r = 1\n')
    const plain = checklist(['src/money', 'src/jobs/retry.ts', 'src/ledger/l.ts'])
    expect(plain.findings.at(-1)).toMatchObject({
      category: 'gap',
      severity: 'address-now',
      source: 'decision-scope',
      title: 'Decisions bound to the declared paths (3): premise #1, ADR-002, AD-001',
      evidence: { kind: 'measured' },
    })
    const finding = plain.findings.at(-1)!
    expect(finding.detail).toContain('- premise #1 — Money amounts are integer cents: src/money/ matches src/money/**')
    expect(finding.detail).toContain('- ADR-002 — Retries go through the shared client: src/jobs/retry.ts matches src/jobs/*.ts')
    expect(finding.id).toBe(`v-gap-${plain.findings.length}`)

    corpus(decisionsMd({ premiseLine: '', adrLine: '' }), ANTI.replace('- **Applies to:** `src/ledger/**`\n', ''))
    const unbound = checklist(['src/money', 'src/jobs/retry.ts', 'src/ledger/l.ts'])
    expect(unbound.findings.map((f) => f.id)).toEqual(plain.findings.slice(0, -1).map((f) => f.id))
    expect(unbound.findings.some((f) => f.source === 'decision-scope')).toBe(false)
  })

  it('trivial and small tiers get no finding', () => {
    corpus()
    write('src/money/a.ts', 'x\n')
    expect(checklist(['src/money/a.ts'], 'trivial').findings).toEqual([])
    expect(checklist(['src/money/a.ts'], 'small').findings).toEqual([])
  })

  it('reports globs that match no file, a folder spelling and a prose line in a hint, never a finding', () => {
    corpus(decisionsMd({ premiseLine: '**Applies to**: src/money, src/gone/**', adrLine: '**Applies to**: the retry layer' }), null)
    write('src/money/a.ts', 'x\n')
    const r = checklist(['docs/other.md'])
    expect(r.findings.some((f) => f.source === 'decision-scope')).toBe(false)
    const hint = r.hints.find((h) => h.startsWith('"Applies to" lines that bind nothing'))
    expect(hint).toContain('(3)')
    expect(hint).toContain('premise #1: src/money matches no file (it names a folder: src/money/** covers the files in it)')
    expect(hint).toContain('premise #1: src/gone/** matches no file')
    expect(hint).toContain('ADR-002: "the retry layer" is not a comma-separated list of paths')
  })
})

describe('V and REVIEW read HEAD and the working tree (V adjustments 3 and 6)', () => {
  beforeEach(() => {
    initSweepRepo(root)
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  })

  it('a line removed in the working tree still binds, from HEAD', () => {
    corpus()
    write('src/money/a.ts', 'x\n')
    commitAll(root, 'decisions')
    corpus(decisionsMd({ premiseLine: '' }))
    const r = checklist(['src/money/a.ts'])
    expect(r.findings.at(-1)?.title).toBe('Decisions bound to the declared paths (1): premise #1')
  })

  it('expands folders from git, untracked included and ignored excluded', () => {
    corpus(decisionsMd({ premiseLine: '**Applies to**: src/money/new.ts', adrLine: '**Applies to**: src/money/skip.log' }), null)
    write('.gitignore', '.rsct/\n*.log\n')
    commitAll(root, 'decisions')
    write('src/money/new.ts', 'x\n')
    write('src/money/skip.log', 'x\n')
    const r = checklist(['src/money'])
    expect(r.findings.at(-1)?.title).toBe('Decisions bound to the declared paths (1): premise #1')
    expect(r.hints.find((h) => h.startsWith('"Applies to"'))).toContain('ADR-002: src/money/skip.log matches no file')
  })

  it('a project in a subfolder reads HEAD under its prefix', () => {
    write('apps/web/.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'web', org: 'o' } }))
    write('apps/web/documentation/decisions.md', decisionsMd())
    write('apps/web/src/money/a.ts', 'x\n')
    commitAll(root, 'web app')
    write('apps/web/documentation/decisions.md', decisionsMd({ premiseLine: '' }))
    const corpusRead = readBoundCorpus(join(root, 'apps', 'web'))
    expect(corpusRead.head).toBe('read')
    expect(corpusRead.entries.map((e) => e.label).sort()).toEqual(['ADR-002', 'premise #1'])
    expect(checklist(['src/money'], 'complex', join(root, 'apps', 'web')).findings.at(-1)?.title).toBe('Decisions bound to the declared paths (1): premise #1')
  })

  it('an unreadable HEAD side is said in a hint', () => {
    corpus()
    commitAll(root, 'decisions')
    const blob = git(root, 'rev-parse', 'HEAD:documentation/decisions.md').trim()
    const object = join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
    chmodSync(object, 0o644)
    unlinkSync(object)
    expect(readBoundCorpus(root).head).toBe('unreadable')
    write('src/money/a.ts', 'x\n')
    const r = checklist(['src/money/a.ts'])
    expect(r.hints).toContain('⚠ documentation/decisions.md could not be read at HEAD: the decisions bound to paths come from the working tree only.')
    expect(r.findings.at(-1)?.title).toBe('Decisions bound to the declared paths (1): premise #1')
  })
})

describe('REVIEW — decisions covering the changed files (6.3, V adjustments 2, 5 and 8)', () => {
  function approval(scope: string): Record<string, string> {
    tick++
    return { timestamp: new Date(Date.now() - 5_000 - tick).toISOString(), action_scope: scope, reason: `decision scope review test approval ${tick}` }
  }

  function prompts(response: DialogResult['response'] = 'yes'): { fn: (o: DialogOptions) => Promise<DialogResult>; seen: DialogOptions[] } {
    const seen: DialogOptions[] = []
    return { seen, fn: async (o) => (seen.push(o), { response, channel: response === 'no-channel' ? 'none' : 'windows' }) }
  }

  function auditEvents(projectRoot = root): Array<Record<string, unknown>> {
    const p = join(projectRoot, '.rsct', 'audit.log')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  async function review(projectRoot = root, p = prompts()) {
    mkdirSync(join(projectRoot, '.rsct'), { recursive: true })
    writeFileSync(join(projectRoot, '.rsct', 'phase-state.json'), JSON.stringify({ phase: 'review', spec_slug: 'feat-x' }))
    const out = await phaseReviewCompleteHandler(
      { project_root: projectRoot, spec_ref: 'feat-x', dev_approval: approval('review_complete:spec_ref=feat-x') },
      { promptFn: p.fn },
    )
    return { out, gate: p.seen.find((o) => o.title === 'RSCT — review complete') }
  }

  beforeEach(() => {
    initSweepRepo(root)
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  })

  it('lists the ids among the framework lines and the titles in the agent part, returns and audits them', async () => {
    corpus()
    commitAll(root, 'decisions')
    git(root, 'checkout', '-q', '-b', 'feat/x')
    write('src/money/a.ts', 'export const a = 1\n')
    write('src/ledger/l.ts', 'export const l = 1\n')
    const { out, gate } = await review()
    expect(out.status).toBe('completed')
    const line = 'Decisions whose "Applies to" line covers the changed files (2): premise #1, AD-001'
    const message = gate!.message
    const footer = message.search(/\n(?:Repository|Folder): /)
    expect(message.indexOf(line)).toBeGreaterThan(-1)
    expect(message.indexOf(line)).toBeLessThan(footer)
    expect(message.indexOf('premise #1 — Money amounts are integer cents')).toBeGreaterThan(footer)
    expect(message.indexOf('AD-001 — Float money in the ledger')).toBeGreaterThan(footer)
    expect(out.decisions_covering).toEqual({ ids: ['premise #1', 'AD-001'], added_since_head: [], report: null })
    const complete = auditEvents().find((e) => e.event === 'review.complete')
    expect(complete).toMatchObject({ decisions_covering: ['premise #1', 'AD-001'], decisions_added_since_head: [] })
  })

  it('marks ids added since HEAD and still lists one whose line left the working tree', async () => {
    corpus(decisionsMd(), null)
    commitAll(root, 'decisions')
    corpus(decisionsMd({ premiseLine: '', extra: '### ADR-003 — Jobs log every retry\n**Applies to**: src/jobs/**\nEvery retry is logged.\n' }), null)
    write('src/money/a.ts', 'export const a = 1\n')
    write('src/jobs/run.ts', 'export const r = 1\n')
    const { out, gate } = await review()
    expect(out.decisions_covering?.ids).toEqual(['ADR-002', 'ADR-003', 'premise #1'])
    expect(out.decisions_covering?.added_since_head).toEqual(['ADR-003'])
    expect(gate!.message).toContain('(3): ADR-002, ADR-003 (added since HEAD), premise #1')
  })

  it('the trust path shows no dialog and still returns and audits the ids', async () => {
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] } }))
    corpus()
    commitAll(root, 'decisions')
    write('src/http/client.ts', 'export const c = 1\n')
    const { out } = await review(root, prompts('no-channel'))
    expect(out.status).toBe('completed')
    expect(out.channel).toBe('trust')
    expect(out.decisions_covering?.ids).toEqual(['ADR-002'])
    expect(auditEvents().find((e) => e.event === 'review.complete')?.decisions_covering).toEqual(['ADR-002'])
  })

  it('more than ten: the count, the first ten ids and a report with all of them', async () => {
    const adrs = Array.from({ length: 12 }, (_, i) => `### ADR-${100 + i} — Rule ${i}\n**Applies to**: src/many/**\nText ${i}.\n`).join('\n')
    corpus(decisionsMd({ extra: adrs }), null)
    commitAll(root, 'decisions')
    write('src/many/a.ts', 'export const a = 1\n')
    const { out, gate } = await review()
    expect(out.decisions_covering?.ids).toHaveLength(12)
    const report = out.decisions_covering?.report
    expect(report).toMatch(/^\.rsct\/reports\/review-decisions-[0-9a-f]{16}\.md$/)
    expect(gate!.message).toContain('Decisions whose "Applies to" line covers the changed files (12): ADR-100, ADR-101')
    expect(gate!.message).toContain(`… and 2 more — full list: ${report}`)
    expect(gate!.message).not.toContain('ADR-110')
    expect(readFileSync(join(root, report!), 'utf8')).toContain('ADR-111 — Rule 11 — src/many/a.ts matches src/many/**')
  })

  it('a project in a subfolder matches repo-relative paths with its prefix stripped, never a sibling app', async () => {
    const web = join(root, 'apps', 'web')
    write('apps/web/.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'web', org: 'o' } }))
    write('apps/web/documentation/decisions.md', decisionsMd())
    commitAll(root, 'web app')
    write('apps/api/src/money/b.ts', 'export const b = 1\n')
    const sibling = await review(web)
    expect(sibling.out.decisions_covering).toEqual({ ids: [], added_since_head: [], report: null })
    write('apps/web/src/money/a.ts', 'export const a = 1\n')
    const own = await review(web)
    expect(own.out.decisions_covering?.ids).toEqual(['premise #1'])
  })

  it('no bound decision: no line, no output', async () => {
    corpus(decisionsMd({ premiseLine: '', adrLine: '' }), null)
    commitAll(root, 'decisions')
    write('src/money/a.ts', 'export const a = 1\n')
    const { out, gate } = await review()
    expect(out.decisions_covering).toBeNull()
    expect(gate!.message).not.toContain('Applies to')
  })
})

describe('rsct_get_decisions — globs that match no file (6.4)', () => {
  it('returns the globs on the entry and a hint for the ones that match nothing', async () => {
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    corpus(decisionsMd({ adrLine: '**Applies to**: src/http/client.ts, src/moved/**' }), null)
    write('src/money/a.ts', 'x\n')
    write('src/http/client.ts', 'x\n')
    const out = await getDecisionsHandler({ project_root: root })
    expect(out.decisions.find((d) => d.id === 'ADR-002')?.applies_to?.globs).toEqual(['src/http/client.ts', 'src/moved/**'])
    const hint = out.hints.find((h) => h.startsWith('"Applies to" lines that bind nothing'))
    expect(hint).toContain('(1): ADR-002: src/moved/** matches no file')
  })
})

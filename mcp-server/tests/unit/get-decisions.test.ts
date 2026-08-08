import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  getDecisionsHandler,
  type GetDecisionsOutput,
} from '../../src/tools/get-decisions.js'
import { extractDecisions } from '../../src/lib/decisions.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('rsct_get_decisions', () => {
  it('returns all decisions (premises + adrs) when no filter is provided', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
    })) as GetDecisionsOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.decisions_file.exists).toBe(true)
    expect(out.total).toBeGreaterThanOrEqual(7)
    expect(out.filtered_count).toBe(out.total)
    expect(out.decisions.some((d) => d.kind === 'premise' && d.id === '#1')).toBe(true)
    expect(out.decisions.some((d) => d.kind === 'adr' && d.id === 'ADR-001')).toBe(true)
  })

  it('filters by kind=premise', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { kind: 'premise' },
    })) as GetDecisionsOutput

    expect(out.decisions.every((d) => d.kind === 'premise')).toBe(true)
    expect(out.filtered_count).toBeGreaterThanOrEqual(3)
  })

  it('filters by kind=adr', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { kind: 'adr' },
    })) as GetDecisionsOutput

    expect(out.decisions.every((d) => d.kind === 'adr')).toBe(true)
    expect(out.filtered_count).toBeGreaterThanOrEqual(4)
  })

  it('filters by status=superseded', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { status: 'superseded' },
    })) as GetDecisionsOutput

    expect(out.filtered_count).toBe(1)
    expect(out.decisions[0]?.id).toBe('ADR-004')
    expect(out.decisions[0]?.status).toBe('superseded')
  })

  it('filters by tag', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { tag: 'webhooks' },
    })) as GetDecisionsOutput

    expect(out.filtered_count).toBe(1)
    expect(out.decisions[0]?.id).toBe('#3')
    expect(out.decisions[0]?.tags).toContain('webhooks')
  })

  it('returns empty list + hint when filter matches nothing', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { tag: 'nonexistent-tag-xyz' },
    })) as GetDecisionsOutput

    expect(out.filtered_count).toBe(0)
    expect(out.decisions).toEqual([])
    expect(out.hints.some((h) => h.includes('zero decisions'))).toBe(true)
  })

  it('degrades gracefully when decisions.md is missing', async () => {
    const out = (await getDecisionsHandler({
      project_root: NO_RSCT,
    })) as GetDecisionsOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.decisions_file.exists).toBe(false)
    expect(out.total).toBe(0)
    expect(out.decisions).toEqual([])
    expect(out.hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('keeps **Status** and **Tags** lines out of the excerpt', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { kind: 'adr', status: 'superseded' },
    })) as GetDecisionsOutput

    const adr004 = out.decisions[0]
    expect(adr004).toBeDefined()
    expect(adr004?.excerpt).not.toMatch(/\*\*Status\*\*/)
    expect(adr004?.excerpt).not.toMatch(/\*\*Tags\*\*/)
  })

  it('combines filters with AND semantics', async () => {
    const out = (await getDecisionsHandler({
      project_root: SAMPLE_RSCT,
      filter: { kind: 'premise', tag: 'webhooks' },
    })) as GetDecisionsOutput

    expect(out.filtered_count).toBe(1)
    expect(out.decisions[0]?.kind).toBe('premise')
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      getDecisionsHandler({ project_root: SAMPLE_RSCT, unknown_key: 'x' }),
    ).rejects.toThrow()
  })

  it('rejects invalid filter values', async () => {
    await expect(
      getDecisionsHandler({
        project_root: SAMPLE_RSCT,
        filter: { kind: 'not-a-kind' },
      }),
    ).rejects.toThrow()
  })
})

describe('lib/decisions extractDecisions — EOF regression guard', () => {
  // These tests pin the line-scan parser against the historical `\z` bug
  // (the original regex used a JS anchor that does not exist; it only
  // worked because every fixture entry happened to terminate with `---`
  // or another `###`). An entry that is genuinely the last thing in the
  // file with no terminator must still be captured.

  it('captures a premise that runs to EOF with no `---` terminator', () => {
    const body = [
      '# Decisions',
      '',
      '## Firm premises',
      '',
      '### #1 — Append-only ledger',
      'Financial events are immutable once committed.',
      '',
      '### #42 — Last premise with no terminator',
      'This entry has nothing after it — no `---`, no other heading, just EOF.',
    ].join('\n')

    const { premises } = extractDecisions(body)
    const last = premises.find((p) => p.id === '#42')
    expect(last).toBeDefined()
    expect(last?.title).toBe('Last premise with no terminator')
    expect(last?.excerpt).toContain('nothing after it')
  })

  it('captures an ADR that runs to EOF', () => {
    const body = [
      '# Decisions',
      '',
      '## ADRs',
      '',
      '### ADR-099 — Final ADR with no trailing separator',
      '**Status**: active',
      '**Context**: this is the last line of the file.',
    ].join('\n')

    const { adrs } = extractDecisions(body)
    expect(adrs.length).toBe(1)
    expect(adrs[0]?.id).toBe('ADR-099')
    expect(adrs[0]?.status).toBe('active')
    expect(adrs[0]?.excerpt).toContain('last line of the file')
    expect(adrs[0]?.excerpt).not.toMatch(/\*\*Status\*\*/)
  })
})

describe('lib/decisions extractDecisions — heading tolerance (#49)', () => {
  // A hand-written decisions.md rarely matches §H byte for byte. Every shape below
  // used to yield zero entries, returned as a clean `adrs_count: 0`.

  it('parses ADRs and premises written at `##` level', () => {
    const body = [
      '# Decisions',
      '',
      '## Firm premises (non-negotiable)',
      '',
      '## #1 — Tenants never share a schema',
      'Hard multi-tenancy boundary.',
      '',
      '## Durable architectural decisions (ADRs)',
      '',
      '## ADR-001 — Postgres over Mongo',
      '**Status**: active',
      'Relational integrity outweighed schema flexibility.',
    ].join('\n')

    const { premises, adrs } = extractDecisions(body)
    expect(premises.map((p) => p.id)).toEqual(['#1'])
    expect(adrs.map((a) => a.id)).toEqual(['ADR-001'])
    expect(adrs[0]?.title).toBe('Postgres over Mongo')
    expect(adrs[0]?.status).toBe('active')
  })

  it('does not turn the container headings into entries', () => {
    // These now sit at the same level as the entries themselves — none may parse.
    const body = [
      '## Firm premises (non-negotiable)',
      '## Durable architectural decisions (ADRs)',
      '## ADRs',
      '## Out of scope',
    ].join('\n')

    const { premises, adrs } = extractDecisions(body)
    expect(premises).toEqual([])
    expect(adrs).toEqual([])
  })

  it('accepts colon and en dash alongside the em dash and the hyphen', () => {
    const body = [
      '### ADR-001: Colon, no leading space',
      'body one.',
      '',
      '### ADR-002 – En dash U+2013',
      'body two.',
      '',
      '### ADR-003 - ASCII hyphen',
      'body three.',
      '',
      '### ADR-004 — Em dash U+2014',
      'body four.',
    ].join('\n')

    const { adrs } = extractDecisions(body)
    expect(adrs.map((a) => a.id)).toEqual(['ADR-001', 'ADR-002', 'ADR-003', 'ADR-004'])
    expect(adrs[0]?.title).toBe('Colon, no leading space')
    expect(adrs[1]?.title).toBe('En dash U+2013')
  })

  it('a `##` section heading still closes the entry before it', () => {
    // The terminator stays `^##\s` on purpose. Accepting `##` entries by relaxing it
    // would let a trailing section be swallowed into the previous ADR's body in any
    // file written without `---` separators — silently, and masked by excerpt
    // truncation. Both heading branches `continue`, so an entry never self-terminates.
    const body = [
      '### ADR-007 — Last real decision',
      'The decision body.',
      '',
      '## Out of scope',
      '- Multi-currency at launch.',
    ].join('\n')

    const { adrs } = extractDecisions(body)
    expect(adrs.length).toBe(1)
    expect(adrs[0]?.excerpt).not.toContain('Out of scope')
    expect(adrs[0]?.excerpt).not.toContain('Multi-currency')
  })
})

describe('rsct_get_decisions — silent-zero reporting (#49)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsct-decisions-'))
    mkdirSync(join(dir, 'documentation'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports a file that mentions decision ids but parses to zero entries', async () => {
    // H4 heading AND a double-hyphen separator — unparseable twice over, which is
    // the point: the tool must not answer "no decisions" for a file that plainly
    // holds some.
    writeFileSync(
      join(dir, 'documentation', 'decisions.md'),
      '# Decisions\n\n#### ADR-001 -- wrong level, wrong separator\nReal content lives here.\n',
      'utf8',
    )

    const out = (await getDecisionsHandler({ project_root: dir })) as GetDecisionsOutput
    expect(out.total).toBe(0)
    expect(out.hints.some((h) => h.includes('mentions decision ids'))).toBe(true)
  })

  it('stays silent when the file is genuinely empty', async () => {
    writeFileSync(join(dir, 'documentation', 'decisions.md'), '\n   \n', 'utf8')

    const out = (await getDecisionsHandler({ project_root: dir })) as GetDecisionsOutput
    expect(out.total).toBe(0)
    expect(out.hints.some((h) => h.includes('mentions decision ids'))).toBe(false)
  })

  it('stays silent for a scaffold that has prose but no decision ids', async () => {
    // A decisions.md stripped back to its section headings genuinely has none.
    // Warning here on every bootstrap would train the reader to ignore the warning.
    writeFileSync(
      join(dir, 'documentation', 'decisions.md'),
      '# Architectural decisions\n\n## Firm premises\n\n## ADRs\n\n## Out of scope\n',
      'utf8',
    )

    const out = (await getDecisionsHandler({ project_root: dir })) as GetDecisionsOutput
    expect(out.total).toBe(0)
    expect(out.hints.some((h) => h.includes('mentions decision ids'))).toBe(false)
  })

  it('reports a decisions.md that exists but cannot be read', async () => {
    // A directory at the path: existsSync passes, readFileSync throws EISDIR. Zero
    // entries proves nothing here, so a clean zero would be the same silent failure
    // this whole change exists to remove.
    mkdirSync(join(dir, 'documentation', 'decisions.md'), { recursive: true })

    const out = (await getDecisionsHandler({ project_root: dir })) as GetDecisionsOutput
    expect(out.decisions_file.exists).toBe(true)
    expect(out.total).toBe(0)
    expect(out.hints.some((h) => h.includes('could not be read'))).toBe(true)
  })
})

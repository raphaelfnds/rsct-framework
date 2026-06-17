import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
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

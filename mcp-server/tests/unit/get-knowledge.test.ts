import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  getKnowledgeHandler,
  type GetKnowledgeOutput,
} from '../../src/tools/get-knowledge.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('rsct_get_knowledge', () => {
  it('returns all sections for an existing canonical category', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'business-rules',
    })) as GetKnowledgeOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.category).toBe('business-rules')
    expect(out.is_canonical_category).toBe(true)
    expect(out.file.exists).toBe(true)
    expect(out.sections_total).toBeGreaterThanOrEqual(6)
    expect(out.sections_returned).toBe(out.sections_total)
    expect(out.query).toBeNull()
    expect(out.sections.some((s) => s.heading.includes('BR-001'))).toBe(true)
  })

  it('filters sections by case-insensitive query', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'business-rules',
      query: 'stripe',
    })) as GetKnowledgeOutput

    expect(out.query).toBe('stripe')
    expect(out.sections_returned).toBe(1)
    expect(out.sections[0]?.heading).toContain('BR-004')
  })

  it('query matches against heading too', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'business-rules',
      query: 'payments',
    })) as GetKnowledgeOutput

    expect(out.sections_returned).toBeGreaterThanOrEqual(1)
    expect(out.sections.some((s) => s.heading.toLowerCase().includes('payments'))).toBe(
      true,
    )
  })

  it('returns empty + hint when query matches nothing', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'business-rules',
      query: 'zzz-nonexistent-xyzzz',
    })) as GetKnowledgeOutput

    expect(out.sections_returned).toBe(0)
    expect(out.sections).toEqual([])
    expect(out.hints.some((h) => h.includes('did not match'))).toBe(true)
  })

  it('reads a different canonical category', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'anti-decisions',
    })) as GetKnowledgeOutput

    expect(out.file.exists).toBe(true)
    expect(out.sections.some((s) => s.heading.startsWith('AD-001'))).toBe(true)
    expect(out.sections.some((s) => s.heading.startsWith('AD-002'))).toBe(true)
  })

  it('exposes section levels (## vs ###)', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'business-rules',
    })) as GetKnowledgeOutput

    const levels = new Set(out.sections.map((s) => s.level))
    expect(levels.has(2)).toBe(true)
    expect(levels.has(3)).toBe(true)
  })

  it('warns when a canonical category file is missing', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'incident-log',
    })) as GetKnowledgeOutput

    expect(out.is_canonical_category).toBe(true)
    expect(out.file.exists).toBe(false)
    expect(out.sections_total).toBe(0)
    expect(out.hints.some((h) => h.includes('does not exist yet'))).toBe(true)
    expect(out.available_categories).toContain('business-rules')
  })

  it('warns when a non-canonical category is requested and missing', async () => {
    const out = (await getKnowledgeHandler({
      project_root: SAMPLE_RSCT,
      category: 'invented-category',
    })) as GetKnowledgeOutput

    expect(out.is_canonical_category).toBe(false)
    expect(out.file.exists).toBe(false)
    expect(out.hints.some((h) => h.includes('not canonical'))).toBe(true)
  })

  it('degrades gracefully outside an rsct project', async () => {
    const out = (await getKnowledgeHandler({
      project_root: NO_RSCT,
      category: 'business-rules',
    })) as GetKnowledgeOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.file.exists).toBe(false)
    expect(out.hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('rejects missing category', async () => {
    await expect(getKnowledgeHandler({ project_root: SAMPLE_RSCT })).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      getKnowledgeHandler({
        project_root: SAMPLE_RSCT,
        category: 'business-rules',
        unknown_key: 'x',
      }),
    ).rejects.toThrow()
  })

  it('rejects empty query', async () => {
    await expect(
      getKnowledgeHandler({
        project_root: SAMPLE_RSCT,
        category: 'business-rules',
        query: '',
      }),
    ).rejects.toThrow()
  })
})

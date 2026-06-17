import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  getArchitectureHandler,
  type GetArchitectureOutput,
} from '../../src/tools/get-architecture.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('rsct_get_architecture — scope=overview (default)', () => {
  it('defaults to scope=overview and parses architecture.md sections', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
    })) as GetArchitectureOutput

    expect(out.scope).toBe('overview')
    expect(out.overview).toBeDefined()
    expect(out.overview?.exists).toBe(true)
    expect(out.overview?.sections.some((s) => s.heading === 'Stack')).toBe(true)
    expect(out.overview?.sections.some((s) => s.heading === 'Runtime flow')).toBe(true)
    expect(out.modules).toBeUndefined()
    expect(out.impacts).toBeUndefined()
  })

  it('hints when architecture.md is missing', async () => {
    const out = (await getArchitectureHandler({
      project_root: NO_RSCT,
      scope: 'overview',
    })) as GetArchitectureOutput

    expect(out.overview?.exists).toBe(false)
    expect(out.hints.some((h) => h.includes('architecture.md not found'))).toBe(true)
  })
})

describe('rsct_get_architecture — scope=module', () => {
  it('returns all modules sorted by name', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'module',
    })) as GetArchitectureOutput

    expect(out.modules?.directory_exists).toBe(true)
    expect(out.modules?.files.map((f) => f.name)).toEqual(['orders', 'payments'])
    expect(out.modules?.filtered_by_name).toBe(false)
    expect(out.overview).toBeUndefined()
  })

  it('narrows to one module via module_name', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'module',
      module_name: 'orders',
    })) as GetArchitectureOutput

    expect(out.modules?.filtered_by_name).toBe(true)
    expect(out.modules?.files.length).toBe(1)
    expect(out.modules?.files[0]?.name).toBe('orders')
    expect(out.modules?.files[0]?.sections.some((s) => s.heading === 'Purpose')).toBe(
      true,
    )
  })

  it('hints when filtered module is not found', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'module',
      module_name: 'nonexistent',
    })) as GetArchitectureOutput

    expect(out.modules?.files.length).toBe(0)
    expect(out.hints.some((h) => h.includes('No documentation/modules/nonexistent.md'))).toBe(
      true,
    )
  })
})

describe('rsct_get_architecture — scope=impact', () => {
  it('returns impact files', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'impact',
    })) as GetArchitectureOutput

    expect(out.impacts?.directory_exists).toBe(true)
    expect(out.impacts?.files.some((f) => f.name === 'orders')).toBe(true)
  })

  it('narrows impact by module_name', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'impact',
      module_name: 'orders',
    })) as GetArchitectureOutput

    expect(out.impacts?.files.length).toBe(1)
    expect(
      out.impacts?.files[0]?.sections.some((s) => s.heading === 'Non-obvious couplings'),
    ).toBe(true)
  })
})

describe('rsct_get_architecture — scope=all', () => {
  it('returns overview + modules + impacts together', async () => {
    const out = (await getArchitectureHandler({
      project_root: SAMPLE_RSCT,
      scope: 'all',
    })) as GetArchitectureOutput

    expect(out.overview).toBeDefined()
    expect(out.modules).toBeDefined()
    expect(out.impacts).toBeDefined()
  })
})

describe('rsct_get_architecture — input validation', () => {
  it('rejects invalid scope', async () => {
    await expect(
      getArchitectureHandler({ project_root: SAMPLE_RSCT, scope: 'bogus' }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      getArchitectureHandler({ project_root: SAMPLE_RSCT, extra: 1 }),
    ).rejects.toThrow()
  })

  it('rejects empty module_name', async () => {
    await expect(
      getArchitectureHandler({
        project_root: SAMPLE_RSCT,
        scope: 'module',
        module_name: '',
      }),
    ).rejects.toThrow()
  })
})

describe('rsct_get_architecture — outside an rsct project', () => {
  it('surfaces rsct-setup hint at top of hints', async () => {
    const out = (await getArchitectureHandler({
      project_root: NO_RSCT,
      scope: 'all',
    })) as GetArchitectureOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.hints[0]).toContain('Project is not rsct-managed')
  })
})

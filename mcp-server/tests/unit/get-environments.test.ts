import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  getEnvironmentsHandler,
  type GetEnvironmentsOutput,
} from '../../src/tools/get-environments.js'
import { maskIfSecret } from '../../src/lib/secrets.js'
import { parseProperties, parseDotEnv } from '../../src/lib/env-files.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('lib/secrets — maskIfSecret', () => {
  it('masks values when the key suggests a credential', () => {
    expect(maskIfSecret('JWT_SECRET', 'anything').masked).toBe(true)
    expect(maskIfSecret('API_KEY', 'short').masked).toBe(true)
    expect(maskIfSecret('user.password', 'changeme').masked).toBe(true)
  })

  it('masks values that match secret value shapes regardless of key', () => {
    expect(maskIfSecret('innocent.field', 'AKIA0123456789ABCDEF').masked).toBe(true)
    expect(maskIfSecret('innocent.field', 'sk-' + 'a'.repeat(25)).masked).toBe(true)
  })

  it('does not mask innocent values', () => {
    expect(maskIfSecret('server.port', '8080').masked).toBe(false)
    expect(maskIfSecret('feature.flag.foo', 'true').masked).toBe(false)
  })

  it('skips masking for empty values', () => {
    expect(maskIfSecret('JWT_SECRET', '').masked).toBe(false)
  })

  it('reports the reason for masking', () => {
    expect(maskIfSecret('PASSWORD', 'x').reason).toBe('key-name')
    expect(maskIfSecret('blob', 'AKIA0123456789ABCDEF').reason).toBe('value-shape')
  })
})

describe('lib/env-files — parsers', () => {
  it('parses .properties with comments and skips blanks', () => {
    const entries = parseProperties(['# header', '', 'a=1', 'b : two', '! also comment', 'c='].join('\n'))
    expect(entries.map((e) => e.key)).toEqual(['a', 'b', 'c'])
    expect(entries.find((e) => e.key === 'b')?.value).toBe('two')
  })

  it('parses .env with export prefix and quoted values', () => {
    const entries = parseDotEnv(['export A=1', 'B="hello world"', "C='quoted'", '# skipped'].join('\n'))
    expect(entries.map((e) => e.key)).toEqual(['A', 'B', 'C'])
    expect(entries.find((e) => e.key === 'B')?.value).toBe('hello world')
  })
})

describe('rsct_get_environments — scope=profiles', () => {
  it('discovers properties + env files and reports detected profiles', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    expect(out.scope).toBe('profiles')
    expect(out.profiles).toBeDefined()
    expect(out.profiles?.detected_profiles).toEqual(['dev', 'prod'])
    expect(out.profiles?.files.some((f) => f.format === 'properties' && f.profile === null)).toBe(
      true,
    )
    expect(out.profiles?.files.some((f) => f.format === 'env')).toBe(true)
  })

  it('masks values matching INV-6 key patterns', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    const allEntries = (out.profiles?.files ?? []).flatMap((f) => f.entries)
    const password = allEntries.find((e) => e.key === 'spring.datasource.password')
    expect(password?.masked).toBe(true)
    expect(password?.value).toBe('***MASKED***')

    const stripe = allEntries.find((e) => e.key === 'stripe.api.key')
    expect(stripe?.masked).toBe(true)

    const jwt = allEntries.find((e) => e.key === 'JWT_SECRET')
    expect(jwt?.masked).toBe(true)
  })

  it('masks values matching INV-6 value-shape patterns', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    const allEntries = (out.profiles?.files ?? []).flatMap((f) => f.entries)
    const awsKey = allEntries.find((e) => e.key === 'aws.access.key.id')
    expect(awsKey?.masked).toBe(true)
    expect(awsKey?.mask_reason).toBe('value-shape')
  })

  it('computes profile deltas with added + modified', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    const prodDelta = out.profiles?.profile_deltas.find((d) => d.profile === 'prod')
    expect(prodDelta).toBeDefined()
    expect(prodDelta?.added.some((e) => e.key === 'stripe.api.key')).toBe(true)
    expect(prodDelta?.modified.some((m) => m.key === 'server.port')).toBe(true)
    expect(prodDelta?.modified.some((m) => m.key === 'spring.datasource.url')).toBe(true)

    const devDelta = out.profiles?.profile_deltas.find((d) => d.profile === 'dev')
    expect(devDelta?.added.some((e) => e.key === 'dev.hot-reload')).toBe(true)
    expect(devDelta?.modified.some((m) => m.key === 'logging.level.root')).toBe(true)
  })

  it('emits a YAML-detected hint without parsing them', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    expect(out.profiles?.yaml_files_detected_but_not_parsed.length).toBeGreaterThan(0)
    expect(out.hints.some((h) => h.includes('YAML config files detected'))).toBe(true)
  })

  it('emits a masking summary hint when secrets are masked', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'profiles',
    })) as GetEnvironmentsOutput

    expect(out.hints.some((h) => h.includes('masked under INV-6'))).toBe(true)
  })
})

describe('rsct_get_environments — scope=infrastructure', () => {
  it('parses INFRA-NNN entries with structured fields', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'infrastructure',
    })) as GetEnvironmentsOutput

    expect(out.scope).toBe('infrastructure')
    expect(out.infrastructure?.file.exists).toBe(true)
    expect(out.infrastructure?.entries.length).toBe(2)

    const db = out.infrastructure?.entries.find((e) => e.id === 'INFRA-001')
    expect(db?.name).toBe('Primary database')
    expect(db?.fields['Type']).toBe('database')
    expect(db?.fields['Provider + region']).toContain('AWS RDS')
    expect(db?.fields['Operational facts designers need']).toContain('max_connections')
  })

  it('omits profiles section when scope=infrastructure only', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'infrastructure',
    })) as GetEnvironmentsOutput

    expect(out.profiles).toBeUndefined()
    expect(out.infrastructure).toBeDefined()
  })

  it('hints when infrastructure.md is missing', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: NO_RSCT,
      scope: 'infrastructure',
    })) as GetEnvironmentsOutput

    expect(out.infrastructure?.file.exists).toBe(false)
    expect(out.hints.some((h) => h.includes('infrastructure.md does not exist'))).toBe(true)
  })
})

describe('rsct_get_environments — scope=all', () => {
  it('returns both sections', async () => {
    const out = (await getEnvironmentsHandler({
      project_root: SAMPLE_RSCT,
      scope: 'all',
    })) as GetEnvironmentsOutput

    expect(out.profiles).toBeDefined()
    expect(out.infrastructure).toBeDefined()
  })
})

describe('rsct_get_environments — input validation', () => {
  it('rejects missing scope', async () => {
    await expect(getEnvironmentsHandler({ project_root: SAMPLE_RSCT })).rejects.toThrow()
  })

  it('rejects invalid scope', async () => {
    await expect(
      getEnvironmentsHandler({ project_root: SAMPLE_RSCT, scope: 'bogus' }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      getEnvironmentsHandler({ project_root: SAMPLE_RSCT, scope: 'all', extra: 1 }),
    ).rejects.toThrow()
  })
})

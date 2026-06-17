import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  checkSecretsHandler,
  type CheckSecretsOutput,
} from '../../src/tools/check-secrets.js'
import { scanDiffForSecrets, MASK_PLACEHOLDER } from '../../src/lib/secrets.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

function diffWithLines(file: string, addedLines: string[], startLine = 10): string {
  const plus = addedLines.map((l) => `+${l}`).join('\n')
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine} +${startLine},${addedLines.length} @@`,
    plus,
  ].join('\n')
}

// Test values are deliberately formed to match patterns but are not real
// credentials: AKIAIOSFODNN7EXAMPLE is AWS's documented public example;
// the sk- value uses obvious filler characters.
const FAKE_OPENAI_KEY = 'sk-AAAAAAAAAAAAAAAAAAAAAAAA'
const FAKE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'

describe('lib/secrets — scanDiffForSecrets value-shape', () => {
  it('finds an OpenAI-style key embedded in an added line', () => {
    const diff = diffWithLines('config/app.env', [`API_KEY=${FAKE_OPENAI_KEY}`])
    const findings = scanDiffForSecrets(diff)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0]?.reason).toBe('value-shape')
    expect(findings[0]?.file).toBe('config/app.env')
    expect(findings[0]?.excerpt).toContain(MASK_PLACEHOLDER)
    expect(findings[0]?.excerpt).not.toContain(FAKE_OPENAI_KEY)
  })

  it('finds an AWS access key in an added line', () => {
    const diff = diffWithLines('deploy/secrets.yml', [`aws_access_key: ${FAKE_AWS_KEY}`])
    const findings = scanDiffForSecrets(diff)
    expect(findings.some((f) => f.reason === 'value-shape')).toBe(true)
    const f = findings.find((x) => x.reason === 'value-shape')
    expect(f?.excerpt).not.toContain(FAKE_AWS_KEY)
  })

  it('finds a PEM private-key BEGIN line', () => {
    const diff = diffWithLines('certs/server.key', ['-----BEGIN RSA PRIVATE KEY-----'])
    const findings = scanDiffForSecrets(diff)
    expect(findings.some((f) => f.reason === 'value-shape')).toBe(true)
    expect(findings[0]?.excerpt).toContain(MASK_PLACEHOLDER)
  })
})

describe('lib/secrets — scanDiffForSecrets key-name', () => {
  it('flags a key/value pair where the key matches the secret-name pattern', () => {
    const diff = diffWithLines('src/auth.ts', [`const jwtSecret = "opaque-but-named"`])
    const findings = scanDiffForSecrets(diff)
    expect(findings.some((f) => f.reason === 'key-name')).toBe(true)
    expect(findings[0]?.excerpt).toContain(MASK_PLACEHOLDER)
    expect(findings[0]?.excerpt).not.toContain('opaque-but-named')
  })

  it('does not flag innocuous variable names', () => {
    const diff = diffWithLines('src/util.ts', ['const userName = "alice"'])
    const findings = scanDiffForSecrets(diff)
    expect(findings).toEqual([])
  })
})

describe('lib/secrets — scanDiffForSecrets extras', () => {
  it('reports an extra-pattern match with pattern_id and masked excerpt', () => {
    const diff = diffWithLines('config/internal.txt', [
      'reading from token corp-internal-XYZ12345 today',
    ])
    const findings = scanDiffForSecrets(diff, [
      { id: 'corp-internal', pattern: /corp-internal-[A-Z0-9]+/ },
    ])
    expect(findings.length).toBe(1)
    expect(findings[0]?.reason).toBe('extra-pattern')
    expect(findings[0]?.pattern_id).toBe('corp-internal')
    expect(findings[0]?.excerpt).toContain(MASK_PLACEHOLDER)
    expect(findings[0]?.excerpt).not.toContain('corp-internal-XYZ12345')
  })

  it('returns empty findings for a clean diff', () => {
    const diff = diffWithLines('src/util.ts', [
      'export function add(a: number, b: number) {',
      '  return a + b',
      '}',
    ])
    expect(scanDiffForSecrets(diff)).toEqual([])
  })
})

describe('lib/secrets — diff parsing', () => {
  it('tracks line numbers across hunk headers', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1,2 @@',
      '+first',
      `+API_KEY=${FAKE_OPENAI_KEY}`,
      '@@ -10 +10,1 @@',
      `+pem header next: -----BEGIN PRIVATE KEY-----`,
    ].join('\n')
    const findings = scanDiffForSecrets(diff)
    expect(findings.length).toBeGreaterThanOrEqual(2)
    const valueShape = findings.find((f) => f.reason === 'value-shape' && f.line_number === 2)
    expect(valueShape).toBeDefined()
    const pem = findings.find((f) => f.line_number === 10)
    expect(pem).toBeDefined()
  })

  it('ignores deleted lines (starting with -)', () => {
    // Deleted line contains a secret; added line is innocuous (no key/value
    // pair, no secret shape). If the deleted line were scanned, it would
    // produce a value-shape finding — assert that it does not.
    const diff = [
      'diff --git a/x.env b/x.env',
      '--- a/x.env',
      '+++ b/x.env',
      '@@ -1 +1 @@',
      `-API_KEY=${FAKE_OPENAI_KEY}`,
      `+# rotated 2026-06-03, value moved to secret manager`,
    ].join('\n')
    const findings = scanDiffForSecrets(diff)
    expect(findings).toEqual([])
  })
})

describe('rsct_check_secrets — tool integration', () => {
  it('honors diff_override and returns findings via the handler', async () => {
    const diff = diffWithLines('app/.env', [`API_KEY=${FAKE_OPENAI_KEY}`])
    const out = (await checkSecretsHandler({
      project_root: SAMPLE_RSCT,
      diff_override: diff,
    })) as CheckSecretsOutput

    expect(out.findings.length).toBeGreaterThanOrEqual(1)
    expect(out.findings[0]?.reason).toBe('value-shape')
    expect(out.hints.some((h) => h.includes('secret finding'))).toBe(true)
  })

  it('reports clean output and a "no patterns matched" hint for a clean diff', async () => {
    const diff = diffWithLines('app/clean.ts', ['const greeting = "hello"'])
    const out = (await checkSecretsHandler({
      project_root: SAMPLE_RSCT,
      diff_override: diff,
    })) as CheckSecretsOutput

    expect(out.findings).toEqual([])
    expect(out.hints.some((h) => h.toLowerCase().includes('no secret patterns'))).toBe(true)
  })

  it('returns scan with default patterns + no rsct hint when outside an rsct project', async () => {
    const diff = diffWithLines('a.env', [`token=${FAKE_OPENAI_KEY}`])
    const out = (await checkSecretsHandler({
      project_root: NO_RSCT,
      diff_override: diff,
    })) as CheckSecretsOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.findings.length).toBeGreaterThanOrEqual(1)
    expect(out.hints.some((h) => h.includes('No .rsct.json'))).toBe(true)
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      checkSecretsHandler({ project_root: SAMPLE_RSCT, bogus: true }),
    ).rejects.toThrow()
  })
})

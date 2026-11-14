import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isUntouchedTemplate } from '../../src/lib/generated-marker.js'
import { promptCategories, runVerificationChecklist } from '../../src/lib/verification-checklist.js'
import { bashAvailable } from './lib/bash-lint.js'
import { bashBin } from './lib/resolve-bash.js'

const BASH = bashAvailable()
const BODY = '---\nlast_capture: 2026-11-14\n---\n# Business rules — acme\n\n<TODO: capture the first rule>\n'
const NOTE = 'is still the untouched template: nothing has been captured in it yet.'

function generated(body: string): string {
  const sha = createHash('sha256').update(body).digest('hex')
  return `<!-- RSCT-GENERATED v=1.0.0 created=2026-11-14T08:00:00Z sha256-body=${sha} -->\n${body}`
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-untouched-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): string {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

const CASES: Array<[string, string, boolean]> = [
  ['as setup wrote it', generated(BODY), true],
  ['checked out with CRLF', generated(BODY).replace(/\n/g, '\r\n'), true],
  ['edited by the developer', generated(BODY).replace('<TODO: capture the first rule>', 'Refunds need two approvers.'), false],
  ['without its final newline', generated(BODY).replace(/\n$/, ''), false],
  ['without a marker', BODY, false],
]

describe('2.25.0 — an untouched generated file is recognised exactly as /rsct-setup recognises it', () => {
  it.each(CASES)('%s', (_name, content, untouched) => {
    expect(isUntouchedTemplate(writeFile('documentation/knowledge/business-rules.md', content))).toBe(untouched)
  })

  it('makes no claim on a file above 4 MB, and reads the last sha256-body on the line, as sed does', () => {
    const big = generated(`${BODY}${'x'.repeat(4 * 1024 * 1024)}\n`)
    expect(isUntouchedTemplate(writeFile('documentation/knowledge/big.md', big))).toBe(false)
    const sha = createHash('sha256').update(BODY).digest('hex')
    const twice = `<!-- RSCT-GENERATED v=1.0.0 created=x sha256-body=${'0'.repeat(64)} sha256-body=${sha} -->\n${BODY}`
    expect(isUntouchedTemplate(writeFile('documentation/knowledge/twice.md', twice))).toBe(true)
  })

  it.skipIf(!BASH)('agrees with the setup comparison (tail -n +2 | tr -d CR | sha256) on every case', () => {
    for (const [name, content, untouched] of CASES) {
      const file = writeFile('probe.md', content)
      const script = [
        'f="$1"',
        'sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d" " -f1; else shasum -a 256 | cut -d" " -f1; fi; }',
        "MARKER=$(head -n 1 \"$f\" | sed -n 's/.*sha256-body=\\([a-f0-9]\\{64\\}\\).*/\\1/p')",
        "BODY=$(tail -n +2 \"$f\" | tr -d '\\r' | sha)",
        'if [ -n "$MARKER" ] && [ "$MARKER" = "$BODY" ]; then echo untouched; else echo edited; fi',
      ].join('\n')
      const r = spawnSync(bashBin(), ['-c', script, 'probe', file], { encoding: 'utf8' })
      expect(r.status, `${name}: ${r.stderr}`).toBe(0)
      expect(r.stdout.trim(), name).toBe(untouched ? 'untouched' : 'edited')
      expect(isUntouchedTemplate(file), name).toBe(untouched)
    }
  })
})

describe('2.25.0 — forgotten prompts', () => {
  it('are taken in name order, whatever order the directory listing returns', () => {
    expect(
      promptCategories(['workflow-rituals', 'README-notes', 'business-rules', 'cost-constraints', 'anti-decisions'], 3),
    ).toEqual(['anti-decisions', 'business-rules', 'cost-constraints'])
  })

  it('say when a knowledge file or the architecture overview is still the untouched template, in the detail only', () => {
    writeFile('documentation/knowledge/business-rules.md', generated(BODY))
    writeFile('documentation/knowledge/business-glossary.md', generated(BODY).replace('<TODO: capture the first rule>', 'Order: a confirmed cart.'))
    writeFile('documentation/architecture.md', generated('# Architecture — acme\n\n## Overview\n\n<TODO>\n'))
    const result = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: [],
      discoveredImporters: [],
      specTier: 'standard',
    })
    const byTitle = new Map(result.findings.map((f) => [f.title, f]))
    expect(byTitle.get('Checklist: business-rules')?.detail).toContain(`documentation/knowledge/business-rules.md ${NOTE}`)
    expect(byTitle.get('Checklist: business-glossary')?.detail).not.toContain(NOTE)
    expect(byTitle.get('Checklist: architecture overview')?.detail).toContain(`documentation/architecture.md ${NOTE}`)
    for (const f of result.findings) {
      expect(f.title).not.toContain('untouched')
      expect(JSON.stringify(f.evidence)).not.toContain('untouched')
    }
    expect(result.findings.filter((f) => f.category === 'forgotten')).toHaveLength(3)
  })
})

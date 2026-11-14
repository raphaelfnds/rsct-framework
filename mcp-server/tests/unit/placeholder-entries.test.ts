import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { extractDecisions, readDecisions } from '../../src/lib/decisions.js'
import { extractAntiDecisions, readAntiDecisions } from '../../src/lib/anti-decisions.js'
import { corpusMiss } from '../../src/lib/corpus-health.js'

const ROOT = resolve(__dirname, '..', '..', '..')

function shipped(rel: string): string {
  return readFileSync(join(ROOT, 'doc-templates', rel), 'utf8')
    .replace(/\r/g, '')
    .replace(/\[APP_NAME\]/g, 'acme')
    .replace(/\[CREATED_AT\]/g, '2026-11-14')
}

const DECISIONS_TEMPLATE = shipped('decisions.md.template')
const ANTI_TEMPLATE = shipped('knowledge/anti-decisions.md.template')
const ANTI_TEMPLATE_BEFORE_2_25 = ANTI_TEMPLATE.replace('### AD-EXAMPLE — ', '### AD-003 — ')

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-placeholder-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeDoc(rel: string, body: string): void {
  const path = join(tmpRoot, 'documentation', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body, 'utf8')
}

describe('2.25.0 — shipped placeholders and examples are not decisions', () => {
  it('the shipped decisions template yields no premise and no ADR, and reports no unparsed id', () => {
    expect(ANTI_TEMPLATE_BEFORE_2_25).not.toBe(ANTI_TEMPLATE)
    const parsed = extractDecisions(DECISIONS_TEMPLATE)
    expect(parsed.premises).toEqual([])
    expect(parsed.adrs).toEqual([])
    writeDoc('decisions.md', DECISIONS_TEMPLATE)
    const snapshot = readDecisions(tmpRoot)
    expect(snapshot.has_decision_ids).toBe(false)
    expect(corpusMiss({ read_error: false, has_ids: snapshot.has_decision_ids, parsed_count: 0 })).toBeNull()
  })

  it('the anti-decision example shipped before 2.25.0 (AD-003) is skipped, in LF and in CRLF', () => {
    expect(extractAntiDecisions(ANTI_TEMPLATE_BEFORE_2_25)).toEqual([])
    expect(extractAntiDecisions(ANTI_TEMPLATE_BEFORE_2_25.replace(/\n/g, '\r\n'))).toEqual([])
    writeDoc('knowledge/anti-decisions.md', ANTI_TEMPLATE_BEFORE_2_25)
    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.has_entry_ids).toBe(false)
  })

  it('the 2.25.0 template example carries no id the parser or the id counter can read, even edited', () => {
    const edited = ANTI_TEMPLATE.replace('2025-10-15 by alice', '2025-10-16 by alice')
    expect(edited).not.toBe(ANTI_TEMPLATE)
    expect(extractAntiDecisions(edited)).toEqual([])
    writeDoc('knowledge/anti-decisions.md', edited)
    expect(readAntiDecisions(tmpRoot).has_entry_ids).toBe(false)
  })

  it('the numbering line of the templates shipped before 2.7.2 does not count as an unparsed id', () => {
    const v1 = ANTI_TEMPLATE_BEFORE_2_25.replace(
      'Numbering: AD-NNN, sequential, append-only.',
      'Numbering: AD-001, AD-002, ... sequential, append-only.',
    )
    expect(v1).not.toBe(ANTI_TEMPLATE_BEFORE_2_25)
    writeDoc('knowledge/anti-decisions.md', v1.replace(/\n/g, '\r\n'))
    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.has_entry_ids).toBe(false)
  })

  it('an example the developer edited is a real entry again', () => {
    const edited = ANTI_TEMPLATE_BEFORE_2_25.replace('2025-10-15 by alice', '2025-10-16 by alice')
    expect(extractAntiDecisions(edited).map((e) => e.id)).toEqual(['AD-003'])
  })

  it('a real body under a <TODO: title stays an entry', () => {
    const body = [
      '## Durable architectural decisions (ADRs)',
      '',
      '### ADR-007 — <TODO: name>',
      '**Status**: active',
      '**Decision**: never store money as a float',
      '',
      '---',
    ].join('\n')
    expect(extractDecisions(body).adrs.map((e) => e.id)).toEqual(['ADR-007'])
  })

  it('a shipped skeleton copied under another number is skipped, the real entries around it are kept', () => {
    const skeleton = DECISIONS_TEMPLATE.slice(DECISIONS_TEMPLATE.indexOf('### ADR-001'), DECISIONS_TEMPLATE.indexOf('## Out of scope'))
    const body = [
      '### #2 — Every amount is stored in cents',
      'Floats lose cents.',
      '',
      skeleton.replace('### ADR-001', '### ADR-002'),
      '### ADR-003 — Postgres row-level security per tenant',
      '**Decision**: one database, tenant_id on every row',
    ].join('\n')
    const parsed = extractDecisions(body)
    expect(parsed.premises.map((e) => e.id)).toEqual(['#2'])
    expect(parsed.adrs.map((e) => e.id)).toEqual(['ADR-003'])
  })

  it.each([
    ['real text in the <TODO: title', '### ADR-7 — <TODO: never store money as a float>\n**Status**: active\n'],
    ['real text in a placeholder field', '### ADR-8 — <TODO: name>\n**Decision**: <never store money as a float>\n'],
    ['a bare angle-bracket line', '### ADR-9 — <TODO: name>\n<money is stored in cents>\n'],
    ['text after a comment', '### ADR-10 — <TODO: name>\n<!-- note --> never store money as a float\n'],
    ['an unclosed comment', '### ADR-11 — <TODO: name>\n<!-- never store money as a float\n'],
    ['a one-word status', '### ADR-12 — <TODO: name>\n**Status**: never\n'],
  ])('%s stays an entry', (_name, body) => {
    expect(extractDecisions(body).adrs).toHaveLength(1)
  })

  it('a malformed real id next to the shipped example is reported as unparsed, not hidden by the example', () => {
    const body = `${ANTI_TEMPLATE_BEFORE_2_25}\n#### AD-010 — heading level the parser does not read\n- **Tried:** x\n`
    writeDoc('knowledge/anti-decisions.md', body)
    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.entries).toEqual([])
    expect(corpusMiss({ read_error: false, has_ids: snapshot.has_entry_ids, parsed_count: snapshot.entries.length })).toBe(
      'ids-unparsed',
    )
  })
})

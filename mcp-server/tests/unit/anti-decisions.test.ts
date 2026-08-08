import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractAntiDecisions,
  readAntiDecisions,
} from '../../src/lib/anti-decisions.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-antidec-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function writeAntiDecisions(root: string, body: string): void {
  const dir = join(root, 'documentation', 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'anti-decisions.md'), body, 'utf8')
}

describe('lib/anti-decisions — extractAntiDecisions', () => {
  it('extracts AD-NNN entries with title and excerpt', () => {
    const body = `# Anti-decisions

### AD-001 — DynamoDB for orders
Tried DynamoDB to escape JPA. Cost forced rollback to Postgres.

### AD-002 — Service-mesh for auth
Istio sidecar added 80ms latency. Mesh adoption blocked.
`
    const entries = extractAntiDecisions(body)
    expect(entries.length).toBe(2)
    expect(entries[0]?.id).toBe('AD-001')
    expect(entries[0]?.title).toBe('DynamoDB for orders')
    expect(entries[0]?.excerpt).toContain('DynamoDB')
    expect(entries[1]?.id).toBe('AD-002')
    expect(entries[1]?.title).toBe('Service-mesh for auth')
  })

  it('terminates an entry at the next H2/H3/--- boundary', () => {
    const body = `### AD-001 — first
body one.

---

### AD-002 — second
body two.

## Section break
non-entry content.

### AD-003 — third
body three.
`
    const entries = extractAntiDecisions(body)
    expect(entries.length).toBe(3)
    expect(entries[0]?.excerpt).toContain('body one')
    expect(entries[1]?.excerpt).toContain('body two')
    expect(entries[2]?.excerpt).toContain('body three')
  })

  it('returns [] when no AD-NNN headings are present', () => {
    const body = `# Anti-decisions

This file is empty of real entries — bootstrap state.
`
    expect(extractAntiDecisions(body)).toEqual([])
  })

  it('ignores TODO placeholders and HTML comments in excerpts', () => {
    const body = `### AD-001 — example
<!-- comment line -->
<TODO: add first entry>
This sentence should appear in the excerpt.
`
    const entries = extractAntiDecisions(body)
    expect(entries[0]?.excerpt).toContain('This sentence')
    expect(entries[0]?.excerpt).not.toContain('TODO:')
    expect(entries[0]?.excerpt).not.toContain('comment line')
  })

  it('extracts related and captured metadata when present', () => {
    const body = `### AD-001 — multi-tenancy via separate DB
- **Tried:** isolated postgres per tenant.
- **Abandoned because:** provisioning too slow.
- **Related:** ADR-005, BR-014; [[incident-log]]
- **Captured:** 2026-06-03 by alice
`
    const entries = extractAntiDecisions(body)
    expect(entries[0]?.related).toEqual([
      'ADR-005',
      'BR-014',
      '[[incident-log]]',
    ])
    expect(entries[0]?.captured).toBe('2026-06-03')
  })

  it('returns excerpt clamped at 320 chars with ellipsis', () => {
    const longBody = 'x'.repeat(500)
    const body = `### AD-001 — long entry
${longBody}
`
    const entries = extractAntiDecisions(body)
    expect(entries[0]?.excerpt.endsWith('...')).toBe(true)
    expect(entries[0]?.excerpt.length).toBeLessThanOrEqual(320)
  })
})

describe('lib/anti-decisions — readAntiDecisions', () => {
  it('returns exists=false when the file is absent', () => {
    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.exists).toBe(false)
    expect(snapshot.path).toBeNull()
    expect(snapshot.entries).toEqual([])
  })

  it('returns parsed entries when the file exists', () => {
    writeAntiDecisions(
      tmpRoot,
      `### AD-001 — Redis cluster bootstrap
Tried multi-AZ Redis cluster. Failover lag exceeded 30s; rolled back.
`,
    )
    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.exists).toBe(true)
    expect(snapshot.path).toBe(
      join(tmpRoot, 'documentation', 'knowledge', 'anti-decisions.md'),
    )
    expect(snapshot.entries.length).toBe(1)
    expect(snapshot.entries[0]?.id).toBe('AD-001')
    expect(snapshot.entries[0]?.title).toBe('Redis cluster bootstrap')
  })
})

// #58 — this parser was the pre-#49 regex character for character, months after
// its sibling was widened. Bodies are inline on purpose: the shipped template and
// the fixture both use `###` + em dash exclusively, so an assertion against either
// would pass before AND after the fix and prove nothing.
describe('lib/anti-decisions — heading tolerance (#58)', () => {
  it('parses entries written at `##` level', () => {
    const entries = extractAntiDecisions(
      [
        '# Anti-decisions',
        '',
        '## Vendor experiments that were rolled back',
        '',
        '## AD-001 — DynamoDB for orders',
        'Single-table design collapsed under the reporting queries.',
      ].join('\n'),
    )
    expect(entries.map((e) => e.id)).toEqual(['AD-001'])
    expect(entries[0]?.title).toBe('DynamoDB for orders')
  })

  it('does not turn container headings into entries', () => {
    // Two of these carry a separator on purpose. Without them the case is decoration:
    // the separator requirement alone would satisfy it, and the `(AD-\d+)` capture —
    // the thing that actually keeps a section heading from becoming an entry once the
    // level was widened to `##` — would never be exercised. Relaxing the id capture
    // to `(\S+)` must fail this test.
    const entries = extractAntiDecisions(
      [
        '## Entries — rolled back experiments',
        '## Vendor experiments: what we abandoned',
        '## When NOT to capture here',
      ].join('\n'),
    )
    expect(entries).toEqual([])
  })

  it('accepts colon and en dash alongside the em dash and the hyphen', () => {
    const entries = extractAntiDecisions(
      [
        '### AD-001: Colon, no leading space',
        'one.',
        '',
        '### AD-002 – En dash U+2013',
        'two.',
        '',
        '### AD-003 - ASCII hyphen',
        'three.',
        '',
        '### AD-004 — Em dash U+2014',
        'four.',
      ].join('\n'),
    )
    expect(entries.map((e) => e.id)).toEqual(['AD-001', 'AD-002', 'AD-003', 'AD-004'])
    expect(entries[0]?.title).toBe('Colon, no leading space')
    expect(entries[1]?.title).toBe('En dash U+2013')
  })

  it('a `##` section heading still closes the entry before it', () => {
    // The terminator stays `^##\s`. The single heading branch `continue`s before
    // reaching it, so a `##` entry cannot terminate itself; relaxing it would let a
    // trailing section be swallowed into the previous entry's body.
    const entries = extractAntiDecisions(
      [
        '### AD-007 — Last real entry',
        'The rationale.',
        '',
        '## Out of scope',
        '- Multi-currency at launch.',
      ].join('\n'),
    )
    expect(entries.length).toBe(1)
    expect(entries[0]?.excerpt).not.toContain('Out of scope')
    expect(entries[0]?.excerpt).not.toContain('Multi-currency')
  })

  it('does not match the template placeholders AD-NNN / AD-XXX', () => {
    const entries = extractAntiDecisions(
      ['### AD-NNN — <short noun phrase>', '### AD-XXX — Never use jQuery'].join('\n'),
    )
    expect(entries).toEqual([])
  })
})

describe('lib/anti-decisions — silent-zero reporting (#58)', () => {
  it('flags a file that carries AD ids but parses to nothing', () => {
    writeAntiDecisions(tmpRoot, '# Anti-decisions\n\n#### AD-001 -- wrong level and separator\nBody.\n')

    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.has_entry_ids).toBe(true)
    expect(snapshot.read_error).toBe(false)
  })

  it('stays quiet on a scaffold with prose but no AD ids', () => {
    // Warning here on every bootstrap would train the reader to ignore the warning.
    writeAntiDecisions(tmpRoot, '# Anti-decisions\n\n## Entries\n\n## When NOT to capture here\n')

    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.has_entry_ids).toBe(false)
  })

  it('does not mistake an ADR reference for an entry id', () => {
    // The template's own example cites ADR-005 in its body. `\bAD-\d+\b` must not
    // fire on it, or every project gets a false parser-miss warning.
    writeAntiDecisions(tmpRoot, '# Anti-decisions\n\nSee ADR-005 for the decision that replaced it.\n')

    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.has_entry_ids).toBe(false)
  })

  it('reports a file that exists but cannot be read', () => {
    // A directory at the path: existsSync passes, readFileSync throws EISDIR. Zero
    // entries proves nothing, and nothing upstream reads this file.
    mkdirSync(join(tmpRoot, 'documentation', 'knowledge', 'anti-decisions.md'), {
      recursive: true,
    })

    const snapshot = readAntiDecisions(tmpRoot)
    expect(snapshot.exists).toBe(true)
    expect(snapshot.read_error).toBe(true)
    expect(snapshot.entries).toEqual([])
  })
})

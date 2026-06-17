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

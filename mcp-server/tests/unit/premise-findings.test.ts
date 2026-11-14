import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runVerificationChecklist } from '../../src/lib/verification-checklist.js'
import {
  phaseVerificationStartHandler,
  type PhaseVerificationStartOutput,
} from '../../src/tools/phase-verification-start.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-premise-findings-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function decisions(...entries: string[]): void {
  writeFile('documentation/decisions.md', `## Durable architectural decisions (ADRs)\n\n${entries.join('\n\n')}\n`)
}

function gapFindings(claims: string[]) {
  const result = runVerificationChecklist({
    projectRoot: tmpRoot,
    declaredPaths: [],
    discoveredImporters: [],
    specClaims: claims,
    specTier: 'standard',
  })
  return { result, gaps: result.findings.filter((f) => f.source === 'premise-check') }
}

const NIGHTLY_EXPORT = '### ADR-1 — Nightly batch export of orders\nThe batch export runs nightly.'
const NEVER_SYNC_GATEWAY = '### ADR-2 — Never call the payment gateway synchronously\nPayment calls are queued.'
const EXPORT_AND_GATEWAY_CLAIM = 'Run the nightly batch export of orders and call the payment gateway'

describe('2.25.0 — a premise finding names the right decision', () => {
  it('a conflict names the decision that carries the negation, not the top-scored one', () => {
    decisions(NIGHTLY_EXPORT, NEVER_SYNC_GATEWAY)
    const { gaps } = gapFindings([EXPORT_AND_GATEWAY_CLAIM])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.title).toBe('Conflict with ADR-2: Never call the payment gateway synchronously')
    expect(gaps[0]?.detail).toContain('score 3, shared: call, gateway, payment')
  })

  it('an anti-decision hit also names the decision the claim would be charged with', () => {
    decisions(NIGHTLY_EXPORT, NEVER_SYNC_GATEWAY)
    writeFile(
      'documentation/knowledge/anti-decisions.md',
      '## Entries\n\n### AD-1 — Exporting orders through the payment gateway\n- **Tried:** export orders via the payment gateway.\n',
    )
    const { result, gaps } = gapFindings([EXPORT_AND_GATEWAY_CLAIM])
    expect(gaps).toHaveLength(1)
    expect(result.premise_audit[gaps[0]?.id ?? '']).toEqual({
      score: 4,
      shared_tokens: ['export', 'gateway', 'orders', 'payment'],
      match_count: 3,
      claim_index: 0,
    })
    expect(gaps[0]?.title).toBe('Anti-decision hit: AD-1 — Exporting orders through the payment gateway')
    expect(gaps[0]?.detail).toContain(
      'Without this anti-decision the claim would be charged with ADR-2 (Never call the payment gateway synchronously) — score 3, shared: call, gateway, payment.',
    )
  })

  it('an anti-decision hit with no decision match says nothing more', () => {
    writeFile(
      'documentation/knowledge/anti-decisions.md',
      '## Entries\n\n### AD-1 — Exporting orders through the payment gateway\n- **Tried:** export orders via the payment gateway.\n',
    )
    const { gaps } = gapFindings([EXPORT_AND_GATEWAY_CLAIM])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.detail).not.toContain('Without this anti-decision')
  })
})

describe('2.25.0 — useful premise shapes still surface (regression guard, synthetic corpus)', () => {
  it('a race-condition claim reaches the pessimistic-lock decision over lower-scored distractors', () => {
    decisions(
      '### ADR-3 — Stock balance reports are generated nightly\nA cron job renders them.',
      '### ADR-7 — Write ahead log for the stock ledger\nThe ledger is append-only.',
      '### ADR-12 — Pessimistic lock closes the race between read and write of the stock balance\nConcurrent withdrawals serialise on a row lock.',
    )
    const { gaps } = gapFindings(['Concurrent withdrawals can race when they read and write the stock balance'])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.title).toBe('Requires revision: matches ADR-12')
  })

  it('a useful match on exactly two shared words still raises its finding', () => {
    decisions(
      '### ADR-20 — Invoices are immutable after issue\nCorrections are new documents.',
      '### ADR-21 — Customers log in with a magic link\nNo passwords.',
    )
    const { gaps } = gapFindings(['Allow editing invoices after they are issued'])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.title).toBe('Requires revision: matches ADR-20')
    expect(gaps[0]?.detail).toContain('score 2, shared: after, invoices')
  })
})

describe('2.25.0 — the premise audit fields', () => {
  it('records score, shared words, match count and claim index per premise finding, keyed by finding id', () => {
    decisions(NIGHTLY_EXPORT, NEVER_SYNC_GATEWAY)
    const { result, gaps } = gapFindings(['Nothing in common here at all', EXPORT_AND_GATEWAY_CLAIM])
    expect(gaps).toHaveLength(1)
    const id = gaps[0]?.id ?? ''
    expect(result.premise_audit).toEqual({
      [id]: { score: 3, shared_tokens: ['call', 'gateway', 'payment'], match_count: 2, claim_index: 1 },
    })
  })

  it('writes them on verification.finding, claims_count on verification.start, and never the claim text', async () => {
    writeFile('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    decisions(NIGHTLY_EXPORT, NEVER_SYNC_GATEWAY)
    const out = (await phaseVerificationStartHandler({
      project_root: tmpRoot,
      spec_ref: 'premise-audit',
      spec_tier: 'standard',
      spec_claims: ['Nothing in common here at all', EXPORT_AND_GATEWAY_CLAIM],
    })) as PhaseVerificationStartOutput
    expect(out.audit_error).toBeNull()
    const raw = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const start = events.find((e) => e.event === 'verification.start')
    expect(start?.claims_count).toBe(2)
    const premise = events.filter((e) => e.event === 'verification.finding' && e.source === 'premise-check')
    expect(premise).toHaveLength(1)
    expect(premise[0]).toMatchObject({ score: 3, shared_tokens: ['call', 'gateway', 'payment'], match_count: 2, claim_index: 1 })
    expect(raw).not.toContain(EXPORT_AND_GATEWAY_CLAIM)
    expect(raw).not.toContain('Nothing in common')
  })
})

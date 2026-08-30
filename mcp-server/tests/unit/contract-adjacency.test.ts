import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runVerificationChecklist } from '../../src/lib/verification-checklist.js'
import { EMPTY_CONTRACT_GRAPH, type ContractGraph } from '../../src/lib/contracts.js'

/**
 * #75 Part B. "Does this break something adjacent" answered from a manifest
 * instead of from an assertion that it was checked.
 *
 * No dependency on #54: `contractsTouchingPaths` already returns this shape
 * in-process. What #54 would add is persistence and a queryable tool.
 */

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-ca-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const GRAPH: ContractGraph = {
  available: true,
  contracts: [
    {
      id: 'orders-api',
      producer: 'checkout',
      surface: ['openapi/**', 'proto/orders.proto'],
      consumers: ['billing', 'analytics'],
      description: 'The published order schema.',
    },
    {
      id: 'internal-only',
      producer: 'checkout',
      surface: ['internal/**'],
      consumers: [],
    },
    {
      id: 'someone-elses',
      producer: 'billing',
      surface: ['openapi/**'],
      consumers: ['checkout'],
    },
  ],
  note: null,
}

function run(over: Partial<Parameters<typeof runVerificationChecklist>[0]> = {}) {
  return runVerificationChecklist({
    projectRoot: tmpRoot,
    declaredPaths: ['openapi/orders.yaml'],
    discoveredImporters: [],
    specTier: 'standard',
    contractGraph: GRAPH,
    appName: 'checkout',
    universeLinked: true,
    ...over,
  })
}

function contractFindings(r: ReturnType<typeof runVerificationChecklist>) {
  return r.findings.filter((f) => f.source === 'contract-surface')
}

describe('the contract adjacency check', () => {
  // MUTATION: drop the contractsTouchingPaths call, or the emission block.
  it('T15 — a declared path on a produced surface raises a MEASURED finding', () => {
    const found = contractFindings(run())
    expect(found).toHaveLength(1)
    expect(found[0]!.title).toContain('orders-api')
    expect(found[0]!.title).toContain('2 consumer(s)')
    // SORTED, not manifest order — `affectedConsumers` runs localeCompare. Pinned
    // because a stable order is what makes two runs of the same phase diffable;
    // the fixture deliberately lists them the other way round so insertion order
    // would fail here.
    expect(found[0]!.detail).toContain('analytics, billing')
  })

  // MUTATION: flip the contract-surface row in evidenceForSource to hypothesis.
  //
  // This is the one class the mix exists to show as WORTH a mandatory action: a
  // real manifest was read and real globs matched, unlike the vocabulary overlap
  // that dominates a premise-check run.
  it('T15b — the class is measured, and it names what else would explain it', () => {
    const e = contractFindings(run())[0]!.evidence
    expect(e.kind).toBe('measured')
    if (e.kind !== 'measured') throw new Error('unreachable')
    expect(e.also_explained_by).toMatch(/GLOB, not a call graph/)
    expect(e.also_explained_by).toMatch(/hand-written/)
  })

  // MUTATION: drop the `consumers.length === 0` guard.
  //
  // A contract nobody consumes gates nothing, and raising it would charge a
  // mandatory action (every V finding needs one, regardless of severity) for a
  // dependency no app declared.
  it('T15c — a contract with no declared consumers raises nothing', () => {
    const found = contractFindings(run({ declaredPaths: ['internal/thing.ts'] }))
    expect(found).toEqual([])
  })

  // MUTATION: pass `null` for `app` / drop the producer filter.
  //
  // Producer-side only. A consumer touching the producer's surface in its OWN
  // repo is not the producer changing the contract.
  it('T15d — only the PRODUCER is gated on its own surface', () => {
    // 'openapi/**' also matches contract `someone-elses`, produced by billing.
    const asCheckout = contractFindings(run())
    expect(asCheckout.map((f) => f.title.match(/'([^']+)'/)?.[1])).toEqual(['orders-api'])

    const asBilling = contractFindings(run({ appName: 'billing' }))
    expect(asBilling.map((f) => f.title.match(/'([^']+)'/)?.[1])).toEqual(['someone-elses'])
  })
})

describe('the four no-op states, reported and not hidden', () => {
  // MUTATION: collapse the four states into a boolean.
  //
  // The one that matters is `no_manifest`: contracts.json is hand-written and no
  // installer creates it, so an empty graph is the DEFAULT state of every
  // universe, not an edge case. "No adjacent app depends on this" and "nobody has
  // ever written the manifest that would say so" must not read alike.
  it('T16 — no universe, no manifest, degraded and available are distinguishable', () => {
    expect(run({ universeLinked: false, contractGraph: EMPTY_CONTRACT_GRAPH }).stats.contract_graph).toBe(
      'no_universe',
    )
    expect(run({ contractGraph: EMPTY_CONTRACT_GRAPH }).stats.contract_graph).toBe('no_manifest')
    expect(
      run({ contractGraph: { available: false, contracts: [], note: 'contracts.json exceeds 1000000 bytes' } })
        .stats.contract_graph,
    ).toBe('degraded')
    expect(run().stats.contract_graph).toBe('available')
  })

  // MUTATION: raise findings from a degraded graph, or drop the hint.
  it('T16b — a degraded graph raises nothing and says the check did NOT run', () => {
    const r = run({ contractGraph: { available: false, contracts: [], note: 'unreadable/malformed' } })
    expect(contractFindings(r)).toEqual([])
    expect(r.hints.some((h) => h.includes('coverage GAP, not a clean pass'))).toBe(true)
  })

  // MUTATION: default `contractGraph` to something non-empty, or throw when absent.
  it('T16c — omitting the graph entirely is a no-op, never a throw', () => {
    const r = runVerificationChecklist({
      projectRoot: tmpRoot,
      declaredPaths: ['openapi/orders.yaml'],
      discoveredImporters: [],
      specTier: 'standard',
    })
    expect(contractFindings(r)).toEqual([])
    expect(r.stats.contract_graph).toBe('no_universe')
    expect(r.stats.contracts_scanned).toBe(0)
  })

  // MUTATION: leave `contract_graph` at its initial value on the tier-skip path.
  it('T16d — a skipped tier reports not_run, distinct from a graph that was empty', () => {
    const r = run({ specTier: 'trivial' })
    expect(r.findings).toEqual([])
    expect(r.stats.contract_graph).toBe('not_run')
  })
})

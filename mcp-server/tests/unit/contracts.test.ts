import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import {
  readContracts,
  contractsTouchingPaths,
  contractsProducedBy,
  contractsConsumedBy,
  affectedConsumers,
  unregisteredProducers,
  EMPTY_CONTRACT_GRAPH,
} from '../../src/lib/contracts.js'

const UNIVERSE = resolve(__dirname, '..', 'fixtures', 'sample-universe')
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rsct-contracts-'))
}

describe('lib/contracts — readContracts', () => {
  it('reads the fixture contracts.json', () => {
    const g = readContracts(UNIVERSE)
    expect(g.available).toBe(true)
    expect(g.contracts.map((c) => c.id).sort()).toEqual(['events-stream', 'orders-api'])
    expect(g.note).toBeNull()
  })
  it('null root → empty graph', () => {
    expect(readContracts(null)).toEqual(EMPTY_CONTRACT_GRAPH)
  })
  it('missing contracts.json → empty graph (no error)', () => {
    const u = tmp()
    writeFileSync(join(u, '.universe.json'), '{}')
    expect(readContracts(u).available).toBe(false)
  })
  it('malformed JSON → unavailable + note', () => {
    const u = tmp()
    writeFileSync(join(u, 'contracts.json'), '{ not json')
    const g = readContracts(u)
    expect(g.available).toBe(false)
    expect(g.note).toMatch(/malformed/)
  })
  it('drops individually malformed contracts + counts in note', () => {
    const u = tmp()
    writeFileSync(
      join(u, 'contracts.json'),
      JSON.stringify({
        contracts: [
          { id: 'ok', producer: 'p', surface: ['a/**'], consumers: ['q'] },
          { id: 'bad', producer: 'p' },
        ],
      }),
    )
    const g = readContracts(u)
    expect(g.contracts.map((c) => c.id)).toEqual(['ok'])
    expect(g.note).toMatch(/1 malformed/)
  })
  it('RV4: empty-surface contract counted in note', () => {
    const u = tmp()
    writeFileSync(
      join(u, 'contracts.json'),
      JSON.stringify({ contracts: [{ id: 'empty', producer: 'p', surface: [], consumers: ['q'] }] }),
    )
    expect(readContracts(u).note).toMatch(/empty surface/)
  })
  it('CRLF contracts.json parses', () => {
    const u = tmp()
    writeFileSync(
      join(u, 'contracts.json'),
      '{\r\n  "contracts": [\r\n    { "id":"c","producer":"p","surface":["a/**"],"consumers":["q"] }\r\n  ]\r\n}\r\n',
    )
    expect(readContracts(u).contracts.length).toBe(1)
  })
})

describe('lib/contracts — surface matching (producer-side, V FV8)', () => {
  const g = readContracts(UNIVERSE)
  it('producer + matching nested path → hit', () => {
    expect(contractsTouchingPaths(g, 'registered-app', ['src/api/orders.ts']).map((c) => c.id)).toEqual([
      'orders-api',
    ])
  })
  it('producer + non-surface path → no hit', () => {
    expect(contractsTouchingPaths(g, 'registered-app', ['docs/readme.md'])).toEqual([])
  })
  it('consumer touching producer surface → NOT its contract', () => {
    expect(contractsTouchingPaths(g, 'web-frontend', ['src/api/orders.ts'])).toEqual([])
  })
  it('backslash staged path normalizes + matches', () => {
    expect(contractsTouchingPaths(g, 'registered-app', ['src\\api\\orders.ts']).map((c) => c.id)).toEqual([
      'orders-api',
    ])
  })
  it('exact-path surface matches', () => {
    expect(contractsTouchingPaths(g, 'registered-app', ['openapi/orders.yaml']).map((c) => c.id)).toEqual([
      'orders-api',
    ])
  })
  it('null app → []', () => {
    expect(contractsTouchingPaths(g, null, ['src/api/x.ts'])).toEqual([])
  })
  it('producedBy / consumedBy', () => {
    expect(contractsProducedBy(g, 'registered-app').map((c) => c.id)).toEqual(['orders-api'])
    expect(contractsConsumedBy(g, 'reporting').map((c) => c.id).sort()).toEqual([
      'events-stream',
      'orders-api',
    ])
  })
  it('affectedConsumers sorts + dedups', () => {
    expect(affectedConsumers(g.contracts)).toEqual(['reporting', 'web-frontend'])
  })
})

describe('lib/contracts — unregisteredProducers (DX-5)', () => {
  it('all producers registered → []', () => {
    expect(unregisteredProducers(['api', 'web'], ['api', 'web', 'extra'])).toEqual([])
  })
  it('an unregistered producer → kind unregistered (no suggestion)', () => {
    expect(unregisteredProducers(['ghost'], ['api', 'web'])).toEqual([
      { producer: 'ghost', kind: 'unregistered' },
    ])
  })
  it('case-only diff → kind case_mismatch + correctly-cased suggestion', () => {
    expect(unregisteredProducers(['Web-Frontend'], ['web-frontend'])).toEqual([
      { producer: 'Web-Frontend', kind: 'case_mismatch', suggestion: 'web-frontend' },
    ])
  })
  it('exact match wins over a case-variant in the registered set', () => {
    // `web` is registered exactly → no issue, even though `WEB` is also present.
    expect(unregisteredProducers(['web'], ['WEB', 'web'])).toEqual([])
  })
  it('dedupes repeated producers, preserving input order', () => {
    expect(unregisteredProducers(['ghost', 'ghost', 'api'], ['api'])).toEqual([
      { producer: 'ghost', kind: 'unregistered' },
    ])
  })
  it('mixed set → one issue per distinct mismatch, in input order', () => {
    expect(unregisteredProducers(['api', 'Web', 'ghost'], ['api', 'web'])).toEqual([
      { producer: 'Web', kind: 'case_mismatch', suggestion: 'web' },
      { producer: 'ghost', kind: 'unregistered' },
    ])
  })
  it('§9.B multi case-match → first registered name in input order wins', () => {
    expect(unregisteredProducers(['app'], ['App', 'APP'])).toEqual([
      { producer: 'app', kind: 'case_mismatch', suggestion: 'App' },
    ])
  })
  it('§9.C does NOT trim — stray whitespace producer is genuinely unregistered', () => {
    expect(unregisteredProducers(['web '], ['web'])).toEqual([
      { producer: 'web ', kind: 'unregistered' },
    ])
  })
  it('§9.D empty registered set → every producer unregistered (intentional)', () => {
    expect(unregisteredProducers(['api', 'web'], [])).toEqual([
      { producer: 'api', kind: 'unregistered' },
      { producer: 'web', kind: 'unregistered' },
    ])
  })
  it('no producers → []', () => {
    expect(unregisteredProducers([], ['api'])).toEqual([])
  })
})

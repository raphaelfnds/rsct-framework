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
  unregisteredNames,
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

describe('lib/contracts — unregisteredNames (DX-5 + PH-2, role-agnostic)', () => {
  it('all names registered → []', () => {
    expect(unregisteredNames(['api', 'web'], ['api', 'web', 'extra'])).toEqual([])
  })
  it('an unregistered name → kind unregistered (no suggestion)', () => {
    expect(unregisteredNames(['ghost'], ['api', 'web'])).toEqual([
      { name: 'ghost', kind: 'unregistered' },
    ])
  })
  it('case-only diff → kind case_mismatch + correctly-cased suggestion', () => {
    expect(unregisteredNames(['Web-Frontend'], ['web-frontend'])).toEqual([
      { name: 'Web-Frontend', kind: 'case_mismatch', suggestion: 'web-frontend' },
    ])
  })
  it('exact match wins over a case-variant in the registered set', () => {
    // `web` is registered exactly → no issue, even though `WEB` is also present.
    expect(unregisteredNames(['web'], ['WEB', 'web'])).toEqual([])
  })
  it('dedupes repeated names, preserving input order', () => {
    expect(unregisteredNames(['ghost', 'ghost', 'api'], ['api'])).toEqual([
      { name: 'ghost', kind: 'unregistered' },
    ])
  })
  it('mixed set → one issue per distinct mismatch, in input order', () => {
    expect(unregisteredNames(['api', 'Web', 'ghost'], ['api', 'web'])).toEqual([
      { name: 'Web', kind: 'case_mismatch', suggestion: 'web' },
      { name: 'ghost', kind: 'unregistered' },
    ])
  })
  it('§9.B multi case-match → first registered name in input order wins', () => {
    expect(unregisteredNames(['app'], ['App', 'APP'])).toEqual([
      { name: 'app', kind: 'case_mismatch', suggestion: 'App' },
    ])
  })
  it('§9.C does NOT trim — stray whitespace name is genuinely unregistered', () => {
    expect(unregisteredNames(['web '], ['web'])).toEqual([
      { name: 'web ', kind: 'unregistered' },
    ])
  })
  it('§9.D empty registered set → every name unregistered (caller caps the wall)', () => {
    expect(unregisteredNames(['api', 'web'], [])).toEqual([
      { name: 'api', kind: 'unregistered' },
      { name: 'web', kind: 'unregistered' },
    ])
  })
  it('no names → []', () => {
    expect(unregisteredNames([], ['api'])).toEqual([])
  })
})

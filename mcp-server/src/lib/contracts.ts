import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { matchesAnyGlob } from './phase-scope.js'

export interface Contract {
  id: string
  producer: string
  surface: string[]
  consumers: string[]
  description?: string
}

export interface ContractGraph {
  available: boolean
  contracts: Contract[]
  note: string | null
}

export const EMPTY_CONTRACT_GRAPH: ContractGraph = {
  available: false,
  contracts: [],
  note: null,
}

const MAX_CONTRACTS_JSON_BYTES = 1_000_000

export function readContracts(universeRoot: string | null): ContractGraph {
  if (!universeRoot) return EMPTY_CONTRACT_GRAPH
  try {
    const p = join(universeRoot, 'contracts.json')
    if (!existsSync(p)) return EMPTY_CONTRACT_GRAPH
    if (statSync(p).size > MAX_CONTRACTS_JSON_BYTES) {
      return { available: false, contracts: [], note: `contracts.json exceeds ${MAX_CONTRACTS_JSON_BYTES} bytes` }
    }
    return parseContracts(readFileSync(p, 'utf8'))
  } catch (e) {
    return {
      available: false,
      contracts: [],
      note: `contracts.json unreadable/malformed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export function parseContracts(text: string): ContractGraph {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTRACTS_JSON_BYTES) {
    return { available: false, contracts: [], note: `contracts.json exceeds ${MAX_CONTRACTS_JSON_BYTES} bytes` }
  }
  try {
    const parsed = JSON.parse(text) as { contracts?: unknown }
    const raw = Array.isArray(parsed.contracts) ? parsed.contracts : []
    const contracts: Contract[] = []
    let dropped = 0
    for (const c of raw) {
      if (isValidContract(c)) contracts.push(normalizeContract(c))
      else dropped++
    }
    const emptySurface = contracts.filter((c) => c.surface.length === 0).length
    const notes: string[] = []
    if (dropped > 0) {
      notes.push(`${dropped} malformed contract ${dropped === 1 ? 'entry' : 'entries'} skipped`)
    }
    if (emptySurface > 0) {
      notes.push(`${emptySurface} contract(s) have an empty surface and can never gate`)
    }
    return { available: true, contracts, note: notes.length > 0 ? notes.join('; ') : null }
  } catch (e) {
    return {
      available: false,
      contracts: [],
      note: `contracts.json unreadable/malformed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

function isValidContract(c: unknown): c is Contract {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.producer === 'string' &&
    o.producer.length > 0 &&
    Array.isArray(o.surface) &&
    o.surface.every((s) => typeof s === 'string') &&
    Array.isArray(o.consumers) &&
    o.consumers.every((s) => typeof s === 'string')
  )
}

function normalizeContract(c: Contract): Contract {
  const out: Contract = {
    id: c.id,
    producer: c.producer,
    surface: c.surface.filter((s) => s.length > 0),
    consumers: c.consumers.filter((s) => s.length > 0),
  }
  if (typeof c.description === 'string' && c.description.length > 0) out.description = c.description
  return out
}

export function contractsTouchingPaths(
  graph: ContractGraph,
  app: string | null,
  paths: readonly string[],
): Contract[] {
  if (!app) return []
  return graph.contracts.filter(
    (c) => c.producer === app && paths.some((p) => matchesAnyGlob(p, c.surface).matched),
  )
}

export function contractsProducedBy(graph: ContractGraph, app: string | null): Contract[] {
  if (!app) return []
  return graph.contracts.filter((c) => c.producer === app)
}

export function contractsConsumedBy(graph: ContractGraph, app: string | null): Contract[] {
  if (!app) return []
  return graph.contracts.filter((c) => c.consumers.includes(app))
}

export function affectedConsumers(contracts: readonly Contract[]): string[] {
  return [...new Set(contracts.flatMap((c) => c.consumers))].sort((a, b) => a.localeCompare(b))
}

export interface NameRegistrationIssue {
  name: string
  kind: 'unregistered' | 'case_mismatch'
  suggestion?: string
}

export function unregisteredNames(
  names: readonly string[],
  registered: readonly string[],
): NameRegistrationIssue[] {
  const exact = new Set(registered)
  const byLower = new Map<string, string>()
  for (const r of registered) {
    const k = r.toLowerCase()
    if (!byLower.has(k)) byLower.set(k, r)
  }
  const issues: NameRegistrationIssue[] = []
  const seen = new Set<string>()
  for (const p of names) {
    if (seen.has(p)) continue
    seen.add(p)
    if (exact.has(p)) continue
    const suggestion = byLower.get(p.toLowerCase())
    if (suggestion !== undefined) issues.push({ name: p, kind: 'case_mismatch', suggestion })
    else issues.push({ name: p, kind: 'unregistered' })
  }
  return issues
}

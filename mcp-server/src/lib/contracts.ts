import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { matchesAnyGlob } from './phase-scope.js'

// T2 — the org-level contract graph. A "contract" is a SURFACE: path globs in
// the PRODUCER's repo that materialize an interface (openapi.yaml, proto/**,
// published schema) which CONSUMER apps depend on. The graph lives in a manual,
// hand-written `contracts.json` at the universe root (the MCP only READS it — no
// installer mutates it, so the AP5 "no reformat" rule doesn't apply). Surface
// matching REUSES the phase-scope glob matcher (one tested, OS-portable matcher:
// `*`/`**`/`?`, normalizes `\`→`/`). Everything here is FAIL-GRACEFUL: a missing
// / malformed / oversize manifest degrades to the empty graph and NEVER throws.

export interface Contract {
  /** Unique slug. */
  id: string
  /** App name (the producer; should be in the universe's registered_apps). */
  producer: string
  /** Path globs RELATIVE to the producer repo (matched against its staged diff). */
  surface: string[]
  /** App names that depend on this surface. */
  consumers: string[]
  description?: string
}

export interface ContractGraph {
  /** contracts.json present + readable (≥0 valid contracts). */
  available: boolean
  contracts: Contract[]
  /** Diagnostic for malformed / oversize / dropped entries (mirrors universe note). */
  note: string | null
}

/** The empty graph — reused as the none/degraded shape (gate no-op). */
export const EMPTY_CONTRACT_GRAPH: ContractGraph = {
  available: false,
  contracts: [],
  note: null,
}

// Defensive cap: never read a multi-MB file into memory for a tiny graph.
const MAX_CONTRACTS_JSON_BYTES = 1_000_000

/**
 * Read `contracts.json` at the universe root and return the validated graph.
 * Any error / missing file / oversize → the empty graph (gate becomes a no-op).
 * Individually malformed contracts are dropped (and counted in `note`).
 */
export function readContracts(universeRoot: string | null): ContractGraph {
  if (!universeRoot) return EMPTY_CONTRACT_GRAPH
  try {
    const p = join(universeRoot, 'contracts.json')
    if (!existsSync(p)) return EMPTY_CONTRACT_GRAPH
    if (statSync(p).size > MAX_CONTRACTS_JSON_BYTES) {
      return { available: false, contracts: [], note: `contracts.json exceeds ${MAX_CONTRACTS_JSON_BYTES} bytes` }
    }
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { contracts?: unknown }
    const raw = Array.isArray(parsed.contracts) ? parsed.contracts : []
    const contracts: Contract[] = []
    let dropped = 0
    for (const c of raw) {
      if (isValidContract(c)) contracts.push(normalizeContract(c))
      else dropped++
    }
    // RV4: a contract whose surface normalizes to [] can never match a path → it
    // silently never gates. Count it in `note` so the dev isn't misled.
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

/**
 * Contracts where `app` is the PRODUCER and at least one surface glob matches one
 * of `paths` (the producer's staged file list). Producer-side only (V FV8): a
 * consumer touching the producer's surface does NOT match — only the producer is
 * gated on its own surface.
 */
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

/** Contracts this app produces. */
export function contractsProducedBy(graph: ContractGraph, app: string | null): Contract[] {
  if (!app) return []
  return graph.contracts.filter((c) => c.producer === app)
}

/** Contracts this app consumes. */
export function contractsConsumedBy(graph: ContractGraph, app: string | null): Contract[] {
  if (!app) return []
  return graph.contracts.filter((c) => c.consumers.includes(app))
}

/** The sorted union of consumers across a set of contracts (for the gate message). */
export function affectedConsumers(contracts: readonly Contract[]): string[] {
  return [...new Set(contracts.flatMap((c) => c.consumers))].sort((a, b) => a.localeCompare(b))
}

/** A name (contract producer, consumer, or the app's own name) that won't match a registered app. */
export interface NameRegistrationIssue {
  name: string
  /** `unregistered` = no app matches (any case); `case_mismatch` = only the case differs. */
  kind: 'unregistered' | 'case_mismatch'
  /** `case_mismatch` only: the correctly-cased registered app name to fix it to. */
  suggestion?: string
}

/**
 * Names (a contract producer, a contract consumer, or the app's own `app.name`)
 * that match NO registered app the way the gate compares them. The gate is
 * `c.producer === app` — exact, case-SENSITIVE, no trim (see
 * {@link contractsTouchingPaths}). A name that isn't registered under that exact
 * comparison can never gate/match, so this surfaces it as a latent-bug diagnostic:
 * - `unregistered` — no registered app matches, even case-insensitively.
 * - `case_mismatch` — a registered app matches case-insensitively but NOT exactly
 *   (e.g. `Web-Frontend` vs `web-frontend`); the gate silently treats it as
 *   unregistered, so it never fires though it looks correct. The `suggestion` is
 *   the correctly-cased name to fix it to.
 *
 * Pure string-set logic — the caller supplies the registered set (no universe
 * import here) and the role wording for the hint. §9.C: the name is NOT trimmed
 * (the gate doesn't trim, so a stray-whitespace name is genuinely unregistered +
 * SHOULD warn). §9.D: an empty `registered` set → every name is `unregistered`
 * (callers cap that wall — see get-topology). §9.B: on a case-insensitive
 * collision (a degenerate universe with both `App` and `APP`), the FIRST
 * registered name in input order wins. Output is input-order, deduped.
 */
export function unregisteredNames(
  names: readonly string[],
  registered: readonly string[],
): NameRegistrationIssue[] {
  const exact = new Set(registered)
  // §9.B first-wins: iterate registered in order, never overwrite a lowercase key.
  const byLower = new Map<string, string>()
  for (const r of registered) {
    const k = r.toLowerCase()
    if (!byLower.has(k)) byLower.set(k, r)
  }
  const issues: NameRegistrationIssue[] = []
  const seen = new Set<string>()
  for (const p of names) {
    if (seen.has(p)) continue // dedupe, preserving input order
    seen.add(p)
    if (exact.has(p)) continue // registered exactly — the gate honors it (§9.C: no trim)
    const suggestion = byLower.get(p.toLowerCase())
    if (suggestion !== undefined) issues.push({ name: p, kind: 'case_mismatch', suggestion })
    else issues.push({ name: p, kind: 'unregistered' })
  }
  return issues
}

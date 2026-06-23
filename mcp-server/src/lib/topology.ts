import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { RsctConfig } from './project-root.js'
import { getUniverse, type UniverseOptions, type UniverseResult } from './universe.js'

// T2 — multi-repo / contract graph. This module infers the project's REPO
// TOPOLOGY (mono / monorepo / multi-repo) from on-disk signals (the "silent
// recognition" step), so rsct_status / rsct_load_context can surface it and the
// /rsct-setup ask can confirm + persist it (.rsct.json `topology.mode`). The
// CONFIRMED mode is what the contract-surface gate (INV-7) diverges on; the
// INFERRED mode only pre-selects the explicit ask. Everything here is
// FAIL-GRACEFUL: any error degrades to a sane block and NEVER throws into
// bootstrap. Universe facts are REUSED from the single source `getUniverse`
// (so registered_apps_count is the applications/ dir count — V FV4 — and the
// resolution never drifts from the universe block).

export type TopologyMode = 'mono' | 'monorepo' | 'multi-repo'

/** Deterministic on-disk signals the inference reads (surfaced for transparency). */
export interface TopologySignals {
  /** A universe is linked + resolvable (from getUniverse). */
  universe_available: boolean
  /** applications/ dir count (ground truth — V FV4), via getUniverse. */
  registered_apps_count: number
  /** This app has an applications/<app>/ dir in the universe. */
  this_app_registered: boolean
  /** Subdirs (1–2 levels) holding an app marker, excluding the SKIP set (V FV5). */
  nested_app_markers: number
  /** The resolved universe root is OUTSIDE this repo (multi-repo signal; V FV2). */
  universe_external: boolean
}

/** The topology block surfaced in status / load_context (always present). */
export interface TopologyBlock {
  /** Dev-confirmed mode from .rsct.json (authoritative — what INV-7 diverges on). */
  confirmed_mode: TopologyMode | null
  /** Silent inference from signals (pre-selects the explicit ask only). */
  inferred_mode: TopologyMode
  /** Informs the ask; NEVER gates enforcement. */
  confidence: 'high' | 'medium' | 'low'
  /** confirmed_mode ?? inferred_mode (what callers display when unconfirmed). */
  effective_mode: TopologyMode
  signals: TopologySignals
}

export interface TopologyResult {
  block: TopologyBlock
  /** Resolved universe root (for the gate / get-topology to read contracts); null when none. */
  universe_root: string | null
  /** FV1 — the "gate INACTIVE" hint when multi-repo is confirmed but unenforceable. */
  hint: string | null
}

/** The empty/default block — used when there is no rsct config (behave like today). */
const NONE_BLOCK: TopologyBlock = {
  confirmed_mode: null,
  inferred_mode: 'mono',
  confidence: 'high',
  effective_mode: 'mono',
  signals: {
    universe_available: false,
    registered_apps_count: 0,
    this_app_registered: false,
    nested_app_markers: 0,
    universe_external: false,
  },
}

// Dirs that must never count as a nested app (V FV5 — else node_modules etc.
// false-positive a monorepo). Mandatory.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.rsct',
  'coverage',
  'build',
  'out',
  'target',
])
const APP_MARKERS = ['package.json', '.rsct.json', 'CLAUDE.md'] as const

/**
 * Count subdirs (1–2 levels under projectRoot) that hold an app marker. The
 * monorepo signal — intentionally LOW-confidence (layout-dependent: packages/*,
 * apps/*, services/*) so it only pre-selects the ask, never gates enforcement.
 * Skips the SKIP_DIRS set and dotfiles. Never throws.
 */
function safeReaddir(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function countNestedAppMarkers(projectRoot: string): number {
  const hasMarker = (dir: string): boolean =>
    APP_MARKERS.some((m) => existsSync(join(dir, m)))
  let count = 0
  for (const e of safeReaddir(projectRoot)) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const lvl1 = join(projectRoot, e.name)
    for (const se of safeReaddir(lvl1)) {
      if (!se.isDirectory() || SKIP_DIRS.has(se.name)) continue
      if (hasMarker(join(lvl1, se.name))) count++
    }
  }
  return count
}

function infer(s: TopologySignals): { inferred: TopologyMode; confidence: TopologyBlock['confidence'] } {
  if (!s.universe_available) {
    if (s.nested_app_markers >= 2) return { inferred: 'monorepo', confidence: 'low' }
    return { inferred: 'mono', confidence: 'high' }
  }
  // A universe is linked.
  if (s.registered_apps_count >= 2 && s.universe_external) {
    return { inferred: 'multi-repo', confidence: 'high' }
  }
  if (s.nested_app_markers >= 2) return { inferred: 'monorepo', confidence: 'low' }
  return { inferred: 'mono', confidence: 'medium' }
}

/**
 * FV1 — when the topology is CONFIRMED multi-repo but the contract gate cannot
 * actually fire (no universe linked, or no contracts.json), surface a HIGH hint
 * so the silently-off gate is never silent. Only an existsSync (cheap) and only
 * when confirmed_mode is multi-repo (rare) — no contracts.json content read here.
 */
function buildTopologyHint(block: TopologyBlock, universeRoot: string | null): string | null {
  if (block.confirmed_mode !== 'multi-repo') return null
  if (!universeRoot) {
    return 'Topology is confirmed multi-repo but no universe is linked — the contract-surface gate is INACTIVE. Run /rsct-canonical-source to link the org universe so rsct_request_commit can enforce contracts.'
  }
  if (!existsSync(join(universeRoot, 'contracts.json'))) {
    return `Topology is confirmed multi-repo but ${universeRoot}/contracts.json is missing — the contract-surface gate is INACTIVE. Add a contracts.json (scaffold via /rsct-init-universe) to enforce contracts.`
  }
  return null
}

/**
 * Detect the repo topology. Reuses the single-source `getUniverse` for universe
 * facts (availability, registered_apps_count = applications/ dir count, this-app
 * registration, resolved root) and adds the two T2-specific signals
 * (nested_app_markers, universe_external). Never throws. NOT called on the commit
 * hot path — the INV-7 gate reads `config.topology.mode` directly (see
 * {@link confirmedTopologyMode}) and resolves the universe root only when needed.
 */
export function detectTopology(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
  precomputedUniverse?: UniverseResult,
): TopologyResult {
  if (!config) return { block: NONE_BLOCK, universe_root: null, hint: null }

  let universeRoot: string | null = null
  let universeAvailable = false
  let registeredAppsCount = 0
  let thisAppRegistered = false
  try {
    // Reuse the universe block the bootstrap tools already resolved (status /
    // load_context call getUniverse), avoiding a second resolution per call.
    const { block: uni } = precomputedUniverse ?? getUniverse(config, projectRoot, opts)
    universeAvailable = uni.available
    universeRoot = uni.available ? uni.local_path : null
    registeredAppsCount = uni.registered_apps_count
    thisAppRegistered = uni.this_app_registered
  } catch {
    // never throw into bootstrap — degrade to no-universe signals
  }

  const signals: TopologySignals = {
    universe_available: universeAvailable,
    registered_apps_count: registeredAppsCount,
    this_app_registered: thisAppRegistered,
    nested_app_markers: countNestedAppMarkers(projectRoot),
    // V FV2 — append path.sep to the prefix, else a sibling `<repo>-universe`
    // (which shares the `<repo>` prefix) is misread as INTERNAL. RV2: a universe
    // root EQUAL to the project root is internal (not external), so guard equality
    // first (startsWith(p + sep) is false for p itself → would wrongly say external).
    universe_external: universeRoot
      ? resolve(universeRoot) !== resolve(projectRoot) &&
        !resolve(universeRoot).startsWith(resolve(projectRoot) + sep)
      : false,
  }

  const { inferred, confidence } = infer(signals)
  const confirmed = readConfirmedMode(config)
  const block: TopologyBlock = {
    confirmed_mode: confirmed,
    inferred_mode: inferred,
    confidence,
    effective_mode: confirmed ?? inferred,
    signals,
  }
  return { block, universe_root: universeRoot, hint: buildTopologyHint(block, universeRoot) }
}

/**
 * Lightweight CONFIRMED-mode read for the commit hot path (INV-7). No signal
 * computation, no readdir — the gate exits immediately for any non-multi-repo
 * project, so 99% of commits pay nothing. A malformed config (rejected by the
 * loader) arrives here as null → the gate is a no-op (V FV7).
 */
export function confirmedTopologyMode(config: RsctConfig | null): TopologyMode | null {
  return readConfirmedMode(config)
}

function readConfirmedMode(config: RsctConfig | null): TopologyMode | null {
  const mode = config?.topology?.mode
  return mode === 'mono' || mode === 'monorepo' || mode === 'multi-repo' ? mode : null
}

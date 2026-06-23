import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RsctConfig } from './project-root.js'
import {
  readUniverseGovernanceIndex,
  EMPTY_GOVERNANCE_INDEX,
  type UniverseGovernanceIndex,
} from './universe-content.js'

// T1.a — make the org-level "universe" usable at runtime. The universe layer
// already exists (universe repo, .universe.json, applications/ registry) and
// `RsctConfig.universe` is populated by /rsct-canonical-source, but nothing ever
// READS it. This module resolves + reads the universe and computes a single
// `UniverseBlock` (the "single source" — both rsct_status and rsct_load_context
// call getUniverse, so they can never drift). Everything here is FAIL-GRACEFUL:
// any error degrades to a sane block and NEVER throws into the bootstrap path.

/** The data shape surfaced in status / load_context output (always present). */
export interface UniverseBlock {
  available: boolean
  name: string | null
  /** The resolved universe path that was chosen (transparency / V #2). */
  local_path: string | null
  registered_apps_count: number
  this_app_registered: boolean
  /** Diagnostic for the degraded / configured-but-missing / reconciliation states. */
  note: string | null
  /**
   * T1.c — lightweight index of the universe's org-level governance docs
   * (slugs only; no content). Always present (FV1); empty when no universe or no
   * docs/governance/. Computed ONLY on the found+readable path (FV2). Content is
   * read on demand via the rsct_get_universe tool.
   */
  governance: UniverseGovernanceIndex
}

export interface UniverseResult {
  block: UniverseBlock
  /** Actionable one-line hint for Claude's hints[] (null when nothing to say). */
  hint: string | null
}

export interface UniverseOptions {
  /** Override $HOME for hermetic tests (FV3). Defaults to the real home. */
  home?: string
}

const NONE_BLOCK: UniverseBlock = {
  available: false,
  name: null,
  local_path: null,
  registered_apps_count: 0,
  this_app_registered: false,
  note: null,
  governance: EMPTY_GOVERNANCE_INDEX,
}

// Defensive cap: never read a multi-MB file into memory for a tiny index.
const MAX_UNIVERSE_JSON_BYTES = 1_000_000

type Resolution =
  | { kind: 'found'; path: string }
  | { kind: 'configured-missing'; path: string }
  | { kind: 'none' }

/** Does a directory hold a `.universe.json` (the universe marker)? */
function isUniverseDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, '.universe.json'))
  } catch {
    return false
  }
}

/**
 * Resolve the universe root. Precedence: (a) config.universe.local if set; (b)
 * the canonical candidate paths (same list as 02-canonical-source.md Phase 1.2);
 * (c) none. A configured-but-missing local path is reported distinctly (V #1).
 */
export function resolveUniverseRoot(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
): Resolution {
  const uni = config?.universe
  const home = opts.home ?? process.env.HOME ?? homedir()

  // (a) explicit config.universe.local
  if (uni?.local && uni.local.trim().length > 0) {
    const local = isAbsolute(uni.local) ? uni.local : resolve(projectRoot, uni.local)
    return isUniverseDir(local) ? { kind: 'found', path: local } : { kind: 'configured-missing', path: local }
  }

  // (b) candidate probe — build "<base>-universe" candidates from the known
  // basenames, in the canonical-source / Phase 1.9 priority order: explicit
  // universe.name first, then the org name INFERRED by stripping a trailing
  // -<digits> suffix (e.g. "bluelt-23" → "bluelt"; T1.d — lets an unlinked,
  // org-suffixed project still discover the canonically-named universe), then
  // the raw org. The inference uses `-\d*$` to match the prompt's
  // `sed 's/-[0-9]*$//'` EXACTLY — `-\d+$` would diverge on a bare trailing dash.
  const name = uni?.name ?? null
  const org = config?.app?.org ?? null
  const inferred = org ? org.replace(/-\d*$/, '') : null
  const basenames = [...new Set([name, inferred, org].filter((x): x is string => !!x))]
  const candidates: string[] = []
  for (const b of basenames) candidates.push(resolve(projectRoot, '..', `${b}-universe`))
  candidates.push(resolve(projectRoot, '..', 'universe'))
  for (const sub of ['projetos', 'projects', 'dev', 'workspace']) {
    for (const b of basenames) candidates.push(join(home, sub, `${b}-universe`))
  }

  for (const c of candidates) {
    if (c && isUniverseDir(c)) return { kind: 'found', path: c }
  }
  return { kind: 'none' }
}

interface UniverseData {
  name: string | null
  registeredFromJson: string[]
  registeredFromDirs: string[]
}

/**
 * Read `.universe.json` + the `applications/` registry. Dirs are the ground
 * truth (V #7); JSON is the index. Returns null on ANY failure (degraded).
 */
export function readUniverse(universeRoot: string): UniverseData | null {
  try {
    const jsonPath = join(universeRoot, '.universe.json')
    if (statSync(jsonPath).size > MAX_UNIVERSE_JSON_BYTES) return null
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      name?: unknown
      registered_apps?: unknown
    }
    const name = typeof parsed.name === 'string' ? parsed.name : null
    const registeredFromJson = Array.isArray(parsed.registered_apps)
      ? parsed.registered_apps.filter((x): x is string => typeof x === 'string')
      : []
    let registeredFromDirs: string[] = []
    try {
      registeredFromDirs = readdirSync(join(universeRoot, 'applications'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
        .map((e) => e.name)
    } catch {
      registeredFromDirs = []
    }
    return { name, registeredFromJson, registeredFromDirs }
  } catch {
    return null
  }
}

/**
 * The single source for the universe block. Both rsct_status and
 * rsct_load_context call this, so the two outputs can never drift (V #6).
 */
export function getUniverse(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
): UniverseResult {
  // Universe surfacing is only meaningful for an rsct-managed project (we need
  // an identity to test registration against). No config → behave like today.
  if (!config) return { block: NONE_BLOCK, hint: null }

  let resolution: Resolution
  try {
    resolution = resolveUniverseRoot(config, projectRoot, opts)
  } catch {
    return { block: NONE_BLOCK, hint: null } // never throw into bootstrap
  }

  if (resolution.kind === 'none') return { block: NONE_BLOCK, hint: null }

  if (resolution.kind === 'configured-missing') {
    const note = `universe configured but not found at ${resolution.path}`
    return {
      block: { ...NONE_BLOCK, name: config.universe?.name ?? null, local_path: resolution.path, note },
      hint: `Universe configured at ${resolution.path} but not found there — fix .rsct.json universe.local or re-run /rsct-canonical-source.`,
    }
  }

  // found — try to read it
  const data = readUniverse(resolution.path)
  if (!data) {
    const note = `universe found but unreadable at ${resolution.path}`
    return {
      block: { ...NONE_BLOCK, name: config.universe?.name ?? null, local_path: resolution.path, note },
      hint: `Universe at ${resolution.path} is present but its .universe.json is missing/corrupt — inspect it.`,
    }
  }

  const appName = config.app?.name ?? null
  const inDirs = appName !== null && data.registeredFromDirs.includes(appName)
  const inJson = appName !== null && data.registeredFromJson.includes(appName)
  const thisAppRegistered = inDirs || inJson

  // Reconciliation note (V #7): JSON index and dirs disagree.
  let note: string | null = null
  if (appName !== null && inJson !== inDirs) {
    note = inJson
      ? `app "${appName}" is listed in .universe.json but has no applications/${appName}/ dir`
      : `app "${appName}" has an applications/${appName}/ dir but is missing from .universe.json registered_apps`
  }

  const block: UniverseBlock = {
    available: true,
    name: data.name ?? config.universe?.name ?? null,
    local_path: resolution.path,
    registered_apps_count: data.registeredFromDirs.length,
    this_app_registered: thisAppRegistered,
    note,
    // V FV2: only the found+readable path computes the governance index.
    governance: readUniverseGovernanceIndex(resolution.path),
  }

  const hint =
    !thisAppRegistered && appName !== null
      ? `Universe found at ${resolution.path}; this app ("${appName}") is not registered there. Run /rsct-setup to register it.`
      : null

  return { block, hint }
}

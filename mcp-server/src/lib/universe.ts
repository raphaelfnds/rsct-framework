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
// `RsctConfig.universe` is populated by /rsct-universe (link mode), but nothing ever
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

// Case-insensitive filesystems (Windows, default macOS): a path equality test must be
// case-folded or a case-variant of the repo's own path compares as different.
// Declared here rather than imported from `onboarding-detect.ts` — that module imports
// this one, and the reverse import would close a cycle.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

type Resolution =
  | { kind: 'found'; path: string }
  | { kind: 'configured-missing'; path: string }
  | { kind: 'none' }

/** Does a directory hold a `.universe.json` (the universe marker)? */
export function isUniverseDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, '.universe.json'))
  } catch {
    return false
  }
}

/**
 * Infer the org slug by stripping a trailing `-<digits>` suffix
 * (e.g. "bluelt-23" → "bluelt"). The `-\d*$` (not `-\d+$`) mirrors the prompt's
 * `sed 's/-[0-9]*$//'` EXACTLY — `-\d+$` would diverge on a bare trailing dash.
 * Single source so the universe resolver and the onboarding detector can never
 * drift on what counts as the "same org". Behavior-preserving: no trim/lowercase
 * here — callers that need a case-insensitive MATCH key apply that themselves
 * (the resolver builds directory names from this and must keep the exact case).
 */
export function normalizeOrg(org: string | null | undefined): string | null {
  return org ? org.replace(/-\d*$/, '') : null
}

/**
 * The canonical candidate paths, in probe order (same list as 02-canonical-source.md
 * Phase 1.2). Shared so the post-install resolver and the pre-install discovery cannot
 * grow separate ideas of where a universe lives.
 *
 * ORDER IS LOAD-BEARING. `../universe` sits BETWEEN the sibling candidates and the
 * `$HOME` ones — it outranks all four home candidates. Appending it instead would flip
 * a shipped precedence: a project with both `../universe` and
 * `$HOME/projetos/<org>-universe` resolves to the former today.
 *
 * `includeOrgBlind` is false for discovery: `../universe` carries no org in its name, so
 * claiming it for a project whose identity is only *inferred* (pre-install, from a git
 * remote) would let another org's shared directory be adopted as ours.
 */
export function universeCandidates(
  projectRoot: string,
  basenames: string[],
  home: string,
  includeOrgBlind: boolean,
): string[] {
  const candidates: string[] = []
  for (const b of basenames) candidates.push(resolve(projectRoot, '..', `${b}-universe`))
  if (includeOrgBlind) candidates.push(resolve(projectRoot, '..', 'universe'))
  for (const sub of ['projetos', 'projects', 'dev', 'workspace']) {
    for (const b of basenames) candidates.push(join(home, sub, `${b}-universe`))
  }
  return candidates
}

/**
 * Pre-install universe discovery: "is one of the canonical candidates a universe?",
 * answered WITHOUT a config. `resolveUniverseRoot` cannot serve this — `getUniverse`
 * early-returns on a null config, which is the state every project is in before
 * `/rsct-setup` writes `.rsct.json`.
 *
 * Both sides walk `universeCandidates`, so the *name-derived* candidate list has one
 * definition. Three asymmetries are deliberate; do not "fix" them into symmetry:
 *
 *   1. `config.universe.local` bypasses candidates entirely in the resolver. Discovery has
 *      no config to read it from — and the branch that calls this is unreachable when
 *      `local` is set anyway.
 *   2. The resolver has a `config.universe.name` basename. Discovery does not.
 *   3. The resolver probes `../universe`. Discovery must not (see `includeOrgBlind`).
 *
 * Basenames mirror the resolver's order — inferred, then raw — because an org carrying a
 * `-<digits>` suffix (`acme-23`) may sit beside either `acme-universe` or
 * `acme-23-universe`, and dropping the raw form misses the second.
 *
 * They are built CASE-EXACT, matching the resolver and the bash probes in
 * `01-setup.md` Phase 1.9 and `02-canonical-source.md` Phase 1.2. An earlier revision
 * also probed lower-cased variants so an `Acme` org would find `acme-universe` on a
 * case-sensitive filesystem — that was withdrawn. `02-canonical-source.md` re-probes
 * case-exact when the developer accepts the link and cannot be handed a path, so
 * discovering a universe it cannot find leads to "not found locally — create one?":
 * issue #65's own failure, relocated one prompt later and made OS-dependent. A
 * case-variant org therefore still misses, consistently, on every layer.
 *
 * Never throws. Returns null when no org can be derived.
 */
export function discoverUniverseCandidate(
  projectRoot: string,
  orgKey: string | null | undefined,
  opts: UniverseOptions = {},
): string | null {
  try {
    const raw = orgKey?.trim() || null
    if (!raw) return null
    const inferred = normalizeOrg(raw)
    const basenames = [
      ...new Set(
        [inferred, raw].filter(
          // `!!x` drops the empty string `normalizeOrg` returns for a digits-only org
          // (`-9` → ''), which would otherwise probe `../-universe`.
          //
          // The rest is a path-traversal guard: a basename becomes a path component, and
          // `rawSelfOrg` can come from a git remote (`parseGitRemoteOrg` returns the first
          // URL segment verbatim). That is untrusted input reaching `resolve()` for the
          // first time here — on Windows a `\` in it is a separator and walks out of the
          // scanned parent.
          (x): x is string => !!x && !/[\\/]/.test(x) && x !== '.' && x !== '..',
        ),
      ),
    ]
    if (basenames.length === 0) return null
    const home = opts.home ?? process.env.HOME ?? homedir()
    const self = resolve(projectRoot)
    const selfKey = CASE_INSENSITIVE_FS ? self.toLowerCase() : self
    for (const c of universeCandidates(projectRoot, basenames, home, false)) {
      // A repo named `<org>-universe` must not discover ITSELF as its own universe;
      // the `is_universe_repo` guard owns that case.
      const cKey = CASE_INSENSITIVE_FS ? resolve(c).toLowerCase() : resolve(c)
      if (cKey === selfKey) continue
      if (isUniverseDir(c)) return c
    }
    return null
  } catch {
    return null
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
  const inferred = normalizeOrg(org)
  const basenames = [...new Set([name, inferred, org].filter((x): x is string => !!x))]
  const candidates = universeCandidates(projectRoot, basenames, home, true)

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
      hint: `Universe configured at ${resolution.path} but not found there — fix .rsct.json universe.local or re-run /rsct-universe.`,
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
